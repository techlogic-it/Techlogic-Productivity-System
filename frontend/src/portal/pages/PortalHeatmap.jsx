import { useState, useEffect, useMemo, Fragment } from 'react';
import portalApi from '../portalApi';
import { usePortalAuth, isProvider as isProviderRole } from '../PortalAuthContext';
import { fmtDateInput, fmtDur } from '../portalUtils';

const DAY_LABELS = [
  [1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun'],
];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function rangeFor(preset) {
  const now = new Date();
  if (preset === 'week') {
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // Monday of this week
    return [mon, now];
  }
  if (preset === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1), now];
  if (preset === '4weeks') { const f = new Date(now); f.setDate(now.getDate() - 27); return [f, now]; }
  return [null, null];
}
const PRESETS = [['week', 'This week'], ['month', 'This month'], ['4weeks', 'Last 4 weeks'], ['custom', 'Custom']];

// Buckets come back as a sparse list ({dayNum, hour, activeSec, productiveSec});
// index them for O(1) lookup while rendering the 7×24 grid.
function indexBuckets(buckets) {
  const map = new Map();
  for (const b of buckets || []) map.set(`${b.dayNum}-${b.hour}`, b);
  return map;
}

// Green intensity scale, relative to the busiest cell in THIS grid — a report
// spanning more weeks naturally sums more seconds per cell, so a fixed scale
// would just wash out shorter ranges. 0 productive time still renders as a
// faint grey so the empty grid structure stays visible.
function cellStyle(sec, maxSec) {
  if (!sec) return { backgroundColor: '#f3f4f6' };
  const ratio = Math.min(1, sec / maxSec);
  // Interpolate from a light to a deep green.
  const from = [220, 245, 230], to = [16, 122, 66];
  const mix = (i) => Math.round(from[i] + (to[i] - from[i]) * ratio);
  return { backgroundColor: `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})` };
}

