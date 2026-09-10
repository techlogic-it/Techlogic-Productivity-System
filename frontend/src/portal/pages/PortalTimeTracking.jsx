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

  const loadClients = useCallback(() => {
    portalApi.get('/monitoring/clients').then((r) => setClients(r.data || [])).catch(() => {});
  }, []);
  useEffect(() => {
    loadClients();
    portalApi.get('/monitoring/employees?activeOnly=true').then((r) => setEmployees(r.data || [])).catch(() => {});
  }, [loadClients]);

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
          <div className="flex gap-2 items-center">
            <input placeholder="New client name" value={newClientName} onChange={(e) => setNewClientName(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm flex-1 max-w-xs" />
            <button onClick={addClient} disabled={!newClientName.trim()} className="rounded-lg bg-teal-600 disabled:opacity-50 text-white px-3 py-1.5 text-sm">Add client</button>
            {clientError && <span className="text-red-600 text-xs">{clientError}</span>}
          </div>
          <p className="text-xs text-gray-400 mt-2">Deactivating a client hides it from the widget's picker for new tasks but keeps past tracked time intact.</p>
        </Card>
      )}
    </div>
  );
}
