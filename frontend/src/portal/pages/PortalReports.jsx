import { useState, useEffect, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import portalApi from '../portalApi';
import { usePortalAuth, isProvider as isProviderRole } from '../PortalAuthContext';
import { fmtDateInput } from '../portalUtils';

const fmtDay = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// Date range for a preset.
function rangeFor(preset) {
  const now = new Date();
  if (preset === 'week') {
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // Monday of this week
    return [mon, now];
  }
  if (preset === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1), now];
  if (preset === '7d') { const f = new Date(now); f.setDate(now.getDate() - 6); return [f, now]; }
  return [null, null];
}

const fmtLate = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

export default function PortalReports() {
  const navigate = useNavigate();
  const { user, org } = usePortalAuth();
  const isProvider = isProviderRole(user.role);

  const [companyId, setCompanyId] = useState('');
  const [companies, setCompanies] = useState([]);
  const reportOrgId = isProvider ? companyId : org?.id;
  const canFilterDept = !!reportOrgId && (isProvider || user.role === 'ORG_ADMIN' || user.role === 'MANAGER');

  const [preset, setPreset] = useState('week');
  const [[f0, t0]] = useState(rangeFor('week'));
  const [fromDate, setFromDate] = useState(fmtDateInput(f0));
  const [toDate, setToDate] = useState(fmtDateInput(t0));
  const [groupId, setGroupId] = useState('');
  const [groups, setGroups] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    if (isProvider) portalApi.get('/orgs/organisations').then((r) => setCompanies(r.data || [])).catch(() => {});
  }, [isProvider]);

  // Reset the department filter when the selected company changes.
  useEffect(() => { setGroupId(''); }, [companyId]);

  useEffect(() => {
    if (!canFilterDept || !reportOrgId) { setGroups([]); return; }
    portalApi.get(`/orgs/organisations/${reportOrgId}/groups`).then((r) => setGroups(r.data || [])).catch(() => {});
  }, [canFilterDept, reportOrgId]);

  const applyPreset = (p) => {
    setPreset(p);
    if (p === 'custom') return;
    const [a, b] = rangeFor(p);
    setFromDate(fmtDateInput(a)); setToDate(fmtDateInput(b));
  };

  useEffect(() => {
    setLoading(true); setError('');
    const q = new URLSearchParams({ fromDate, toDate });
    if (groupId) q.set('groupId', groupId);
    if (isProvider && companyId) q.set('organisationId', companyId);
    portalApi.get(`/monitoring/late-report?${q.toString()}`)
      .then((r) => setRows(r.data?.rows || []))
      .catch((e) => setError(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [fromDate, toDate, groupId, companyId]);

  const PRESETS = [['week', 'This week'], ['month', 'This month'], ['7d', 'Last 7 days'], ['custom', 'Custom']];

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-xl font-bold text-gray-800">Late arrivals</h1>
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <div className="flex rounded-lg border border-gray-300 overflow-hidden">
            {PRESETS.map(([p, label]) => (
              <button key={p} onClick={() => applyPreset(p)}
                className={`px-3 py-1.5 ${preset === p ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{label}</button>
            ))}
          </div>
          {isProvider && (
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
              <option value="">All companies</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          {canFilterDept && groups.length > 0 && (
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
              <option value="">All departments</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
        </div>
      </div>

      {preset === 'custom' && (
        <div className="flex items-center gap-2 text-sm mb-4">
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1" />
          <span className="text-gray-400">→</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1" />
        </div>
      )}

      <p className="text-sm text-gray-500 mb-4">“Late” = the first activity of a working day starts after the company's office-start time. Non-working days and days with no activity are ignored.</p>

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-6 text-gray-400 text-sm">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-gray-400 text-sm">No tracked working days in this range.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Employee</th>
                  <th className="text-center font-medium px-3 py-2">Office start</th>
                  <th className="text-center font-medium px-3 py-2">Avg start</th>
                  <th className="text-right font-medium px-3 py-2">Days worked</th>
                  <th className="text-right font-medium px-3 py-2">Late days</th>
                  <th className="text-right font-medium px-3 py-2">On-time</th>
                  <th className="text-right font-medium px-3 py-2">Avg late</th>
                  <th className="text-right font-medium px-3 py-2">Worst</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const open = expandedId === r.employeeId;
                  return (
                  <Fragment key={r.employeeId}>
                  <tr onClick={() => setExpandedId(open ? null : r.employeeId)}
                    className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer">
                    <td className="px-3 py-2 font-medium text-gray-800">
                      <span className="inline-block w-3 text-gray-400">{open ? '▾' : '▸'}</span> {r.displayName}
                    </td>
                    <td className="px-3 py-2 text-center text-gray-500">{r.officeStart}</td>
                    <td className="px-3 py-2 text-center tabular-nums text-gray-700 font-medium">{r.avgStart}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-600">{r.worked}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span className={r.late > 0 ? 'text-red-600 font-semibold' : 'text-gray-400'}>{r.late}</span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${r.onTimePct >= 90 ? 'bg-green-100 text-green-700' : r.onTimePct >= 70 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>{r.onTimePct}%</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-600">{r.late > 0 ? fmtLate(r.avgLateMin) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-500">{r.late > 0 ? fmtLate(r.worstLateMin) : '—'}</td>
                  </tr>
                  {open && (
                    <tr className="bg-gray-50/60">
                      <td colSpan={8} className="px-6 py-3">
                        <div className="text-xs text-gray-500 mb-2">Each working day's start time — click to open that day</div>
                        <div className="flex flex-wrap gap-2">
                          {(r.days || []).map((d) => (
                            <button key={d.date} onClick={() => navigate(`/portal/employees/${r.employeeId}?date=${d.date}`)}
                              className={`rounded-lg border px-2.5 py-1 text-xs ${d.lateBy > 0 ? 'border-red-200 bg-red-50 text-red-700' : 'border-gray-200 bg-white text-gray-700'} hover:bg-gray-100`}>
                              <span className="text-gray-400">{fmtDay(d.date)}</span> <span className="font-semibold">{d.start}</span>
                              {d.lateBy > 0 && <span className="ml-1 text-red-500">+{fmtLate(d.lateBy)}</span>}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
