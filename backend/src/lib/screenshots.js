// Screenshot storage (S3-compatible object storage) + retention sweep.
// Only metadata lives in Postgres (MonitoredScreenshot); the image bytes live in a
// bucket, addressed by storageKey. By default that's the platform's shared
// Cloudflare R2 bucket (R2_* env vars). A company can instead have its OWN bucket
// (OrgStorage, configured by provider admins only): its screenshots are written
// there, and each screenshot row remembers which storage holds it (storageId,
// null = platform), so images taken before a switch are still found afterwards.

import crypto from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import prisma from '../prisma.js';
import { encryptEnrollmentKey as encryptSecret, decryptEnrollmentKey as decryptSecret } from './enrollment.js';

// ── Platform bucket (unchanged behaviour) ───────────────────────────────────

const platformClient =
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
    ? new S3Client({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
      })
    : null;
const platform = platformClient && process.env.R2_BUCKET
  ? { client: platformClient, bucket: process.env.R2_BUCKET, batchDelete: true }
  : null;

export function platformConfigured() {
  return !!platform;
}

// ── Per-company buckets ─────────────────────────────────────────────────────

function buildClient(cfg, extra = {}) {
  return new S3Client({
    region: cfg.region || 'auto',
    endpoint: cfg.endpoint,
    forcePathStyle: !!cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // Recent SDK versions attach checksum headers by default, which many
    // S3-compatible providers reject. Only send them where an operation requires it.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...extra,
  });
}

// A client is rebuilt only when something that affects connecting changes — not
// when a health field on the row is updated.
const handles = new Map(); // storageId -> { stamp, client, bucket, batchDelete }
function handleFor(row) {
  const stamp = [row.endpoint, row.region, row.bucket, row.accessKeyId, row.secretCipher, row.forcePathStyle].join('|');
  const hit = handles.get(row.id);
  if (hit && hit.stamp === stamp) return hit;
  const secret = decryptSecret(row.secretCipher);
  if (!secret) throw new Error('Stored storage secret could not be decrypted (has ENROLLMENT_KEY_SECRET changed?) — re-enter it');
  // Individual deletes, not multi-object: DeleteObjects needs checksum support
  // that not every S3-compatible provider has.
  const h = { stamp, bucket: row.bucket, client: buildClient({ ...row, secretAccessKey: secret }), batchDelete: false };
  handles.set(row.id, h);
  return h;
}

export async function activeStorageFor(organisationId) {
  if (!organisationId) return null;
  return prisma.orgStorage.findFirst({ where: { organisationId, active: true }, orderBy: { createdAt: 'desc' } });
}

// Can this company capture screenshots at all: it has its own bucket, or the
// platform bucket is configured.
export async function screenshotsAvailableFor(organisationId) {
  return platformConfigured() || !!(await activeStorageFor(organisationId));
}

// What the portal tells a company about where its screenshots go.
export async function storageStatusFor(organisationId) {
  const row = await activeStorageFor(organisationId);
  if (!row) return { mode: 'platform' };
  return { mode: 'custom', bucket: row.bucket, lastOkAt: row.lastOkAt, lastError: row.lastError, lastErrorAt: row.lastErrorAt };
}

// Where to write a new screenshot for this company. A company with its own bucket
// NEVER falls back to the platform bucket — they chose it to keep their data
// theirs — so a broken bucket means the upload fails (and the health shows it).
export async function resolveUploadTarget(organisationId) {
  const row = await activeStorageFor(organisationId);
  if (row) {
    try { return { row, storageId: row.id, ...handleFor(row) }; }
    catch (e) { await recordStorageHealth(row, e); throw e; }
  }
  if (platform) return { row: null, storageId: null, ...platform };
  return null;
}

export async function putScreenshot(target, key, buffer) {
  await target.client.send(new PutObjectCommand({ Bucket: target.bucket, Key: key, Body: buffer, ContentType: 'image/jpeg' }));
}

