import crypto from 'crypto';
import { Router } from 'express';
import asyncHandler from 'express-async-handler';

import prisma from '../prisma.js';
import { authenticatePortal, requirePortalRole, scopeFor } from '../middleware/portal-auth.js';
import {
  dateOnly,
  weightForCategory,
  getMonitoringSettings,
  resolveClassification,
  effectiveClassification,
} from '../lib/monitoring-rollup.js';
import { generateAgentToken, hashAgentToken } from '../middleware/agent-auth.js';

const router = Router();
router.use(authenticatePortal);

// Product dashboard reads. Tenant isolation comes from scopeFor() on every query
// — this is the parallel of the internal monitoring.js dashboard plane, but
// authenticated by PortalUser and scoped to the caller's org/group. The internal
// (Entra) routes are untouched.

// MonitoredDevice has no groupId column, so a group admin's device view is scoped
// via its employees instead of a direct groupId filter.
function deviceWhere(portalUser) {
  const s = scopeFor(portalUser);
  if (s.groupId !== undefined) {
    const { groupId, ...rest } = s;
    return { ...rest, employees: { some: { groupId } } };
  }
  return s;
}

async function logAccess(portalUser, action, extra = {}) {
  await prisma.monitoringAccessLog.create({
    data: {
      portalUserId: portalUser.id,
      organisationId: portalUser.organisationId ?? extra.organisationId ?? null,
      action,
      targetEmployeeId: extra.targetEmployeeId ?? null,
      meta: extra.meta ?? undefined,
    },
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const { fromDate, toDate, employeeId } = req.query;
    const where = { ...scopeFor(req.portalUser) };
    if (employeeId) where.employeeId = employeeId;
    if (fromDate || toDate) {
      where.summaryDate = {};
      if (fromDate) where.summaryDate.gte = dateOnly(fromDate);
      if (toDate) where.summaryDate.lte = dateOnly(toDate);
    }

    const summaries = await prisma.activitySummary.findMany({
      where,
      include: { employee: { select: { id: true, displayName: true, upn: true } } },
      orderBy: { summaryDate: 'asc' },
    });

    const perEmployee = new Map();
    const total = { activeSec: 0, idleSec: 0, productiveSec: 0, neutralSec: 0, nonProductiveSec: 0, overtimeSec: 0, overtimeProductiveSec: 0 };
    for (const s of summaries) {
      total.activeSec += s.activeSec; total.idleSec += s.idleSec;
      total.productiveSec += s.productiveSec; total.neutralSec += s.neutralSec;
      total.nonProductiveSec += s.nonProductiveSec;
      total.overtimeSec += s.overtimeSec || 0; total.overtimeProductiveSec += s.overtimeProductiveSec || 0;

      const key = s.employeeId;
      if (!perEmployee.has(key)) {
        perEmployee.set(key, {
          employeeId: key,
          displayName: s.employee?.displayName || s.employee?.upn || 'Unknown',
          activeSec: 0, idleSec: 0, productiveSec: 0, neutralSec: 0, nonProductiveSec: 0, overtimeSec: 0, overtimeProductiveSec: 0,
        });
      }
      const e = perEmployee.get(key);
      e.activeSec += s.activeSec; e.idleSec += s.idleSec;
      e.productiveSec += s.productiveSec; e.neutralSec += s.neutralSec;
      e.nonProductiveSec += s.nonProductiveSec;
      e.overtimeSec += s.overtimeSec || 0; e.overtimeProductiveSec += s.overtimeProductiveSec || 0;
    }

    const withPct = (row) => ({
      ...row,
      productivityPct: row.activeSec > 0 ? Math.round((row.productiveSec / row.activeSec) * 100) : 0,
      // Of the overtime worked, how much was productive.
      overtimePct: row.overtimeSec > 0 ? Math.round((row.overtimeProductiveSec / row.overtimeSec) * 100) : 0,
    });

    if (employeeId) await logAccess(req.portalUser, 'VIEW_EMPLOYEE', { targetEmployeeId: employeeId });

    res.json({
      total: withPct(total),
      employees: [...perEmployee.values()].map(withPct).sort((a, b) => b.activeSec - a.activeSec),
      days: summaries,
    });
  }),
);

