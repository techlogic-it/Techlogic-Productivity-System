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

const fmtLate = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
const fmtDay = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

export default function PortalExecutive() {
  const navigate = useNavigate();
  const { user, org } = usePortalAuth();
  const isProvider = isProviderRole(user.role);

  const [mode, setMode] = useState('company'); // 'company' | 'employee'
  const [companyId, setCompanyId] = useState('');
  const [companies, setCompanies] = useState([]);
  const reportOrgId = isProvider ? companyId : org?.id;
  const [employeeId, setEmployeeId] = useState('');

  const [preset, setPreset] = useState('month');
  const [[f0, t0]] = useState(rangeFor('month'));
  const [fromDate, setFromDate] = useState(fmtDateInput(f0));
  const [toDate, setToDate] = useState(fmtDateInput(t0));

  const [summary, setSummary] = useState({ total: {}, employees: [], days: [] });
  const [lateRows, setLateRows] = useState([]);
  const [topApps, setTopApps] = useState([]);
  const [employees, setEmployees] = useState([]); // for department names + the employee picker
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isProvider) portalApi.get('/orgs/organisations').then((r) => setCompanies(r.data || [])).catch(() => {});
  }, [isProvider]);

  // Reset the employee pick when switching mode/company.
  useEffect(() => { setEmployeeId(''); }, [mode, companyId]);

  const applyPreset = (p) => {
    setPreset(p);
    if (p === 'custom') return;
    const [a, b] = rangeFor(p);
    setFromDate(fmtDateInput(a)); setToDate(fmtDateInput(b));
  };

  // Fetched independently of employeeId — it's what POPULATES the employee
  // picker in employee mode, so it can't wait on an employee already being picked.
  useEffect(() => {
    if (!reportOrgId) { setEmployees([]); return; }
    portalApi.get('/monitoring/employees?activeOnly=true')
      .then((r) => setEmployees(isProvider ? (r.data || []).filter((emp) => emp.organisationId === reportOrgId) : (r.data || [])))
      .catch(() => setEmployees([]));
  }, [reportOrgId, isProvider]);

  useEffect(() => {
    if (!reportOrgId) return;
    if (mode === 'employee' && !employeeId) { setSummary({ total: {}, employees: [], days: [] }); setLateRows([]); setTopApps([]); return; }
    const base = { fromDate, toDate, organisationId: reportOrgId };
    const scoped = mode === 'employee' ? { ...base, employeeId } : base;
    setLoading(true);
    Promise.all([
      portalApi.get(`/monitoring/summary?${new URLSearchParams(scoped).toString()}`).then((r) => r.data),
      portalApi.get(`/monitoring/late-report?${new URLSearchParams(base).toString()}`).then((r) => r.data), // no employeeId filter — pick the one row client-side
      portalApi.get(`/monitoring/top-apps?${new URLSearchParams(scoped).toString()}`).then((r) => r.data),
    ]).then(([s, l, a]) => {
      setSummary(s || { total: {}, employees: [], days: [] });
      setLateRows(l?.rows || []);
      setTopApps((a?.apps || []).slice(0, 8));
    }).finally(() => setLoading(false));
  }, [reportOrgId, fromDate, toDate, mode, employeeId]);

  const t = summary.total || {};
  const tracked = (t.activeSec || 0) + (t.idleSec || 0);
  const employeeName = employees.find((e) => e.id === employeeId)?.displayName || employees.find((e) => e.id === employeeId)?.upn || 'Employee';
  const myLate = useMemo(() => lateRows.find((r) => r.employeeId === employeeId) || null, [lateRows, employeeId]);

  // Downloading as PDF is really "print the page" (window.print()), and the
  // browser's print header shows document.title — override the generic app
  // title here so a printed/PDF'd report is headed with the actual company
  // (and employee, in that mode) it's for, not "Techlogic Productivity System".
  const companyName = isProvider ? companies.find((c) => c.id === companyId)?.name : org?.name;
  useEffect(() => {
    if (!companyName) return;
    document.title = mode === 'employee' && employeeId ? `${companyName} — ${employeeName}` : `${companyName} — Executive Summary`;
  }, [companyName, mode, employeeId, employeeName]);

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
        <h1 className="text-xl font-bold text-gray-800">{mode === 'employee' && employeeId ? `${employeeName} — summary` : 'Executive summary'}</h1>
        {reportOrgId && (mode === 'company' || employeeId) && (
          <button onClick={() => window.print()} className="rounded-lg bg-teal-600 hover:bg-teal-700 text-white px-3 py-1.5 text-sm">
            Download PDF
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm flex-wrap mb-4 print:hidden">
        <div className="flex rounded-lg border border-gray-300 overflow-hidden">
          <button onClick={() => setMode('company')} className={`px-3 py-1.5 ${mode === 'company' ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>Company</button>
          <button onClick={() => setMode('employee')} className={`px-3 py-1.5 ${mode === 'employee' ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>Employee</button>
        </div>
        {isProvider && (
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
            <option value="">Select a company…</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        {mode === 'employee' && (
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5" disabled={!reportOrgId}>
            <option value="">Select an employee…</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.displayName || e.upn || 'Unnamed'}</option>)}
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
      ) : mode === 'employee' && !employeeId ? (
        <div className="text-gray-400 text-sm">Pick an employee to see their summary.</div>
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

          {mode === 'employee' ? (
            <Card title="On-time arrivals" subtitle={myLate ? `${myLate.onTimePct}% on-time · office start ${myLate.officeStart} · avg start ${myLate.avgStart}` : 'No worked days in this period'}>
              {!myLate || (myLate.days || []).length === 0 ? (
                <div className="p-6 text-gray-400 text-sm">No tracked working days in this period.</div>
              ) : (
                <div className="p-4">
                  <div className="flex flex-wrap gap-2">
                    {myLate.days.map((d) => (
                      <span key={d.date} className={`rounded-lg border px-2.5 py-1 text-xs ${d.lateBy > 0 ? 'border-red-200 bg-red-50 text-red-700' : 'border-gray-200 bg-white text-gray-700'}`}>
                        <span className="text-gray-400">{fmtDay(d.date)}</span> <span className="font-semibold">{d.start}</span>
                        {d.lateBy > 0 && <span className="ml-1 text-red-500">+{fmtLate(d.lateBy)}</span>}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          ) : (
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
          )}

          {mode === 'company' && (
          <>
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
          </>
          )}

          <Card title="Top apps & sites" subtitle={mode === 'employee' ? employeeName : 'company-wide'}>
            <AppUsageBars apps={topApps} />
          </Card>
        </>
      )}
    </div>
  );
}
