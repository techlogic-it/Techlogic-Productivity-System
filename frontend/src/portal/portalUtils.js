export function pad(n) { return String(n).padStart(2, '0'); }

export function fmtDateInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtDur(sec) {
  if (!sec || sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// Productivity % → tailwind colour band.
export function pctColour(pct) {
  if (pct >= 70) return 'bg-green-100 text-green-700';
  if (pct >= 40) return 'bg-amber-100 text-amber-700';
  return 'bg-red-100 text-red-700';
}

export const WEIGHT_COLOUR = {
  PRODUCTIVE: 'bg-green-100 text-green-700',
  NEUTRAL: 'bg-gray-100 text-gray-600',
  NON_PRODUCTIVE: 'bg-red-100 text-red-700',
};
