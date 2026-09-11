using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
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

    // WinForms' message loop (Application.Run) must own the main thread in the
    // STA apartment, so the async startup work (enrol, fetch policy) runs
    // synchronously-blocking here first, then the background tracker loop runs
    // on its own Task while Application.Run takes the main thread for the
    // work-tracker widget.
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            var cfg = Config.Load(args);
            var state = AgentState.Load(cfg.StatePath);
            var id = Identity.Get();

            EnsureEnrolled(cfg, state, id).GetAwaiter().GetResult();
            var policy = FetchPolicy(cfg, state).GetAwaiter().GetResult();
            Log($"policy: sample {policy.SampleIntervalSec}s · upload {policy.UploadIntervalSec}s · idle {policy.IdleThresholdSec}s · titles {policy.CollectWindowTitles}");
            Log($"identity: {id.DisplayName} ({id.LocalAccountKey}){(cfg.ClaimCode is null ? "" : $" · claim {cfg.ClaimCode}")}");

            var agent = new Agent(cfg, state, id, policy);

            if (cfg.Once)
            {
                agent.SampleOnce();
                Thread.Sleep(2000);
                agent.SampleOnce();
                agent.Flush().GetAwaiter().GetResult();
                Log("done (--once)");
                return 0;
            }

            using var cts = new CancellationTokenSource();

            // The work-tracker widget is opt-in per company (MonitoringSetting.
            // workTrackerEnabled) — most companies just want silent passive
            // tracking with no on-screen window. Activity/idle tracking and
            // screenshots run in RunBackgroundLoop either way, completely
            // independent of whether the widget exists at all.
            if (policy.WorkTrackerEnabled)
            {
                Log("running — background tracker + work-tracker widget");
                var backgroundLoop = Task.Run(() => RunBackgroundLoop(agent, policy, cts.Token));

                Application.SetHighDpiMode(HighDpiMode.SystemAware);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var widget = new WorkTrackerForm(cfg, state, id))
                    Application.Run(widget);

                Log("shutting down — final flush…");
                cts.Cancel();
                backgroundLoop.GetAwaiter().GetResult();
            }
            else
            {
                Log("running — background tracker only (work tracker not enabled for this company)");
                Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
                RunBackgroundLoop(agent, policy, cts.Token).GetAwaiter().GetResult();
            }
            return 0;
        }
        catch (Exception ex)
        {
            Log($"error: {ex.Message}");
            return 1;
        }
    }

    private static async Task RunBackgroundLoop(Agent agent, Policy policy, CancellationToken token)
    {
        agent.SampleOnce();
        var lastUpload = DateTime.UtcNow;
        var lastScreenshot = DateTime.MinValue; // MinValue so the first capture fires promptly, not after a full interval
        while (!token.IsCancellationRequested)
        {
            try { await Task.Delay(policy.SampleIntervalSec * 1000, token); }
            catch (TaskCanceledException) { break; }

            agent.SampleOnce();
            if ((DateTime.UtcNow - lastUpload).TotalSeconds >= policy.UploadIntervalSec)
            {
                await agent.Flush();
                lastUpload = DateTime.UtcNow;
            }
            if (policy.CollectScreenshots && (DateTime.UtcNow - lastScreenshot).TotalSeconds >= policy.ScreenshotIntervalSec)
            {
                await agent.CaptureAndUploadScreenshot();
                lastScreenshot = DateTime.UtcNow;
            }
        }
        await agent.Flush();
    }

    private static async Task EnsureEnrolled(Config cfg, AgentState state, Identity id)
    {
        // Re-enrol if we have no token OR the enrolment key changed — e.g. a new
        // installer re-pointed this PC to a different company. Without the key check
        // the PC would silently keep its old company's enrolment.
        // NOTE: state.EnrolledKey is null for devices enrolled before this field
        // existed — treat that as "unknown", not "changed", so upgrading the agent
        // in place doesn't force a spurious re-enrol (and duplicate device) on every
        // already-enrolled PC. We backfill it below instead.
        var haveToken = !string.IsNullOrEmpty(state.AgentToken);
        var keyChanged = haveToken && state.EnrolledKey != null
            && !string.IsNullOrEmpty(cfg.EnrollmentKey) && state.EnrolledKey != cfg.EnrollmentKey;
        if (haveToken && !keyChanged)
        {
            if (state.EnrolledKey == null && !string.IsNullOrEmpty(cfg.EnrollmentKey))
            {
                state.EnrolledKey = cfg.EnrollmentKey; // backfill so a future real change is still detected
                state.Save(cfg.StatePath);
            }
            return;
        }
        if (string.IsNullOrEmpty(cfg.EnrollmentKey))
            throw new Exception("Not enrolled and no enrollmentKey provided");
        if (keyChanged) Log("enrolment key changed — re-enrolling this device into the new company…");

        Log($"enrolling device \"{id.DeviceName}\"…");
        var body = JsonSerializer.Serialize(new
        {
            enrollmentKey = cfg.EnrollmentKey,
            deviceName = id.DeviceName,
            agentVersion = "win-0.7.0",
        });
        using var res = await Http.PostAsync($"{cfg.ServerUrl}/api/monitoring/enroll", Json(body));
        var text = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode) throw new Exception($"enroll failed: {(int)res.StatusCode} {text}");

        using var doc = JsonDocument.Parse(text);
        state.DeviceId = doc.RootElement.GetProperty("deviceId").GetString();
        state.AgentToken = doc.RootElement.GetProperty("agentToken").GetString();
        state.EnrolledKey = cfg.EnrollmentKey; // remember which company/key this device is for
        state.Claimed = false; // a fresh enrolment hasn't redeemed a claim code yet
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
                if (p.TryGetProperty("collectScreenshots", out var cs)) policy.CollectScreenshots = cs.GetBoolean();
                if (p.TryGetProperty("screenshotIntervalSec", out var si)) policy.ScreenshotIntervalSec = si.GetInt32();
                if (p.TryGetProperty("workTrackerEnabled", out var wt)) policy.WorkTrackerEnabled = wt.GetBoolean();
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

        var body = JsonSerializer.Serialize(new { employee, events = batch, sessionEvents = Array.Empty<object>(), agentVersion = "win-0.7.0" });
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

    // One periodic desktop capture. Best-effort: unlike activity events this is
    // never spooled/retried on failure (no point caching a stale screenshot, and
    // it avoids ever accumulating captured images on disk) — it just tries again
    // at the next interval.
    public async Task CaptureAndUploadScreenshot()
    {
        var jpeg = Capture.CaptureScreenJpeg();
        if (jpeg is null) return;

        var employee = new Dictionary<string, object?>
        {
            ["localAccountKey"] = _id.LocalAccountKey,
            ["displayName"] = _id.DisplayName,
        };
        var body = JsonSerializer.Serialize(new
        {
            employee,
            capturedAt = DateTime.UtcNow.ToString("O"),
            imageBase64 = Convert.ToBase64String(jpeg),
        });
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{_cfg.ServerUrl}/api/monitoring/screenshot") { Content = Program.Json(body) };
            req.Headers.Add("Authorization", $"Bearer {_state.AgentToken}");
            using var res = await new HttpClient().SendAsync(req);
            if (!res.IsSuccessStatusCode)
                Program.Log($"screenshot upload failed: {(int)res.StatusCode} {await res.Content.ReadAsStringAsync()}");
        }
        catch (Exception ex)
        {
            Program.Log($"screenshot upload error: {ex.Message}");
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

    private const int SM_XVIRTUALSCREEN = 76;
    private const int SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);

    // Captures the full virtual desktop (all monitors), downscaled + JPEG-encoded
    // to keep uploads small. Returns null on any failure (e.g. no desktop session,
    // locked workstation) — screenshots are best-effort, never worth crashing over.
    public static byte[]? CaptureScreenJpeg(int jpegQuality = 45, int maxWidth = 1600)
    {
        try
        {
            var x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            var y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            var w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            var h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if (w <= 0 || h <= 0) return null;

            using var full = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(full))
                g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);

            Bitmap? resized = null;
            var toEncode = full;
            if (w > maxWidth)
            {
                var newH = (int)((long)h * maxWidth / w);
                resized = new Bitmap(full, new Size(maxWidth, Math.Max(1, newH)));
                toEncode = resized;
            }
            try
            {
                var jpegCodec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
                using var eps = new EncoderParameters(1);
                eps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)jpegQuality);
                using var ms = new MemoryStream();
                toEncode.Save(ms, jpegCodec, eps);
                return ms.ToArray();
            }
            finally { resized?.Dispose(); }
        }
        catch (Exception ex) { Program.Log($"screenshot capture failed: {ex}"); return null; }
    }
}
