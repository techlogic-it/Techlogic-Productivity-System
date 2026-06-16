import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import portalApi from '../portalApi';

// Provider business overview — how many companies use the product, how many
// people they monitor, when each renews, and the monthly revenue they bring in.
// (Deliberately NOT per-employee productivity — that lives on each company's pages.)

const gbp = (n) => (n == null ? null : `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`);

// Whole days from today (local midnight) to a date string. null if no date.
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const today = new Date();
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((a - b) / 86400000);
}

function RenewalCell({ dateStr }) {
  if (!dateStr) return <span className="text-gray-300">—</span>;
  const n = daysUntil(dateStr);
  const date = new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  let rel, klass;
  if (n < 0) { rel = `${-n}d overdue`; klass = 'text-red-600 font-semibold'; }
  else if (n === 0) { rel = 'today'; klass = 'text-red-600 font-semibold'; }
  else if (n <= 30) { rel = `in ${n}d`; klass = 'text-amber-600 font-medium'; }
  else { rel = `in ${n}d`; klass = 'text-gray-400'; }
  return <span>{date} <span className={`text-xs ${klass}`}>· {rel}</span></span>;
}

function Kpi({ label, value, sub }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-2xl font-bold text-gray-800 mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function PortalProviderDashboard() {
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    portalApi.get('/orgs/organisations')
      .then((r) => setOrgs(r.data || []))
      .catch((e) => setError(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const totalActive = orgs.reduce((s, o) => s + (o.monitoredUserCount || 0), 0);
  const monthlyRevenue = orgs.reduce((s, o) => s + (o.monthlyRevenue || 0), 0);
  const renewalsSoon = orgs.filter((o) => { const n = daysUntil(o.renewalDate); return n != null && n <= 30; }).length;
  const unpriced = orgs.filter((o) => o.monthlyRevenue == null).length;

  // Soonest renewal first; companies without a date sink to the bottom; then by name.
  const rows = [...orgs].sort((a, b) => {
    const da = daysUntil(a.renewalDate), db = daysUntil(b.renewalDate);
    if (da == null && db == null) return a.name.localeCompare(b.name);
    if (da == null) return 1;
    if (db == null) return -1;
    return da - db;
  });

  return (
    <div className="max-w-6xl">
      <h1 className="text-xl font-bold text-gray-800 mb-4">Overview</h1>
      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Kpi label="Companies" value={orgs.length} sub="using the product" />
        <Kpi label="Active people" value={totalActive} sub="monitored users" />
        <Kpi label="Monthly revenue" value={gbp(monthlyRevenue) ?? '£0'} sub={`${gbp(monthlyRevenue * 12) ?? '£0'} / year`} />
        <Kpi label="Renewals due" value={renewalsSoon} sub="within 30 days" />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 font-semibold text-gray-700 text-sm flex items-center justify-between">
          <span>Companies</span>
          {unpriced > 0 && <span className="text-xs font-normal text-amber-600">{unpriced} not priced yet — set a £/seat and renewal in Companies → Company details</span>}
        </div>
        {loading ? (
          <div className="p-6 text-gray-400 text-sm">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-gray-400 text-sm">No companies yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Company</th>
                  <th className="text-right font-medium px-3 py-2">Active people</th>
                  <th className="text-right font-medium px-3 py-2">Licences</th>
                  <th className="text-left font-medium px-3 py-2">Renewal</th>
                  <th className="text-right font-medium px-3 py-2">£/seat</th>
                  <th className="text-right font-medium px-3 py-2">Monthly revenue</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} onClick={() => navigate('/portal/admin')}
                    className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer">
                    <td className="px-3 py-2 font-medium text-gray-800">{o.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">{o.monitoredUserCount ?? 0}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-500">{o.seatLimit != null ? o.seatLimit : '∞'}</td>
                    <td className="px-3 py-2"><RenewalCell dateStr={o.renewalDate} /></td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-500">{o.pricePerSeat != null ? gbp(o.pricePerSeat) : (o.flatMonthlyFee != null ? 'flat' : '—')}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-gray-800">{gbp(o.monthlyRevenue) ?? <span className="text-amber-600 font-normal">unpriced</span>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold text-gray-700">
                  <td className="px-3 py-2">Total</td>
                  <td className="px-3 py-2 text-right tabular-nums">{totalActive}</td>
                  <td className="px-3 py-2"></td>
                  <td className="px-3 py-2"></td>
                  <td className="px-3 py-2"></td>
                  <td className="px-3 py-2 text-right tabular-nums">{gbp(monthlyRevenue) ?? '£0'}/mo</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
