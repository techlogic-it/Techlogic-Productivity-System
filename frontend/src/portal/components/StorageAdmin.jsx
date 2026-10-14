import { useState, useEffect, useCallback } from 'react';
import portalApi from '../portalApi';

const field = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm';
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const host = (url) => { try { return new URL(url).host; } catch { return url; } };
const EMPTY = { endpoint: '', region: 'auto', bucket: '', accessKeyId: '', secretAccessKey: '', forcePathStyle: false, retentionManagedByCustomer: false };

function TestResult({ test }) {
  if (!test) return null;
  const rows = [['Write a test file', test.write], ['Read it back', test.read], ['Delete it', test.delete]];
  return (
    <ul className="mt-2 text-xs space-y-1">
      {rows.map(([label, r]) => (
        <li key={label} className={r.ok ? 'text-green-700' : 'text-red-600'}>
          {r.ok ? '✓' : '✗'} {label}{!r.ok && r.error ? ` — ${r.error}` : ''}
        </li>
      ))}
    </ul>
  );
}

// Provider admins only: where this company's screenshots are stored. Default is
// the shared platform bucket; a company can have its own S3-compatible bucket.
export default function StorageAdmin({ orgId }) {
  const [info, setInfo] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [test, setTest] = useState(null);

  const load = useCallback(() => {
    if (!orgId) return;
    portalApi.get(`/orgs/organisations/${orgId}/storage`).then((r) => setInfo(r.data)).catch(() => setInfo(null));
  }, [orgId]);
  useEffect(() => { setEditing(false); setError(''); setOk(''); setTest(null); load(); }, [load]);

  const custom = info?.mode === 'custom';
  const s = info?.storage;

  const startEdit = () => {
    setError(''); setOk(''); setTest(null);
    setForm(s ? { ...EMPTY, endpoint: s.endpoint, region: s.region, bucket: s.bucket, forcePathStyle: s.forcePathStyle, retentionManagedByCustomer: s.retentionManagedByCustomer } : EMPTY);
    setEditing(true);
  };

  const save = async () => {
    setBusy(true); setError(''); setOk(''); setTest(null);
    try {
      const { data } = await portalApi.put(`/orgs/organisations/${orgId}/storage`, form);
      setTest(data.test); setOk('Connection works — saved. New screenshots for this company now go to this bucket.');
      setEditing(false); load();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save'); setTest(e.response?.data?.test || null);
    } finally { setBusy(false); }
  };

  const runTest = async () => {
    setBusy(true); setError(''); setOk(''); setTest(null);
    try {
      const { data } = await portalApi.post(`/orgs/organisations/${orgId}/storage/test`);
      setTest(data.test); data.ok ? setOk('Connection test passed.') : setError('Connection test failed.'); load();
    } catch (e) { setError(e.response?.data?.error || 'Test failed'); } finally { setBusy(false); }
  };

  const useShared = async () => {
    if (!window.confirm("Switch this company back to the shared platform storage?\n\nNew screenshots will be stored with us. Screenshots already taken stay in the company's bucket and remain viewable until they expire.")) return;
    setBusy(true); setError(''); setOk(''); setTest(null);
    try { await portalApi.delete(`/orgs/organisations/${orgId}/storage`); setOk('Switched back to platform storage.'); load(); }
    catch (e) { setError(e.response?.data?.error || 'Failed'); } finally { setBusy(false); }
  };

  if (!info) return <div className="text-sm text-gray-400">Loading…</div>;

  return (
    <div className="text-sm">
      {!editing && (
        <div className="mb-3">
          {custom ? (
            <>
              <div className="font-medium text-gray-800">Company's own bucket</div>
              <div className="text-gray-600 mt-1">{s.bucket} <span className="text-gray-400">on</span> {host(s.endpoint)} <span className="text-gray-400">· key {s.accessKeyHint}</span></div>
              <div className="text-xs text-gray-500 mt-1">
                {s.retentionManagedByCustomer ? 'The company manages deletion in its own bucket (we only remove screenshots from the portal after 30 days).' : 'We delete screenshots from the bucket after 30 days.'}
              </div>
              {s.lastError
                ? <div className="mt-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2">Uploads are failing since {when(s.lastErrorAt)}: {s.lastError}. Screenshots for this company are not being saved until this is fixed.</div>
                : <div className="text-xs text-green-700 mt-1">Healthy — last successful write {when(s.lastOkAt)}.</div>}
            </>
          ) : (
            <>
              <div className="font-medium text-gray-800">Shared platform storage</div>
              <div className="text-xs text-gray-500 mt-1">This company's screenshots are kept in Techlogic's Cloudflare R2 bucket{info.platformAvailable ? '' : ' — which is not configured on this server'}.</div>
            </>
          )}
          <div className="flex gap-2 flex-wrap mt-3">
            <button onClick={startEdit} className="rounded-lg bg-teal-600 hover:bg-teal-700 text-white px-3 py-1.5">{custom ? 'Change' : 'Set up company storage'}</button>
            {custom && <button onClick={runTest} disabled={busy} className="rounded-lg border border-gray-300 hover:bg-gray-50 text-gray-700 px-3 py-1.5 disabled:opacity-50">{busy ? 'Testing…' : 'Test connection'}</button>}
            {custom && <button onClick={useShared} disabled={busy} className="rounded-lg border border-gray-300 hover:bg-gray-50 text-gray-700 px-3 py-1.5">Use shared storage instead</button>}
          </div>
        </div>
      )}

      {editing && (
        <div className="space-y-3 max-w-xl">
          <p className="text-xs text-gray-500">Any S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze, MinIO…). Create an access key limited to this one bucket with read, write{form.retentionManagedByCustomer ? '' : ' and delete'} permission. Saving writes, reads and deletes a tiny test file to check it — nothing is saved unless that works.</p>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Endpoint</label>
            <input value={form.endpoint} onChange={(e) => setForm((f) => ({ ...f, endpoint: e.target.value }))} placeholder="https://<account-id>.r2.cloudflarestorage.com" className={field} />
          </div>
          <div className="flex gap-3">
            <div className="flex-1"><label className="block text-xs text-gray-500 mb-1">Bucket</label>
              <input value={form.bucket} onChange={(e) => setForm((f) => ({ ...f, bucket: e.target.value }))} className={field} /></div>
            <div className="w-36"><label className="block text-xs text-gray-500 mb-1">Region</label>
              <input value={form.region} onChange={(e) => setForm((f) => ({ ...f, region: e.target.value }))} placeholder="auto" className={field} /></div>
          </div>
          <div className="flex gap-3">
            <div className="flex-1"><label className="block text-xs text-gray-500 mb-1">Access key ID{s ? ' (blank = keep saved)' : ''}</label>
              <input value={form.accessKeyId} onChange={(e) => setForm((f) => ({ ...f, accessKeyId: e.target.value }))} autoComplete="off" className={field} /></div>
            <div className="flex-1"><label className="block text-xs text-gray-500 mb-1">Secret access key{s ? ' (blank = keep saved)' : ''}</label>
              <input type="password" value={form.secretAccessKey} onChange={(e) => setForm((f) => ({ ...f, secretAccessKey: e.target.value }))} autoComplete="new-password" className={field} /></div>
          </div>
          <label className="flex items-start gap-2 text-gray-700"><input type="checkbox" className="mt-1" checked={form.forcePathStyle} onChange={(e) => setForm((f) => ({ ...f, forcePathStyle: e.target.checked }))} />
            <span>Path-style addressing <span className="text-xs text-gray-400">(MinIO and some other providers need this)</span></span></label>
          <label className="flex items-start gap-2 text-gray-700"><input type="checkbox" className="mt-1" checked={form.retentionManagedByCustomer} onChange={(e) => setForm((f) => ({ ...f, retentionManagedByCustomer: e.target.checked }))} />
            <span>The company manages deletion in its own bucket <span className="text-xs text-gray-400">(we won't delete their images; screenshots still disappear from the portal after 30 days)</span></span></label>
          {s && (form.endpoint.trim().replace(/\/$/, '') !== s.endpoint || form.bucket.trim() !== s.bucket) && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs px-3 py-2">Changing the endpoint or bucket applies to new screenshots only. Ones already taken stay in the old bucket and remain viewable until they expire.</div>
          )}
          <div className="flex gap-3 items-center">
            <button onClick={save} disabled={busy} className="rounded-lg bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 disabled:opacity-50">{busy ? 'Testing…' : 'Test and save'}</button>
            <button onClick={() => { setEditing(false); setError(''); setTest(null); }} className="text-gray-500 hover:underline">Cancel</button>
          </div>
        </div>
      )}

      {error && <div className="text-red-600 mt-2">{error}</div>}
      {ok && <div className="text-green-700 mt-2">{ok}</div>}
      <TestResult test={test} />
    </div>
  );
}
