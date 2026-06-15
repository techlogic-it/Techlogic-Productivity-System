using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace ProductivityAgent;

// Windows port of the cross-platform reference agent (../agent). Same enrol →
// capture → ingest protocol and identical JSON shapes; only identity (user SID)
// and capture (Win32) differ. Console app — run as a Windows Service / scheduled
// task in production (see ../agent/README.md).
internal static class Program
{
    private static readonly HttpClient Http = new();

    private static async Task<int> Main(string[] args)
    {
        try
        {
            var cfg = Config.Load(args);
            var state = AgentState.Load(cfg.StatePath);
            var id = Identity.Get();

            await EnsureEnrolled(cfg, state, id);
            var policy = await FetchPolicy(cfg, state);
            Log($"policy: sample {policy.SampleIntervalSec}s · upload {policy.UploadIntervalSec}s · idle {policy.IdleThresholdSec}s · titles {policy.CollectWindowTitles}");
            Log($"identity: {id.DisplayName} ({id.LocalAccountKey}){(cfg.ClaimCode is null ? "" : $" · claim {cfg.ClaimCode}")}");

            var agent = new Agent(cfg, state, id, policy);

            if (cfg.Once)
            {
                agent.SampleOnce();
                await Task.Delay(2000);
                agent.SampleOnce();
                await agent.Flush();
                Log("done (--once)");
                return 0;
            }

            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
            Log("running — Ctrl-C to stop");
            agent.SampleOnce();

            var lastUpload = DateTime.UtcNow;
            while (!cts.IsCancellationRequested)
            {
                try { await Task.Delay(policy.SampleIntervalSec * 1000, cts.Token); }
                catch (TaskCanceledException) { break; }

                agent.SampleOnce();
                if ((DateTime.UtcNow - lastUpload).TotalSeconds >= policy.UploadIntervalSec)
                {
                    await agent.Flush();
                    lastUpload = DateTime.UtcNow;
                }
            }

            Log("shutting down — final flush…");
            await agent.Flush();
            return 0;
        }
        catch (Exception ex)
        {
            Log($"error: {ex.Message}");
            return 1;
        }
    }

    private static async Task EnsureEnrolled(Config cfg, AgentState state, Identity id)
    {
        if (!string.IsNullOrEmpty(state.AgentToken)) return;
        if (string.IsNullOrEmpty(cfg.EnrollmentKey))
            throw new Exception("Not enrolled and no enrollmentKey provided");

        Log($"enrolling device \"{id.DeviceName}\"…");
        var body = JsonSerializer.Serialize(new
        {
            enrollmentKey = cfg.EnrollmentKey,
            deviceName = id.DeviceName,
            agentVersion = "win-0.1.0",
        });
        using var res = await Http.PostAsync($"{cfg.ServerUrl}/api/monitoring/enroll", Json(body));
        var text = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode) throw new Exception($"enroll failed: {(int)res.StatusCode} {text}");

        using var doc = JsonDocument.Parse(text);
        state.DeviceId = doc.RootElement.GetProperty("deviceId").GetString();
        state.AgentToken = doc.RootElement.GetProperty("agentToken").GetString();
        state.Save(cfg.StatePath);
        Log($"enrolled (deviceId {state.DeviceId})");
    }

    private static async Task<Policy> FetchPolicy(Config cfg, AgentState state)
    {
        var policy = Policy.Default();
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, $"{cfg.ServerUrl}/api/monitoring/config");
            req.Headers.Add("Authorization", $"Bearer {state.AgentToken}");
            using var res = await Http.SendAsync(req);
            if (res.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
                var p = doc.RootElement.GetProperty("policy");
                if (p.TryGetProperty("sampleIntervalSec", out var s)) policy.SampleIntervalSec = s.GetInt32();
                if (p.TryGetProperty("idleThresholdSec", out var it)) policy.IdleThresholdSec = it.GetInt32();
                if (p.TryGetProperty("uploadIntervalSec", out var u)) policy.UploadIntervalSec = u.GetInt32();
                if (p.TryGetProperty("collectWindowTitles", out var c)) policy.CollectWindowTitles = c.GetBoolean();
                if (p.TryGetProperty("maxBatchSize", out var m)) policy.MaxBatchSize = m.GetInt32();
            }
        }
        catch { /* keep defaults if the policy fetch fails */ }
        cfg.ApplyPolicyOverride(policy);
        return policy;
    }

    internal static StringContent Json(string body) => new(body, Encoding.UTF8, "application/json");
    internal static void Log(string msg) => Console.WriteLine($"[agent {DateTime.UtcNow:O}] {msg}");
}

// ── The capture + upload engine ──────────────────────────────────────────────
internal sealed class Agent
{
    private readonly Config _cfg;
    private readonly AgentState _state;
    private readonly Identity _id;
    private readonly Policy _policy;
    private readonly List<Event> _buffer = new();
    private Segment? _current;

    public Agent(Config cfg, AgentState state, Identity id, Policy policy)
    { _cfg = cfg; _state = state; _id = id; _policy = policy; }