// Record success/failure on a company's bucket without a DB write per upload:
// success only updates when recovering from an error or once an hour; the same
// failure is only re-written every 10 minutes.
export async function recordStorageHealth(row, error) {
  if (!row) return;
  const now = Date.now();
  try {
    if (!error) {
      if (!row.lastError && row.lastOkAt && now - row.lastOkAt.getTime() < 3600e3) return;
      await prisma.orgStorage.update({ where: { id: row.id }, data: { lastOkAt: new Date(), lastError: null, lastErrorAt: null } });
    } else {
      const msg = String(error?.message || error).slice(0, 300);
      if (row.lastError === msg && row.lastErrorAt && now - row.lastErrorAt.getTime() < 600e3) return;
      await prisma.orgStorage.update({ where: { id: row.id }, data: { lastError: msg, lastErrorAt: new Date() } });
    }
  } catch { /* health is best-effort */ }
}

// Short-lived signed GET URLs — screenshots are never public. 15 min balances
// "not a lasting link if it leaks" against the portal tab being left open for a
// while before a thumbnail is clicked. Each shot is signed against the storage
// that actually holds it; null means it can't be shown (storage gone/unreachable).
export async function signedScreenshotUrls(shots) {
  const ids = [...new Set(shots.map((s) => s.storageId).filter(Boolean))];
  const rows = ids.length ? await prisma.orgStorage.findMany({ where: { id: { in: ids } } }) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return Promise.all(shots.map(async (s) => {
    try {
      let h = platform;
      if (s.storageId) {
        const row = byId.get(s.storageId);
        if (!row) return null;
        h = handleFor(row);
      }
      if (!h) return null;
      return await getSignedUrl(h.client, new GetObjectCommand({ Bucket: h.bucket, Key: s.storageKey }), { expiresIn: 900 });
    } catch { return null; }
  }));
}

// ── Deleting ────────────────────────────────────────────────────────────────

