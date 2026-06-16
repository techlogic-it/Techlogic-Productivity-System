import { useState, useEffect, useCallback } from 'react';
import portalApi from '../portalApi';
import { usePortalAuth, isProvider as isProviderRole } from '../PortalAuthContext';

const DAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['7', 'Sun']];
const CATEGORIES = ['PRODUCTIVE', 'COMMUNICATION', 'DEVELOPMENT', 'ADMIN_BACKOFFICE', 'RMM_SUPPORT', 'RESEARCH', 'SOCIAL', 'ENTERTAINMENT', 'UNCATEGORISED', 'BLOCKED_HIGH_RISK'];
const WEIGHTS = ['PRODUCTIVE', 'NEUTRAL', 'NON_PRODUCTIVE'];
const label = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c + c.slice(1).toLowerCase()).replace(/(\w)(\w*)/g, (m, a, b) => a + b.toLowerCase());
const WEIGHT_COLOUR = { PRODUCTIVE: 'text-green-700', NEUTRAL: 'text-gray-500', NON_PRODUCTIVE: 'text-red-600' };
const input = 'rounded-lg border border-gray-300 px-2 py-1 text-sm';

function Card({ title, subtitle, children }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 mb-5">
      <div className="font-semibold text-gray-700 text-sm">{title}</div>
      {subtitle && <div className="text-xs text-gray-500 mb-3 mt-0.5">{subtitle}</div>}
      <div className={subtitle ? '' : 'mt-3'}>{children}</div>
    </div>
  );
}

