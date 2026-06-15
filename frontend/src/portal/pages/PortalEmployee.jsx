import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import portalApi from '../portalApi';
import { fmtDur, fmtDateInput, fmtTime, WEIGHT_COLOUR } from '../portalUtils';

// Browsers are one process for every tab, so a per-process total would just say
// "Microsoft Edge". Label browser rows by their window-title's first segment
// (e.g. "YouTube", "ChatGPT") so sites show up individually.
const BROWSERS = new Set(['MSEDGE.EXE', 'CHROME.EXE', 'FIREFOX.EXE', 'BRAVE.EXE', 'OPERA.EXE', 'IEXPLORE.EXE', 'ARC.EXE', 'VIVALDI.EXE']);
const catLabel = (c) => (c || 'Uncategorised').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

export default function PortalEmployee() {
  const { id } = useParams();
  const [date, setDate] = useState(fmtDateInput(new Date()));
  const [events, setEvents] = useState([]);
  const [day, setDay] = useState({ total: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true); setError('');
    Promise.all([
      portalApi.get(`/monitoring/timeline?employeeId=${id}&date=${date}`),
      portalApi.get(`/monitoring/summary?employeeId=${id}&fromDate=${date}&toDate=${date}`),
    ])
      .then(([tl, sm]) => { setEvents(tl.data || []); setDay(sm.data || { total: {} }); })
      .catch((e) => setError(e.response?.data?.error || 'Not available in your scope'))
      .finally(() => setLoading(false));
  }, [id, date]);

  const name = day.employees?.[0]?.displayName || events[0]?.employee?.displayName || 'Employee';
  const t = day.total || {};

  // Aggregate the day's active events into a per-app/site breakdown.
  const appBreakdown = useMemo(() => {
    const map = new Map();
    let totalSec = 0;
    for (const e of events) {
      if (e.isIdle) continue;
      const sec = e.durationSec || 0;
      if (!sec) continue;
      const proc = (e.processName || '').toUpperCase();
      const label = (BROWSERS.has(proc) && e.windowTitle)
        ? (e.windowTitle.split(/\s[-–|]\s/)[0].trim() || e.resolvedDisplayName || e.processName)
        : (e.resolvedDisplayName || e.processName || 'Unknown');
      const key = label.toLowerCase();
      const row = map.get(key) || { label, sec: 0, weights: {}, categories: {} };
      row.sec += sec;
      row.weights[e.resolvedWeight || 'NEUTRAL'] = (row.weights[e.resolvedWeight || 'NEUTRAL'] || 0) + sec;
      row.categories[e.resolvedCategory || 'UNCATEGORISED'] = (row.categories[e.resolvedCategory || 'UNCATEGORISED'] || 0) + sec;
      map.set(key, row);
      totalSec += sec;
    }
    const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1])[0]?.[0];
    return [...map.values()]
      .map((r) => ({ label: r.label, sec: r.sec, weight: top(r.weights) || 'NEUTRAL', category: top(r.categories) || 'UNCATEGORISED', pct: totalSec ? Math.round((r.sec / totalSec) * 100) : 0 }))
      .sort((a, b) => b.sec - a.sec);
  }, [events]);

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <Link to="/portal/employees" className="text-sm text-teal-700 hover:underline">← People</Link>
          <h1 className="text-xl font-bold text-gray-800">{name}</h1>
        </div>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-gray-300 px-2 py-1 text-sm" />
      </div>

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}

      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { l: 'Active', v: t.activeSec },
          { l: 'Productive', v: t.productiveSec },
          { l: 'Idle', v: t.idleSec },
          { l: 'Overtime', v: t.overtimeSec, sub: t.overtimeSec ? `${fmtDur(t.overtimeProductiveSec)} productive · ${t.overtimePct ?? 0}%` : null },
        ].map(({ l, v, sub }) => (
          <div key={l} className="bg-white rounded-xl border border-gray-200 p-3">
            <div className="text-xs uppercase text-gray-500">{l}</div>
            <div className="text-lg font-bold text-gray-800">{fmtDur(v)}</div>
            {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-gray-100 font-semibold text-gray-700 text-sm">Apps &amp; sites</div>
        {loading ? (
          <div className="p-6 text-gray-400 text-sm">Loading…</div>
        ) : appBreakdown.length === 0 ? (
          <div className="p-6 text-gray-400 text-sm">No app activity recorded for this day.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="text-left font-medium px-4 py-2">App / site</th>
                <th className="text-left font-medium px-4 py-2">Category</th>
                <th className="text-right font-medium px-4 py-2">Time</th>
                <th className="text-right font-medium px-4 py-2">Share</th>
                <th className="text-left font-medium px-4 py-2">Class</th>
              </tr>
            </thead>
            <tbody>
              {appBreakdown.slice(0, 30).map((a) => (
                <tr key={a.label} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-medium text-gray-800 truncate max-w-[260px]">{a.label}</td>
                  <td className="px-4 py-2 text-gray-500">{catLabel(a.category)}</td>
                  <td className="px-4 py-2 text-right text-gray-700 whitespace-nowrap">{fmtDur(a.sec)}</td>
                  <td className="px-4 py-2 text-right text-gray-400">{a.pct}%</td>
                  <td className="px-4 py-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${WEIGHT_COLOUR[a.weight] || 'bg-gray-100'}`}>
                      {(a.weight || 'NEUTRAL').toLowerCase().replace('_', '-')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 font-semibold text-gray-700 text-sm">Timeline</div>
        {loading ? (
          <div className="p-6 text-gray-400 text-sm">Loading…</div>
        ) : events.length === 0 ? (
          <div className="p-6 text-gray-400 text-sm">No activity recorded for this day.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="text-left font-medium px-4 py-2">Time</th>
                <th className="text-left font-medium px-4 py-2">App</th>
                <th className="text-left font-medium px-4 py-2">Window</th>
                <th className="text-right font-medium px-4 py-2">Duration</th>
                <th className="text-left font-medium px-4 py-2">Class</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t border-gray-100">
                  <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{fmtTime(e.startTime)}</td>
                  <td className="px-4 py-2 font-medium text-gray-800">{e.resolvedDisplayName || e.processName}</td>
                  <td className="px-4 py-2 text-gray-500 truncate max-w-[200px]">{e.windowTitle || '—'}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{e.isIdle ? 'idle' : fmtDur(e.durationSec)}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${WEIGHT_COLOUR[e.resolvedWeight] || 'bg-gray-100'}`}>
                      {(e.resolvedWeight || 'NEUTRAL').toLowerCase()}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
