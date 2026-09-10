// Screenshot storage (Cloudflare R2, S3-compatible) + retention sweep.
// Only metadata lives in Postgres (MonitoredScreenshot); the image bytes live in
// the R2 bucket, addressed by storageKey. Configured via R2_* env vars — absent
// in dev unless a company actually turns screenshots on.

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import prisma from '../prisma.js';

const BUCKET = process.env.R2_BUCKET || null;

const client =
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

export function screenshotsConfigured() {
  return !!(client && BUCKET);
}

export async function putScreenshot(key, buffer) {
  if (!client || !BUCKET) throw new Error('R2 is not configured (set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET)');
  await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: 'image/jpeg' }));
}

// Short-lived signed GET URL — screenshots are never public. 15 min balances
// "not a lasting link if it leaks" against the portal tab being left open for a
// while before a thumbnail is clicked.
export async function signedScreenshotUrl(key) {
  if (!client || !BUCKET) return null;
  return getSignedUrl(client, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 900 });
}

async function deleteObjects(keys) {
  if (!client || !BUCKET || keys.length === 0) return;
  // DeleteObjects takes at most 1000 keys per call.
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await client.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: batch.map((Key) => ({ Key })) } }));
  }
}

const SCREENSHOT_RETENTION_DAYS = Number(process.env.MON_SCREENSHOT_RETENTION_DAYS) || 30;

// Deletes both the R2 objects and their Postgres rows for screenshots older than
// the retention window. Run daily alongside the activity-event retention sweep.
export async function runScreenshotRetention() {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - SCREENSHOT_RETENTION_DAYS);

  const stale = await prisma.monitoredScreenshot.findMany({
    where: { capturedAt: { lt: cutoff } },
    select: { id: true, storageKey: true },
    take: 5000, // bounded per run; the daily interval will catch up over time
  });
  if (stale.length === 0) return { deleted: 0 };

  await deleteObjects(stale.map((s) => s.storageKey));
  await prisma.monitoredScreenshot.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  return { deleted: stale.length };
}
