import { Router } from 'express';
import asyncHandler from 'express-async-handler';
import fs from 'fs';
import path from 'path';

import { authenticateAgent, generateAgentToken, hashAgentToken } from '../middleware/agent-auth.js';
import { hashEnrollmentKey } from '../lib/enrollment.js';
import prisma from '../prisma.js';

const router = Router();

// Agent plane only (enrol / config / ingest / download). Dashboard reads live in
// portal-monitoring.js behind the portal JWT — no Entra anywhere here.

// Dev convenience: if no enrollment secret is configured we accept enrollment.
// Production uses per-organisation enrolment keys; set this to lock the legacy path.
const ENROLLMENT_SECRET = process.env.MONITORING_ENROLLMENT_SECRET || null;

// Agent policy â€” what/how the agent collects. Configurable via env.
const AGENT_POLICY = {
  sampleIntervalSec: Number(process.env.MON_SAMPLE_INTERVAL_SEC) || 5,
  idleThresholdSec: Number(process.env.MON_IDLE_THRESHOLD_SEC) || 300,
  uploadIntervalSec: Number(process.env.MON_UPLOAD_INTERVAL_SEC) || 60,
  collectWindowTitles: process.env.MON_COLLECT_WINDOW_TITLES !== 'false', // on by default
  maxBatchSize: 1000,
};


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AGENT PLANE â€” no Entra JWT. Defined BEFORE router.use(authenticate).
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// POST /api/monitoring/enroll â€” first-run handshake. Provisioned secret in,
// one-time agent token out (only its hash is stored).
//
// Product build: the agent presents a per-organisation `enrollmentKey`, which
// resolves the Organisation (and an optional default Group) the device belongs
// to â€” no Microsoft Entra anywhere. The legacy global `enrollmentSecret` path is
// kept for the internal Scenario-B build (organisation stays null).
router.post('/enroll', asyncHandler(async (req, res) => {
  const { enrollmentKey, enrollmentSecret, deviceName, entraDeviceId, azureTenantId, agentVersion } =
    req.body || {};

  if (!deviceName) {
    return res.status(400).json({ error: 'deviceName is required' });
  }

  // Resolve the tenant. A per-org key takes precedence over the legacy secret.
  let organisationId = null;
  let defaultGroupId = null;
  if (enrollmentKey) {
    const key = await prisma.enrollmentKey.findUnique({
      where: { keyHash: hashEnrollmentKey(enrollmentKey) },
    });
    if (!key || !key.isActive || (key.expiresAt && key.expiresAt < new Date())) {
      return res.status(401).json({ error: 'Invalid or inactive enrollment key' });
    }
    organisationId = key.organisationId;
    defaultGroupId = key.defaultGroupId;
  } else if (ENROLLMENT_SECRET) {
    if (enrollmentSecret !== ENROLLMENT_SECRET) {
      return res.status(401).json({ error: 'Invalid enrollment secret' });
    }
  } else if (!enrollmentKey) {
    return res.status(401).json({ error: 'An enrollment key is required' });
  }

  const token = generateAgentToken();
  const tokenHash = hashAgentToken(token);

  // Re-enrollment of a known device (by entraDeviceId) rotates its token.
  const existing = entraDeviceId
    ? await prisma.monitoredDevice.findUnique({ where: { entraDeviceId } })
    : null;

  const device = existing
    ? await prisma.monitoredDevice.update({
        where: { id: existing.id },
        data: {
          deviceName, azureTenantId, agentVersion, agentTokenHash: tokenHash, status: 'ACTIVE',
          ...(organisationId ? { organisationId, defaultGroupId } : {}),
        },
      })
    : await prisma.monitoredDevice.create({
        data: { deviceName, entraDeviceId, azureTenantId, agentVersion, agentTokenHash: tokenHash, organisationId, defaultGroupId },
      });

  // Token is returned exactly once; it cannot be recovered later.
  res.status(201).json({ deviceId: device.id, agentToken: token, policy: await policyForDevice(device) });
}));

// GET /api/monitoring/agent-download â€” the prebuilt Windows agent binary.
// Unauthenticated: the per-company install.bat (which carries the enrolment key)
// fetches it on a fresh machine. The exe itself is not a secret. Override the
// location with AGENT_EXE_PATH; defaults to the local publish output in dev.
// Where the installer fetches the agent exe. In production (Linux/Railway can't
// compile a Windows exe) set AGENT_DOWNLOAD_URL to a hosted binary — e.g. a GitHub
// release asset — and we 302 there (the installer's PowerShell + GitHub both follow
// redirects). Locally, stream the prebuilt exe from disk via AGENT_EXE_PATH.
const AGENT_DOWNLOAD_URL = process.env.AGENT_DOWNLOAD_URL || null;
const AGENT_EXE_PATH =
  process.env.AGENT_EXE_PATH ||
  path.join(process.cwd(), '..', 'agent-windows', 'publish', 'ProductivityAgent.exe');