    public void SampleOnce()
    {
        var fg = Capture.GetForeground();
        var isIdle = Capture.GetIdleSeconds() >= _policy.IdleThresholdSec;
        var title = _policy.CollectWindowTitles ? fg.WindowTitle : null;
        var now = DateTime.UtcNow;

        if (_current is not null && (_current.ProcessName != fg.ProcessName || _current.IsIdle != isIdle))
            CloseSegment(now);
        _current ??= new Segment(fg.ProcessName, title, isIdle, now);
        if (_current.WindowTitle is null) _current.WindowTitle = title;
    }

    private void CloseSegment(DateTime end)
    {
        if (_current is null) return;
        var dur = Math.Max(1, (int)Math.Round((end - _current.Start).TotalSeconds));
        _buffer.Add(new Event
        {
            clientEventId = Guid.NewGuid().ToString(),
            processName = _current.ProcessName,
            windowTitle = _current.WindowTitle,
            startTime = _current.Start.ToString("O"),
            endTime = end.ToString("O"),
            durationSec = dur,
            isIdle = _current.IsIdle,
        });
        _current = null;
    }

    public async Task Flush()
    {
        CloseSegment(DateTime.UtcNow);
        var pending = new List<Event>(Spool.ReadAll(_cfg.SpoolPath));
        pending.AddRange(_buffer);
        if (pending.Count == 0) return;

        var batch = pending.Take(_policy.MaxBatchSize).ToList();
        var employee = new Dictionary<string, object?>
        {
            ["localAccountKey"] = _id.LocalAccountKey,
            ["displayName"] = _id.DisplayName,
        };
        if (!string.IsNullOrEmpty(_cfg.ClaimCode) && !_state.Claimed)
            employee["claimCode"] = _cfg.ClaimCode;

        var body = JsonSerializer.Serialize(new { employee, events = batch, sessionEvents = Array.Empty<object>(), agentVersion = "win-0.1.0" });
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{_cfg.ServerUrl}/api/monitoring/ingest") { Content = Program.Json(body) };
            req.Headers.Add("Authorization", $"Bearer {_state.AgentToken}");
            using var res = await new HttpClient().SendAsync(req);
            if (res.StatusCode is System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden)
            {
                Program.Log($"FATAL: token rejected ({(int)res.StatusCode}) — re-enrol required. Exiting.");
                Environment.Exit(1);
            }
            if (!res.IsSuccessStatusCode)
                throw new Exception($"ingest failed: {(int)res.StatusCode} {await res.Content.ReadAsStringAsync()}");

            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
            var accepted = doc.RootElement.TryGetProperty("acceptedEvents", out var a) ? a.GetInt32() : batch.Count;
            Spool.Clear(_cfg.SpoolPath);
            _buffer.Clear();
            _buffer.AddRange(pending.Skip(_policy.MaxBatchSize));
            if (!string.IsNullOrEmpty(_cfg.ClaimCode) && !_state.Claimed) { _state.Claimed = true; _state.Save(_cfg.StatePath); }
            Program.Log($"uploaded {accepted} event(s)");
        }
        catch (Exception ex)
        {
            Spool.Append(_cfg.SpoolPath, _buffer);
            _buffer.Clear();
            Program.Log($"offline — spooled {pending.Count} event(s) for retry ({ex.Message})");
        }
    }
}

internal sealed class Segment
{
    public string ProcessName { get; }
    public string? WindowTitle { get; set; }
    public bool IsIdle { get; }
    public DateTime Start { get; }
    public Segment(string p, string? t, bool idle, DateTime start) { ProcessName = p; WindowTitle = t; IsIdle = idle; Start = start; }
}

internal sealed class Event
{
    public string clientEventId { get; set; } = "";
    public string processName { get; set; } = "";
    public string? windowTitle { get; set; }
    public string startTime { get; set; } = "";
    public string endTime { get; set; } = "";
    public int durationSec { get; set; }
    public bool isIdle { get; set; }
}

// ── Identity: the Windows user SID (immutable across renames) ─────────────────
internal sealed record Identity(string LocalAccountKey, string DisplayName, string DeviceName)
{
    public static Identity Get()
    {
        string sid;
        try { sid = WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName; }
        catch { sid = Environment.UserName; }
        var display = string.IsNullOrWhiteSpace(Environment.UserName) ? sid : Environment.UserName;
        return new Identity(sid, display, Environment.MachineName);
    }
}

// ── Capture: Win32 foreground window + idle time ─────────────────────────────
internal static class Capture
{
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    public static (string ProcessName, string? WindowTitle) GetForeground()
    {
        try
        {
            var hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return ("unknown", null);

            var sb = new StringBuilder(512);
            GetWindowText(hwnd, sb, sb.Capacity);
            var title = sb.Length > 0 ? sb.ToString() : null;

            GetWindowThreadProcessId(hwnd, out var pid);
            var proc = "unknown";
            try { proc = Process.GetProcessById((int)pid).ProcessName.ToUpperInvariant() + ".EXE"; }
            catch { /* process may have exited */ }
            return (proc, title);
        }
        catch { return ("unknown", null); }
    }

    public static int GetIdleSeconds()
    {
        try
        {
            var lii = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
            if (!GetLastInputInfo(ref lii)) return 0;
            var idleMs = (uint)Environment.TickCount - lii.dwTime;
            return (int)(idleMs / 1000);
        }
        catch { return 0; }
    }
}