export default function PortalSettings() {
  const { user } = usePortalAuth();
  const isProvider = isProviderRole(user.role);

  const [orgs, setOrgs] = useState([]);
  const [orgId, setOrgId] = useState(isProvider ? '' : user.organisationId || '');
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState(''); const [error, setError] = useState('');

  const [apps, setApps] = useState([]);
  const [newApp, setNewApp] = useState({ processName: '', displayName: '', category: 'UNCATEGORISED', weight: 'NEUTRAL' });
  const [rules, setRules] = useState({ orgRules: [], globalRules: [] });
  const [newRule, setNewRule] = useState({ keyword: '', category: 'ENTERTAINMENT', weight: 'NON_PRODUCTIVE' });

  const q = orgId ? `?organisationId=${orgId}` : '';

  useEffect(() => {
    if (isProvider) portalApi.get('/orgs/organisations').then((r) => {
      setOrgs(r.data || []);
      if (!orgId && r.data?.[0]) setOrgId(r.data[0].id);
    }).catch(() => {});
  }, []); // eslint-disable-line

  const loadAll = useCallback(async () => {
    if (isProvider && !orgId) return;
    const [st, ap, tr] = await Promise.all([
      portalApi.get(`/monitoring/settings${q}`),
      portalApi.get(`/monitoring/apps${q}`),
      portalApi.get(`/monitoring/title-rules${q}`),
    ]);
    setS(st.data); setApps(ap.data || []); setRules(tr.data || { orgRules: [], globalRules: [] });
  }, [orgId]); // eslint-disable-line

  useEffect(() => { loadAll(); }, [loadAll]);

  // ── Office hours ──
  const days = new Set(String(s?.workingDays || '').split(',').filter(Boolean));
  const toggleDay = (d) => {
    const next = new Set(days); next.has(d) ? next.delete(d) : next.add(d);
    setS({ ...s, workingDays: [...next].sort().join(',') });
  };
  const saveHours = async () => {
    setMsg(''); setError('');
    try {
      const { data } = await portalApi.put(`/monitoring/settings${q}`, {
        organisationId: orgId || undefined,
        officeStart: s.officeStart, officeEnd: s.officeEnd, workingDays: s.workingDays, timezone: s.timezone,
        idleThresholdSec: s.idleThresholdSec === '' || s.idleThresholdSec == null ? null : Number(s.idleThresholdSec),
      });
      setS(data); setMsg('Saved');
    } catch (e) { setError(e.response?.data?.error || 'Failed to save'); }
  };

  // ── App categories ──
  const classify = async (processName, displayName, category, weight) => {
    await portalApi.put(`/monitoring/apps/classify${q}`, { organisationId: orgId || undefined, processName, displayName, category, weight });
    loadAll();
  };
  const revert = async (processName) => {
    await portalApi.delete(`/monitoring/apps/classify/${encodeURIComponent(processName)}${q}`);
    loadAll();
  };
  const addApp = async () => {
    if (!newApp.processName.trim()) return;
    await classify(newApp.processName.trim(), newApp.displayName.trim(), newApp.category, newApp.weight);
    setNewApp({ processName: '', displayName: '', category: 'UNCATEGORISED', weight: 'NEUTRAL' });
  };

  // ── Title rules ──
  const addRule = async () => {
    if (!newRule.keyword.trim()) return;
    await portalApi.post(`/monitoring/title-rules${q}`, { organisationId: orgId || undefined, ...newRule });
    setNewRule({ keyword: '', category: 'ENTERTAINMENT', weight: 'NON_PRODUCTIVE' });
    loadAll();
  };
  const patchRule = async (id, field, value) => { await portalApi.patch(`/monitoring/title-rules/${id}${q}`, { [field]: value }); loadAll(); };
  const deleteRule = async (id) => { await portalApi.delete(`/monitoring/title-rules/${id}${q}`); loadAll(); };

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold text-gray-800">Settings</h1>
        {isProvider && orgs.length > 0 && (
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
      </div>

      {!s ? <div className="text-gray-400 text-sm">Loading…</div> : (
        <>
          <Card title="Office hours" subtitle="Activity inside office hours counts toward productivity; outside it is overtime.">
            <div className="flex gap-4 mb-4">
              <div className="flex-1">
                <label className="block text-sm text-gray-600 mb-1">Office start</label>
                <input type="time" value={s.officeStart} onChange={(e) => setS({ ...s, officeStart: e.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              </div>
              <div className="flex-1">
                <label className="block text-sm text-gray-600 mb-1">Office end</label>
                <input type="time" value={s.officeEnd} onChange={(e) => setS({ ...s, officeEnd: e.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              </div>
            </div>
            <label className="block text-sm text-gray-600 mb-1">Working days</label>
            <div className="flex gap-1 mb-4">
              {DAYS.map(([d, l]) => (
                <button key={d} onClick={() => toggleDay(d)} className={`flex-1 rounded-lg py-1.5 text-xs font-medium border ${days.has(d) ? 'bg-teal-600 text-white border-teal-600' : 'bg-white text-gray-600 border-gray-300'}`}>{l}</button>
              ))}
            </div>
            <label className="block text-sm text-gray-600 mb-1">Timezone</label>
            <input value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-4" />
            <label className="block text-sm text-gray-600 mb-1">Idle timeout (minutes)</label>
            <input
              type="number" min="1" max="120" placeholder="5 (default)"
              value={s.idleThresholdSec != null && s.idleThresholdSec !== '' ? Math.round(s.idleThresholdSec / 60) : ''}
              onChange={(e) => setS({ ...s, idleThresholdSec: e.target.value === '' ? '' : Math.round(Number(e.target.value) * 60) })}
              className="w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm mb-1"
            />
            <p className="text-xs text-gray-400 mb-4">No keyboard/mouse for this long counts as idle (excluded from active/productive). Blank = 5 min default. Applies to each PC on the agent's next config refresh.</p>
            <div className="flex items-center gap-3">
              <button onClick={saveHours} className="rounded-lg bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 text-sm">Save office hours</button>
              {msg && <span className="text-green-600 text-sm">{msg}</span>}
              {error && <span className="text-red-600 text-sm">{error}</span>}
            </div>
          </Card>

          <Card title="App categories" subtitle="Mark which apps are productive, social, etc. Changes apply to this company only and recalculate at the next rollup.">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                  <th className="py-2 font-medium">App</th>
                  <th className="py-2 font-medium">Category</th>
                  <th className="py-2 font-medium">Productivity</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {apps.map((a) => (
                  <tr key={a.processName} className="border-b border-gray-50">
                    <td className="py-1.5"><span className="font-medium text-gray-800">{a.displayName || a.processName}</span> <span className="text-xs text-gray-400">{a.processName}</span></td>
                    <td className="py-1.5">
                      <select value={a.category} onChange={(e) => classify(a.processName, a.displayName, e.target.value, a.weight)} className={input}>
                        {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
                      </select>
                    </td>
                    <td className="py-1.5">
                      <select value={a.weight} onChange={(e) => classify(a.processName, a.displayName, a.category, e.target.value)} className={`${input} ${WEIGHT_COLOUR[a.weight]}`}>
                        {WEIGHTS.map((w) => <option key={w} value={w}>{label(w)}</option>)}
                      </select>
                    </td>
                    <td className="py-1.5 text-right">
                      {a.isOverride
                        ? <button onClick={() => revert(a.processName)} className="text-xs text-gray-500 hover:underline" title="Revert to the shared default">Custom · revert</button>
                        : <span className="text-xs text-gray-300">default</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 grid grid-cols-4 gap-2 items-end border-t border-gray-100 pt-3">
              <input placeholder="PROCESS.EXE" value={newApp.processName} onChange={(e) => setNewApp({ ...newApp, processName: e.target.value })} className={input} />
              <input placeholder="Display name" value={newApp.displayName} onChange={(e) => setNewApp({ ...newApp, displayName: e.target.value })} className={input} />
              <select value={newApp.category} onChange={(e) => setNewApp({ ...newApp, category: e.target.value })} className={input}>{CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
              <div className="flex gap-1">
                <select value={newApp.weight} onChange={(e) => setNewApp({ ...newApp, weight: e.target.value })} className={`${input} flex-1`}>{WEIGHTS.map((w) => <option key={w} value={w}>{label(w)}</option>)}</select>
                <button onClick={addApp} className="rounded-lg bg-teal-600 text-white px-3 text-sm">Add</button>
              </div>
            </div>
          </Card>

          <Card title="Page / title rules" subtitle="Catch browser activity by window-title keyword (e.g. youtube → Entertainment), since every browser tab is the same process.">
            <table className="w-full text-sm mb-3">
              <tbody>
                {rules.orgRules.map((r) => (
                  <tr key={r.id} className="border-b border-gray-50">
                    <td className="py-1.5 font-mono text-gray-700">{r.keyword}</td>
                    <td className="py-1.5">
                      <select value={r.category} onChange={(e) => patchRule(r.id, 'category', e.target.value)} className={input}>{CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
                    </td>
                    <td className="py-1.5">
                      <select value={r.weight} onChange={(e) => patchRule(r.id, 'weight', e.target.value)} className={`${input} ${WEIGHT_COLOUR[r.weight]}`}>{WEIGHTS.map((w) => <option key={w} value={w}>{label(w)}</option>)}</select>
                    </td>
                    <td className="py-1.5 text-right"><button onClick={() => deleteRule(r.id)} className="text-xs text-red-600 hover:underline">Remove</button></td>
                  </tr>
                ))}
                {rules.orgRules.length === 0 && <tr><td colSpan={4} className="py-2 text-sm text-gray-400">No company rules yet.</td></tr>}
              </tbody>
            </table>
            <div className="grid grid-cols-4 gap-2 items-end border-t border-gray-100 pt-3">
              <input placeholder="keyword e.g. youtube" value={newRule.keyword} onChange={(e) => setNewRule({ ...newRule, keyword: e.target.value })} className={input} />
              <select value={newRule.category} onChange={(e) => setNewRule({ ...newRule, category: e.target.value })} className={input}>{CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
              <select value={newRule.weight} onChange={(e) => setNewRule({ ...newRule, weight: e.target.value })} className={input}>{WEIGHTS.map((w) => <option key={w} value={w}>{label(w)}</option>)}</select>
              <button onClick={addRule} className="rounded-lg bg-teal-600 text-white px-3 py-1.5 text-sm">Add rule</button>
            </div>
            {rules.globalRules.length > 0 && (
              <div className="mt-3 text-xs text-gray-400">
                Shared defaults (also applied unless you override the keyword): {rules.globalRules.map((g) => g.keyword).join(', ')}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
