import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import portalApi from '../portalApi';
import { usePortalAuth } from '../PortalAuthContext';
import { fmtDur, fmtDateInput, pctColour } from '../portalUtils';
import { isProvider as isProviderRole } from '../PortalAuthContext';
import PortalProviderDashboard from './PortalProviderDashboard';
import { RingStat, hrsShort, RING } from '../components/RingStat';
import TrendChart from '../components/TrendChart';
import AppUsageBars from '../components/AppUsageBars';

function Kpi({ label, value, sub }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-xl font-bold text-gray-800 mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

// Winner = most productive HOURS (not highest %), among people who've tracked
// at least `minTrackedSec` — so a 10-minute perfect score can't beat someone
// who put in a full, mostly-productive day. Simple and explainable on purpose:
// no opaque weighting a manager (or the employee) can't double-check by eye.
function pickTopPerformer(employees, minTrackedSec) {
  const eligible = (employees || []).filter((e) => (e.activeSec || 0) + (e.idleSec || 0) >= minTrackedSec);
  if (eligible.length === 0) return null;
  return [...eligible].sort((a, b) => b.productiveSec - a.productiveSec || b.productivityPct - a.productivityPct)[0];
}

function EmployeeHighlight({ title, winner, onOpen }) {
  return (
    <div className="bg-gradient-to-br from-amber-50 to-white rounded-xl border border-amber-200 p-4">
      <div className="text-xs uppercase tracking-wide text-amber-700 font-semibold mb-2">{title}</div>
      {!winner ? (
        <div className="text-sm text-gray-400">Not enough tracked activity yet.</div>
      ) : (
        <div onClick={() => onOpen(winner.employeeId)} className="cursor-pointer">
          <div className="text-lg font-bold text-gray-800">{winner.displayName}</div>
          <div className="text-sm text-gray-600 mt-0.5">
            {fmtDur(winner.productiveSec)} productive · <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${pctColour(winner.productivityPct)}`}>{winner.productivityPct}%</span>
          </div>
        </div>
      )}
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

// A company's own productivity dashboard. Also used by a provider to view ONE
// company (providerOrgId/providerOrgName props pin the report to that company).
function CompanyDashboard({ providerOrgId, providerOrgName }) {
  const navigate = useNavigate();
  const { user, org } = usePortalAuth();
  const reportOrgId = providerOrgId || org?.id;
  const canFilterDept = !!reportOrgId && (!!providerOrgId || user.role === 'ORG_ADMIN' || user.role === 'MANAGER');

  const [preset, setPreset] = useState('month');
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [fromDate, setFromDate] = useState(fmtDateInput(monthStart));
  const [toDate, setToDate] = useState(fmtDateInput(new Date()));
  const [groupId, setGroupId] = useState('');
  const [groups, setGroups] = useState([]);
  const [trendPeriod, setTrendPeriod] = useState('day');
  const [data, setData] = useState({ total: {}, employees: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!canFilterDept || !reportOrgId) return;
    portalApi.get(`/orgs/organisations/${reportOrgId}/groups`).then((r) => setGroups(r.data || [])).catch(() => {});
  }, [canFilterDept, reportOrgId]);

  const applyPreset = (p) => {
    setPreset(p);
    if (p === 'custom') return;
    const [f, tEnd] = rangeFor(p);
    setFromDate(fmtDateInput(f)); setToDate(fmtDateInput(tEnd));
  };

  const query = () => {
    const q = new URLSearchParams({ fromDate, toDate });
    if (groupId) q.set('groupId', groupId);
    if (providerOrgId) q.set('organisationId', providerOrgId);
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

  // Top apps/sites across everyone in the current scope + filters — capped to
  // the top 10 here (a compact dashboard card, not a deep-dive report).
  const [topApps, setTopApps] = useState([]);
  useEffect(() => {
    portalApi.get(`/monitoring/top-apps?${query()}`)
      .then((r) => setTopApps((r.data?.apps || []).slice(0, 10)))
      .catch(() => setTopApps([]));
    // eslint-disable-next-line
  }, [fromDate, toDate, groupId]);

  // Employee of the Day/Week — always today / this-week-to-date, independent
  // of whatever range the rest of the dashboard is showing, so it stays a
  // fixed, recognisable highlight rather than shifting with the date filter.
  const [dayWinner, setDayWinner] = useState(null);
  const [weekWinner, setWeekWinner] = useState(null);
  useEffect(() => {
    if (!reportOrgId) return;
    const today = fmtDateInput(new Date());
    const mon = new Date(); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
    const weekStart = fmtDateInput(mon);
    const qFor = (f, t) => {
      const p = new URLSearchParams({ fromDate: f, toDate: t });
      if (groupId) p.set('groupId', groupId);
      if (providerOrgId) p.set('organisationId', providerOrgId);
      return p.toString();
    };
    portalApi.get(`/monitoring/summary?${qFor(today, today)}`)
      .then((r) => setDayWinner(pickTopPerformer(r.data?.employees, 60 * 60))) // ≥1h tracked today
      .catch(() => setDayWinner(null));
    portalApi.get(`/monitoring/summary?${qFor(weekStart, today)}`)
      .then((r) => setWeekWinner(pickTopPerformer(r.data?.employees, 5 * 60 * 60))) // ≥5h tracked this week
      .catch(() => setWeekWinner(null));
  }, [reportOrgId, groupId, providerOrgId]);

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
        <h1 className="text-xl font-bold text-gray-800">{providerOrgName ? `${providerOrgName} — productivity` : 'Dashboard'}</h1>
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <EmployeeHighlight title="🏆 Employee of the Day" winner={dayWinner} onOpen={(id) => navigate(`/portal/employees/${id}`)} />
        <EmployeeHighlight title="🏆 Employee of the Week" winner={weekWinner} onOpen={(id) => navigate(`/portal/employees/${id}`)} />
      </div>

      {(() => { const tracked = (t.activeSec || 0) + (t.idleSec || 0); return (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <RingStat color={RING.active} pct={tracked ? t.activeSec / tracked : 0} value={hrsShort(t.activeSec)} label="Active" sub="of tracked time" />
          <RingStat color={RING.productive} pct={tracked ? t.productiveSec / tracked : 0} value={hrsShort(t.productiveSec)} label="Productive" sub="of tracked time" />
          <RingStat color={RING.idle} pct={tracked ? t.idleSec / tracked : 0} value={hrsShort(t.idleSec)} label="Idle" sub="of tracked time" />
          <RingStat color={RING.productivity} pct={(t.productivityPct ?? 0) / 100} value={`${t.productivityPct ?? 0}%`} label="Productivity" sub="productive ÷ tracked" />
        </div>
      ); })()}

      <div className="grid grid-cols-3 gap-3 mb-6">
        <Kpi label="Neutral" value={fmtDur(t.neutralSec)} />
        <Kpi label="Non-productive" value={fmtDur(t.nonProductiveSec)} />
        <Kpi label="Overtime" value={fmtDur(t.overtimeSec)} sub={t.overtimeSec ? `${fmtDur(t.overtimeProductiveSec)} prod · ${t.overtimePct ?? 0}%` : null} />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between flex-wrap gap-2">
          <span className="font-semibold text-gray-700 text-sm">Productivity trend</span>
          <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs">
            {[['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']].map(([p, label]) => (
              <button key={p} onClick={() => setTrendPeriod(p)}
                className={`px-3 py-1 ${trendPeriod === p ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{label}</button>
            ))}
          </div>
        </div>
        {loading ? <div className="p-6 text-gray-400 text-sm">Loading…</div> : <TrendChart days={data.days} period={trendPeriod} />}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-gray-100 font-semibold text-gray-700 text-sm">
          Top apps &amp; sites <span className="font-normal text-gray-400">— {groupId ? 'this department' : 'company-wide'}</span>
        </div>
        <AppUsageBars apps={topApps} />
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

// Providers: a company selector that switches between the all-companies business
// overview and one company's productivity report.
function ProviderDashboardSwitcher() {
  const [orgs, setOrgs] = useState([]);
  const [orgId, setOrgId] = useState('');
  useEffect(() => { portalApi.get('/orgs/organisations').then((r) => setOrgs(r.data || [])).catch(() => {}); }, []);
  const selected = orgs.find((o) => o.id === orgId);
  return (
    <div className="max-w-6xl">
      <div className="flex items-center justify-end mb-3">
        <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
          <option value="">All companies — overview</option>
          {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </div>
      {orgId
        ? <CompanyDashboard key={orgId} providerOrgId={orgId} providerOrgName={selected?.name} />
        : <PortalProviderDashboard />}
    </div>
  );
}

// Providers get the company switcher; everyone else their own company's report.
export default function PortalDashboard() {
  const { user } = usePortalAuth();
  if (isProviderRole(user.role)) return <ProviderDashboardSwitcher />;
  return <CompanyDashboard />;
}
