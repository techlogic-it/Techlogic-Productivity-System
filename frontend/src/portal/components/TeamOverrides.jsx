import { useState, useEffect, useCallback } from 'react';
import portalApi from '../portalApi';

const DAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['7', 'Sun']];
const DAY_NAME = Object.fromEntries(DAYS);
const field = 'rounded-lg border border-gray-300 px-2 py-1.5 text-sm';

// "1,2,3,4,5" -> "Mon–Fri", "1,3,5" -> "Mon, Wed, Fri"
function daysText(csv) {
  const n = String(csv || '').split(',').filter(Boolean).map(Number).sort((a, b) => a - b);
  if (n.length === 0) return 'no days';
  const consecutive = n.every((d, i) => i === 0 || d === n[i - 1] + 1);
  if (consecutive && n.length > 2) return `${DAY_NAME[n[0]]}–${DAY_NAME[n[n.length - 1]]}`;
  return n.map((d) => DAY_NAME[d]).join(', ');
}

// Per-team overrides of the company's office hours and screenshot setting. A team
// that doesn't set anything inherits the company's values, shown alongside.
export default function TeamOverrides({ orgId, q, company }) {
  const [groups, setGroups] = useState([]);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    if (!orgId) return;
    portalApi.get(`/orgs/organisations/${orgId}/groups`).then((r) => setGroups(r.data || [])).catch(() => setGroups([]));
  }, [orgId]);
  useEffect(() => { load(); }, [load]);

  const companyHours = `${company.officeStart}–${company.officeEnd}, ${daysText(company.workingDays)}`;
  const companyShots = company.screenshotsEnabled ? 'on' : 'off';

  const startEdit = (g) => {
    setError(''); setMsg('');
    setEditId(g.id);
    setForm({
      customHours: !!(g.officeStart && g.officeEnd && g.workingDays),
      officeStart: g.officeStart || company.officeStart,
      officeEnd: g.officeEnd || company.officeEnd,
      workingDays: g.workingDays || company.workingDays,
      screenshots: g.screenshotsEnabled === true ? 'on' : g.screenshotsEnabled === false ? 'off' : 'inherit',
    });
  };

  const toggleDay = (d) => {
    const set = new Set(String(form.workingDays).split(',').filter(Boolean));
    set.has(d) ? set.delete(d) : set.add(d);
    setForm((f) => ({ ...f, workingDays: [...set].sort().join(',') }));
  };

  const save = async () => {
    setError(''); setMsg('');
    const body = { organisationId: q ? orgId : undefined };
    if (form.customHours) Object.assign(body, { officeStart: form.officeStart, officeEnd: form.officeEnd, workingDays: form.workingDays });
    else body.useCompanyHours = true;
    if (company.screenshotsAvailable) body.screenshotsEnabled = form.screenshots === 'on' ? true : form.screenshots === 'off' ? false : null;
    try {
      await portalApi.put(`/monitoring/group-settings/${editId}${q}`, body);
      setEditId(null); setMsg('Saved'); load();
    } catch (e) { setError(e.response?.data?.error || 'Failed to save'); }
  };

  if (groups.length === 0) {
    return <p className="text-sm text-gray-400">No teams yet. Create teams under Admin, then you can give each its own hours and screenshot setting here.</p>;
  }

  return (
    <div>
      <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
        {groups.map((g) => {
          const customHours = !!(g.officeStart && g.officeEnd && g.workingDays);
          const shots = g.screenshotsEnabled === true ? 'on' : g.screenshotsEnabled === false ? 'off' : null;
          const editing = editId === g.id;
          return (
            <div key={g.id} className="p-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="font-medium text-gray-800 text-sm">{g.name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    Hours: {customHours ? <span className="text-teal-700 font-medium">{g.officeStart}–{g.officeEnd}, {daysText(g.workingDays)}</span> : <>same as company ({companyHours})</>}
                  </div>
                  <div className="text-xs text-gray-500">
                    Screenshots: {shots ? <span className={`font-medium ${shots === 'on' ? 'text-teal-700' : 'text-gray-700'}`}>{shots} for this team</span> : <>same as company ({companyShots})</>}
                  </div>
                </div>
                {!editing && <button onClick={() => startEdit(g)} className="text-xs text-teal-700 hover:underline">Edit</button>}
              </div>

              {editing && form && (
                <div className="mt-3 rounded-lg bg-gray-50 border border-gray-200 p-3">
                  <label className="flex items-center gap-2 text-sm text-gray-700 mb-2">
                    <input type="checkbox" checked={form.customHours} onChange={(e) => setForm((f) => ({ ...f, customHours: e.target.checked }))} />
                    This team has its own office hours
                  </label>
                  {form.customHours && (
                    <div className="mb-3">
                      <div className="flex gap-3 mb-2">
                        <div><label className="block text-xs text-gray-500 mb-1">Start</label>
                          <input type="time" value={form.officeStart} onChange={(e) => setForm((f) => ({ ...f, officeStart: e.target.value }))} className={field} /></div>
                        <div><label className="block text-xs text-gray-500 mb-1">End</label>
                          <input type="time" value={form.officeEnd} onChange={(e) => setForm((f) => ({ ...f, officeEnd: e.target.value }))} className={field} /></div>
                      </div>
                      <div className="flex gap-1">
                        {DAYS.map(([d, l]) => {
                          const on = String(form.workingDays).split(',').includes(d);
                          return <button key={d} type="button" onClick={() => toggleDay(d)} className={`flex-1 rounded-lg py-1 text-xs font-medium border ${on ? 'bg-teal-600 text-white border-teal-600' : 'bg-white text-gray-600 border-gray-300'}`}>{l}</button>;
                        })}
                      </div>
                    </div>
                  )}

                  {company.screenshotsAvailable && (
                    <div className="mb-3">
                      <label className="block text-xs text-gray-500 mb-1">Screenshots for this team</label>
                      <select value={form.screenshots} onChange={(e) => setForm((f) => ({ ...f, screenshots: e.target.value }))} className={field}>
                        <option value="inherit">Same as company ({companyShots})</option>
                        <option value="on">On</option>
                        <option value="off">Off</option>
                      </select>
                      {form.screenshots === 'on' && (
                        <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs px-3 py-2">
                          Make sure this team's staff have been told screenshots are being captured before enabling this — check your obligations under local data-protection law (e.g. UK GDPR).
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-3">
                    <button onClick={save} className="rounded-lg bg-teal-600 hover:bg-teal-700 text-white px-3 py-1.5 text-sm">Save team</button>
                    <button onClick={() => setEditId(null)} className="text-sm text-gray-500 hover:underline">Cancel</button>
                    {error && <span className="text-red-600 text-sm">{error}</span>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {msg && <div className="text-green-600 text-sm mt-2">{msg}</div>}
    </div>
  );
}
