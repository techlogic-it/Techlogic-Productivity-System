import { fmtDur } from '../portalUtils';

const WEIGHT_BAR = { PRODUCTIVE: 'bg-green-500', NEUTRAL: 'bg-gray-300', NON_PRODUCTIVE: 'bg-red-400' };
const WEIGHT_DOT = { PRODUCTIVE: 'bg-green-500', NEUTRAL: 'bg-gray-400', NON_PRODUCTIVE: 'bg-red-400' };
const catLabel = (c) => (c || 'Uncategorised').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

// Ranked horizontal bars for a list of {label, sec, weight, category, pct} rows
// — same visual language as the employee page's single-day app/site breakdown,
// reused here for period-aggregated (server-side) app/site usage.
export default function AppUsageBars({ apps, emptyText = 'No app activity recorded for this period.' }) {
  if (!apps || apps.length === 0) return <div className="p-6 text-gray-400 text-sm">{emptyText}</div>;
  return (
    <div className="p-4 space-y-2.5">
      {apps.map((a) => (
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
      <div className="flex items-center gap-4 pt-2 text-xs text-gray-500 border-t border-gray-100 mt-1 flex-wrap">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block" /> Productive</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-gray-300 inline-block" /> Neutral</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-red-400 inline-block" /> Non-productive</span>
        <span className="ml-auto">Bar = share of active time</span>
      </div>
    </div>
  );
}
