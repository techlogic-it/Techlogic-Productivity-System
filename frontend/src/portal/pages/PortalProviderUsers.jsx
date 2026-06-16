import { useState, useEffect, useCallback } from 'react';
import portalApi from '../portalApi';

// Internal Techlogic staff accounts. A PROVIDER_ADMIN manages these; scoped
// tiers (Support / read-only) are limited to the companies assigned here.

const TIERS = [
  { value: 'PROVIDER_VIEWER', label: 'View-only — read dashboards & timelines' },
  { value: 'PROVIDER_SUPPORT', label: 'Support — manage assigned companies (seats, key, installers, reset passwords)' },
  { value: 'PROVIDER_ADMIN', label: 'Provider Admin — all companies + manage provider users' },
];
const TIER_LABEL = { PROVIDER_ADMIN: 'Provider Admin', PROVIDER_SUPPORT: 'Support', PROVIDER_VIEWER: 'View-only' };
const TIER_BADGE = {
  PROVIDER_ADMIN: 'bg-teal-100 text-teal-700',
  PROVIDER_SUPPORT: 'bg-blue-100 text-blue-700',
  PROVIDER_VIEWER: 'bg-gray-100 text-gray-600',
};

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

// Checkbox list of companies a scoped provider user may reach.
function CompanyPicker({ orgs, selected, onChange }) {
  const toggle = (id) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="max-h-44 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
      {orgs.map((o) => (
        <label key={o.id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 cursor-pointer">
          <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} />
          <span className="text-gray-700">{o.name}</span>
        </label>
      ))}
      {orgs.length === 0 && <div className="px-3 py-2 text-sm text-gray-400">No companies yet.</div>}
    </div>
  );
}

const EMPTY = { name: '', email: '', role: 'PROVIDER_SUPPORT', organisationIds: [] };

