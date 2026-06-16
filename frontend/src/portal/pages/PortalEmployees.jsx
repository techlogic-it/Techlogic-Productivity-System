import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import portalApi from '../portalApi';
import { usePortalAuth, isProvider as isProviderRole } from '../PortalAuthContext';

const CLAIM_BADGE = {
  CLAIMED: 'bg-green-100 text-green-700',
  PENDING: 'bg-amber-100 text-amber-700',
  UNMAPPED: 'bg-gray-200 text-gray-600',
};

// When the agent was installed for this person — the device enrolment date,
// falling back to when we first captured the account.
const installedAt = (e) => e.primaryDevice?.enrolledAt || e.createdAt || null;
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export default function PortalEmployees() {
  const navigate = useNavigate();
  const { user, org } = usePortalAuth();
  const [employees, setEmployees] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // employee being mapped
  const [form, setForm] = useState({ displayName: '', groupId: '' });
  const [showRemoved, setShowRemoved] = useState(false);
  const [search, setSearch] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');

  const isProvider = isProviderRole(user.role);

  const removedCount = employees.filter((e) => e.isActive === false).length;
  const usedSeats = employees.length - removedCount;
  // Companies present in the list (provider spans several) — drives the filter.
  const companies = isProvider
    ? [...new Map(employees.filter((e) => e.organisation).map((e) => [e.organisation.id, e.organisation])).values()].sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const q = search.trim().toLowerCase();
  const visible = employees
    .filter((e) => (showRemoved ? true : e.isActive !== false))
    .filter((e) => (companyFilter ? e.organisationId === companyFilter : true))
    .filter((e) => !q || [e.displayName, e.localAccountKey, e.organisation?.name, e.group?.name].some((v) => (v || '').toLowerCase().includes(q)))
    // Newest installs first, so the latest people are easy to spot.
    .sort((a, b) => new Date(installedAt(b) || 0) - new Date(installedAt(a) || 0));
  // Seat usage only makes sense for whole-company roles (their list is the whole org).
  const showSeats = org?.seatLimit != null && (user.role === 'ORG_ADMIN' || user.role === 'MANAGER');
  const atLimit = showSeats && usedSeats >= org.seatLimit;

  const load = useCallback(async () => {
    setLoading(true);
    const r = await portalApi.get('/monitoring/employees');
    setEmployees(r.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const orgId = org?.id;
    if (!orgId) return;
    portalApi.get(`/orgs/organisations/${orgId}/groups`).then((r) => setGroups(r.data || [])).catch(() => {});
  }, [org]);

  const startMap = (e) => {
    setEditing(e.id);
    setForm({ displayName: e.displayName || '', groupId: e.groupId || '' });
  };

  const saveMap = async () => {
    await portalApi.patch(`/monitoring/employees/${editing}`, {
      displayName: form.displayName,
      ...(user.role === 'GROUP_ADMIN' ? {} : { groupId: form.groupId || null }),
    });
    setEditing(null);
    load();
  };

  // Remove frees a licence seat (their PC stops being monitored); restore takes one.
  const setActive = async (e, isActive) => {
    if (!isActive && !window.confirm(`Remove "${e.displayName || e.localAccountKey}" from monitoring? This drops their device from the system, frees a licence seat, and stops monitoring that PC.`)) return;
    try {
      await portalApi.patch(`/monitoring/employees/${e.id}`, { isActive });
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Could not update.');
    }
  };

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <h1 className="text-xl font-bold text-gray-800">People</h1>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search people…"
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm w-48"
          />
          {isProvider && companies.length > 0 && (
            <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
              <option value="">All companies</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          {showSeats && (
            <span className={`text-sm font-medium rounded-lg px-3 py-1 ${atLimit ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
              {usedSeats} of {org.seatLimit} seats used{atLimit ? ' — limit reached' : ''}
            </span>
          )}
          {removedCount > 0 && (
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
              <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
              Show removed ({removedCount})
            </label>
          )}
        </div>
      </div>
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-6 text-gray-400 text-sm">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="p-6 text-gray-400 text-sm">{employees.length === 0 ? 'No monitored people yet.' : (q || companyFilter) ? 'No people match your search/filter.' : 'No active people. Tick “Show removed” to see removed users.'}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="text-left font-medium px-4 py-2">Name</th>
                {isProvider && <th className="text-left font-medium px-4 py-2">Company</th>}
                <th className="text-left font-medium px-4 py-2">Department</th>
                <th className="text-left font-medium px-4 py-2">OS account</th>
                <th className="text-left font-medium px-4 py-2">Installed</th>
                <th className="text-left font-medium px-4 py-2">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <tr key={e.id} className={`border-t border-gray-100 ${e.isActive === false ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-2 font-medium text-gray-800">{e.displayName || <span className="text-gray-400">Unnamed</span>}</td>
                  {isProvider && <td className="px-4 py-2 text-gray-600">{e.organisation?.name || '—'}</td>}
                  <td className="px-4 py-2 text-gray-600">{e.group?.name || '—'}</td>
                  <td className="px-4 py-2 text-gray-500 font-mono text-xs">{e.localAccountKey || '—'}</td>
                  <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{fmtDate(installedAt(e))}</td>
                  <td className="px-4 py-2">
                    {e.isActive === false ? (
                      <span className="inline-block rounded-full px-2 py-0.5 text-xs font-semibold bg-gray-200 text-gray-600">Removed (seat freed)</span>
                    ) : (
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${CLAIM_BADGE[e.claimStatus] || 'bg-gray-100'}`}>{e.claimStatus}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {e.isActive === false ? (
                      <button onClick={() => setActive(e, true)} className="text-teal-700 hover:underline">Restore</button>
                    ) : (
                      <>
                        <button onClick={() => navigate(`/portal/employees/${e.id}`)} className="text-teal-700 hover:underline mr-3">View</button>
                        <button onClick={() => startMap(e)} className="text-gray-600 hover:underline mr-3">Map</button>
                        <button onClick={() => setActive(e, false)} className="text-red-600 hover:underline">Remove</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-sm p-5" onClick={(ev) => ev.stopPropagation()}>
            <div className="font-semibold text-gray-800 mb-3">Map person</div>
            <label className="block text-sm text-gray-600 mb-1">Display name</label>
            <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              className="w-full mb-3 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            {user.role !== 'GROUP_ADMIN' && (
              <>
                <label className="block text-sm text-gray-600 mb-1">Department</label>
                <select value={form.groupId} onChange={(e) => setForm({ ...form, groupId: e.target.value })}
                  className="w-full mb-4 rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  <option value="">— none —</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm text-gray-600">Cancel</button>
              <button onClick={saveMap} className="px-3 py-1.5 text-sm rounded-lg bg-teal-600 text-white">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