router.get(
  '/devices',
  asyncHandler(async (req, res) => {
    const devices = await prisma.monitoredDevice.findMany({
      where: deviceWhere(req.portalUser),
      orderBy: { lastSeenAt: 'desc' },
      include: {
        _count: { select: { events: true } },
        employees: { orderBy: { updatedAt: 'desc' }, take: 1 },
      },
    });
    const out = devices.map((d) => {
      const primaryEmployee = d.employees?.[0] || null;
      const { employees, ...rest } = d;
      return { ...rest, primaryEmployee };
    });
    res.json(out);
  }),
);

router.get(
  '/employees',
  asyncHandler(async (req, res) => {
    const where = { ...scopeFor(req.portalUser) };
    if (req.query.activeOnly === 'true') where.isActive = true;
    if (req.query.claimStatus) where.claimStatus = req.query.claimStatus;
    const employees = await prisma.monitoredEmployee.findMany({
      where,
      include: { group: { select: { id: true, name: true } } },
      orderBy: { displayName: 'asc' },
    });
    res.json(employees);
  }),
);

router.get(
  '/timeline',
  asyncHandler(async (req, res) => {
    const { employeeId, date } = req.query;
    if (!employeeId) return res.status(400).json({ error: 'employeeId is required' });

    // Enforce scope: the employee must be visible to this caller.
    const inScope = await prisma.monitoredEmployee.findFirst({
      where: { id: employeeId, ...scopeFor(req.portalUser) },
      select: { id: true, organisationId: true },
    });
    if (!inScope) return res.status(404).json({ error: 'Employee not found in your scope' });

    const where = { employeeId };
    if (date) {
      const start = dateOnly(date);
      const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
      where.startTime = { gte: start, lt: end };
    }

    const events = await prisma.activityEvent.findMany({
      where,
      orderBy: { startTime: 'desc' },
      take: 2000,
    });

    const { byProc, titleRules } = await effectiveClassification(inScope.organisationId);
    const resolved = events.map((e) => {
      const c = resolveClassification(e.processName, e.windowTitle, byProc, titleRules);
      return { ...e, resolvedDisplayName: c.displayName || e.processName, resolvedCategory: c.category, resolvedWeight: c.weight };
    });

    await logAccess(req.portalUser, 'VIEW_TIMELINE', { targetEmployeeId: employeeId, meta: { date } });
    res.json(resolved);
  }),
);

router.get(
  '/export',
  asyncHandler(async (req, res) => {
    const { fromDate, toDate } = req.query;
    const where = { ...scopeFor(req.portalUser) };
    if (fromDate || toDate) {
      where.summaryDate = {};
      if (fromDate) where.summaryDate.gte = dateOnly(fromDate);
      if (toDate) where.summaryDate.lte = dateOnly(toDate);
    }
    const rows = await prisma.activitySummary.findMany({
      where,
      include: { employee: { select: { displayName: true, upn: true } } },
      orderBy: [{ summaryDate: 'asc' }],
    });

    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Date', 'Employee', 'Active (s)', 'Idle (s)', 'Productive (s)', 'Neutral (s)', 'Non-productive (s)', 'Overtime (s)', 'Productive overtime (s)', 'Productivity %'];
    const lines = [header.map(esc).join(',')];
    for (const r of rows) {
      const pct = r.activeSec > 0 ? Math.round((r.productiveSec / r.activeSec) * 100) : 0;
      lines.push([
        r.summaryDate.toISOString().slice(0, 10),
        r.employee?.displayName || r.employee?.upn || 'Unknown',
        r.activeSec, r.idleSec, r.productiveSec, r.neutralSec, r.nonProductiveSec, r.overtimeSec || 0, r.overtimeProductiveSec || 0, pct,
      ].map(esc).join(','));
    }

    await logAccess(req.portalUser, 'EXPORT_CSV', { meta: { fromDate, toDate, rows: rows.length } });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="productivity.csv"');
    res.send(lines.join('\n'));
  }),
);

// ── App categorisation: global catalogue + per-company overrides ─────────────
const APP_CATEGORIES = ['PRODUCTIVE', 'COMMUNICATION', 'DEVELOPMENT', 'ADMIN_BACKOFFICE', 'RMM_SUPPORT', 'RESEARCH', 'SOCIAL', 'ENTERTAINMENT', 'UNCATEGORISED', 'BLOCKED_HIGH_RISK'];
const WEIGHTS = ['PRODUCTIVE', 'NEUTRAL', 'NON_PRODUCTIVE'];