export default function PortalProviderUsers() {
  const [users, setUsers] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [secret, setSecret] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [edit, setEdit] = useState(null);
  const [editForm, setEditForm] = useState({ role: 'PROVIDER_SUPPORT', organisationIds: [], isActive: true });
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [u, o] = await Promise.all([
      portalApi.get('/orgs/provider/users'),
      portalApi.get('/orgs/organisations'),
    ]);
    setUsers(u.data || []);
    setOrgs(o.data || []);
  }, []);
  useEffect(() => { load().catch((e) => setError(e.response?.data?.error || 'Failed to load')); }, [load]);

  const orgName = (id) => orgs.find((o) => o.id === id)?.name || '—';
  const inviteLink = (token) => `${window.location.origin}/portal/accept-invite?token=${token}`;

  const create = async () => {
    setError('');
    try {
      const payload = { ...form, organisationIds: form.role === 'PROVIDER_ADMIN' ? [] : form.organisationIds };
      const { data } = await portalApi.post('/orgs/provider/users', payload);
      if (data.inviteToken) setSecret({ label: `Invite link for ${data.user.email} — send it so they set a password`, value: inviteLink(data.inviteToken) });
      setForm(EMPTY); setShowNew(false); load();
    } catch (e) { setError(e.response?.data?.error || 'Could not create provider user'); }
  };

  const startEdit = (u) => {
    setEdit(u);
    setEditForm({ role: u.role, organisationIds: u.organisationIds || [], isActive: u.isActive });
  };
  const saveEdit = async () => {
    setError('');
    try {
      await portalApi.patch(`/orgs/provider/users/${edit.id}`, {
        role: editForm.role,
        organisationIds: editForm.role === 'PROVIDER_ADMIN' ? [] : editForm.organisationIds,
        isActive: editForm.isActive,
      });
      setEdit(null); load();
    } catch (e) { setError(e.response?.data?.error || 'Could not save'); }
  };
  const toggleActive = async (u) => {
    setError('');
    try { await portalApi.patch(`/orgs/provider/users/${u.id}`, { isActive: !u.isActive }); load(); }
    catch (e) { setError(e.response?.data?.error || 'Could not update'); }
  };
  const resetLink = async (u) => {
    const { data } = await portalApi.post(`/orgs/provider/users/${u.id}/invite`);
    setSecret({ label: `Reset link for ${u.email} — send it so they set a new password`, value: inviteLink(data.inviteToken) });
  };

  const input = 'rounded-lg border border-gray-300 px-3 py-2 text-sm';

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold text-gray-800">Provider users</h1>
        <button onClick={() => setShowNew((s) => !s)} className="rounded-lg bg-teal-600 text-white px-3 py-1.5 text-sm">{showNew ? 'Cancel' : '+ New provider user'}</button>
      </div>
      <p className="text-sm text-gray-500 mb-4">Techlogic staff who support customer companies. Assign each one the companies they may manage. They never appear inside a company's own user list.</p>

      <Reveal secret={secret} onClose={() => setSecret(null)} />
      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}

      {showNew && (
        <Section title="New provider user">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
            <input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={input} />
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className={`${input} col-span-2`}>
              {TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          {form.role !== 'PROVIDER_ADMIN' ? (
            <div className="mb-3">
              <div className="text-xs text-gray-500 mb-1">Companies this person can {form.role === 'PROVIDER_VIEWER' ? 'view' : 'manage'}</div>
              <CompanyPicker orgs={orgs} selected={form.organisationIds} onChange={(ids) => setForm({ ...form, organisationIds: ids })} />
            </div>
          ) : (
            <div className="mb-3 text-xs text-gray-500">Provider Admins reach every company automatically.</div>
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={create}
              disabled={!form.name.trim() || !form.email.trim() || (form.role !== 'PROVIDER_ADMIN' && form.organisationIds.length === 0)}
              className="rounded-lg bg-teal-600 disabled:opacity-50 text-white px-4 py-2 text-sm"
            >Create &amp; get invite link</button>
            {error && <span className="text-red-600 text-sm">{error}</span>}
          </div>
        </Section>
      )}

      <Section title="Team">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
              <th className="py-2 font-medium">Name</th>
              <th className="py-2 font-medium">Tier</th>
              <th className="py-2 font-medium">Companies</th>
              <th className="py-2 font-medium">Status</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-gray-50">
                <td className="py-2">
                  <div className="font-medium text-gray-800">{u.name}</div>
                  <div className="text-xs text-gray-400">{u.email}</div>
                </td>
                <td className="py-2">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${TIER_BADGE[u.role]}`}>{TIER_LABEL[u.role]}</span>
                </td>
                <td className="py-2 text-gray-600 text-xs max-w-xs">
                  {u.role === 'PROVIDER_ADMIN'
                    ? <span className="text-gray-400">All companies</span>
                    : (u.organisationIds?.length ? u.organisationIds.map(orgName).join(', ') : <span className="text-amber-600">None assigned</span>)}
                </td>
                <td className="py-2 text-xs">
                  {!u.isActive ? <span className="text-red-500">Disabled</span>
                    : u.passwordSetAt ? <span className="text-green-600">Active</span>
                    : <span className="text-gray-400">Invited</span>}
                </td>
                <td className="py-2 text-right whitespace-nowrap">
                  <button onClick={() => resetLink(u)} className="text-xs text-teal-700 hover:underline mr-3">{u.passwordSetAt ? 'Reset link' : 'Invite link'}</button>
                  <button onClick={() => startEdit(u)} className="text-xs text-gray-600 hover:underline mr-3">Edit</button>
                  <button onClick={() => toggleActive(u)} className="text-xs text-gray-500 hover:underline">{u.isActive ? 'Disable' : 'Enable'}</button>
                </td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={5} className="py-3 text-gray-400">No provider users yet.</td></tr>}
          </tbody>
        </table>
      </Section>

      {edit && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4" onClick={() => setEdit(null)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-5" onClick={(ev) => ev.stopPropagation()}>
            <div className="font-semibold text-gray-800 mb-1">Edit provider user</div>
            <div className="text-xs text-gray-500 mb-3">{edit.email}</div>
            <label className="block text-sm text-gray-600 mb-1">Tier</label>
            <select value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })} className={`${input} w-full mb-3`}>
              {TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            {editForm.role !== 'PROVIDER_ADMIN' ? (
              <div className="mb-3">
                <div className="text-xs text-gray-500 mb-1">Assigned companies</div>
                <CompanyPicker orgs={orgs} selected={editForm.organisationIds} onChange={(ids) => setEditForm({ ...editForm, organisationIds: ids })} />
              </div>
            ) : (
              <div className="mb-3 text-xs text-gray-500">Provider Admins reach every company automatically.</div>
            )}
            <label className="flex items-center gap-2 text-sm text-gray-600 mb-4">
              <input type="checkbox" checked={editForm.isActive} onChange={(e) => setEditForm({ ...editForm, isActive: e.target.checked })} />
              Active (can sign in)
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setEdit(null)} className="px-3 py-1.5 text-sm text-gray-600">Cancel</button>
              <button onClick={saveEdit} disabled={editForm.role !== 'PROVIDER_ADMIN' && editForm.organisationIds.length === 0} className="px-3 py-1.5 text-sm rounded-lg bg-teal-600 disabled:opacity-50 text-white">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
