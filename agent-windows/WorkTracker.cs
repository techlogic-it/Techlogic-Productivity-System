using System.Text.Json;

namespace ProductivityAgent;

// Talks to the agent-plane work-tracker endpoints (/clients, /work/start,
// /work/open, /work/end). Every call swallows its own exceptions and returns
// an empty/false result on failure — the widget should degrade quietly on a
// flaky connection, never crash the always-on-top window.
internal sealed class WorkClient
{
    private readonly Config _cfg;
    private readonly AgentState _state;
    private static readonly HttpClient Http = new();

    public WorkClient(Config cfg, AgentState state) { _cfg = cfg; _state = state; }

    private HttpRequestMessage Req(HttpMethod method, string path)
    {
        var req = new HttpRequestMessage(method, $"{_cfg.ServerUrl}{path}");
        req.Headers.Add("Authorization", $"Bearer {_state.AgentToken}");
        return req;
    }

    public async Task<List<ClientDto>> GetClients()
    {
        try
        {
            using var res = await Http.SendAsync(Req(HttpMethod.Get, "/api/monitoring/clients"));
            if (!res.IsSuccessStatusCode) return new List<ClientDto>();
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
            var list = new List<ClientDto>();
            foreach (var el in doc.RootElement.EnumerateArray())
                list.Add(new ClientDto(el.GetProperty("id").GetString() ?? "", el.GetProperty("name").GetString() ?? ""));
            return list;
        }
        catch { return new List<ClientDto>(); }
    }

    public async Task<List<OpenSessionDto>> GetOpenSessions(string localAccountKey)
    {
        try
        {
            using var res = await Http.SendAsync(Req(HttpMethod.Get, $"/api/monitoring/work/open?localAccountKey={Uri.EscapeDataString(localAccountKey)}"));
            if (!res.IsSuccessStatusCode) return new List<OpenSessionDto>();
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
            var list = new List<OpenSessionDto>();
            foreach (var el in doc.RootElement.EnumerateArray())
            {
                list.Add(new OpenSessionDto(
                    el.GetProperty("agentSessionId").GetString() ?? "",
                    el.TryGetProperty("clientName", out var cn) && cn.ValueKind == JsonValueKind.String ? cn.GetString() : null,
                    el.GetProperty("taskName").GetString() ?? "",
                    DateTime.Parse(el.GetProperty("startTime").GetString()!).ToUniversalTime()));
            }
            return list;
        }
        catch { return new List<OpenSessionDto>(); }
    }