router.get('/agent-download', (req, res) => {
  if (AGENT_DOWNLOAD_URL) return res.redirect(302, AGENT_DOWNLOAD_URL);
  if (!fs.existsSync(AGENT_EXE_PATH)) {
    return res.status(404).json({ error: 'Agent binary not available (set AGENT_DOWNLOAD_URL or AGENT_EXE_PATH).' });
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="ProductivityAgent.exe"');
  fs.createReadStream(AGENT_EXE_PATH).pipe(res);
});

// Per-org policy: the company can override the idle threshold; everything else is
// the global default. The agent applies this on its next /config poll.
async function policyForDevice(device) {
  const policy = { ...AGENT_POLICY };
  if (device?.organisationId) {
    const setting = await prisma.monitoringSetting.findUnique({
      where: { organisationId: device.organisationId },
      select: { idleThresholdSec: true },
    });
    if (setting?.idleThresholdSec != null) policy.idleThresholdSec = setting.idleThresholdSec;
  }
  return policy;
}

// GET /api/monitoring/config â€” agent pulls current policy.
router.get('/config', authenticateAgent, asyncHandler(async (req, res) => {
  res.json({ policy: await policyForDevice(req.device) });
}));

// Resolve the MonitoredEmployee an ingest batch belongs to. Three paths:
//   A. claim code  â†’ bind a pre-created (named) employee to this OS account;
//   B. capture     â†’ upsert by (organisationId, localAccountKey), UNMAPPED until
//                     an admin maps it (product build);
//   legacy         â†’ upsert by entraUserId when the device has no organisation
//                     (internal Scenario-B build, unchanged behaviour).
async function resolveEmployee(device, employee, localKey) {
  const orgId = device.organisationId;

  // Path A â€” claim code redemption (product).
  if (employee?.claimCode && orgId) {
    const pending = await prisma.monitoredEmployee.findUnique({
      where: { claimCode: employee.claimCode },
    });
    if (pending && pending.organisationId === orgId && pending.claimStatus !== 'CLAIMED') {
      return prisma.monitoredEmployee.update({
        where: { id: pending.id },
        data: {
          localAccountKey: localKey ?? pending.localAccountKey,
          displayName: employee.displayName ?? pending.displayName,
          claimStatus: 'CLAIMED',
          primaryDeviceId: device.id,
          isActive: true,
        },
      });
    }
    // Invalid/used code â†’ fall through and capture by localKey instead.
  }

  // Legacy internal build: no organisation â†’ identity is the Entra id.
  if (!orgId) {
    return prisma.monitoredEmployee.upsert({
      where: { entraUserId: localKey },
      update: {
        upn: employee?.upn ?? undefined,
        displayName: employee?.displayName ?? undefined,
        primaryDeviceId: device.id,
      },
      create: {
        entraUserId: localKey,
        localAccountKey: localKey,
        upn: employee?.upn,
        displayName: employee?.displayName,
        primaryDeviceId: device.id,
        claimStatus: 'CLAIMED',
      },
    });
  }

  // Path B â€” capture-then-map (product): key by tenant-scoped OS account.
  const existing = await prisma.monitoredEmployee.findUnique({
    where: { organisationId_localAccountKey: { organisationId: orgId, localAccountKey: localKey } },
  });
  if (existing) {
    // A removed (deactivated) user stops being monitored and frees its seat.
    if (!existing.isActive) return null;
    // Once an admin has named/mapped this person (CLAIMED), their manual name is
    // authoritative — don't let the agent's OS-derived name overwrite it on every
    // upload. While still UNMAPPED, keep refreshing the captured OS name.
    const keepName = existing.claimStatus === 'CLAIMED';
    return prisma.monitoredEmployee.update({
      where: { id: existing.id },
      data: {
        displayName: keepName ? undefined : (employee?.displayName ?? undefined),
        upn: employee?.upn ?? undefined,
        primaryDeviceId: device.id,
      },
    });
  }
  // New monitored user â€” enforce the company seat limit (licensing).
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { seatLimit: true } });
  if (org?.seatLimit != null) {
    const activeCount = await prisma.monitoredEmployee.count({ where: { organisationId: orgId, isActive: true } });
    if (activeCount >= org.seatLimit) return null; // at seat limit â€” not monitored
  }
  return prisma.monitoredEmployee.create({
    data: {
      organisationId: orgId,
      groupId: device.defaultGroupId,
      localAccountKey: localKey,
      displayName: employee?.displayName,
      upn: employee?.upn,
      customerId: device.customerId,
      claimStatus: 'UNMAPPED',
      primaryDeviceId: device.id,
    },
  });
}

