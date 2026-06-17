import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import portalApi from '../portalApi';
import { usePortalAuth, isProvider as isProviderRole } from '../PortalAuthContext';

const STATUS_BADGE = {
  ACTIVE: 'bg-green-100 text-green-700',
  DISABLED: 'bg-gray-200 text-gray-600',
  RETIRED: 'bg-gray-200 text-gray-500',
};

const fmtSeen = (s) => {
  if (!s) return 'never';
  const d = new Date(s);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 14) return `${days}d ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

export default function PortalDevices() {
  const navigate = useNavigate();
  const { user } = usePortalAuth();
  const isProvider = isProviderRole(user.role);
  const isReadOnly = user.role === 'PROVIDER_VIEWER';

  const [devices, setDevices] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState('');
  const [search, setSearch] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await portalApi.get(`/monitoring/devices${isProvider && companyId ? `?organisationId=${companyId}` : ''}`);
      setDevices(r.data || []);
    } catch (e) { setError(e.response?.data?.error || 'Failed to load'); }
    finally { setLoading(false); }
  }, [isProvider, companyId]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (isProvider) portalApi.get('/orgs/organisations').then((r) => setCompanies(r.data || [])).catch(() => {});
  }, [isProvider]);

  const setStatus = async (d, status) => {
    if (status === 'DISABLED' && !window.confirm(`Retire "${d.deviceName}"? It drops out of the active list and stops counting toward licences. Its history is kept.`)) return;
    try { await portalApi.patch(`/monitoring/devices/${d.id}`, { status }); load(); }
    catch (e) { alert(e.response?.data?.error || 'Could not update the device.'); }
  };
  const rename = async (d) => {
    const name = window.prompt('Device name', d.deviceName);
    if (!name || !name.trim() || name.trim() === d.deviceName) return;
    try { await portalApi.patch(`/monitoring/devices/${d.id}`, { deviceName: name.trim() }); load(); }
    catch (e) { alert(e.response?.data?.error || 'Could not rename.'); }
  };

  const q = search.trim().toLowerCase();
  const visible = devices
    .filter((d) => (showRetired ? true : d.status !== 'RETIRED'))
    .filter((d) => !q || [d.deviceName, d.organisation?.name, ...(d.users || []).map((u) => u.name)].some((v) => (v || '').toLowerCase().includes(q)));
  const retiredCount = devices.filter((d) => d.status === 'RETIRED').length;

  return (
    <div className="max-w-6xl">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <h1 className="text-xl font-bold text-gray-800">Devices</h1>
        <div className="flex items-center gap-3 flex-wrap text-sm">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search devices…" className="rounded-lg border border-gray-300 px-3 py-1.5 w-48" />
          {isProvider && (
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5">
              <option value="">All companies</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          {retiredCount > 0 && (
            <label className="flex items-center gap-2 text-gray-600 cursor-pointer">
              <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired ({retiredCount})
            </label>
          )}
        </div>
      </div>

      <p className="text-sm text-gray-500 mb-4">Every PC running the agent. Each device's activity is automatically attributed to the user logged into it. If the same person shows two devices running at once, retiring the stale one keeps the device count tidy (their hours are de-duplicated either way).</p>

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-6 text-gray-400 text-sm">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="p-6 text-gray-400 text-sm">{devices.length === 0 ? 'No devices enrolled yet.' : 'No devices match your search.'}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Device</th>
                  {isProvider && <th className="text-left font-medium px-4 py-2">Company</th>}
                  <th className="text-left font-medium px-4 py-2">User(s)</th>
                  <th className="text-left font-medium px-4 py-2">Status</th>
                  <th className="text-left font-medium px-4 py-2">Last seen</th>
                  <th className="text-left font-medium px-4 py-2">Agent</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((d) => (
                  <tr key={d.id} className={`border-t border-gray-100 ${d.status !== 'ACTIVE' ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-2 font-medium text-gray-800">{d.deviceName}</td>
                    {isProvider && <td className="px-4 py-2 text-gray-600">{d.organisation?.name || '—'}</td>}
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        {(d.users || []).length === 0 ? <span className="text-gray-400">—</span> : d.users.map((u) => (
                          <button key={u.id} onClick={() => navigate(`/portal/employees/${u.id}`)}
                            className={`rounded-full px-2 py-0.5 text-xs ${u.isActive ? 'bg-teal-50 text-teal-700 hover:bg-teal-100' : 'bg-gray-100 text-gray-400'}`}>{u.name}</button>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2"><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[d.status] || 'bg-gray-100'}`}>{(d.status || '').toLowerCase()}</span></td>
                    <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{fmtSeen(d.lastSeenAt)}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs">{d.agentVersion || '—'}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {!isReadOnly && (
                        <>
                          <button onClick={() => rename(d)} className="text-xs text-gray-600 hover:underline mr-3">Rename</button>
                          {d.status === 'ACTIVE'
                            ? <button onClick={() => setStatus(d, 'DISABLED')} className="text-xs text-red-600 hover:underline">Retire</button>
                            : <button onClick={() => setStatus(d, 'ACTIVE')} className="text-xs text-teal-700 hover:underline">Restore</button>}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