// The global catalogue, each app annotated with this company's effective
// classification (its override if any, else the global default).
router.get('/apps', asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  const apps = await prisma.monitoredApp.findMany({ orderBy: { displayName: 'asc' } });
  const overrides = orgId ? await prisma.orgAppClassification.findMany({ where: { organisationId: orgId } }) : [];
  const ovByProc = new Map(overrides.map((o) => [o.processName.toUpperCase(), o]));
  const out = apps.map((a) => {
    const ov = ovByProc.get(a.processName.toUpperCase());
    return {
      processName: a.processName,
      displayName: a.displayName,
      category: ov?.category ?? a.category,
      weight: ov?.weight ?? a.weight,
      isOverride: !!ov,
      globalCategory: a.category,
      globalWeight: a.weight,
    };
  });
  // Company-only apps (overrides for a process not in the global catalogue).
  const known = new Set(apps.map((a) => a.processName.toUpperCase()));
  for (const o of overrides) {
    if (!known.has(o.processName.toUpperCase())) {
      out.push({ processName: o.processName, displayName: o.displayName || o.processName, category: o.category, weight: o.weight, isOverride: true, globalCategory: null, globalWeight: null });
    }
  }
  res.json(out.sort((a, b) => (a.displayName || a.processName).localeCompare(b.displayName || b.processName)));
}));

// Set (or clear) this company's classification for an app.
router.put('/apps/classify', requirePortalRole('ORG_ADMIN'), asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  if (!orgId) return res.status(400).json({ error: 'organisationId is required' });
  const processName = String(req.body?.processName || '').trim().toUpperCase();
  if (!processName) return res.status(400).json({ error: 'processName is required' });
  const category = req.body?.category;
  const weight = req.body?.weight;
  if (!APP_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  if (!WEIGHTS.includes(weight)) return res.status(400).json({ error: 'Invalid weight' });
  const data = { category, weight, displayName: String(req.body?.displayName || '').trim() || null };
  const row = await prisma.orgAppClassification.upsert({
    where: { organisationId_processName: { organisationId: orgId, processName } },
    update: data,
    create: { organisationId: orgId, processName, ...data },
  });
  res.json(row);
}));

// Revert an app to the global default (delete the company override).
router.delete('/apps/classify/:processName', requirePortalRole('ORG_ADMIN'), asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  if (!orgId) return res.status(400).json({ error: 'organisationId is required' });
  await prisma.orgAppClassification.deleteMany({ where: { organisationId: orgId, processName: String(req.params.processName).toUpperCase() } });
  res.json({ ok: true });
}));

// Title rules: this company's rules plus the read-only global defaults.
router.get('/title-rules', asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  const orgRules = orgId ? await prisma.orgTitleRule.findMany({ where: { organisationId: orgId }, orderBy: { keyword: 'asc' } }) : [];
  const globalRules = await prisma.titleRule.findMany({ orderBy: { keyword: 'asc' } });
  res.json({ orgRules, globalRules });
}));

router.post('/title-rules', requirePortalRole('ORG_ADMIN'), asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  if (!orgId) return res.status(400).json({ error: 'organisationId is required' });
  const keyword = String(req.body?.keyword || '').trim().toLowerCase();
  if (!keyword) return res.status(400).json({ error: 'keyword is required' });
  const category = APP_CATEGORIES.includes(req.body?.category) ? req.body.category : 'SOCIAL';
  const weight = WEIGHTS.includes(req.body?.weight) ? req.body.weight : 'NON_PRODUCTIVE';
  try {
    const row = await prisma.orgTitleRule.create({ data: { organisationId: orgId, keyword, category, weight } });
    res.status(201).json(row);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'That keyword already exists for this company' });
    throw e;
  }
}));

router.patch('/title-rules/:id', requirePortalRole('ORG_ADMIN'), asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  const target = await prisma.orgTitleRule.findFirst({ where: { id: req.params.id, organisationId: orgId } });
  if (!target) return res.status(404).json({ error: 'Rule not found' });
  const data = {};
  if (req.body?.keyword !== undefined) data.keyword = String(req.body.keyword).trim().toLowerCase();
  if (req.body?.category !== undefined && APP_CATEGORIES.includes(req.body.category)) data.category = req.body.category;
  if (req.body?.weight !== undefined && WEIGHTS.includes(req.body.weight)) data.weight = req.body.weight;
  const row = await prisma.orgTitleRule.update({ where: { id: target.id }, data });
  res.json(row);
}));

router.delete('/title-rules/:id', requirePortalRole('ORG_ADMIN'), asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  const target = await prisma.orgTitleRule.findFirst({ where: { id: req.params.id, organisationId: orgId } });
  if (!target) return res.status(404).json({ error: 'Rule not found' });
  await prisma.orgTitleRule.delete({ where: { id: target.id } });
  res.json({ ok: true });
}));