async function inChunks(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

async function deleteObjects(h, keys) {
  if (keys.length === 0) return;
  if (h.batchDelete) {
    // DeleteObjects takes at most 1000 keys per call.
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      const res = await h.client.send(new DeleteObjectsCommand({ Bucket: h.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
      if (res.Errors?.length) throw new Error(`delete failed for ${res.Errors.length} object(s): ${res.Errors[0].Code} ${res.Errors[0].Message}`);
    }
    return;
  }
  await inChunks(keys, 25, async (Key) => {
    try { await h.client.send(new DeleteObjectCommand({ Bucket: h.bucket, Key })); }
    catch (e) { if (e?.name !== 'NoSuchKey' && e?.$metadata?.httpStatusCode !== 404) throw e; }
  });
}

// Remove a set of screenshot rows (and their images where we're allowed to).
// Rows are only removed once their images are — if a bucket is unreachable its
// rows stay put and the sweep retries next run. A company that manages its own
// retention keeps its images; we still drop the portal rows.
async function purgeRows(rows, failedStorages) {
  const groups = new Map();
  for (const r of rows) {
    const k = r.storageId || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let removed = 0;
  for (const [sid, list] of groups) {
    try {
      const keys = list.map((r) => r.storageKey);
      if (!sid) {
        if (platform) await deleteObjects(platform, keys); // unconfigured platform: nothing to delete, rows still go
      } else {
        const row = await prisma.orgStorage.findUnique({ where: { id: sid } });
        if (row && !row.retentionManagedByCustomer) await deleteObjects(handleFor(row), keys);
      }
      removed += (await prisma.monitoredScreenshot.deleteMany({ where: { id: { in: list.map((r) => r.id) } } })).count;
    } catch (e) {
      failedStorages.add(sid);
      console.error(`[screenshot-retention] storage ${sid || 'platform'}: ${e.message}`);
    }
  }
  return removed;
}

const SCREENSHOT_RETENTION_DAYS = Number(process.env.MON_SCREENSHOT_RETENTION_DAYS) || 30;

// Deletes both the stored images and their Postgres rows for screenshots older
// than the retention window. Run daily alongside the activity-event sweep.
// Works through the backlog in passes of 1000 so a busy deployment keeps up.
export async function runScreenshotRetention() {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - SCREENSHOT_RETENTION_DAYS);

  const failed = new Set();
  let deleted = 0;
  for (let pass = 0; pass < 50; pass += 1) {
    const where = { capturedAt: { lt: cutoff } };
    // A storage that failed this run is skipped so its stuck rows can't hog every
    // pass. (Null storageId rows must be named explicitly: NOT IN drops NULLs.)
    if (failed.size) {
      const others = [...failed].filter(Boolean);
      const ors = [];
      if (!failed.has('')) ors.push({ storageId: null });
      ors.push(others.length ? { storageId: { notIn: others } } : { storageId: { not: null } });
      where.OR = ors;
    }
    const stale = await prisma.monitoredScreenshot.findMany({
      where, select: { id: true, storageKey: true, storageId: true }, orderBy: { capturedAt: 'asc' }, take: 1000,
    });
    if (stale.length === 0) break;
    const removed = await purgeRows(stale, failed);
    deleted += removed;
    if (removed === 0) break;
  }
  return { deleted };
}

// Used when a company is deleted: remove its images wherever they live. Best
// effort — the caller deletes the rows regardless. Returns how many were removed.
export async function purgeOrgScreenshots(organisationId) {
  const failed = new Set();
  let removedTotal = 0;
  for (;;) {
    const rows = await prisma.monitoredScreenshot.findMany({
      where: { organisationId }, select: { id: true, storageKey: true, storageId: true }, take: 1000,
    });
    if (rows.length === 0) break;
    const removed = await purgeRows(rows, failed);
    if (removed === 0) break;
    removedTotal += removed;
  }
  return removedTotal;
}

// ── Setting up a company's bucket (provider admins) ─────────────────────────

// https only, and no internal addresses: provider admins are trusted, but this
// makes the server fetch an address they type, so keep it away from private
// networks (cloud metadata, Railway internal, localhost).
function normaliseEndpoint(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { error: 'Endpoint must be a full URL, e.g. https://<account>.r2.cloudflarestorage.com' }; }
  if (u.protocol !== 'https:') return { error: 'Endpoint must start with https://' };
  if (u.username || u.password) return { error: 'Do not put credentials in the endpoint URL' };
  if (u.pathname !== '/' || u.search || u.hash) return { error: 'Endpoint should be just the host, with no path (put the bucket name in the Bucket field)' };
  const host = u.hostname.toLowerCase();
  const privateV4 = /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || privateV4 || host.includes(':') || host === '[::1]') {
    return { error: 'That endpoint points at an internal address. Use the public address of the storage service.' };
  }
  return { value: u.origin };
}

function validateStorageInput(i) {
  const ep = normaliseEndpoint(i.endpoint);
  if (ep.error) return ep;
  const bucket = String(i.bucket || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,61}[a-zA-Z0-9]$/.test(bucket)) return { error: 'Bucket name looks invalid (3–63 letters, numbers, dots, dashes).' };
  const region = String(i.region || 'auto').trim() || 'auto';
  if (!/^[a-zA-Z0-9-]{2,32}$/.test(region)) return { error: 'Region looks invalid (use "auto" for Cloudflare R2, or e.g. "eu-west-2" for AWS).' };
  const accessKeyId = String(i.accessKeyId || '').trim();
  if (accessKeyId.length < 3 || accessKeyId.length > 128 || /\s/.test(accessKeyId)) return { error: 'Access key ID looks invalid.' };
  return {
    value: { endpoint: ep.value, bucket, region, accessKeyId, forcePathStyle: !!i.forcePathStyle, retentionManagedByCustomer: !!i.retentionManagedByCustomer },
  };
}

async function step(fn) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try { await fn(ctl.signal); return { ok: true }; }
  catch (e) {
    const detail = ctl.signal.aborted ? 'timed out after 15s' : `${e?.name || 'Error'}${e?.message ? ` — ${e.message}` : ''}`;
    return { ok: false, error: detail.slice(0, 240) };
  } finally { clearTimeout(timer); }
}

