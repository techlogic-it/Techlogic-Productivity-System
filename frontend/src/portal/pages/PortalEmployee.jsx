import { useState, useEffect, useMemo } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import portalApi from '../portalApi';
import { fmtDur, fmtDateInput, fmtTime } from '../portalUtils';
import { RingStat, hrsShort, RING } from '../components/RingStat';

// Browsers are one process for every tab, so a per-process total would just say
// "Microsoft Edge". Label browser rows by their window-title's first segment
// (e.g. "YouTube", "ChatGPT") so sites show up individually.
const BROWSERS = new Set(['MSEDGE.EXE', 'CHROME.EXE', 'FIREFOX.EXE', 'BRAVE.EXE', 'OPERA.EXE', 'IEXPLORE.EXE', 'ARC.EXE', 'VIVALDI.EXE']);
const catLabel = (c) => (c || 'Uncategorised').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

// Solid colours per productivity weight — for the bar breakdown + timeline dots.
const WEIGHT_BAR = { PRODUCTIVE: 'bg-green-500', NEUTRAL: 'bg-gray-300', NON_PRODUCTIVE: 'bg-red-400' };
const WEIGHT_DOT = { PRODUCTIVE: 'bg-green-500', NEUTRAL: 'bg-gray-400', NON_PRODUCTIVE: 'bg-red-400' };

// Date range for a KPI-period preset (mirrors PortalDashboard's rangeFor).
function rangeFor(preset) {
  const now = new Date();
  if (preset === 'today') return [now, now];
  if (preset === '7days') { const d = new Date(now); d.setDate(now.getDate() - 6); return [d, now]; }
  if (preset === 'week') {
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // Monday of this week
    return [mon, now];
  }
  if (preset === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1), now];
  return [null, null];
}
const PERIOD_PRESETS = [['today', 'Today'], ['7days', '7 days'], ['week', 'This week'], ['month', 'This month'], ['custom', 'Custom']];

