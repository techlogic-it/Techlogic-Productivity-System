import { useState, useEffect, useCallback, useMemo } from 'react';
import portalApi from '../portalApi';
import { usePortalAuth, isAtLeast } from '../PortalAuthContext';
import { fmtDur, fmtDateInput, fmtTime } from '../portalUtils';

// Date range for a period preset (same approach as PortalDashboard/PortalEmployee).
function rangeFor(preset) {
  const now = new Date();
  if (preset === 'today') return [now, now];
  if (preset === '7days') { const d = new Date(now); d.setDate(now.getDate() - 6); return [d, now]; }
  if (preset === 'week') {
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    return [mon, now];
  }
  if (preset === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1), now];
  return [null, null];
}
const PRESETS = [['today', 'Today'], ['7days', '7 days'], ['week', 'This week'], ['month', 'This month'], ['custom', 'Custom']];

const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// First field of a CSV line, quote-aware — a plain split(',')[0] mangles a
// quoted name that itself contains a comma (e.g. "Smith, Jones & Co").
function firstCsvField(line) {
  if (line[0] === '"') {
    let out = '';
    for (let i = 1; i < line.length; i++) {
      if (line[i] === '"') {
        if (line[i + 1] === '"') { out += '"'; i++; continue; }
        break; // closing quote
      }
      out += line[i];
    }
    return out.trim();
  }
  const idx = line.indexOf(',');
  return (idx === -1 ? line : line.slice(0, idx)).trim();
}

// Extract names from a CSV file's text: first column of each non-blank line.
// Skips a header row if it looks like one (e.g. "Name" / "Client" / "Company")
// rather than an actual client name.
const HEADER_WORDS = new Set(['name', 'client', 'client name', 'company', 'company name', 'customer', 'customer name', 'task', 'task name']);
function namesFromCsv(text) {
  const lines = text.split(/\r\n|\n|\r/).map((l) => l.trim()).filter(Boolean);
  const names = lines.map(firstCsvField).filter(Boolean);
  if (names.length && HEADER_WORDS.has(names[0].toLowerCase())) names.shift();
  return names;
}

function Card({ title, subtitle, children }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 mb-5">
      <div className="font-semibold text-gray-700 text-sm">{title}</div>
      {subtitle && <div className="text-xs text-gray-500 mb-3 mt-0.5">{subtitle}</div>}
      <div className={subtitle ? '' : 'mt-3'}>{children}</div>
    </div>
  );
}

