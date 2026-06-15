using System.Text.Json;

namespace ProductivityAgent;

// Configuration (read-only, provisioned at install) + runtime state. Resolution
// order: CLI flags → environment → JSON config file. Mirrors ../agent/src/config.js.
internal sealed class Config
{
    public string ServerUrl { get; private set; } = "";
    public string? EnrollmentKey { get; private set; }
    public string? ClaimCode { get; private set; }
    public bool Once { get; private set; }
    public string StatePath { get; private set; } = "";
    public string SpoolPath { get; private set; } = "";

    private int? _ovSample, _ovUpload, _ovIdle, _ovBatch;
    private bool? _ovTitles;

    public static Config Load(string[] args)
    {
        var cli = ParseArgs(args);
        var exeDir = Path.GetDirectoryName(Environment.ProcessPath) ?? Directory.GetCurrentDirectory();
        var configPath = cli.GetValueOrDefault("config")
                         ?? Environment.GetEnvironmentVariable("AGENT_CONFIG")
                         ?? Path.Combine(exeDir, "agent.config.json");

        JsonElement file = default;
        var hasFile = File.Exists(configPath);
        if (hasFile)
        {
            try { file = JsonDocument.Parse(File.ReadAllText(configPath)).RootElement; }
            catch (Exception e) { throw new Exception($"Invalid config file {configPath}: {e.Message}"); }
        }
        string? FromFile(string k) => hasFile && file.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        var cfg = new Config
        {
            ServerUrl = cli.GetValueOrDefault("server")
                        ?? Environment.GetEnvironmentVariable("AGENT_SERVER_URL")
                        ?? FromFile("serverUrl") ?? "",
            EnrollmentKey = cli.GetValueOrDefault("key")
                        ?? Environment.GetEnvironmentVariable("AGENT_ENROLLMENT_KEY")
                        ?? FromFile("enrollmentKey"),
            ClaimCode = cli.GetValueOrDefault("claim")
                        ?? Environment.GetEnvironmentVariable("AGENT_CLAIM_CODE")
                        ?? FromFile("claimCode"),
            Once = cli.ContainsKey("once"),
        };
        if (string.IsNullOrEmpty(cfg.ServerUrl))
            throw new Exception("serverUrl is required (--server / AGENT_SERVER_URL / config.serverUrl)");
        cfg.ServerUrl = cfg.ServerUrl.TrimEnd('/');

        cfg.StatePath = FromFile("statePath") ?? Path.Combine(exeDir, "agent.state.json");
        cfg.SpoolPath = FromFile("spoolPath") ?? Path.Combine(exeDir, "agent.spool.jsonl");

        if (hasFile && file.TryGetProperty("policy", out var p) && p.ValueKind == JsonValueKind.Object)
        {
            if (p.TryGetProperty("sampleIntervalSec", out var a)) cfg._ovSample = a.GetInt32();
            if (p.TryGetProperty("uploadIntervalSec", out var b)) cfg._ovUpload = b.GetInt32();
            if (p.TryGetProperty("idleThresholdSec", out var c)) cfg._ovIdle = c.GetInt32();
            if (p.TryGetProperty("maxBatchSize", out var d)) cfg._ovBatch = d.GetInt32();
            if (p.TryGetProperty("collectWindowTitles", out var e)) cfg._ovTitles = e.GetBoolean();
        }
        return cfg;
    }

    public void ApplyPolicyOverride(Policy policy)
    {
        if (_ovSample is int s) policy.SampleIntervalSec = s;
        if (_ovUpload is int u) policy.UploadIntervalSec = u;
        if (_ovIdle is int i) policy.IdleThresholdSec = i;
        if (_ovBatch is int b) policy.MaxBatchSize = b;
        if (_ovTitles is bool t) policy.CollectWindowTitles = t;
    }

    private static Dictionary<string, string?> ParseArgs(string[] argv)
    {
        var o = new Dictionary<string, string?>();
        for (var i = 0; i < argv.Length; i++)
        {
            switch (argv[i])
            {
                case "--server": o["server"] = argv[++i]; break;
                case "--key": o["key"] = argv[++i]; break;
                case "--claim": o["claim"] = argv[++i]; break;
                case "--config": o["config"] = argv[++i]; break;
                case "--once": o["once"] = null; break;
            }
        }
        return o;
    }
}

internal sealed class AgentState
{
    public string? DeviceId { get; set; }
    public string? AgentToken { get; set; }
    public bool Claimed { get; set; }

    public static AgentState Load(string path)
    {
        if (File.Exists(path))
        {
            try { return JsonSerializer.Deserialize<AgentState>(File.ReadAllText(path)) ?? new AgentState(); }
            catch { /* fall through */ }
        }
        return new AgentState();
    }

    public void Save(string path)
        => File.WriteAllText(path, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    // NOTE (production): DPAPI-encrypt AgentToken (ProtectedData.Protect) and store
    // under %ProgramData%\ProductivityAgent rather than plaintext beside the exe.
}

internal sealed class Policy
{
    public int SampleIntervalSec { get; set; }
    public int IdleThresholdSec { get; set; }
    public int UploadIntervalSec { get; set; }
    public bool CollectWindowTitles { get; set; }
    public int MaxBatchSize { get; set; }

    public static Policy Default() => new()
    {
        SampleIntervalSec = 5,
        IdleThresholdSec = 300,
        UploadIntervalSec = 60,
        CollectWindowTitles = true,
        MaxBatchSize = 1000,
    };
}

// Offline spool: JSONL, one event per line, idempotent on retry (UUID per event).
internal static class Spool
{
    public static void Append(string path, IEnumerable<Event> events)
    {
        var lines = events.Select(e => JsonSerializer.Serialize(e)).ToArray();
        if (lines.Length > 0) File.AppendAllLines(path, lines);
    }

    public static List<Event> ReadAll(string path)
    {
        var list = new List<Event>();
        if (!File.Exists(path)) return list;
        foreach (var line in File.ReadAllLines(path))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try { var e = JsonSerializer.Deserialize<Event>(line); if (e is not null) list.Add(e); }
            catch { /* skip corrupt line */ }
        }
        return list;
    }

    public static void Clear(string path) { if (File.Exists(path)) File.Delete(path); }
}
