import { useMemo } from 'react';
import { fmtDur, fmtDateInput } from '../portalUtils';

// Bucket a date-only summary into a day/week/month key + short label, without
// timezone drift (summaryDate is UTC midnight; we read the calendar parts directly).
function bucketFor(summaryDate, period) {
  const [y, m, d] = summaryDate.slice(0, 10).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (period === 'month') {
    return { key: `${y}-${String(m).padStart(2, '0')}`, label: dt.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) };
  }
  if (period === 'week') {
    const mon = new Date(dt);
    mon.setDate(dt.getDate() - ((dt.getDay() + 6) % 7)); // back to Monday
    return { key: fmtDateInput(mon), label: mon.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
  }
  return { key: fmtDateInput(dt), label: dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
}

// Stacked productive/neutral/non-productive bars over time, fed by a list of
// ActivitySummary-shaped rows ({ summaryDate, activeSec, idleSec, productiveSec,
// neutralSec, nonProductiveSec }) — e.g. the `days` array /monitoring/summary
// already returns. Shared by the company dashboard and an individual employee's
// page, bucketed per day/week/month.
export default function TrendChart({ days, period = 'day' }) {
  const buckets = useMemo(() => {
    const map = new Map();
    for (const s of days || []) {
      const { key, label } = bucketFor(s.summaryDate, period);
      if (!map.has(key)) map.set(key, { key, label, activeSec: 0, idleSec: 0, productiveSec: 0, neutralSec: 0, nonProductiveSec: 0 });
      const b = map.get(key);
      b.activeSec += s.activeSec || 0;
      b.idleSec += s.idleSec || 0;
      b.productiveSec += s.productiveSec || 0;
      b.neutralSec += s.neutralSec || 0;
      b.nonProductiveSec += s.nonProductiveSec || 0;
    }
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [days, period]);

  if (buckets.length === 0) return <div className="p-6 text-gray-400 text-sm">No activity to chart.</div>;
  const max = Math.max(...buckets.map((b) => b.activeSec), 1);

  return (
    <div className="p-4">
      <div className="flex items-end gap-2 h-48 overflow-x-auto" style={{ minWidth: buckets.length * 40 }}>
        {buckets.map((b) => {
          const present = b.activeSec + b.idleSec;
          const pct = present > 0 ? Math.round((b.productiveSec / present) * 100) : 0;
          const h = (b.activeSec / max) * 100;
          const seg = (sec) => (b.activeSec > 0 ? `${(sec / b.activeSec) * 100}%` : '0%');
          return (
            <div key={b.key} className="flex-1 min-w-[28px] h-full flex flex-col justify-end items-center">
              <div className="text-[10px] text-gray-500 mb-0.5">{pct}%</div>
              <div className="w-full rounded-t overflow-hidden bg-gray-100 flex flex-col-reverse" style={{ height: `${h}%`, minHeight: 4 }}
                title={`${b.label} · ${fmtDur(b.activeSec)} active · ${pct}% productive`}>
                <div style={{ height: seg(b.productiveSec) }} className="bg-green-500" />
                <div style={{ height: seg(b.neutralSec) }} className="bg-gray-300" />
                <div style={{ height: seg(b.nonProductiveSec) }} className="bg-red-400" />
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex gap-2 mt-1 overflow-x-auto" style={{ minWidth: buckets.length * 40 }}>
        {buckets.map((b) => <div key={b.key} className="flex-1 min-w-[28px] text-center text-[10px] text-gray-400 whitespace-nowrap">{b.label}</div>)}
      </div>
      <div className="flex items-center gap-4 mt-3 text-xs text-gray-500 flex-wrap">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-green-500 inline-block" /> Productive</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-gray-300 inline-block" /> Neutral</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-red-400 inline-block" /> Non-productive</span>
        <span className="ml-auto">Bar height = active time · % = productivity</span>
      </div>
    </div>
  );
}