export default function PortalEmployee() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const [date, setDate] = useState(/^\d{4}-\d{2}-\d{2}$/.test(searchParams.get('date') || '') ? searchParams.get('date') : fmtDateInput(new Date()));
  const [events, setEvents] = useState([]);
  const [screenshots, setScreenshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // KPI period (Active/Productive/Idle/Productivity above) — independent of the
  // single `date` below, which drives Apps & sites / Screenshots / Timeline (those
  // are inherently a day-at-a-time drill-down, not something to show a month of).
  const [preset, setPreset] = useState('today');
  const [periodFrom, setPeriodFrom] = useState(fmtDateInput(new Date()));
  const [periodTo, setPeriodTo] = useState(fmtDateInput(new Date()));
  const [period, setPeriod] = useState({ total: {} });
  const applyPreset = (p) => {
    setPreset(p);
    if (p === 'custom') return;
    const [f, tEnd] = rangeFor(p);
    setPeriodFrom(fmtDateInput(f)); setPeriodTo(fmtDateInput(tEnd));
  };

  useEffect(() => {
    portalApi.get(`/monitoring/summary?employeeId=${id}&fromDate=${periodFrom}&toDate=${periodTo}`)
      .then((r) => setPeriod(r.data || { total: {} }))
      .catch((e) => setError(e.response?.data?.error || 'Not available in your scope'));
  }, [id, periodFrom, periodTo]);

  useEffect(() => {
    setLoading(true); setError('');
    portalApi.get(`/monitoring/timeline?employeeId=${id}&date=${date}`)
      .then((tl) => setEvents(tl.data || []))
      .catch((e) => setError(e.response?.data?.error || 'Not available in your scope'))
      .finally(() => setLoading(false));
    // Separate call — screenshots being off/unavailable shouldn't break the rest
    // of the page, so a failure here is swallowed rather than surfaced as `error`.
    portalApi.get(`/monitoring/screenshots?employeeId=${id}&date=${date}`)
      .then((r) => setScreenshots(r.data || []))
      .catch(() => setScreenshots([]));
  }, [id, date]);

  const name = period.employees?.[0]?.displayName || events[0]?.employee?.displayName || 'Employee';
  const t = period.total || {};

  // Optional time-of-day window — narrows the timeline + apps/sites to a period
  // of the day (default: whole day). Client-side over the day's events.
  const [fromTime, setFromTime] = useState('');
  const [toTime, setToTime] = useState('');
  const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const windowed = !!(fromTime || toTime);
  const filteredEvents = useMemo(() => {
    const f = toMin(fromTime), tt = toMin(toTime);
    if (f == null && tt == null) return events;
    return events.filter((e) => { const d = new Date(e.startTime); const m = d.getHours() * 60 + d.getMinutes(); return (f == null || m >= f) && (tt == null || m <= tt); });
  }, [events, fromTime, toTime]);

  // Per-hour activity intensity for the day — active seconds (and the productive
  // slice) bucketed by the local hour the interval started in.
  const hourly = useMemo(() => {
    const b = Array.from({ length: 24 }, () => ({ activeSec: 0, idleSec: 0, prodSec: 0 }));
    for (const e of events) {
      const sec = e.durationSec || 0;
      if (!sec) continue;
      const h = new Date(e.startTime).getHours();
      if (e.isIdle) b[h].idleSec += sec;
      else { b[h].activeSec += sec; if (e.resolvedWeight === 'PRODUCTIVE') b[h].prodSec += sec; }
    }
    return b;
  }, [events]);
  const hasActivity = hourly.some((h) => h.activeSec > 0);

  // Aggregate the day's active events into a per-app/site breakdown.
  const appBreakdown = useMemo(() => {
    const map = new Map();
    let totalSec = 0;
    for (const e of filteredEvents) {
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
  }, [filteredEvents]);

  // Which screenshot (if any) was captured during — or closest to — each timeline
  // entry, so "what was on screen" is one click away from "what app was active".
  // Screenshots are periodic (e.g. every 5 min), independent of activity segments,
  // so several short entries can share the same nearest capture.
  const SCREENSHOT_MATCH_WINDOW_MS = 3 * 60 * 1000;
  const screenshotByEventId = useMemo(() => {
    const map = new Map();
    if (screenshots.length === 0) return map;
    for (const e of events) {
      const start = new Date(e.startTime).getTime();
      const end = new Date(e.endTime || e.startTime).getTime();
      let best = null, bestDist = Infinity;
      for (const s of screenshots) {
        const t = new Date(s.capturedAt).getTime();
        const dist = t >= start && t <= end ? 0 : t < start ? start - t : t - end;
        if (dist < bestDist) { bestDist = dist; best = s; }
      }
      if (best && bestDist <= SCREENSHOT_MATCH_WINDOW_MS) map.set(e.id, best);
    }
    return map;
  }, [events, screenshots]);

  return (
    <div className="max-w-4xl">
      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div>
          <Link to="/portal/employees" className="text-sm text-teal-700 hover:underline">← People</Link>
          <h1 className="text-xl font-bold text-gray-800">{name}</h1>
        </div>
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <div className="flex rounded-lg border border-gray-300 overflow-hidden">
            {PERIOD_PRESETS.map(([p, label]) => (
              <button key={p} onClick={() => applyPreset(p)}
                className={`px-3 py-1.5 ${preset === p ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{label}</button>
            ))}
          </div>
          {preset === 'custom' && (
            <>
              <input type="date" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1" />
              <span className="text-gray-400">→</span>
              <input type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1" />
            </>
          )}
        </div>
      </div>

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}

      {(() => { const tracked = (t.activeSec || 0) + (t.idleSec || 0); return (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-2">
          <RingStat color={RING.active} pct={tracked ? t.activeSec / tracked : 0} value={hrsShort(t.activeSec)} label="Active" sub="of tracked" />
          <RingStat color={RING.productive} pct={tracked ? t.productiveSec / tracked : 0} value={hrsShort(t.productiveSec)} label="Productive" sub="of tracked" />
          <RingStat color={RING.idle} pct={tracked ? t.idleSec / tracked : 0} value={hrsShort(t.idleSec)} label="Idle" sub="of tracked" />
          <RingStat color={RING.productivity} pct={(t.productivityPct ?? 0) / 100} value={`${t.productivityPct ?? 0}%`} label="Productivity"
            sub={t.overtimeSec ? `+${fmtDur(t.overtimeSec)} overtime` : 'productive ÷ tracked'} />
        </div>
      ); })()}
      <p className="text-xs text-gray-400 mb-4">
        {preset === 'today' ? "Today's" : `${periodFrom} to ${periodTo}`} totals. App/site breakdown, screenshots and timeline below are always for one day at a time:
      </p>

      <div className="flex items-center gap-2 text-sm flex-wrap mb-6">
        <span className="text-xs text-gray-400">Day</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-gray-300 px-2 py-1" />
        <span className="text-gray-400 text-xs ml-2">Time</span>
        <input type="time" value={fromTime} onChange={(e) => setFromTime(e.target.value)}
          className="rounded-lg border border-gray-300 px-2 py-1" />
        <span className="text-gray-400">→</span>
        <input type="time" value={toTime} onChange={(e) => setToTime(e.target.value)}
          className="rounded-lg border border-gray-300 px-2 py-1" />
        {windowed && <button onClick={() => { setFromTime(''); setToTime(''); }} className="text-xs text-teal-700 hover:underline">Clear</button>}
      </div>

      {!loading && hasActivity && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
          <div className="font-semibold text-gray-700 text-sm mb-3">Activity intensity (by hour)</div>
          <div className="flex items-end gap-0.5 h-20">
            {hourly.map((b, h) => {
              const frac = Math.min(1, b.activeSec / 3600);
              const prodFrac = b.activeSec ? b.prodSec / b.activeSec : 0;
              return (
                <div key={h} className="flex-1 h-full bg-gray-100 rounded-t relative"
                  title={`${String(h).padStart(2, '0')}:00 — ${fmtDur(b.activeSec)} active${b.idleSec ? `, ${fmtDur(b.idleSec)} idle` : ''}`}>
                  <div className="absolute bottom-0 left-0 right-0 bg-teal-500 rounded-t" style={{ height: `${frac * 100}%` }}>
                    <div className="absolute bottom-0 left-0 right-0 bg-green-500" style={{ height: `${prodFrac * 100}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[10px] text-gray-400 mt-1"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>
          <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-green-500 inline-block" /> Productive</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-teal-500 inline-block" /> Active</span>
            <span className="ml-auto">Bar height = active time that hour (hover for detail)</span>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-gray-100 font-semibold text-gray-700 text-sm flex items-center justify-between">
          <span>Apps &amp; sites</span>
          {windowed && <span className="text-xs font-normal text-gray-400">{fromTime || '00:00'}–{toTime || '23:59'}</span>}
        </div>
        {loading ? (
          <div className="p-6 text-gray-400 text-sm">Loading…</div>
        ) : appBreakdown.length === 0 ? (
          <div className="p-6 text-gray-400 text-sm">{windowed ? 'No app activity in the selected time window.' : 'No app activity recorded for this day.'}</div>
        ) : (
          <div className="p-4 space-y-2.5">
            {appBreakdown.slice(0, 30).map((a) => (
              <div key={a.label}>
                <div className="flex items-center justify-between text-sm mb-1 gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${WEIGHT_DOT[a.weight] || 'bg-gray-300'}`} />
                    <span className="font-medium text-gray-800 truncate">{a.label}</span>
                    <span className="text-xs text-gray-400 shrink-0 hidden sm:inline">{catLabel(a.category)}</span>
                  </div>
                  <span className="text-xs text-gray-500 whitespace-nowrap tabular-nums">{fmtDur(a.sec)} · {a.pct}%</span>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${WEIGHT_BAR[a.weight] || 'bg-gray-300'}`} style={{ width: `${Math.max(2, a.pct)}%` }} />
                </div>
              </div>
            ))}
            <div className="flex items-center gap-4 pt-2 text-xs text-gray-500 border-t border-gray-100 mt-1">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block" /> Productive</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-gray-300 inline-block" /> Neutral</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-red-400 inline-block" /> Non-productive</span>
              <span className="ml-auto">Bar = share of active time</span>
            </div>
          </div>
        )}
      </div>

      {screenshots.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
          <div className="px-4 py-3 border-b border-gray-100 font-semibold text-gray-700 text-sm">
            Screenshots <span className="font-normal text-gray-400">({screenshots.length})</span>
          </div>
          <div className="p-4 flex gap-3 overflow-x-auto">
            {screenshots.map((s) => (
              <a key={s.id} href={s.url} target="_blank" rel="noreferrer" title={fmtTime(s.capturedAt)}
                className="shrink-0 block w-32 rounded-lg overflow-hidden border border-gray-200 hover:border-teal-400 transition-colors">
                <img src={s.url} alt={fmtTime(s.capturedAt)} className="w-32 h-20 object-cover bg-gray-100" loading="lazy" />
                <div className="text-[11px] text-gray-500 text-center py-1 bg-gray-50">{fmtTime(s.capturedAt)}</div>
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 font-semibold text-gray-700 text-sm flex items-center justify-between">
          <span>Timeline</span>
          {windowed && <span className="text-xs font-normal text-gray-400">{filteredEvents.length} of {events.length} entries · {fromTime || '00:00'}–{toTime || '23:59'}</span>}
        </div>
        {loading ? (
          <div className="p-6 text-gray-400 text-sm">Loading…</div>
        ) : filteredEvents.length === 0 ? (
          <div className="p-6 text-gray-400 text-sm">{windowed && events.length > 0 ? 'No activity in the selected time window.' : 'No activity recorded for this day.'}</div>
        ) : (
          <div className="p-4 pl-5">
            <ol className="relative border-l-2 border-gray-100 ml-2">
              {filteredEvents.map((e) => {
                const shot = screenshotByEventId.get(e.id);
                return (
                  <li key={e.id} className="relative pl-5 py-1.5">
                    <span className={`absolute -left-[7px] top-2.5 w-3 h-3 rounded-full ring-2 ring-white ${e.isIdle ? 'bg-gray-200' : (WEIGHT_DOT[e.resolvedWeight] || 'bg-gray-400')}`} />
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="text-xs text-gray-400 tabular-nums shrink-0">{fmtTime(e.startTime)}</span>
                          <span className={`text-sm font-medium truncate ${e.isIdle ? 'text-gray-400' : 'text-gray-800'}`}>{e.isIdle ? 'Idle' : (e.resolvedDisplayName || e.processName)}</span>
                          {shot && (
                            <a href={shot.url} target="_blank" rel="noreferrer" title={`Screenshot near ${fmtTime(shot.capturedAt)}`}
                              className="shrink-0 text-gray-300 hover:text-teal-600" onClick={(ev) => ev.stopPropagation()}>📷</a>
                          )}
                        </div>
                        {!e.isIdle && e.windowTitle && <div className="text-xs text-gray-400 truncate">{e.windowTitle}</div>}
                      </div>
                      <span className="text-xs text-gray-500 whitespace-nowrap tabular-nums shrink-0">{e.isIdle ? 'idle' : fmtDur(e.durationSec)}</span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