export default function PortalTimeTracking() {
  const { user } = usePortalAuth();
  const canManageClients = isAtLeast(user?.role, 'ORG_ADMIN');

  const [preset, setPreset] = useState('week');
  const [fromDate, setFromDate] = useState(fmtDateInput(rangeFor('week')[0]));
  const [toDate, setToDate] = useState(fmtDateInput(rangeFor('week')[1]));
  const [clientId, setClientId] = useState('');
  const [employeeId, setEmployeeId] = useState('');

  const [clients, setClients] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const applyPreset = (p) => {
    setPreset(p);
    if (p === 'custom') return;
    const [f, t] = rangeFor(p);
    setFromDate(fmtDateInput(f)); setToDate(fmtDateInput(t));
  };

  const [tasks, setTasks] = useState([]);
  const loadClients = useCallback(() => {
    portalApi.get('/monitoring/clients').then((r) => setClients(r.data || [])).catch(() => {});
  }, []);
  const loadTasks = useCallback(() => {
    portalApi.get('/monitoring/tasks').then((r) => setTasks(r.data || [])).catch(() => {});
  }, []);
  useEffect(() => {
    loadClients(); loadTasks();
    portalApi.get('/monitoring/employees?activeOnly=true').then((r) => setEmployees(r.data || [])).catch(() => {});
  }, [loadClients, loadTasks]);

  useEffect(() => {
    setLoading(true); setError('');
    const q = new URLSearchParams({ fromDate, toDate });
    if (clientId) q.set('clientId', clientId);
    if (employeeId) q.set('employeeId', employeeId);
    portalApi.get(`/monitoring/work-sessions?${q}`)
      .then((r) => setSessions(r.data || []))
      .catch((e) => setError(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [fromDate, toDate, clientId, employeeId]);

  // Summary: total time per client over the selected range.
  const byClient = useMemo(() => {
    const map = new Map();
    let totalSec = 0;
    for (const s of sessions) {
      const key = s.clientId || '__none';
      const row = map.get(key) || { clientId: s.clientId, name: s.clientName || 'No client', sec: 0, entries: 0 };
      row.sec += s.durationSec; row.entries += 1;
      map.set(key, row);
      totalSec += s.durationSec;
    }
    return { rows: [...map.values()].sort((a, b) => b.sec - a.sec), totalSec };
  }, [sessions]);

  // ── Manage clients ──
  const [newClientName, setNewClientName] = useState('');
  const [clientError, setClientError] = useState('');
  const addClient = async () => {
    if (!newClientName.trim()) return;
    setClientError('');
    try {
      await portalApi.post('/monitoring/clients', { name: newClientName.trim() });
      setNewClientName(''); loadClients();
    } catch (e) { setClientError(e.response?.data?.error || 'Could not add client'); }
  };
  const toggleClientActive = async (c) => {
    await portalApi.patch(`/monitoring/clients/${c.id}`, { isActive: !c.isActive });
    loadClients();
  };
  const renameClient = async (c) => {
    const name = window.prompt('Client name', c.name);
    if (!name || !name.trim() || name.trim() === c.name) return;
    try { await portalApi.patch(`/monitoring/clients/${c.id}`, { name: name.trim() }); loadClients(); }
    catch (e) { alert(e.response?.data?.error || 'Could not rename client'); }
  };

  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState('');
  const importClientsCsv = async (file) => {
    if (!file) return;
    setImportBusy(true); setImportResult(''); setClientError('');
    try {
      const text = await file.text();
      const names = namesFromCsv(text);
      if (names.length === 0) { setClientError('No client names found in that file.'); return; }
      const { data } = await portalApi.post('/monitoring/clients/import', { names });
      const bits = [];
      if (data.created) bits.push(`${data.created} added`);
      if (data.reactivated) bits.push(`${data.reactivated} reactivated`);
      if (data.alreadyActive) bits.push(`${data.alreadyActive} already there`);
      setImportResult(`${data.total} row${data.total === 1 ? '' : 's'}: ${bits.join(', ') || 'nothing new'}.`);
      loadClients();
    } catch (e) {
      setClientError(e.response?.data?.error || 'Could not import that file.');
    } finally {
      setImportBusy(false);
    }
  };

  // ── Manage tasks ──
  const [newTaskName, setNewTaskName] = useState('');
  const [taskError, setTaskError] = useState('');
  const addTask = async () => {
    if (!newTaskName.trim()) return;
    setTaskError('');
    try {
      await portalApi.post('/monitoring/tasks', { name: newTaskName.trim() });
      setNewTaskName(''); loadTasks();
    } catch (e) { setTaskError(e.response?.data?.error || 'Could not add task'); }
  };
  const toggleTaskActive = async (t) => {
    await portalApi.patch(`/monitoring/tasks/${t.id}`, { isActive: !t.isActive });
    loadTasks();
  };
  const renameTask = async (t) => {
    const name = window.prompt('Task name', t.name);
    if (!name || !name.trim() || name.trim() === t.name) return;
    try { await portalApi.patch(`/monitoring/tasks/${t.id}`, { name: name.trim() }); loadTasks(); }
    catch (e) { alert(e.response?.data?.error || 'Could not rename task'); }
  };

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <h1 className="text-xl font-bold text-gray-800">Time Tracking</h1>
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <div className="flex rounded-lg border border-gray-300 overflow-hidden">
            {PRESETS.map(([p, label]) => (
              <button key={p} onClick={() => applyPreset(p)}
                className={`px-3 py-1.5 ${preset === p ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{label}</button>
            ))}
          </div>
          {preset === 'custom' && (
            <>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1" />
              <span className="text-gray-400">→</span>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1" />
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 text-sm flex-wrap mb-5">
        <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{!c.isActive ? ' (inactive)' : ''}</option>)}
        </select>
        <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
          <option value="">Everyone</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.displayName || e.localAccountKey || 'Unnamed'}</option>)}
        </select>
      </div>

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}

      <Card title="Time by client" subtitle={`${fromDate} to ${toDate} — ${fmtDur(byClient.totalSec)} tracked across ${sessions.length} task${sessions.length === 1 ? '' : 's'}.`}>
        {loading ? (
          <div className="text-gray-400 text-sm">Loading…</div>
        ) : byClient.rows.length === 0 ? (
          <div className="text-gray-400 text-sm">No tracked tasks in this range.</div>
        ) : (
          <div className="space-y-2.5">
            {byClient.rows.map((r) => (
              <div key={r.clientId || '__none'}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="font-medium text-gray-800">{r.name}</span>
                  <span className="text-xs text-gray-500 tabular-nums">{fmtDur(r.sec)} · {r.entries} task{r.entries === 1 ? '' : 's'}</span>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-teal-500" style={{ width: `${byClient.totalSec ? Math.max(2, Math.round((r.sec / byClient.totalSec) * 100)) : 0}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-5">
        <div className="px-4 py-3 border-b border-gray-100 font-semibold text-gray-700 text-sm">Tasks</div>
        {loading ? (
          <div className="p-6 text-gray-400 text-sm">Loading…</div>
        ) : sessions.length === 0 ? (
          <div className="p-6 text-gray-400 text-sm">No tracked tasks in this range.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Date</th>
                  <th className="text-left font-medium px-4 py-2">Employee</th>
                  <th className="text-left font-medium px-4 py-2">Client</th>
                  <th className="text-left font-medium px-4 py-2">Task</th>
                  <th className="text-left font-medium px-4 py-2">Notes</th>
                  <th className="text-right font-medium px-4 py-2">Duration</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} className="border-t border-gray-50">
                    <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{fmtDate(s.startTime)} {fmtTime(s.startTime)}</td>
                    <td className="px-4 py-2 text-gray-700">{s.employeeName}</td>
                    <td className="px-4 py-2 text-gray-700">{s.clientName || <span className="text-gray-300">—</span>}</td>
                    <td className="px-4 py-2 text-gray-800 font-medium">{s.taskName}</td>
                    <td className="px-4 py-2 text-gray-400 truncate max-w-[200px]">{s.notes || ''}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {s.running ? <span className="text-teal-600">{fmtDur(s.durationSec)} · running</span> : fmtDur(s.durationSec)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canManageClients && (
        <Card title="Clients" subtitle="Managed here for the desktop work-tracker widget's client picker.">
          <div className="flex flex-wrap gap-2 mb-3">
            {clients.map((c) => (
              <span key={c.id} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${c.isActive ? 'border-gray-200 bg-white' : 'border-gray-200 bg-gray-50 opacity-60'}`}>
                <span className="font-medium text-gray-700">{c.name}</span>
                {!c.isActive && <span className="text-gray-400">inactive</span>}
                <button onClick={() => renameClient(c)} className="text-gray-400 hover:text-teal-600" title="Rename">✎</button>
                <button onClick={() => toggleClientActive(c)} className="text-gray-400 hover:text-red-600" title={c.isActive ? 'Deactivate' : 'Reactivate'}>
                  {c.isActive ? '✕' : '↺'}
                </button>
              </span>
            ))}
            {clients.length === 0 && <span className="text-sm text-gray-400">No clients yet.</span>}
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <input placeholder="New client name" value={newClientName} onChange={(e) => setNewClientName(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm flex-1 max-w-xs" />
            <button onClick={addClient} disabled={!newClientName.trim()} className="rounded-lg bg-teal-600 disabled:opacity-50 text-white px-3 py-1.5 text-sm">Add client</button>
            <span className="text-gray-300">|</span>
            <label className={`rounded-lg border border-gray-300 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 ${importBusy ? 'opacity-50 pointer-events-none' : ''}`}>
              {importBusy ? 'Importing…' : 'Import CSV'}
              <input type="file" accept=".csv,text/csv" className="hidden"
                onChange={(e) => { importClientsCsv(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {clientError && <span className="text-red-600 text-xs">{clientError}</span>}
            {importResult && !clientError && <span className="text-teal-700 text-xs">{importResult}</span>}
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Deactivating a client hides it from the widget's picker for new tasks but keeps past tracked time intact.
            CSV import reads the first column of each row as the client name (a header row like "Name" is skipped automatically).
          </p>
        </Card>
      )}

      {canManageClients && (
        <Card title="Tasks" subtitle="Predefined task names offered as suggestions in the widget — staff can still type a custom one.">
          <div className="flex flex-wrap gap-2 mb-3">
            {tasks.map((t) => (
              <span key={t.id} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${t.isActive ? 'border-gray-200 bg-white' : 'border-gray-200 bg-gray-50 opacity-60'}`}>
                <span className="font-medium text-gray-700">{t.name}</span>
                {!t.isActive && <span className="text-gray-400">inactive</span>}
                <button onClick={() => renameTask(t)} className="text-gray-400 hover:text-teal-600" title="Rename">✎</button>
                <button onClick={() => toggleTaskActive(t)} className="text-gray-400 hover:text-red-600" title={t.isActive ? 'Deactivate' : 'Reactivate'}>
                  {t.isActive ? '✕' : '↺'}
                </button>
              </span>
            ))}
            {tasks.length === 0 && <span className="text-sm text-gray-400">No predefined tasks yet.</span>}
          </div>
          <div className="flex gap-2 items-center">
            <input placeholder="New task name" value={newTaskName} onChange={(e) => setNewTaskName(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm flex-1 max-w-xs" />
            <button onClick={addTask} disabled={!newTaskName.trim()} className="rounded-lg bg-teal-600 disabled:opacity-50 text-white px-3 py-1.5 text-sm">Add task</button>
            {taskError && <span className="text-red-600 text-xs">{taskError}</span>}
          </div>
        </Card>
      )}
    </div>
  );
}