function Heatmap({ title, subtitle, buckets }) {
  const byKey = useMemo(() => indexBuckets(buckets), [buckets]);
  const maxSec = useMemo(() => Math.max(1, ...(buckets || []).map((b) => b.productiveSec)), [buckets]);
  const totalSec = useMemo(() => (buckets || []).reduce((s, b) => s + b.productiveSec, 0), [buckets]);

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-4 mb-6 print:break-inside-avoid">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-1">
        <div>
          <div className="font-semibold text-gray-800">{title}</div>
          {subtitle && <div className="text-xs text-gray-400">{subtitle}</div>}
        </div>
        <div className="text-sm text-gray-500">{fmtDur(totalSec)} productive over this period</div>
      </div>
      <div className="overflow-x-auto">
        <div className="inline-grid gap-[2px]" style={{ gridTemplateColumns: '3.5rem repeat(7, minmax(2.25rem, 1fr))' }}>
          <div />
          {DAY_LABELS.map(([n, label]) => (
            <div key={n} className="text-[10px] text-gray-400 text-center pb-1">{label}</div>
          ))}
          {HOURS.map((h) => (
            <Fragment key={h}>
              <div className="text-[10px] text-gray-400 text-right pr-1.5 leading-[1.35rem]">
                {String(h).padStart(2, '0')}:00
              </div>
              {DAY_LABELS.map(([n, dayLabel]) => {
                const b = byKey.get(`${n}-${h}`);
                const sec = b?.productiveSec || 0;
                return (
                  <div
                    key={`${n}-${h}`}
                    title={`${dayLabel} ${String(h).padStart(2, '0')}:00 — ${fmtDur(sec)} productive`}
                    className="h-[1.35rem] rounded-sm"
                    style={cellStyle(sec, maxSec)}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function PortalHeatmap() {
  const { user, org } = usePortalAuth();
  const isProvider = isProviderRole(user.role);

  const [mode, setMode] = useState('employee'); // 'employee' | 'team'
  const [companyId, setCompanyId] = useState('');
  const [companies, setCompanies] = useState([]);
  const reportOrgId = isProvider ? companyId : org?.id;

  const [employees, setEmployees] = useState([]);
  const [employeeId, setEmployeeId] = useState('');
  const [groups, setGroups] = useState([]);
  const [groupId, setGroupId] = useState('');

  const [preset, setPreset] = useState('4weeks');
  const [[f0, t0]] = useState(rangeFor('4weeks'));
  const [fromDate, setFromDate] = useState(fmtDateInput(f0));
  const [toDate, setToDate] = useState(fmtDateInput(t0));

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isProvider) portalApi.get('/orgs/organisations').then((r) => setCompanies(r.data || [])).catch(() => {});
  }, [isProvider]);

  // Reset the pickers when the selected company or mode changes.
  useEffect(() => { setEmployeeId(''); setGroupId(''); }, [companyId, mode]);

  useEffect(() => {
    if (!reportOrgId) { setEmployees([]); setGroups([]); return; }
    portalApi.get('/monitoring/employees?activeOnly=true').then((r) => {
      const all = r.data || [];
      setEmployees(isProvider ? all.filter((e) => e.organisationId === reportOrgId) : all);
    }).catch(() => {});
    portalApi.get(`/orgs/organisations/${reportOrgId}/groups`).then((r) => setGroups(r.data || [])).catch(() => {});
  }, [reportOrgId, isProvider]);

  const applyPreset = (p) => {
    setPreset(p);
    if (p === 'custom') return;
    const [a, b] = rangeFor(p);
    setFromDate(fmtDateInput(a)); setToDate(fmtDateInput(b));
  };

  const targetId = mode === 'employee' ? employeeId : groupId;

  useEffect(() => {
    if (!targetId) { setData(null); return; }
    setLoading(true); setError('');
    const q = new URLSearchParams({ fromDate, toDate });
    if (mode === 'employee') q.set('employeeId', targetId); else q.set('groupId', targetId);
    if (isProvider && companyId) q.set('organisationId', companyId);
    portalApi.get(`/monitoring/heatmap?${q.toString()}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [mode, targetId, fromDate, toDate, isProvider, companyId]);

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2 print:hidden">
        <h1 className="text-xl font-bold text-gray-800">Productivity heatmap</h1>
        {data && (
          <button onClick={() => window.print()} className="rounded-lg bg-teal-600 hover:bg-teal-700 text-white px-3 py-1.5 text-sm">
            Download PDF
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm flex-wrap mb-3 print:hidden">
        <div className="flex rounded-lg border border-gray-300 overflow-hidden">
          <button onClick={() => setMode('employee')} className={`px-3 py-1.5 ${mode === 'employee' ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>By employee</button>
          <button onClick={() => setMode('team')} className={`px-3 py-1.5 ${mode === 'team' ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>By team</button>
        </div>
        {isProvider && (
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
            <option value="">Select a company…</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        {mode === 'employee' ? (
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5" disabled={!reportOrgId}>
            <option value="">Select an employee…</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.displayName || e.upn || 'Unnamed'}</option>)}
          </select>
        ) : (
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5" disabled={!reportOrgId}>
            <option value="">Select a team…</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
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

      <p className="text-sm text-gray-500 mb-4">
        Each cell is one hour-of-day × day-of-week slot, coloured by how much productive time fell into it across the selected period. Covers every hour, not just office hours — the point is to see the real pattern, including evenings/weekends.
      </p>

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 print:hidden">{error}</div>}

      {!targetId ? (
        <div className="text-gray-400 text-sm">{mode === 'employee' ? 'Pick an employee to see their heatmap.' : 'Pick a team to see its heatmap.'}</div>
      ) : loading ? (
        <div className="text-gray-400 text-sm">Loading…</div>
      ) : mode === 'employee' ? (
        data?.employee && (
          <Heatmap
            title={data.employee.displayName}
            subtitle={`${data.fromDate} to ${data.toDate}`}
            buckets={data.employee.buckets}
          />
        )
      ) : (
        data?.team && (
          <>
            <Heatmap
              title={`Team — ${groups.find((g) => g.id === groupId)?.name || ''}`}
              subtitle={`${data.fromDate} to ${data.toDate} · combined across ${data.members.length} member${data.members.length === 1 ? '' : 's'}`}
              buckets={data.team.buckets}
            />
            {data.members.map((m) => (
              <Heatmap key={m.employeeId} title={m.displayName} buckets={m.buckets} />
            ))}
          </>
        )
      )}
    </div>
  );
}
