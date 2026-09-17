import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import portalApi from '../portalApi';
import { usePortalAuth, isProvider as isProviderRole } from '../PortalAuthContext';
import { fmtDur, fmtDateInput, pctColour } from '../portalUtils';
import { RingStat, hrsShort, RING } from '../components/RingStat';
import TrendChart from '../components/TrendChart';
import AppUsageBars from '../components/AppUsageBars';

function rangeFor(preset) {
  const now = new Date();
  if (preset === 'week') {
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // Monday of this week
    return [mon, now];
  }
  if (preset === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1), now];
  if (preset === '30d') { const f = new Date(now); f.setDate(now.getDate() - 29); return [f, now]; }
  return [null, null];
}
const PRESETS = [['week', 'This week'], ['month', 'This month'], ['30d', 'Last 30 days'], ['custom', 'Custom']];

function Card({ title, subtitle, children, className = '' }) {
  return (
    <section className={`bg-white rounded-xl border border-gray-200 overflow-hidden mb-6 print:break-inside-avoid ${className}`}>
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="font-semibold text-gray-700 text-sm">{title}</div>
        {subtitle && <div className="text-xs text-gray-400">{subtitle}</div>}
      </div>
      {children}
    </section>
  );
}

export default function PortalExecutive() {
  const navigate = useNavigate();
  const { user, org } = usePortalAuth();
  const isProvider = isProviderRole(user.role);

  const [companyId, setCompanyId] = useState('');
  const [companies, setCompanies] = useState([]);
  const reportOrgId = isProvider ? companyId : org?.id;

  const [preset, setPreset] = useState('month');
  const [[f0, t0]] = useState(rangeFor('month'));
  const [fromDate, setFromDate] = useState(fmtDateInput(f0));
  const [toDate, setToDate] = useState(fmtDateInput(t0));

  const [summary, setSummary] = useState({ total: {}, employees: [], days: [] });
  const [lateRows, setLateRows] = useState([]);
  const [topApps, setTopApps] = useState([]);
  const [employees, setEmployees] = useState([]); // for department names
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isProvider) portalApi.get('/orgs/organisations').then((r) => setCompanies(r.data || [])).catch(() => {});
  }, [isProvider]);

  const applyPreset = (p) => {
    setPreset(p);
    if (p === 'custom') return;
    const [a, b] = rangeFor(p);
    setFromDate(fmtDateInput(a)); setToDate(fmtDateInput(b));
  };

  useEffect(() => {
    if (!reportOrgId) return;
    const q = new URLSearchParams({ fromDate, toDate, organisationId: reportOrgId });
    setLoading(true);
    Promise.all([
      portalApi.get(`/monitoring/summary?${q.toString()}`).then((r) => r.data),
      portalApi.get(`/monitoring/late-report?${q.toString()}`).then((r) => r.data),
      portalApi.get(`/monitoring/top-apps?${q.toString()}`).then((r) => r.data),
      portalApi.get('/monitoring/employees?activeOnly=true').then((r) => r.data),
    ]).then(([s, l, a, e]) => {
      setSummary(s || { total: {}, employees: [], days: [] });
      setLateRows(l?.rows || []);
      setTopApps((a?.apps || []).slice(0, 8));
      setEmployees(isProvider ? (e || []).filter((emp) => emp.organisationId === reportOrgId) : (e || []));
    }).finally(() => setLoading(false));
  }, [reportOrgId, fromDate, toDate, isProvider]);

  const t = summary.total || {};
  const tracked = (t.activeSec || 0) + (t.idleSec || 0);

  const performers = useMemo(() => {
    const ranked = [...(summary.employees || [])].filter((e) => (e.activeSec || 0) + (e.idleSec || 0) > 0).sort((a, b) => b.productivityPct - a.productivityPct);
    return { top: ranked.slice(0, 5), bottom: ranked.slice(-5).reverse().filter((e) => !ranked.slice(0, 5).includes(e)) };
  }, [summary.employees]);

  const byDept = useMemo(() => {
    const groupName = new Map(employees.map((e) => [e.id, e.group?.name || 'No department']));
    const map = new Map();
    for (const e of summary.employees || []) {
      const dept = groupName.get(e.employeeId) || 'No department';
      const row = map.get(dept) || { dept, activeSec: 0, idleSec: 0, productiveSec: 0, count: 0 };
      row.activeSec += e.activeSec || 0; row.idleSec += e.idleSec || 0; row.productiveSec += e.productiveSec || 0; row.count += 1;
      map.set(dept, row);
    }
    return [...map.values()]
      .map((r) => ({ ...r, pct: (r.activeSec + r.idleSec) > 0 ? Math.round((r.productiveSec / (r.activeSec + r.idleSec)) * 100) : 0 }))
      .sort((a, b) => b.pct - a.pct);
  }, [summary.employees, employees]);

  const lateSummary = useMemo(() => {
    const worked = lateRows.reduce((s, r) => s + r.worked, 0);
    const late = lateRows.reduce((s, r) => s + r.late, 0);
    const worst = [...lateRows].sort((a, b) => b.late - a.late || b.avgLateMin - a.avgLateMin).slice(0, 5);
    return { worked, late, onTimePct: worked ? Math.round(((worked - late) / worked) * 100) : 100, worst };
  }, [lateRows]);

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2 print:hidden">
        <h1 className="text-xl font-bold text-gray-800">Executive summary</h1>
        {reportOrgId && (
          <button onClick={() => window.print()} className="rounded-lg bg-teal-600 hover:bg-teal-700 text-white px-3 py-1.5 text-sm">
            Download PDF
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm flex-wrap mb-4 print:hidden">
        {isProvider && (
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
            <option value="">Select a company…</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <div className="flex rounded-lg border border-gray-300 overflow-hidden">
          {PRESETS.map(([p, label]) => (
            <button key={p} onClick={() => applyPreset(p)}
              className={`px-3 py-1.5 ${preset === p ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{label}</button>
          ))}
        </div>
      </div>

      {preset === 'custom' && (
        <div className="flex items-center gap-2 text-sm mb-4 print:hidden">
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1" />
          <span className="text-gray-400">→</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1" />
        </div>
      )}

      {!reportOrgId ? (
        <div className="text-gray-400 text-sm">Pick a company to see its executive summary.</div>
      ) : loading ? (
        <div className="text-gray-400 text-sm">Loading…</div>
      ) : (
        <>
          <div className="mb-1 text-sm text-gray-500">{fromDate} to {toDate}</div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <RingStat color={RING.active} pct={tracked ? t.activeSec / tracked : 0} value={hrsShort(t.activeSec)} label="Active" sub="of tracked time" />
            <RingStat color={RING.productive} pct={tracked ? t.productiveSec / tracked : 0} value={hrsShort(t.productiveSec)} label="Productive" sub="of tracked time" />
            <RingStat color={RING.idle} pct={tracked ? t.idleSec / tracked : 0} value={hrsShort(t.idleSec)} label="Idle" sub="of tracked time" />
            <RingStat color={RING.productivity} pct={(t.productivityPct ?? 0) / 100} value={`${t.productivityPct ?? 0}%`} label="Productivity" sub="productive ÷ tracked" />
          </div>

          <Card title="Productivity trend">
            <TrendChart days={summary.days} period={preset === 'month' || preset === '30d' ? 'week' : 'day'} />
          </Card>

          <Card title="On-time arrivals" subtitle={`${lateSummary.onTimePct}% on-time across ${lateSummary.worked} worked day${lateSummary.worked === 1 ? '' : 's'}`}>
            {lateSummary.worst.length === 0 ? (
              <div className="p-6 text-gray-400 text-sm">No late arrivals in this period.</div>
            ) : (
              <div className="p-4">
                <div className="text-xs text-gray-500 mb-2">Most late arrivals this period</div>
                <div className="space-y-1.5">
                  {lateSummary.worst.map((r) => (
                    <div key={r.employeeId} onClick={() => navigate(`/portal/employees/${r.employeeId}`)}
                      className="flex items-center justify-between text-sm print:cursor-default cursor-pointer hover:bg-gray-50 rounded px-2 py-1 -mx-2">
                      <span className="text-gray-800">{r.displayName}</span>
                      <span className="text-gray-500">{r.late} late day{r.late === 1 ? '' : 's'} · avg +{r.avgLateMin}m</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <Card title="Top performers" subtitle="by productivity %" className="mb-0">
              {performers.top.length === 0 ? <div className="p-6 text-gray-400 text-sm">No activity in this period.</div> : (
                <div className="p-4 space-y-1.5">
                  {performers.top.map((e) => (
                    <div key={e.employeeId} onClick={() => navigate(`/portal/employees/${e.employeeId}`)}
                      className="flex items-center justify-between text-sm print:cursor-default cursor-pointer hover:bg-gray-50 rounded px-2 py-1 -mx-2">
                      <span className="text-gray-800">{e.displayName}</span>
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${pctColour(e.productivityPct)}`}>{e.productivityPct}%</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title="Needs attention" subtitle="lowest productivity %" className="mb-0">
              {performers.bottom.length === 0 ? <div className="p-6 text-gray-400 text-sm">No activity in this period.</div> : (
                <div className="p-4 space-y-1.5">
                  {performers.bottom.map((e) => (
                    <div key={e.employeeId} onClick={() => navigate(`/portal/employees/${e.employeeId}`)}
                      className="flex items-center justify-between text-sm print:cursor-default cursor-pointer hover:bg-gray-50 rounded px-2 py-1 -mx-2">
                      <span className="text-gray-800">{e.displayName}</span>
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${pctColour(e.productivityPct)}`}>{e.productivityPct}%</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <Card title="Department comparison" subtitle="productivity % of tracked time">
            {byDept.length === 0 ? <div className="p-6 text-gray-400 text-sm">No activity in this period.</div> : (
              <div className="p-4 space-y-2.5">
                {byDept.map((d) => (
                  <div key={d.dept}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="font-medium text-gray-800">{d.dept} <span className="text-xs font-normal text-gray-400">({d.count})</span></span>
                      <span className="text-xs text-gray-500">{fmtDur(d.productiveSec)} · {d.pct}%</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-green-500" style={{ width: `${Math.max(2, d.pct)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Top apps & sites" subtitle="company-wide">
            <AppUsageBars apps={topApps} />
          </Card>
        </>
      )}
    </div>
  );
}
