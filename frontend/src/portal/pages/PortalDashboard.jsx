import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import portalApi from '../portalApi';
import { fmtDur, fmtDateInput, pctColour } from '../portalUtils';

function Kpi({ label, value, sub }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-2xl font-bold text-gray-800 mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function PortalDashboard() {
  const navigate = useNavigate();
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const [fromDate, setFromDate] = useState(fmtDateInput(monthStart));
  const [toDate, setToDate] = useState(fmtDateInput(today));
  const [data, setData] = useState({ total: {}, employees: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true); setError('');
    portalApi.get(`/monitoring/summary?fromDate=${fromDate}&toDate=${toDate}`)
      .then((r) => setData(r.data || { total: {}, employees: [] }))
      .catch((e) => setError(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [fromDate, toDate]);

  const t = data.total || {};

  const exportCsv = async () => {
    const r = await portalApi.get(`/monitoring/export?fromDate=${fromDate}&toDate=${toDate}`, { responseType: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(r.data);
    a.download = `productivity-${fromDate}_to_${toDate}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="max-w-6xl">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold text-gray-800">Dashboard</h1>
        <div className="flex items-center gap-2 text-sm">
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1" />
          <span className="text-gray-400">→</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1" />
          <button onClick={exportCsv} className="ml-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-white px-3 py-1.5">
            Export CSV
          </button>
        </div>
      </div>

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Kpi label="Active" value={fmtDur(t.activeSec)} sub="office hours" />
        <Kpi label="Productive" value={fmtDur(t.productiveSec)} />
        <Kpi label="Productivity" value={`${t.productivityPct ?? 0}%`} sub="productive ÷ active" />
        <Kpi label="Overtime" value={fmtDur(t.overtimeSec)} sub={t.overtimeSec ? `${fmtDur(t.overtimeProductiveSec)} productive · ${t.overtimePct ?? 0}%` : 'outside office hours'} />
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 font-semibold text-gray-700 text-sm">People</div>
        {loading ? (
          <div className="p-6 text-gray-400 text-sm">Loading…</div>
        ) : data.employees.length === 0 ? (
          <div className="p-6 text-gray-400 text-sm">No activity in this range yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="text-left font-medium px-4 py-2">Employee</th>
                <th className="text-right font-medium px-4 py-2">Active</th>
                <th className="text-right font-medium px-4 py-2">Productive</th>
                <th className="text-right font-medium px-4 py-2">Overtime</th>
                <th className="text-right font-medium px-4 py-2">Productivity</th>
              </tr>
            </thead>
            <tbody>
              {data.employees.map((e) => (
                <tr key={e.employeeId}
                  onClick={() => navigate(`/portal/employees/${e.employeeId}`)}
                  className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer">
                  <td className="px-4 py-2 font-medium text-gray-800">{e.displayName}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{fmtDur(e.activeSec)}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{fmtDur(e.productiveSec)}</td>
                  <td className="px-4 py-2 text-right text-gray-600">
                    {fmtDur(e.overtimeSec)}
                    {e.overtimeSec > 0 && <div className="text-xs text-gray-400">{fmtDur(e.overtimeProductiveSec)} prod · {e.overtimePct ?? 0}%</div>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${pctColour(e.productivityPct)}`}>
                      {e.productivityPct}%
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
