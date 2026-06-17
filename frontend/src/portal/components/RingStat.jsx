// Donut-gauge stat — a value inside a coloured progress ring (work/active/idle
// style headline metrics). Pure SVG, no chart lib.

// Compact hours label for the ring centre (e.g. "16.5h", "42h", "45m").
export const hrsShort = (sec) => {
  const s = Math.max(0, sec || 0);
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const h = s / 3600;
  return h >= 10 ? `${Math.round(h)}h` : `${Math.round(h * 10) / 10}h`;
};

export function RingStat({ pct, color, value, label, sub }) {
  const size = 120, stroke = 12, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, pct || 0));
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 flex flex-col items-center">
      <div className="relative w-28 h-28">
        <svg viewBox={`0 0 ${size} ${size}`} className="w-full h-full -rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#eef2f7" strokeWidth={stroke} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={c * (1 - p)} style={{ transition: 'stroke-dashoffset .5s ease' }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-2xl font-bold text-gray-800 leading-none">{value}</div>
          <div className="text-[10px] uppercase tracking-wide text-gray-400 mt-1">{label}</div>
        </div>
      </div>
      {sub && <div className="text-xs text-gray-400 mt-2 text-center">{sub}</div>}
    </div>
  );
}

// Colour palette for the gauges.
export const RING = { active: '#3b82f6', productive: '#22c55e', idle: '#ef4444', productivity: '#14b8a6', overtime: '#0d9488' };
