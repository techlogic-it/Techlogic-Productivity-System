import { useState, useEffect, useCallback } from 'react';
import portalApi from '../portalApi';
import { usePortalAuth, isProvider as isProviderRole } from '../PortalAuthContext';

function Section({ title, children, action }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 mb-5">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <div className="font-semibold text-gray-700 text-sm">{title}</div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// One-time secret reveal (enrolment key / claim code / invite link).
function Reveal({ secret, onClose }) {
  if (!secret) return null;
  return (
    <div className="mb-4 rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 flex items-center justify-between">
      <div>
        <div className="text-xs text-amber-700 font-medium">{secret.label} — copy now, shown once</div>
        <code className="text-sm font-mono text-amber-900 break-all">{secret.value}</code>
      </div>
      <button onClick={onClose} className="text-amber-700 text-sm ml-3">Dismiss</button>
    </div>
  );
}

// Company-level login roles offered when inviting a user.
const ROLE_OPTIONS = [
  { value: 'ORG_ADMIN', label: 'Admin — full company control' },
  { value: 'MANAGER', label: 'Manager — all departments + manage staff' },
  { value: 'GROUP_ADMIN', label: 'Department Manager — one department only' },
  { value: 'VIEWER', label: 'Viewer — reports, read-only' },
];
const ROLE_LABEL = { PROVIDER_ADMIN: 'Provider Admin', ORG_ADMIN: 'Admin', MANAGER: 'Manager', GROUP_ADMIN: 'Department Manager', VIEWER: 'Viewer' };

const EMPTY_COMPANY = { name: '', address: '', phone: '', email: '', website: '', contactName: '', contactEmail: '', contactPhone: '', seatLimit: '', pricePerSeat: '', flatMonthlyFee: '', renewalDate: '' };

export default function PortalAdmin() {
  const { user, org } = usePortalAuth();
  const isProvider = isProviderRole(user.role);          // any Techlogic staff tier
  const isProviderAdmin = user.role === 'PROVIDER_ADMIN'; // create/delete companies
  const canManageSeats = user.role === 'PROVIDER_ADMIN' || user.role === 'PROVIDER_SUPPORT'; // seats + key rotation
  const isReadOnly = user.role === 'PROVIDER_VIEWER'; // can look, never change

  const [orgs, setOrgs] = useState([]);
  const [orgId, setOrgId] = useState(org?.id || '');
  const [groups, setGroups] = useState([]);
  const [users, setUsers] = useState([]);
  const [companyKey, setCompanyKey] = useState(null);
  const [secret, setSecret] = useState(null);
  const [copied, setCopied] = useState('');

  const [showNew, setShowNew] = useState(false);
  const [newCompany, setNewCompany] = useState(EMPTY_COMPANY);
  const [details, setDetails] = useState(EMPTY_COMPANY);
  const [detailsMsg, setDetailsMsg] = useState('');
  const [newDept, setNewDept] = useState({ name: '', managerName: '', managerEmail: '' });
  const [invite, setInvite] = useState({ email: '', name: '', role: 'VIEWER', groupId: '' });
  const [editUser, setEditUser] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', role: 'VIEWER', groupId: '' });
  const [editDept, setEditDept] = useState(null);
  const [editDeptForm, setEditDeptForm] = useState({ name: '', managerUserId: '' });

  const loadOrgs = useCallback(async () => {
    const r = await portalApi.get('/orgs/organisations');
    setOrgs(r.data || []);
    return r.data || [];
  }, []);

  useEffect(() => {
    loadOrgs().then((list) => { if (!orgId && list[0]) setOrgId(list[0].id); }).catch(() => {});
  }, []); // eslint-disable-line

  // Mirror the selected company's details into the editable form.
  useEffect(() => {
    const o = orgs.find((x) => x.id === orgId);
    if (o) {
      setDetails({
        name: o.name || '', address: o.address || '', phone: o.phone || '', email: o.email || '',
        website: o.website || '', contactName: o.contactName || '', contactEmail: o.contactEmail || '', contactPhone: o.contactPhone || '',
        seatLimit: o.seatLimit ?? '',
        pricePerSeat: o.pricePerSeat ?? '', flatMonthlyFee: o.flatMonthlyFee ?? '',
        renewalDate: o.renewalDate ? o.renewalDate.slice(0, 10) : '',
      });
      setDetailsMsg('');
    }
  }, [orgId, orgs]);

  const loadOrg = useCallback(async () => {
    if (!orgId) return;
    const [g, u, k] = await Promise.all([
      portalApi.get(`/orgs/organisations/${orgId}/groups`),
      portalApi.get(`/orgs/organisations/${orgId}/users`),
      portalApi.get(`/orgs/organisations/${orgId}/enrollment-key`),
    ]);
    setGroups(g.data || []); setUsers(u.data || []); setCompanyKey(k.data || null);
  }, [orgId]);

  useEffect(() => { loadOrg(); }, [loadOrg]);

  const createCompany = async () => {
    if (!newCompany.name.trim()) return;
    const { data } = await portalApi.post('/orgs/organisations', newCompany);
    setNewCompany(EMPTY_COMPANY); setShowNew(false);
    await loadOrgs(); setOrgId(data.id);
  };
  const saveDetails = async () => {
    setDetailsMsg('');
    try {
      await portalApi.patch(`/orgs/organisations/${orgId}`, details);
      setDetailsMsg('Saved'); await loadOrgs();
    } catch (e) {
      setDetailsMsg(e.response?.data?.error || 'Could not save');
    }
  };
  const deleteCompany = async (o) => {
    if (!window.confirm(`Permanently delete "${o.name}" and ALL its data (devices, users, activity)? This cannot be undone.`)) return;
    try {
      await portalApi.delete(`/orgs/organisations/${o.id}`);
      const list = await loadOrgs();
      if (orgId === o.id) setOrgId(list[0]?.id || '');
    } catch (e) {
      alert(e.response?.data?.error || 'Could not delete the company.');
    }
  };
  const addDepartment = async () => {
    if (!newDept.name.trim()) return;
    const { data: dept } = await portalApi.post(`/orgs/organisations/${orgId}/groups`, { name: newDept.name.trim() });
    // Optionally invite a department manager (scoped to this department only).
    if (newDept.managerName.trim() && newDept.managerEmail.trim()) {
      const { data } = await portalApi.post(`/orgs/organisations/${orgId}/users`, {
        name: newDept.managerName.trim(), email: newDept.managerEmail.trim(), role: 'GROUP_ADMIN', groupId: dept.id,
      });
      if (data.inviteToken) {
        const link = `${window.location.origin}/portal/accept-invite?token=${data.inviteToken}`;
        setSecret({ label: `Invite link for ${data.user.email} — manager of "${dept.name}", send it so they set a password`, value: link });
      }
    }
    setNewDept({ name: '', managerName: '', managerEmail: '' });
    loadOrg();
  };
  const sendInvite = async () => {
    if (!invite.email || !invite.name) return;
    const { data } = await portalApi.post(`/orgs/organisations/${orgId}/users`, invite);
    setInvite({ email: '', name: '', role: 'VIEWER', groupId: '' });
    if (data.inviteToken) {
      const link = `${window.location.origin}/portal/accept-invite?token=${data.inviteToken}`;
      setSecret({ label: `Invite link for ${data.user.email} — send it so they set a password`, value: link });
    }
    loadOrg();
  };
  const resendInvite = async (u) => {
    const { data } = await portalApi.post(`/orgs/organisations/${orgId}/users/${u.id}/invite`);
    const link = `${window.location.origin}/portal/accept-invite?token=${data.inviteToken}`;
    setSecret({ label: `Invite link for ${u.email} — send it so they set a password`, value: link });
  };
  const startEditDept = (g) => {
    const mgr = users.find((u) => u.role === 'GROUP_ADMIN' && u.groupId === g.id);
    setEditDept(g);
    setEditDeptForm({ name: g.name || '', managerUserId: mgr ? mgr.id : '' });
  };
  const saveDept = async () => {
    try {
      const name = editDeptForm.name.trim();
      if (name && name !== editDept.name) {
        await portalApi.patch(`/orgs/organisations/${orgId}/groups/${editDept.id}`, { name });
      }
      const currentMgr = users.find((u) => u.role === 'GROUP_ADMIN' && u.groupId === editDept.id);
      if ((currentMgr?.id || '') !== editDeptForm.managerUserId) {
        await portalApi.put(`/orgs/organisations/${orgId}/groups/${editDept.id}/manager`, { userId: editDeptForm.managerUserId || null });
      }
      setEditDept(null); loadOrg();
    } catch (e) { alert(e.response?.data?.error || 'Could not save'); }
  };
  const deleteDept = async () => {
    if (!window.confirm(`Delete department "${editDept.name}"?\n\nIts people move to "no department" and a department manager becomes a viewer. This cannot be undone.`)) return;
    try {
      await portalApi.delete(`/orgs/organisations/${orgId}/groups/${editDept.id}`);
      setEditDept(null); loadOrg();
    } catch (e) { alert(e.response?.data?.error || 'Could not delete'); }
  };
  const startEditUser = (u) => { setEditUser(u); setEditForm({ name: u.name || '', role: u.role, groupId: u.groupId || '' }); };
  const saveUser = async () => {
    try {
      await portalApi.patch(`/orgs/organisations/${orgId}/users/${editUser.id}`, {
        name: editForm.name, role: editForm.role, groupId: editForm.groupId || null,
      });
      setEditUser(null); loadOrg();
    } catch (e) { alert(e.response?.data?.error || 'Could not save'); }
  };
  const regenerateKey = async () => {
    if (!window.confirm('Regenerate the company key?\n\nThe current key stops working IMMEDIATELY. Every installer (.bat) already handed out for this company will stop being able to enrol new machines until you re-issue it. Already-enrolled agents keep working.\n\nAre you sure?')) return;
    const { data } = await portalApi.post(`/orgs/organisations/${orgId}/enrollment-key/regenerate`);
    setCompanyKey(data);
  };
  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what); setTimeout(() => setCopied(''), 1500);
    } catch { /* clipboard unavailable (e.g. non-secure context) */ }
  };
  const downloadBat = async (path, filename) => {
    const res = await portalApi.get(path, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };
  const downloadInstaller = () => downloadBat(`/orgs/organisations/${orgId}/installer.bat`, 'install-techlogic-productivity.bat');
  const downloadUninstaller = () => downloadBat(`/orgs/organisations/${orgId}/uninstaller.bat`, 'uninstall-techlogic-productivity.bat');
  const setDefaultGroup = async (groupId) => {
    const { data } = await portalApi.put(`/orgs/organisations/${orgId}/enrollment-key`, { defaultGroupId: groupId || null });
    setCompanyKey(data);
    loadOrg(); // refresh people — ungrouped users were back-filled into the group
  };
  const input = 'rounded-lg border border-gray-300 px-3 py-2 text-sm';
  const selectedOrg = orgs.find((o) => o.id === orgId);
  const field = (label, key, type = 'text') => (
    <label className="block">
      <span className="block text-xs text-gray-500 mb-1">{label}</span>
      <input type={type} value={newCompany[key]} onChange={(e) => setNewCompany({ ...newCompany, [key]: e.target.value })} className={`${input} w-full`} />
    </label>
  );

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-gray-800">{isProvider ? 'Companies' : 'Admin'}</h1>
          {selectedOrg?.seatLimit != null && (
            <span className={`text-sm font-medium rounded-lg px-3 py-1 ${(selectedOrg.monitoredUserCount ?? 0) >= selectedOrg.seatLimit ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
              {selectedOrg.monitoredUserCount ?? 0} of {selectedOrg.seatLimit} seats used
            </span>
          )}
        </div>
        {isProvider && orgs.length > 0 && (
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className={input}>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
      </div>

      <Reveal secret={secret} onClose={() => setSecret(null)} />

      {isProvider && (
        <Section
          title="Companies"
          action={isProviderAdmin && <button onClick={() => setShowNew((s) => !s)} className="rounded-lg bg-teal-600 text-white px-3 py-1.5 text-sm">{showNew ? 'Cancel' : '+ New company'}</button>}
        >
          {isProviderAdmin && showNew && (
            <div className="mb-5 rounded-lg border border-gray-200 p-4 bg-gray-50">
              <div className="grid grid-cols-2 gap-3">
                {field('Company name *', 'name')}
                {field('Website', 'website')}
                <label className="block col-span-2">
                  <span className="block text-xs text-gray-500 mb-1">Address</span>
                  <textarea value={newCompany.address} onChange={(e) => setNewCompany({ ...newCompany, address: e.target.value })} rows={2} className={`${input} w-full`} />
                </label>
                {field('Company phone', 'phone')}
                {field('Company email', 'email', 'email')}
                <div className="col-span-2 text-xs font-medium text-gray-500 mt-1">Key contact</div>
                {field('Contact name', 'contactName')}
                {field('Contact email', 'contactEmail', 'email')}
                {field('Contact phone', 'contactPhone')}
              </div>
              <button onClick={createCompany} disabled={!newCompany.name.trim()} className="mt-4 rounded-lg bg-teal-600 disabled:opacity-50 text-white px-4 py-2 text-sm">Create company</button>
            </div>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                <th className="py-2 font-medium">Company</th>
                <th className="py-2 font-medium text-right">Monitored users</th>
                <th className="py-2 font-medium text-right">Active devices</th>
                <th className="py-2 font-medium text-right">Admins</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id} className={`border-b border-gray-50 ${o.id === orgId ? 'bg-teal-50' : 'hover:bg-gray-50'}`}>
                  <td className="py-2 font-medium text-gray-800 cursor-pointer" onClick={() => setOrgId(o.id)}>{o.name}</td>
                  <td className="py-2 text-right tabular-nums cursor-pointer" onClick={() => setOrgId(o.id)}>
                    <span className={o.seatLimit != null && (o.monitoredUserCount ?? 0) >= o.seatLimit ? 'text-red-600 font-semibold' : ''}>
                      {o.monitoredUserCount ?? 0}{o.seatLimit != null ? ` / ${o.seatLimit}` : ''}
                    </span>
                  </td>
                  <td className="py-2 text-right tabular-nums text-gray-600 cursor-pointer" onClick={() => setOrgId(o.id)}>{o.activeDeviceCount ?? 0}</td>
                  <td className="py-2 text-right tabular-nums text-gray-500 cursor-pointer" onClick={() => setOrgId(o.id)}>{o._count?.portalUsers ?? 0}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {o.id === orgId && <span className="text-xs text-teal-700 font-medium mr-3">Managing</span>}
                    {isProviderAdmin && <button onClick={() => deleteCompany(o)} className="text-xs text-red-600 hover:underline">Delete</button>}
                  </td>
                </tr>
              ))}
              {orgs.length === 0 && <tr><td colSpan={5} className="py-3 text-gray-400">No companies yet.</td></tr>}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-gray-400">Click a company to manage it below. Delete is blocked until all active monitoring devices are retired.</p>
        </Section>
      )}

      {/* Company details — editable for the selected company (admins). */}
      <Section title="Company details">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs text-gray-500 mb-1">Company name</span>
            <input value={details.name} onChange={(e) => setDetails({ ...details, name: e.target.value })} className={`${input} w-full`} />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-500 mb-1">Website</span>
            <input value={details.website} onChange={(e) => setDetails({ ...details, website: e.target.value })} className={`${input} w-full`} />
          </label>
          <label className="block col-span-2">
            <span className="block text-xs text-gray-500 mb-1">Address</span>
            <textarea value={details.address} onChange={(e) => setDetails({ ...details, address: e.target.value })} rows={2} className={`${input} w-full`} />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-500 mb-1">Company phone</span>
            <input value={details.phone} onChange={(e) => setDetails({ ...details, phone: e.target.value })} className={`${input} w-full`} />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-500 mb-1">Company email</span>
            <input value={details.email} onChange={(e) => setDetails({ ...details, email: e.target.value })} className={`${input} w-full`} />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-500 mb-1">Key contact name</span>
            <input value={details.contactName} onChange={(e) => setDetails({ ...details, contactName: e.target.value })} className={`${input} w-full`} />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-500 mb-1">Contact email</span>
            <input value={details.contactEmail} onChange={(e) => setDetails({ ...details, contactEmail: e.target.value })} className={`${input} w-full`} />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-500 mb-1">Contact phone</span>
            <input value={details.contactPhone} onChange={(e) => setDetails({ ...details, contactPhone: e.target.value })} className={`${input} w-full`} />
          </label>
          {canManageSeats && (
            <label className="block col-span-2 border-t border-gray-100 pt-3 mt-1">
              <span className="block text-xs text-gray-500 mb-1">Licence — max monitored users (seats). Blank = unlimited. New users beyond this aren't monitored until a seat is freed.</span>
              <input type="number" min="0" placeholder="Unlimited" value={details.seatLimit} onChange={(e) => setDetails({ ...details, seatLimit: e.target.value })} className={`${input} w-40`} />
            </label>
          )}
          {canManageSeats && (
            <div className="col-span-2 grid grid-cols-3 gap-3">
              <label className="block">
                <span className="block text-xs text-gray-500 mb-1">Price per seat (£/month)</span>
                <input type="number" min="0" step="0.01" placeholder="—" value={details.pricePerSeat} onChange={(e) => setDetails({ ...details, pricePerSeat: e.target.value })} className={`${input} w-full`} />
              </label>
              {(details.seatLimit === '' || details.seatLimit == null) && (
                <label className="block">
                  <span className="block text-xs text-gray-500 mb-1">Flat fee (£/month, unlimited seats)</span>
                  <input type="number" min="0" step="0.01" placeholder="—" value={details.flatMonthlyFee} onChange={(e) => setDetails({ ...details, flatMonthlyFee: e.target.value })} className={`${input} w-full`} />
                </label>
              )}
              <label className="block">
                <span className="block text-xs text-gray-500 mb-1">Renewal date</span>
                <input type="date" value={details.renewalDate} onChange={(e) => setDetails({ ...details, renewalDate: e.target.value })} className={`${input} w-full`} />
              </label>
              <div className="col-span-3 text-xs text-gray-400">
                {details.seatLimit !== '' && details.pricePerSeat !== ''
                  ? `Monthly revenue = £${(Number(details.pricePerSeat) * Number(details.seatLimit)).toLocaleString('en-GB')} (£${details.pricePerSeat}/seat × ${details.seatLimit} licences).`
                  : 'Monthly revenue = price per seat × licences (or the flat fee when seats are unlimited).'}
              </div>
            </div>
          )}
        </div>
        {!isReadOnly && (
          <div className="flex items-center gap-3 mt-4">
            <button onClick={saveDetails} className="rounded-lg bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 text-sm">Save details</button>
            {detailsMsg && <span className={`text-sm ${detailsMsg === 'Saved' ? 'text-green-600' : 'text-red-600'}`}>{detailsMsg}</span>}
          </div>
        )}
      </Section>

      {/* Departments + company logins are the company's OWN administration — hidden
          from the provider console (which only supports companies, never runs them). */}
      {!isProvider && (<>
      <Section title="Departments">
        <div className="grid grid-cols-3 gap-2 mb-2">
          <input placeholder="Department name *" value={newDept.name} onChange={(e) => setNewDept({ ...newDept, name: e.target.value })} className={input} />
          <input placeholder="Manager name" value={newDept.managerName} onChange={(e) => setNewDept({ ...newDept, managerName: e.target.value })} className={input} />
          <input placeholder="Manager email" value={newDept.managerEmail} onChange={(e) => setNewDept({ ...newDept, managerEmail: e.target.value })} className={input} />
        </div>
        <div className="flex items-center gap-2 mb-3">
          <button onClick={addDepartment} disabled={!newDept.name.trim()} className="rounded-lg bg-teal-600 disabled:opacity-50 text-white px-3 py-1.5 text-sm">Add department</button>
          <span className="text-xs text-gray-400">A manager (optional) sees only their own department's productivity.</span>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {groups.map((g) => {
              const mgr = users.find((u) => u.role === 'GROUP_ADMIN' && u.groupId === g.id);
              return (
                <tr key={g.id} className="border-t border-gray-100">
                  <td className="py-2 font-medium text-gray-800">{g.name}</td>
                  <td className="py-2 text-gray-500">{mgr ? `Manager: ${mgr.name}` : <span className="text-gray-400">No manager</span>}</td>
                  <td className="py-2 text-right">
                    <button onClick={() => startEditDept(g)} className="text-xs text-gray-600 hover:underline">Edit</button>
                  </td>
                </tr>
              );
            })}
            {groups.length === 0 && <tr><td className="py-2 text-sm text-gray-400">No departments yet.</td></tr>}
          </tbody>
        </table>
      </Section>

      <Section title="Users (authorised logins)">
        <div className="grid grid-cols-2 gap-2 mb-3">
          <input placeholder="Name" value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} className={input} />
          <input placeholder="Email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} className={input} />
          <select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })} className={`${input} col-span-2`}>
            {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          {(invite.role === 'VIEWER' || invite.role === 'GROUP_ADMIN') && (
            <select value={invite.groupId} onChange={(e) => setInvite({ ...invite, groupId: e.target.value })} className={`${input} col-span-2`}>
              <option value="">{invite.role === 'GROUP_ADMIN' ? 'Select department…' : 'Whole company'}</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{invite.role === 'GROUP_ADMIN' ? g.name : `Only: ${g.name}`}</option>)}
            </select>
          )}
        </div>
        <button onClick={sendInvite} disabled={invite.role === 'GROUP_ADMIN' && !invite.groupId} className="rounded-lg bg-teal-600 disabled:opacity-50 text-white px-3 py-1.5 text-sm mb-3">Invite</button>
        <table className="w-full text-sm">
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-gray-100">
                <td className="py-2 font-medium text-gray-800">{u.name}</td>
                <td className="py-2 text-gray-500">{u.email}</td>
                <td className="py-2 text-gray-600">{ROLE_LABEL[u.role] || u.role}</td>
                <td className="py-2 text-right text-xs text-gray-400">{u.passwordSetAt ? 'active' : 'invited'}</td>
                <td className="py-2 text-right whitespace-nowrap">
                  {!u.passwordSetAt && (
                    <button onClick={() => resendInvite(u)} className="text-xs text-teal-700 hover:underline mr-3">Copy invite link</button>
                  )}
                  <button onClick={() => startEditUser(u)} className="text-xs text-gray-600 hover:underline">Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      </>)}

      {/* Provider support: read the company's logins and reset a forgotten password,
          without taking over the company's own user administration. */}
      {isProvider && (
        <Section title="Company logins (support)">
          <p className="text-xs text-gray-500 mb-3">The company manages its own logins. As provider support you can re-issue a password link if someone is locked out.</p>
          <table className="w-full text-sm">
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-gray-100">
                  <td className="py-2 font-medium text-gray-800">{u.name}</td>
                  <td className="py-2 text-gray-500">{u.email}</td>
                  <td className="py-2 text-gray-600">{ROLE_LABEL[u.role] || u.role}</td>
                  <td className="py-2 text-right text-xs text-gray-400">{u.passwordSetAt ? 'active' : 'invited'}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {!isReadOnly && <button onClick={() => resendInvite(u)} className="text-xs text-teal-700 hover:underline">{u.passwordSetAt ? 'Reset password link' : 'Copy invite link'}</button>}
                  </td>
                </tr>
              ))}
              {users.length === 0 && <tr><td className="py-2 text-sm text-gray-400">No company logins yet.</td></tr>}
            </tbody>
          </table>
        </Section>
      )}

      <Section title="Company enrolment key">
        {!companyKey ? (
          <div className="text-sm text-gray-400">Loading…</div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="text-xs text-gray-500 mb-1">One key for this company — the installer carries it. Shown in full so you can copy it anytime.</div>
              <div className="flex gap-2">
                <code className="flex-1 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-sm font-mono break-all">{companyKey.enrollmentKey}</code>
                <button onClick={() => copy(companyKey.enrollmentKey, 'key')} className="shrink-0 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 text-sm">{copied === 'key' ? 'Copied' : 'Copy'}</button>
              </div>
            </div>
            {!isProvider && (
              <div>
                <div className="text-xs text-gray-500 mb-1">Default department — new machines (and currently unassigned users) automatically join this department.</div>
                <select value={companyKey.defaultGroupId || ''} onChange={(e) => setDefaultGroup(e.target.value)} className={input}>
                  <option value="">No default department</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
            )}
            <div>
              <div className="text-xs text-gray-500 mb-1">One-click installer — hand this to the user (downloads the agent, installs it, autostarts at login). No admin needed.</div>
              <div className="flex gap-2">
                <button onClick={downloadInstaller} className="rounded-lg bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 text-sm font-medium">Download installer (.bat)</button>
                <button onClick={downloadUninstaller} className="rounded-lg border border-gray-300 hover:bg-gray-50 text-gray-700 px-4 py-2 text-sm">Download uninstaller (.bat)</button>
              </div>
            </div>
            {canManageSeats && (
              <div className="flex items-center gap-3 pt-1 border-t border-gray-100">
                <button onClick={regenerateKey} className="mt-3 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 px-3 py-1.5 text-sm">Regenerate key</button>
                <span className="mt-3 text-xs text-gray-400">Provider staff only. Rotating immediately invalidates the old key; every deployed installer must be re-issued.</span>
              </div>
            )}
          </div>
        )}
      </Section>

      {editUser && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4" onClick={() => setEditUser(null)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-sm p-5" onClick={(ev) => ev.stopPropagation()}>
            <div className="font-semibold text-gray-800 mb-1">Edit user</div>
            <div className="text-xs text-gray-500 mb-3">{editUser.email}</div>
            <label className="block text-sm text-gray-600 mb-1">Name</label>
            <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className={`${input} w-full mb-3`} />
            <label className="block text-sm text-gray-600 mb-1">Role</label>
            <select value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })} className={`${input} w-full mb-3`}>
              {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            {(editForm.role === 'GROUP_ADMIN' || editForm.role === 'VIEWER') && (
              <>
                <label className="block text-sm text-gray-600 mb-1">Department</label>
                <select value={editForm.groupId} onChange={(e) => setEditForm({ ...editForm, groupId: e.target.value })} className={`${input} w-full mb-4`}>
                  <option value="">{editForm.role === 'GROUP_ADMIN' ? 'Select department…' : 'Whole company'}</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditUser(null)} className="px-3 py-1.5 text-sm text-gray-600">Cancel</button>
              <button onClick={saveUser} disabled={editForm.role === 'GROUP_ADMIN' && !editForm.groupId} className="px-3 py-1.5 text-sm rounded-lg bg-teal-600 disabled:opacity-50 text-white">Save</button>
            </div>
          </div>
        </div>
      )}

      {editDept && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4" onClick={() => setEditDept(null)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-sm p-5" onClick={(ev) => ev.stopPropagation()}>
            <div className="font-semibold text-gray-800 mb-3">Edit department</div>
            <label className="block text-sm text-gray-600 mb-1">Name</label>
            <input value={editDeptForm.name} onChange={(e) => setEditDeptForm({ ...editDeptForm, name: e.target.value })} className={`${input} w-full mb-3`} />
            <label className="block text-sm text-gray-600 mb-1">Manager</label>
            <select value={editDeptForm.managerUserId} onChange={(e) => setEditDeptForm({ ...editDeptForm, managerUserId: e.target.value })} className={`${input} w-full mb-1`}>
              <option value="">No manager</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
            </select>
            <div className="text-xs text-gray-400 mb-4">The manager sees only this department's productivity. Switching managers makes the previous one a department viewer.</div>
            <div className="flex justify-between items-center">
              <button onClick={deleteDept} className="px-3 py-1.5 text-sm text-red-600 hover:underline">Delete</button>
              <div className="flex gap-2">
                <button onClick={() => setEditDept(null)} className="px-3 py-1.5 text-sm text-gray-600">Cancel</button>
                <button onClick={saveDept} disabled={!editDeptForm.name.trim()} className="px-3 py-1.5 text-sm rounded-lg bg-teal-600 disabled:opacity-50 text-white">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
