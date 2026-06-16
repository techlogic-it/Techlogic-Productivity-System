import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import portalApi from '../portalApi';
import { usePortalAuth } from '../PortalAuthContext';
import { fmtDur, fmtDateInput, pctColour } from '../portalUtils';

function Kpi({ label, value, sub }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-xl font-bold text-gray-800 mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

// Date range for a preset.
function rangeFor(preset) {
  const now = new Date();
  if (preset === 'today') return [now, now];
  if (preset === 'week') {
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // Monday of this week
    return [mon, now];
  }
  if (preset === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1), now];
  return [null, null];
}

export default function PortalDashboard() {
  const navigate = useNavigate();
  const { user, org } = usePortalAuth();
  const canFilterDept = org?.id && (user.role === 'ORG_ADMIN' || user.role === 'MANAGER');

  const [preset, setPreset] = useState('month');
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [fromDate, setFromDate] = useState(fmtDateInput(monthStart));
  const [toDate, setToDate] = useState(fmtDateInput(new Date()));
  const [groupId, setGroupId] = useState('');
  const [groups, setGroups] = useState([]);
  const [data, setData] = useState({ total: {}, employees: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!canFilterDept) return;
    portalApi.get(`/orgs/organisations/${org.id}/groups`).then((r) => setGroups(r.data || [])).catch(() => {});
  }, [canFilterDept, org]);

  const applyPreset = (p) => {
    setPreset(p);
    if (p === 'custom') return;
    const [f, tEnd] = rangeFor(p);
    setFromDate(fmtDateInput(f)); setToDate(fmtDateInput(tEnd));
  };

  const query = () => {
    const q = new URLSearchParams({ fromDate, toDate });
    if (groupId) q.set('groupId', groupId);
    return q.toString();
  };

  useEffect(() => {
    setLoading(true); setError('');
    portalApi.get(`/monitoring/summary?${query()}`)
      .then((r) => setData(r.data || { total: {}, employees: [] }))
      .catch((e) => setError(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line
  }, [fromDate, toDate, groupId]);

  const t = data.total || {};

  const exportCsv = async () => {
    const r = await portalApi.get(`/monitoring/export?${query()}`, { responseType: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(r.data);
    a.download = `productivity-${fromDate}_to_${toDate}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const PRESETS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['custom', 'Custom']];
  const Col = ({ children, klass = 'text-gray-600' }) => <td className={`px-3 py-2 text-right ${klass}`}>{children}</td>;

  return (
    <div className="max-w-6xl">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-xl font-bold text-gray-800">Dashboard</h1>
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <div className="flex rounded-lg border border-gray-300 overflow-hidden">
            {PRESETS.map(([p, label]) => (
              <button key={p} onClick={() => applyPreset(p)}
                className={`px-3 py-1.5 ${preset === p ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{label}</button>
            ))}
          </div>
          {canFilterDept && groups.length > 0 && (
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
              <option value="">All departments</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          <button onClick={exportCsv} className="rounded-lg bg-gray-800 hover:bg-gray-700 text-white px-3 py-1.5">Export CSV</button>
        </div>
      </div>

      {preset === 'custom' && (
        <div className="flex items-center gap-2 text-sm mb-4">
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1" />
          <span className="text-gray-400">→</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1" />
        </div>
      )}

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
        <Kpi label="Active" value={fmtDur(t.activeSec)} sub="office hours" />
        <Kpi label="Productive" value={fmtDur(t.productiveSec)} />
        <Kpi label="Neutral" value={fmtDur(t.neutralSec)} />
        <Kpi label="Non-productive" value={fmtDur(t.nonProductiveSec)} />
        <Kpi label="Idle" value={fmtDur(t.idleSec)} />
        <Kpi label="Overtime" value={fmtDur(t.overtimeSec)} sub={t.overtimeSec ? `${fmtDur(t.overtimeProductiveSec)} prod · ${t.overtimePct ?? 0}%` : null} />
        <Kpi label="Productivity" value={`${t.productivityPct ?? 0}%`} sub="productive ÷ active" />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 font-semibold text-gray-700 text-sm">People</div>
        {loading ? (
          <div className="p-6 text-gray-400 text-sm">Loading…</div>
        ) : data.employees.length === 0 ? (
          <div className="p-6 text-gray-400 text-sm">No activity in this range.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Employee</th>
                  <th className="text-right font-medium px-3 py-2">Active</th>
                  <th className="text-right font-medium px-3 py-2">Productive</th>
                  <th className="text-right font-medium px-3 py-2">Neutral</th>
                  <th className="text-right font-medium px-3 py-2">Non-prod</th>
                  <th className="text-right font-medium px-3 py-2">Idle</th>
                  <th className="text-right font-medium px-3 py-2">Overtime</th>
                  <th className="text-right font-medium px-3 py-2">Productivity</th>
                </tr>
              </thead>
              <tbody>
                {data.employees.map((e) => (
                  <tr key={e.employeeId} onClick={() => navigate(`/portal/employees/${e.employeeId}`)}
                    className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer">
                    <td className="px-3 py-2 font-medium text-gray-800">{e.displayName}</td>
                    <Col>{fmtDur(e.activeSec)}</Col>
                    <Col klass="text-green-700">{fmtDur(e.productiveSec)}</Col>
                    <Col>{fmtDur(e.neutralSec)}</Col>
                    <Col klass="text-red-600">{fmtDur(e.nonProductiveSec)}</Col>
                    <Col klass="text-gray-400">{fmtDur(e.idleSec)}</Col>
                    <Col>{fmtDur(e.overtimeSec)}{e.overtimeSec > 0 && <div className="text-xs text-gray-400">{e.overtimePct ?? 0}% prod</div>}</Col>
                    <td className="px-3 py-2 text-right">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${pctColour(e.productivityPct)}`}>{e.productivityPct}%</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