// ── Per-organisation settings (office hours) ─────────────────────────────────

function targetOrgId(req) {
  // Provider may inspect a specific org via ?organisationId; everyone else is
  // pinned to their own.
  if (req.portalUser.role === 'PROVIDER_ADMIN') return req.query.organisationId || req.body?.organisationId || null;
  return req.portalUser.organisationId;
}

router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    res.json(await getMonitoringSettings(targetOrgId(req)));
  }),
);

router.put(
  '/settings',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    const orgId = targetOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'organisationId is required' });

    const { officeStart, officeEnd, workingDays, timezone } = req.body || {};
    const hhmm = /^([01]?\d|2[0-3]):[0-5]\d$/;
    const data = {};
    if (officeStart !== undefined) {
      if (!hhmm.test(officeStart)) return res.status(400).json({ error: 'officeStart must be HH:mm' });
      data.officeStart = officeStart;
    }
    if (officeEnd !== undefined) {
      if (!hhmm.test(officeEnd)) return res.status(400).json({ error: 'officeEnd must be HH:mm' });
      data.officeEnd = officeEnd;
    }
    if (workingDays !== undefined) {
      const days = Array.isArray(workingDays) ? workingDays : String(workingDays).split(',');
      const norm = [...new Set(days.map((d) => Number(d)).filter((n) => n >= 1 && n <= 7))].sort((a, b) => a - b);
      if (norm.length === 0) return res.status(400).json({ error: 'workingDays must include at least one day (1=Mon … 7=Sun)' });
      data.workingDays = norm.join(',');
    }
    if (timezone !== undefined) {
      try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }); }
      catch { return res.status(400).json({ error: 'Invalid timezone' }); }
      data.timezone = timezone;
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const settings = await prisma.monitoringSetting.upsert({
      where: { organisationId: orgId },
      update: data,
      create: { id: crypto.randomUUID(), organisationId: orgId, officeStart: '08:00', officeEnd: '18:00', workingDays: '1,2,3,4,5', timezone: 'Europe/London', ...data },
    });
    res.json(settings);
  }),
);

// ── Admin actions ────────────────────────────────────────────────────────────

// Map a captured employee (Path B) to a name/group, or activate/deactivate.
// GROUP_ADMIN can only place employees into their own group.
router.patch(
  '/employees/:id',
  requirePortalRole('GROUP_ADMIN', 'ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    const target = await prisma.monitoredEmployee.findFirst({
      where: { id: req.params.id, ...scopeFor(req.portalUser) },
    });
    if (!target) return res.status(404).json({ error: 'Employee not found in your scope' });

    const { displayName, isActive } = req.body || {};
    const data = {};
    if (displayName !== undefined) data.displayName = displayName?.trim() || null;
    if (isActive !== undefined) data.isActive = !!isActive;
    if (req.body?.groupId !== undefined) {
      if (req.portalUser.role === 'GROUP_ADMIN') data.groupId = req.portalUser.groupId;
      else data.groupId = req.body.groupId || null;
    }
    // Mapping a captured account assigns it a person; mark it claimed.
    if ((data.displayName || data.groupId) && target.claimStatus === 'UNMAPPED') {
      data.claimStatus = 'CLAIMED';
    }

    const employee = await prisma.monitoredEmployee.update({
      where: { id: target.id },
      data,
      include: { group: { select: { id: true, name: true } } },
    });
    await logAccess(req.portalUser, 'MAP_EMPLOYEE', { targetEmployeeId: employee.id, meta: { groupId: employee.groupId } });
    res.json(employee);
  }),
);

router.patch(
  '/devices/:id',
  requirePortalRole('MANAGER'), // staff management: MANAGER and above may retire devices
  asyncHandler(async (req, res) => {
    const target = await prisma.monitoredDevice.findFirst({
      where: { id: req.params.id, ...deviceWhere(req.portalUser) },
    });
    if (!target) return res.status(404).json({ error: 'Device not found in your scope' });

    const { status, rotateToken } = req.body || {};
    const data = {};
    if (status) data.status = status;
    let newToken;
    if (rotateToken) {
      newToken = generateAgentToken();
      data.agentTokenHash = hashAgentToken(newToken);
    }
    const device = await prisma.monitoredDevice.update({ where: { id: target.id }, data });
    res.json({ device, ...(newToken ? { agentToken: newToken } : {}) });
  }),
);

export default router;