// Write, read back and delete a tiny object, so the provider sees exactly which
// permission is missing instead of a generic failure later.
export async function testStorageConfig(cfg) {
  const client = buildClient(cfg, { maxAttempts: 1 });
  const Key = `techlogic-connection-test/${crypto.randomUUID()}.txt`;
  const skipped = { ok: false, error: 'skipped (an earlier step failed)' };
  const write = await step((signal) => client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key, Body: 'ok', ContentType: 'text/plain' }), { abortSignal: signal }));
  const read = write.ok
    ? await step(async (signal) => { const r = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key }), { abortSignal: signal }); await r.Body.transformToString(); })
    : skipped;
  const del = write.ok ? await step((signal) => client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key }), { abortSignal: signal })) : skipped;
  client.destroy();
  return { write, read, delete: del };
}

export function storageSummary(row) {
  if (!row) return null;
  return {
    id: row.id, endpoint: row.endpoint, region: row.region, bucket: row.bucket,
    accessKeyHint: `…${row.accessKeyId.slice(-4)}`, forcePathStyle: row.forcePathStyle,
    retentionManagedByCustomer: row.retentionManagedByCustomer,
    lastOkAt: row.lastOkAt, lastError: row.lastError, lastErrorAt: row.lastErrorAt, updatedAt: row.updatedAt,
  };
}

// Validate, test and save a company's bucket. Nothing is stored unless the test
// passes. Changing the endpoint or bucket creates a NEW storage and retires the
// old one (existing screenshots still live in the old bucket); anything else
// (rotating keys, toggling options) updates in place.
export async function saveOrgStorage(organisationId, input = {}) {
  const active = await activeStorageFor(organisationId);
  // Editing the bucket that's already active (same endpoint + bucket)? Then a
  // blank access key ID / secret means "keep the saved one".
  const ep = normaliseEndpoint(input.endpoint);
  const sameLocation = !ep.error && !!active && active.endpoint === ep.value && active.bucket === String(input.bucket || '').trim();
  const v = validateStorageInput({ ...input, accessKeyId: String(input.accessKeyId || '').trim() || (sameLocation ? active.accessKeyId : '') });
  if (v.error) return { status: 400, error: v.error };
  const cfg = v.value;

  let secret = input.secretAccessKey ? String(input.secretAccessKey) : null;
  if (!secret) {
    if (!sameLocation) return { status: 400, error: 'Enter the secret access key — it is needed whenever the endpoint or bucket changes.' };
    secret = decryptSecret(active.secretCipher);
    if (!secret) return { status: 400, error: 'The stored secret can no longer be read. Please enter the secret access key again.' };
  }

  const test = await testStorageConfig({ ...cfg, secretAccessKey: secret });
  const needsDelete = !cfg.retentionManagedByCustomer;
  if (!test.write.ok || !test.read.ok || (needsDelete && !test.delete.ok)) {
    return { status: 400, error: 'Connection test failed — nothing was saved.', test };
  }

  const data = { ...cfg, secretCipher: encryptSecret(secret), lastOkAt: new Date(), lastError: null, lastErrorAt: null };
  const row = sameLocation
    ? await prisma.orgStorage.update({ where: { id: active.id }, data })
    : await prisma.$transaction(async (tx) => {
        await tx.orgStorage.updateMany({ where: { organisationId, active: true }, data: { active: false } });
        return tx.orgStorage.create({ data: { organisationId, active: true, ...data } });
      });
  return { status: 200, storage: storageSummary(row), test };
}

// Go back to the platform bucket. The old storage row is kept (inactive) so
// screenshots already taken can still be shown and, in time, cleaned up.
export async function clearOrgStorage(organisationId) {
  const r = await prisma.orgStorage.updateMany({ where: { organisationId, active: true }, data: { active: false } });
  return r.count;
}