// POST /api/monitoring/ingest â€” batched upload of activity + session events.
// Idempotent via clientEventId. Body:
//   { employee: { localAccountKey, displayName, claimCode?,  // product build
//                 entraUserId?, upn? },                       // internal build
//     agentVersion?, events: [...], sessionEvents: [...] }
router.post('/ingest', authenticateAgent, asyncHandler(async (req, res) => {
  const device = req.device;
  const { employee, events = [], sessionEvents = [], agentVersion } = req.body || {};

  // Identity key: the OS account (product) or the Entra id/upn (internal).
  const localKey =
    employee?.localAccountKey || employee?.entraUserId || (employee?.upn ? `upn:${employee.upn}` : null);
  if (!localKey && !employee?.claimCode) {
    return res.status(400).json({ error: 'employee.localAccountKey (or entraUserId/upn) is required' });
  }
  if (events.length + sessionEvents.length > AGENT_POLICY.maxBatchSize) {
    return res.status(413).json({ error: `Batch exceeds ${AGENT_POLICY.maxBatchSize} events` });
  }

  const emp = await resolveEmployee(device, employee, localKey);
  if (!emp) {
    // Over the company's seat limit (or a removed user): accept the upload but
    // store nothing, so the agent clears its spool and this user simply isn't
    // monitored until a seat is freed.
    await prisma.monitoredDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date(), agentVersion: agentVersion ?? undefined },
    });
    return res.json({ acceptedEvents: 0, acceptedSessionEvents: 0, notMonitored: true });
  }

  // Build a processName â†’ app catalogue map for appId tagging.
  const apps = await prisma.monitoredApp.findMany();
  const appByProc = new Map(apps.map((a) => [a.processName.toUpperCase(), a]));

  const activityRows = events
    .filter((e) => e.clientEventId && e.startTime && e.endTime)
    .map((e) => {
      const proc = String(e.processName || '').toUpperCase();
      const matched = appByProc.get(proc);
      const start = new Date(e.startTime);
      const end = new Date(e.endTime);
      return {
        deviceId: device.id,
        employeeId: emp.id,
        appId: matched?.id ?? null,
        processName: e.processName || 'unknown',
        windowTitle: AGENT_POLICY.collectWindowTitles ? (e.windowTitle ?? null) : null,
        startTime: start,
        endTime: end,
        durationSec: e.durationSec ?? Math.max(0, Math.round((end - start) / 1000)),
        isIdle: !!e.isIdle,
        clientEventId: e.clientEventId,
      };
    });

  const sessionRows = sessionEvents
    .filter((s) => s.clientEventId && s.type && s.occurredAt)
    .map((s) => ({
      deviceId: device.id,
      employeeId: emp.id,
      type: s.type,
      occurredAt: new Date(s.occurredAt),
      clientEventId: s.clientEventId,
    }));

  // skipDuplicates makes retried uploads safe (clientEventId is unique).
  const [act, sess] = await Promise.all([
    activityRows.length
      ? prisma.activityEvent.createMany({ data: activityRows, skipDuplicates: true })
      : { count: 0 },
    sessionRows.length
      ? prisma.sessionEvent.createMany({ data: sessionRows, skipDuplicates: true })
      : { count: 0 },
  ]);

  await prisma.monitoredDevice.update({
    where: { id: device.id },
    data: { lastSeenAt: new Date(), agentVersion: agentVersion ?? undefined },
  });

  res.json({ acceptedEvents: act.count, acceptedSessionEvents: sess.count });
}));

// POST /api/monitoring/retire â€” the uninstaller calls this (with the device token)
// so an uninstalled machine drops out of the portal: the device is disabled and
// the user(s) primarily on it are deactivated (freeing their licence seat).
router.post('/retire', authenticateAgent, asyncHandler(async (req, res) => {
  const device = req.device;
  await prisma.monitoredDevice.update({ where: { id: device.id }, data: { status: 'DISABLED' } });
  await prisma.monitoredEmployee.updateMany({
    where: { primaryDeviceId: device.id, isActive: true },
    data: { isActive: false },
  });
  res.json({ ok: true });
}));

export default router;