    public async Task<bool> Start(string localAccountKey, string displayName, string? clientId, string taskName, string? notes, string agentSessionId)
    {
        try
        {
            var body = JsonSerializer.Serialize(new
            {
                employee = new { localAccountKey, displayName },
                clientId,
                taskName,
                notes,
                agentSessionId,
            });
            using var req = Req(HttpMethod.Post, "/api/monitoring/work/start");
            req.Content = Program.Json(body);
            using var res = await Http.SendAsync(req);
            return res.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    public async Task<bool> End(string agentSessionId)
    {
        try
        {
            var body = JsonSerializer.Serialize(new { agentSessionId });
            using var req = Req(HttpMethod.Post, "/api/monitoring/work/end");
            req.Content = Program.Json(body);
            using var res = await Http.SendAsync(req);
            return res.IsSuccessStatusCode;
        }
        catch { return false; }
    }
}

internal sealed record ClientDto(string Id, string Name);
internal sealed record OpenSessionDto(string AgentSessionId, string? ClientName, string TaskName, DateTime StartTime);

// Small always-on-top widget: pick a client + task, Start; several tasks can
// run at once, each gets its own row with an elapsed timer and a Stop button.
// Recovers still-open sessions from the server on launch (GET /work/open), so
// a PC restart mid-task doesn't lose or duplicate it.
internal sealed class WorkTrackerForm : Form
{
    private readonly WorkClient _client;
    private readonly Identity _id;
    private readonly ComboBox _clientBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 296 };
    private readonly TextBox _taskBox = new() { PlaceholderText = "Task (e.g. VAT Return)", Width = 296 };
    private readonly TextBox _notesBox = new() { PlaceholderText = "Notes (optional)", Width = 296 };
    private readonly Button _startButton = new() { Text = "Start task", Width = 296, Height = 30 };
    private readonly FlowLayoutPanel _runningPanel = new() { FlowDirection = FlowDirection.TopDown, AutoScroll = true, Dock = DockStyle.Fill, WrapContents = false, Padding = new Padding(10, 0, 10, 10) };
    private readonly System.Windows.Forms.Timer _tickTimer = new() { Interval = 1000 };
    private readonly List<RunningRow> _running = new();
    private List<ClientDto> _clients = new();

    public WorkTrackerForm(Config cfg, AgentState state, Identity id)
    {
        _client = new WorkClient(cfg, state);
        _id = id;

        Text = "Techlogic Work Tracker";
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        ShowInTaskbar = false;
        Width = 340;
        Height = 440;
        var wa = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 720);
        Location = new Point(wa.Right - Width - 12, wa.Bottom - Height - 12);
        BackColor = Color.White;

        BuildLayout();
        _tickTimer.Tick += (_, __) => RefreshElapsed();
        _tickTimer.Start();
        Load += async (_, __) => await Initialise();
        // Never actually let the user close the widget — it's meant to stay
        // running alongside the background tracker. Minimise instead.
        FormClosing += (_, e) => { if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); } };
    }

    private void BuildLayout()
    {
        var top = new TableLayoutPanel { Dock = DockStyle.Top, ColumnCount = 1, AutoSize = true, Padding = new Padding(10) };
        top.Controls.Add(new Label { Text = "Start a new task", Font = new Font(Font, FontStyle.Bold), AutoSize = true, Margin = new Padding(0, 0, 0, 6) });
        top.Controls.Add(_clientBox);
        top.Controls.Add(new Panel { Height = 4 });
        top.Controls.Add(_taskBox);
        top.Controls.Add(new Panel { Height = 4 });
        top.Controls.Add(_notesBox);
        top.Controls.Add(new Panel { Height = 6 });
        top.Controls.Add(_startButton);
        top.Controls.Add(new Label { Text = "Running", Font = new Font(Font, FontStyle.Bold), AutoSize = true, Margin = new Padding(0, 10, 0, 0) });
        _startButton.Click += async (_, __) => await StartClicked();

        Controls.Add(_runningPanel);
        Controls.Add(top);
    }

    private async Task Initialise()
    {
        _clients = await _client.GetClients();
        _clientBox.Items.Clear();
        _clientBox.Items.Add("(no client)");
        foreach (var c in _clients) _clientBox.Items.Add(c.Name);
        _clientBox.SelectedIndex = 0;

        foreach (var s in await _client.GetOpenSessions(_id.LocalAccountKey))
            AddRunningRow(s.AgentSessionId, s.ClientName, s.TaskName, s.StartTime);
    }

    private async Task StartClicked()
    {
        var task = _taskBox.Text.Trim();
        if (task.Length == 0) { MessageBox.Show(this, "Enter a task name first.", "Work Tracker"); return; }

        string? clientId = null; string? clientName = null;
        if (_clientBox.SelectedIndex > 0)
        {
            var c = _clients[_clientBox.SelectedIndex - 1];
            clientId = c.Id; clientName = c.Name;
        }
        var notes = _notesBox.Text.Trim();
        var sessionId = Guid.NewGuid().ToString();

        _startButton.Enabled = false;
        var ok = await _client.Start(_id.LocalAccountKey, _id.DisplayName, clientId, task, notes.Length > 0 ? notes : null, sessionId);
        _startButton.Enabled = true;
        if (!ok) { MessageBox.Show(this, "Couldn't start the task — check your connection.", "Work Tracker"); return; }

        AddRunningRow(sessionId, clientName, task, DateTime.UtcNow);
        _taskBox.Clear(); _notesBox.Clear(); _clientBox.SelectedIndex = 0;
    }

    private void AddRunningRow(string sessionId, string? clientName, string taskName, DateTime startTime)
    {
        var row = new RunningRow(sessionId, clientName, taskName, startTime);
        var panel = new Panel { Width = 300, Height = 54, Margin = new Padding(0, 0, 0, 6), BorderStyle = BorderStyle.FixedSingle };
        var label = new Label { AutoSize = false, Location = new Point(6, 6), Width = 220, Height = 42 };
        var stop = new Button { Text = "Stop", Width = 60, Height = 30, Location = new Point(228, 10) };
        stop.Click += async (_, __) => await StopClicked(row, panel, stop);
        panel.Controls.Add(label);
        panel.Controls.Add(stop);
        row.Label = label;
        _running.Add(row);
        _runningPanel.Controls.Add(panel);
        RefreshElapsed();
    }

    private static string BuildLabel(RunningRow row)
    {
        var elapsed = DateTime.UtcNow - row.StartTime;
        if (elapsed < TimeSpan.Zero) elapsed = TimeSpan.Zero;
        var cl = string.IsNullOrEmpty(row.ClientName) ? "(no client)" : row.ClientName;
        return $"{cl}\n{row.TaskName} — {(int)elapsed.TotalHours}h {elapsed.Minutes}m";
    }

    private void RefreshElapsed()
    {
        foreach (var row in _running) if (row.Label is not null) row.Label.Text = BuildLabel(row);
    }

    private async Task StopClicked(RunningRow row, Panel panel, Button stop)
    {
        stop.Enabled = false;
        var ok = await _client.End(row.AgentSessionId);
        if (!ok) { stop.Enabled = true; MessageBox.Show(this, "Couldn't stop the task — check your connection.", "Work Tracker"); return; }
        _running.Remove(row);
        _runningPanel.Controls.Remove(panel);
        panel.Dispose();
    }

    private sealed class RunningRow
    {
        public readonly string AgentSessionId;
        public readonly string? ClientName;
        public readonly string TaskName;
        public readonly DateTime StartTime;
        public Label? Label;
        public RunningRow(string id, string? clientName, string taskName, DateTime start)
        { AgentSessionId = id; ClientName = clientName; TaskName = taskName; StartTime = start; }
    }
}
