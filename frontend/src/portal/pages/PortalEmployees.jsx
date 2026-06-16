import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import portalApi from '../portalApi';
import { usePortalAuth } from '../PortalAuthContext';

const CLAIM_BADGE = {
  CLAIMED: 'bg-green-100 text-green-700',
  PENDING: 'bg-amber-100 text-amber-700',
  UNMAPPED: 'bg-gray-200 text-gray-600',
};

export default function PortalEmployees() {
  const navigate = useNavigate();
  const { user, org } = usePortalAuth();
  const [employees, setEmployees] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // employee being mapped
  const [form, setForm] = useState({ displayName: '', groupId: '' });

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
      <h1 className="text-xl font-bold text-gray-800 mb-5">People</h1>
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-6 text-gray-400 text-sm">Loading…</div>
        ) : employees.length === 0 ? (
          <div className="p-6 text-gray-400 text-sm">No monitored people yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="text-left font-medium px-4 py-2">Name</th>
                <th className="text-left font-medium px-4 py-2">Department</th>
                <th className="text-left font-medium px-4 py-2">OS account</th>
                <th className="text-left font-medium px-4 py-2">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id} className={`border-t border-gray-100 ${e.isActive === false ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-2 font-medium text-gray-800">{e.displayName || <span className="text-gray-400">Unnamed</span>}</td>
                  <td className="px-4 py-2 text-gray-600">{e.group?.name || '—'}</td>
                  <td className="px-4 py-2 text-gray-500 font-mono text-xs">{e.localAccountKey || '—'}</td>
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
