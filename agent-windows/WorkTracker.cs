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

    public async Task<List<string>> GetTasks()
    {
        try
        {
            using var res = await Http.SendAsync(Req(HttpMethod.Get, "/api/monitoring/tasks"));
            if (!res.IsSuccessStatusCode) return new List<string>();
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
            var list = new List<string>();
            foreach (var el in doc.RootElement.EnumerateArray())
            {
                var name = el.GetProperty("name").GetString();
                if (!string.IsNullOrEmpty(name)) list.Add(name);
            }
            return list;
        }
        catch { return new List<string>(); }
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
    private const int FormWidth = 400;
    private const int ContentWidth = FormWidth - 40; // form width minus left+right padding (20 each)

    private static readonly Color HeaderBg = Color.FromArgb(245, 246, 247);
    private static readonly Color BorderGray = Color.FromArgb(224, 224, 224);
    private static readonly Color AccentGreen = Color.FromArgb(34, 139, 82);
    private static readonly Color ElapsedGreen = Color.FromArgb(30, 130, 76);
    private static readonly Color LabelGray = Color.FromArgb(110, 110, 110);

    private readonly WorkClient _client;
    private readonly Identity _id;
    // DropDown (not DropDownList) + AutoComplete on both fields: type to filter,
    // or pick from the dropdown. Client still resolves to a real Client row (or
    // an error if the typed text matches nothing) — Task stays free text either
    // way, the list is only ever a suggestion there.
    private readonly ComboBox _clientBox = new() { DropDownStyle = ComboBoxStyle.DropDown, Width = ContentWidth, Font = new Font("Segoe UI", 9.5f), AutoCompleteMode = AutoCompleteMode.SuggestAppend, AutoCompleteSource = AutoCompleteSource.ListItems };
    private readonly ComboBox _taskBox = new() { DropDownStyle = ComboBoxStyle.DropDown, Width = ContentWidth, Font = new Font("Segoe UI", 9.5f), AutoCompleteMode = AutoCompleteMode.SuggestAppend, AutoCompleteSource = AutoCompleteSource.ListItems };
    private readonly TextBox _notesBox = new() { PlaceholderText = "Notes (optional)", Width = ContentWidth, Font = new Font("Segoe UI", 9.5f) };
    private readonly Button _startButton = new() { Text = "▶   Start task", Width = ContentWidth, Height = 36, Font = new Font("Segoe UI", 10f, FontStyle.Bold), BackColor = AccentGreen, ForeColor = Color.White, FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand };
    private readonly Label _youLabel = new() { AutoSize = true, Font = new Font("Segoe UI", 9f), ForeColor = Color.FromArgb(60, 60, 60) };
    private readonly Label _statusLabel = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(12, 0, 12, 0), Font = new Font("Segoe UI", 8.5f), ForeColor = LabelGray };
    private readonly FlowLayoutPanel _runningPanel = new() { FlowDirection = FlowDirection.TopDown, AutoScroll = true, Dock = DockStyle.Fill, WrapContents = false, Padding = new Padding(20, 4, 20, 16), BackColor = Color.White };
    private readonly Panel _headerPanel = new() { Dock = DockStyle.Top, Height = 40, BackColor = HeaderBg, Padding = new Padding(20, 0, 20, 0) };
    private readonly TableLayoutPanel _topPanel = new() { Dock = DockStyle.Top, ColumnCount = 1, AutoSize = true, Padding = new Padding(20, 16, 20, 14) };
    private readonly Panel _statusBar = new() { Dock = DockStyle.Bottom, Height = 28, BackColor = HeaderBg };
    private readonly System.Windows.Forms.Timer _tickTimer = new() { Interval = 1000 };
    private readonly List<RunningRow> _running = new();
    private List<ClientDto> _clients = new();

    public WorkTrackerForm(Config cfg, AgentState state, Identity id)
    {
        _client = new WorkClient(cfg, state);
        _id = id;
        _youLabel.Text = $"You: {id.DisplayName}";

        Text = "Work Tracker";
        Font = new Font("Segoe UI", 9f);
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        ShowInTaskbar = false;
        Width = FormWidth;
        BackColor = Color.White;

        BuildLayout();
        Height = 540; // placeholder until Load recomputes it from actual rendered content

        _startButton.FlatAppearance.BorderSize = 0;
        _startButton.FlatAppearance.MouseOverBackColor = Color.FromArgb(28, 120, 70);
        _tickTimer.Tick += (_, __) => RefreshElapsed();
        _tickTimer.Start();
        // Fires after the control hierarchy is fully laid out but before the
        // window is actually painted, so resizing here is invisible to the user.
        Load += (_, __) => SizeToContent();
        Load += async (_, __) => await Initialise();
        // Keep every running row exactly as wide as the panel's visible area,
        // whether or not the vertical scrollbar is currently showing — a fixed
        // pixel width here is what caused rows (and their Stop button) to spill
        // outside the window, forcing an ugly horizontal scrollbar.
        _runningPanel.Resize += (_, __) => ResizeRunningRows();
        // Never actually let the user close the widget — it's meant to stay
        // running alongside the background tracker. Minimise instead.
        FormClosing += (_, e) => { if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); } };
    }

    // Sizes the window from what the header/fields/status bar actually render
    // at, rather than a guessed constant — at higher display scaling these
    // controls render noticeably taller than their 96-DPI pixel sizes suggest,
    // and a fixed window height left the running-tasks list squeezed to almost
    // nothing. MinRunningPanelHeight guarantees it always gets a usable amount
    // of room regardless of how tall the fields end up on a given display.
    private void SizeToContent()
    {
        const int MinRunningPanelHeight = 220;
        var chromeHeight = Height - ClientSize.Height; // title bar + window borders
        Height = chromeHeight + _headerPanel.Height + _topPanel.PreferredSize.Height + _statusBar.Height + MinRunningPanelHeight;

        var wa = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 720);
        Location = new Point(wa.Right - Width - 12, wa.Bottom - Height - 12);
    }

    private void BuildLayout()
    {
        _headerPanel.Controls.Add(_youLabel);
        _youLabel.Anchor = AnchorStyles.Left;
        _youLabel.Location = new Point(0, (_headerPanel.Height - _youLabel.Height) / 2);
        _headerPanel.Paint += (_, e) => e.Graphics.DrawLine(new Pen(BorderGray), 0, _headerPanel.Height - 1, _headerPanel.Width, _headerPanel.Height - 1);

        _topPanel.Controls.Add(FieldLabel("CUSTOMER — type to search"));
        _topPanel.Controls.Add(_clientBox);
        _topPanel.Controls.Add(new Panel { Height = 12 });
        _topPanel.Controls.Add(FieldLabel("TASK — pick one or type your own"));
        _topPanel.Controls.Add(_taskBox);
        _topPanel.Controls.Add(new Panel { Height = 12 });
        _topPanel.Controls.Add(_notesBox);
        _topPanel.Controls.Add(new Panel { Height = 16 });
        _topPanel.Controls.Add(_startButton);
        _topPanel.Controls.Add(new Label { Text = "RUNNING", Font = new Font("Segoe UI", 8.5f, FontStyle.Bold), ForeColor = LabelGray, AutoSize = true, Margin = new Padding(2, 20, 0, 6) });
        _startButton.Click += async (_, __) => await StartClicked();

        _statusBar.Controls.Add(_statusLabel);
        _statusBar.Paint += (_, e) => e.Graphics.DrawLine(new Pen(BorderGray), 0, 0, _statusBar.Width, 0);

        Controls.Add(_runningPanel);
        Controls.Add(_topPanel);
        Controls.Add(_headerPanel);
        Controls.Add(_statusBar);
    }

    private static Label FieldLabel(string text) => new()
    { Text = text, AutoSize = true, ForeColor = Color.FromArgb(140, 140, 140), Font = new Font("Segoe UI", 7.5f), Margin = new Padding(2, 0, 0, 3) };

    private void SetStatus(string text, bool isError = false)
    {
        _statusLabel.Text = text;
        _statusLabel.ForeColor = isError ? Color.FromArgb(178, 40, 40) : LabelGray;
    }

    private void ResizeRunningRows()
    {
        var w = Math.Max(220, _runningPanel.ClientSize.Width - _runningPanel.Padding.Horizontal);
        foreach (Control c in _runningPanel.Controls) c.Width = w;
    }

    private async Task Initialise()
    {
        _clients = await _client.GetClients();
        _clientBox.Items.Clear();
        foreach (var c in _clients) _clientBox.Items.Add(c.Name);

        _taskBox.Items.Clear();
        foreach (var t in await _client.GetTasks()) _taskBox.Items.Add(t);

        var open = await _client.GetOpenSessions(_id.LocalAccountKey);
        foreach (var s in open) AddRunningRow(s.AgentSessionId, s.ClientName, s.TaskName, s.StartTime);
        SetStatus(open.Count > 0 ? $"Restored {open.Count} running task{(open.Count == 1 ? "" : "s")}." : "Ready.");
    }

    private async Task StartClicked()
    {
        var task = _taskBox.Text.Trim();
        if (task.Length == 0) { SetStatus("Enter a task name first.", isError: true); return; }

        var typedClient = _clientBox.Text.Trim();
        string? clientId = null; string? clientName = null;
        if (typedClient.Length > 0)
        {
            var match = _clients.FirstOrDefault(c => c.Name.Equals(typedClient, StringComparison.OrdinalIgnoreCase));
            if (match is null) { SetStatus($"\"{typedClient}\" isn't a known customer — pick one from the list, or clear the field.", isError: true); return; }
            clientId = match.Id; clientName = match.Name;
        }
        var notes = _notesBox.Text.Trim();
        var sessionId = Guid.NewGuid().ToString();

        _startButton.Enabled = false;
        SetStatus("Starting…");
        var ok = await _client.Start(_id.LocalAccountKey, _id.DisplayName, clientId, task, notes.Length > 0 ? notes : null, sessionId);
        _startButton.Enabled = true;
        if (!ok) { SetStatus("Couldn't start the task — check your connection.", isError: true); return; }

        AddRunningRow(sessionId, clientName, task, DateTime.UtcNow);
        SetStatus($"Started: {(clientName ?? "no customer")} — {task}");
        _taskBox.Text = ""; _notesBox.Clear(); _clientBox.Text = "";
    }

    private void AddRunningRow(string sessionId, string? clientName, string taskName, DateTime startTime)
    {
        var row = new RunningRow(sessionId, clientName, taskName, startTime);
        var initialWidth = Math.Max(220, _runningPanel.ClientSize.Width - _runningPanel.Padding.Horizontal);
        var panel = new Panel { Width = initialWidth, Height = 60, Margin = new Padding(0, 0, 0, 8), BorderStyle = BorderStyle.FixedSingle, Padding = new Padding(12, 8, 12, 8), BackColor = Color.White };
        // Anchored (not fixed position): the text stretches to fill whatever
        // space is left of the Stop button, and Stop stays pinned to the right
        // edge, so this keeps looking right as the row is resized.
        var stop = new Button { Text = "Stop", Width = 64, Height = 30, Font = new Font("Segoe UI", 8.5f), Anchor = AnchorStyles.Top | AnchorStyles.Right, FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand };
        stop.FlatAppearance.BorderColor = BorderGray;
        stop.Location = new Point(panel.ClientSize.Width - panel.Padding.Right - stop.Width, (panel.ClientSize.Height - stop.Height) / 2);
        var titleLabel = new Label
        {
            AutoSize = false,
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
            ForeColor = Color.FromArgb(30, 30, 30),
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            Location = new Point(0, 0),
            Size = new Size(stop.Location.X - 10, 20),
        };
        var elapsedLabel = new Label
        {
            AutoSize = false,
            Font = new Font("Segoe UI", 8.5f),
            ForeColor = ElapsedGreen,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            Location = new Point(0, 21),
            Size = new Size(stop.Location.X - 10, 18),
        };
        stop.Click += async (_, __) => await StopClicked(row, panel, stop);
        panel.Controls.Add(titleLabel);
        panel.Controls.Add(elapsedLabel);
        panel.Controls.Add(stop);
        row.TitleLabel = titleLabel; row.ElapsedLabel = elapsedLabel;
        _running.Add(row);
        _runningPanel.Controls.Add(panel);
        RefreshElapsed();
    }

    private static void ApplyLabels(RunningRow row)
    {
        var elapsed = DateTime.UtcNow - row.StartTime;
        if (elapsed < TimeSpan.Zero) elapsed = TimeSpan.Zero;
        var cl = string.IsNullOrEmpty(row.ClientName) ? "No customer" : row.ClientName;
        if (row.TitleLabel is not null) row.TitleLabel.Text = $"{cl} — {row.TaskName}";
        if (row.ElapsedLabel is not null) row.ElapsedLabel.Text = $"{(int)elapsed.TotalHours}h {elapsed.Minutes}m {elapsed.Seconds}s";
    }

    private void RefreshElapsed()
    {
        foreach (var row in _running) ApplyLabels(row);
    }

    private async Task StopClicked(RunningRow row, Panel panel, Button stop)
    {
        stop.Enabled = false;
        var ok = await _client.End(row.AgentSessionId);
        if (!ok) { stop.Enabled = true; SetStatus("Couldn't stop the task — check your connection.", isError: true); return; }
        _running.Remove(row);
        _runningPanel.Controls.Remove(panel);
        panel.Dispose();
        SetStatus($"Stopped: {row.TaskName}");
    }

    private sealed class RunningRow
    {
        public readonly string AgentSessionId;
        public readonly string? ClientName;
        public readonly string TaskName;
        public readonly DateTime StartTime;
        public Label? TitleLabel;
        public Label? ElapsedLabel;
        public RunningRow(string id, string? clientName, string taskName, DateTime start)
        { AgentSessionId = id; ClientName = clientName; TaskName = taskName; StartTime = start; }
    }
}
