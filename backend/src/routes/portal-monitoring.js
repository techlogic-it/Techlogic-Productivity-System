import crypto from 'crypto';
import { Router } from 'express';
import asyncHandler from 'express-async-handler';

import prisma from '../prisma.js';
import { authenticatePortal, requirePortalRole, scopeFor, blockReadOnlyProvider } from '../middleware/portal-auth.js';
import {
  dateOnly,
  weightForCategory,
  getMonitoringSettings,
  resolveClassification,
  effectiveClassification,
  officeConfig,
  localTimeInfo,
} from '../lib/monitoring-rollup.js';
import { generateAgentToken, hashAgentToken } from '../middleware/agent-auth.js';
import { sendDigest, emailConfigured } from '../lib/digests.js';

const router = Router();
router.use(authenticatePortal);
router.use(blockReadOnlyProvider); // PROVIDER_VIEWER may read but never write

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

// Lets a provider narrow a report to ONE of their companies via ?organisationId
// (validated against what they may reach). Returns the org id to pin to, or null
// (no filter — provider sees all their companies; non-providers are already
// pinned by scopeFor and can't widen).
function providerOrgScope(req) {
  const u = req.portalUser;
  const want = req.query.organisationId;
  if (!want) return null;
  if (u.role === 'PROVIDER_ADMIN') return want;
  if (u.role === 'PROVIDER_SUPPORT' || u.role === 'PROVIDER_VIEWER') {
    return (u.assignedOrgIds || []).includes(want) ? want : null;
  }
  return null;
}

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const { fromDate, toDate, employeeId } = req.query;
    const where = { ...scopeFor(req.portalUser) };
    if (employeeId) where.employeeId = employeeId;
    const orgPick = providerOrgScope(req);
    if (orgPick) where.organisationId = orgPick; // provider drilling into one company
    // Department filter — only for company-wide roles (never widens a scoped view).
    if (req.query.groupId && ['PROVIDER_ADMIN', 'PROVIDER_SUPPORT', 'ORG_ADMIN', 'MANAGER'].includes(req.portalUser.role)) {
      where.groupId = req.query.groupId;
    }
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

    const withPct = (row) => {
      // Productivity = productive ÷ all tracked office time (active + idle), so
      // idle time counts against it (a lot of idle ⇒ lower productivity).
      const present = (row.activeSec || 0) + (row.idleSec || 0);
      return {
        ...row,
        productivityPct: present > 0 ? Math.round((row.productiveSec / present) * 100) : 0,
        // How much of ACTIVE time was productive (focus while at the keyboard).
        activeProductivityPct: row.activeSec > 0 ? Math.round((row.productiveSec / row.activeSec) * 100) : 0,
        // Of the overtime worked, how much was productive.
        overtimePct: row.overtimeSec > 0 ? Math.round((row.overtimeProductiveSec / row.overtimeSec) * 100) : 0,
      };
    };

    if (employeeId) await logAccess(req.portalUser, 'VIEW_EMPLOYEE', { targetEmployeeId: employeeId });

    res.json({
      total: withPct(total),
      employees: [...perEmployee.values()].map(withPct).sort((a, b) => b.activeSec - a.activeSec),
      days: summaries,
    });
  }),
);

// Minutes-since-midnight → "HH:mm".
function fmtMins(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// GET /late-report — per-person late-arrival summary over a date range. "Late" =
// the first activity of a working day starts after the company's office-start.
router.get(
  '/late-report',
  asyncHandler(async (req, res) => {
    const empWhere = { ...scopeFor(req.portalUser), isActive: true };
    const orgPick = providerOrgScope(req);
    if (orgPick) empWhere.organisationId = orgPick;
    if (req.query.groupId && ['PROVIDER_ADMIN', 'PROVIDER_SUPPORT', 'ORG_ADMIN', 'MANAGER'].includes(req.portalUser.role)) {
      empWhere.groupId = req.query.groupId;
    }
    const employees = await prisma.monitoredEmployee.findMany({
      where: empWhere,
      select: { id: true, displayName: true, upn: true, organisationId: true },
    });
    if (employees.length === 0) return res.json({ rows: [] });

    // Date window (default last 7 days), as UTC midnights.
    const end = req.query.toDate ? dateOnly(req.query.toDate) : dateOnly(new Date());
    const start = req.query.fromDate ? dateOnly(req.query.fromDate) : new Date(end);
    if (!req.query.fromDate) start.setUTCDate(start.getUTCDate() - 6);
    const days = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) days.push(new Date(d));
    if (days.length === 0 || days.length > 92) return res.status(400).json({ error: 'Pick a range of up to ~3 months.' });

    // Office config per org (cached) — drives office-start, working days, timezone.
    const cfgCache = new Map();
    const cfgFor = async (orgId) => {
      const key = orgId || '__none__';
      if (!cfgCache.has(key)) cfgCache.set(key, officeConfig(await getMonitoringSettings(orgId)));
      return cfgCache.get(key);
    };

    const rows = [];
    for (const emp of employees) {
      const cfg = await cfgFor(emp.organisationId);
      let worked = 0, late = 0, totalLate = 0, worst = 0, totalArrival = 0;
      const dayList = []; // every worked day: when they started, and how late
      for (const day of days) {
        const dayEnd = new Date(day); dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
        const first = await prisma.activityEvent.findFirst({
          where: { employeeId: emp.id, isIdle: false, startTime: { gte: day, lt: dayEnd } },
          orderBy: { startTime: 'asc' },
          select: { startTime: true },
        });
        if (!first) continue;
        const { dayNum, minutesOfDay } = localTimeInfo(first.startTime, cfg.timezone);
        if (!cfg.days.has(dayNum)) continue; // non-working day → ignore
        worked += 1;
        totalArrival += minutesOfDay;
        const lateBy = minutesOfDay - cfg.startMin;
        if (lateBy > 0) { late += 1; totalLate += lateBy; worst = Math.max(worst, lateBy); }
        dayList.push({ date: day.toISOString().slice(0, 10), start: fmtMins(minutesOfDay), lateBy: Math.max(0, lateBy) });
      }
      if (worked === 0) continue;
      rows.push({
        employeeId: emp.id,
        displayName: emp.displayName || emp.upn || 'Unnamed',
        officeStart: fmtMins(cfg.startMin),
        worked, late,
        onTimePct: Math.round(((worked - late) / worked) * 100),
        avgStart: fmtMins(Math.round(totalArrival / worked)), // typical start time
        avgLateMin: late ? Math.round(totalLate / late) : 0,
        worstLateMin: worst,
        days: dayList, // per-day start timestamps
      });
    }
    rows.sort((a, b) => b.late - a.late || b.avgLateMin - a.avgLateMin);
    await logAccess(req.portalUser, 'VIEW_LATE_REPORT', {});
    res.json({ rows });
  }),
);

router.get(
  '/devices',
  asyncHandler(async (req, res) => {
    const orgPick = providerOrgScope(req);
    const where = { ...deviceWhere(req.portalUser), ...(orgPick ? { organisationId: orgPick } : {}) };
    const devices = await prisma.monitoredDevice.findMany({
      where,
      orderBy: { lastSeenAt: 'desc' },
      include: {
        _count: { select: { events: true } },
        organisation: { select: { id: true, name: true } },
        employees: { select: { id: true, displayName: true, upn: true, isActive: true }, orderBy: { updatedAt: 'desc' } },
      },
    });
    const out = devices.map((d) => {
      const { employees, ...rest } = d;
      const users = employees.map((e) => ({ id: e.id, name: e.displayName || e.upn || 'Unnamed', isActive: e.isActive }));
      return { ...rest, users, primaryEmployee: employees[0] || null };
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
      include: {
        group: { select: { id: true, name: true } },
        organisation: { select: { id: true, name: true } },
        primaryDevice: { select: { enrolledAt: true, lastSeenAt: true, deviceName: true } },
      },
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
    const orgPick = providerOrgScope(req);
    if (orgPick) where.organisationId = orgPick;
    if (req.query.groupId && ['PROVIDER_ADMIN', 'PROVIDER_SUPPORT', 'ORG_ADMIN', 'MANAGER'].includes(req.portalUser.role)) {
      where.groupId = req.query.groupId;
    }
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
      const present = (r.activeSec || 0) + (r.idleSec || 0);
      const pct = present > 0 ? Math.round((r.productiveSec / present) * 100) : 0;
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
  const effCat = (o) => o.customCategory || o.category; // custom category wins
  const out = apps.map((a) => {
    const ov = ovByProc.get(a.processName.toUpperCase());
    return {
      processName: a.processName,
      displayName: a.displayName,
      category: ov ? effCat(ov) : a.category,
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
      out.push({ processName: o.processName, displayName: o.displayName || o.processName, category: effCat(o), weight: o.weight, isOverride: true, globalCategory: null, globalWeight: null });
    }
  }
  res.json(out.sort((a, b) => (a.displayName || a.processName).localeCompare(b.displayName || b.processName)));
}));

// Set (or clear) this company's classification for an app. `category` may be a
// built-in AppCategory OR one of the company's custom category names.
router.put('/apps/classify', requirePortalRole('ORG_ADMIN'), asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  if (!orgId) return res.status(400).json({ error: 'organisationId is required' });
  const processName = String(req.body?.processName || '').trim().toUpperCase();
  if (!processName) return res.status(400).json({ error: 'processName is required' });
  const category = String(req.body?.category || '');
  let weight = req.body?.weight;

  // Built-in category → store the enum; otherwise it must be one of this company's
  // custom categories (category stays UNCATEGORISED, the name goes in customCategory).
  const data = { displayName: String(req.body?.displayName || '').trim() || null };
  if (APP_CATEGORIES.includes(category)) {
    data.category = category;
    data.customCategory = null;
  } else {
    const custom = await prisma.orgCategory.findUnique({ where: { organisationId_name: { organisationId: orgId, name: category } } });
    if (!custom) return res.status(400).json({ error: 'Invalid category' });
    data.category = 'UNCATEGORISED';
    data.customCategory = custom.name;
    if (!WEIGHTS.includes(weight)) weight = custom.weight; // default to the category's weight
  }
  if (!WEIGHTS.includes(weight)) return res.status(400).json({ error: 'Invalid weight' });
  data.weight = weight;

  const row = await prisma.orgAppClassification.upsert({
    where: { organisationId_processName: { organisationId: orgId, processName } },
    update: data,
    create: { organisationId: orgId, processName, ...data },
  });
  res.json(row);
}));

// ── Custom per-company app categories ────────────────────────────────────────
router.get('/org-categories', asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  if (!orgId) return res.json([]);
  const cats = await prisma.orgCategory.findMany({ where: { organisationId: orgId }, orderBy: { name: 'asc' } });
  res.json(cats);
}));

router.post('/org-categories', requirePortalRole('ORG_ADMIN'), asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  if (!orgId) return res.status(400).json({ error: 'organisationId is required' });
  const name = String(req.body?.name || '').trim();
  const weight = WEIGHTS.includes(req.body?.weight) ? req.body.weight : 'NEUTRAL';
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  if (APP_CATEGORIES.includes(name.toUpperCase().replace(/[\s-]+/g, '_'))) {
    return res.status(409).json({ error: 'That matches a built-in category — pick a different name' });
  }
  try {
    const row = await prisma.orgCategory.create({ data: { organisationId: orgId, name, weight } });
    res.status(201).json(row);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'That category already exists' });
    throw e;
  }
}));

router.delete('/org-categories/:id', requirePortalRole('ORG_ADMIN'), asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  const cat = await prisma.orgCategory.findFirst({ where: { id: req.params.id, organisationId: orgId } });
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  // Un-file any apps using it (back to Uncategorised; their weight is kept).
  await prisma.orgAppClassification.updateMany({
    where: { organisationId: orgId, customCategory: cat.name },
    data: { customCategory: null, category: 'UNCATEGORISED' },
  });
  await prisma.orgCategory.delete({ where: { id: cat.id } });
  res.json({ ok: true });
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
  const u = req.portalUser;
  // Provider admin may inspect any org via ?organisationId.
  if (u.role === 'PROVIDER_ADMIN') return req.query.organisationId || req.body?.organisationId || null;
  // Scoped provider staff may inspect any company they're assigned to.
  if (u.role === 'PROVIDER_SUPPORT' || u.role === 'PROVIDER_VIEWER') {
    const want = req.query.organisationId || req.body?.organisationId || null;
    return want && (u.assignedOrgIds || []).includes(want) ? want : null;
  }
  // Everyone else is pinned to their own org.
  return u.organisationId;
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

    const { officeStart, officeEnd, workingDays, timezone, idleThresholdSec, dailyDigest, weeklyDigest, digestRecipients } = req.body || {};
    const hhmm = /^([01]?\d|2[0-3]):[0-5]\d$/;
    const data = {};
    if (idleThresholdSec !== undefined) {
      const n = idleThresholdSec === null || idleThresholdSec === '' ? null : Number(idleThresholdSec);
      if (n !== null && (!Number.isInteger(n) || n < 30 || n > 7200)) {
        return res.status(400).json({ error: 'Idle timeout must be 30–7200 seconds (or blank for the default).' });
      }
      data.idleThresholdSec = n;
    }
    if (dailyDigest !== undefined) data.dailyDigest = !!dailyDigest;
    if (weeklyDigest !== undefined) data.weeklyDigest = !!weeklyDigest;
    if (digestRecipients !== undefined) {
      const cleaned = String(digestRecipients || '').split(',').map((s) => s.trim()).filter(Boolean);
      const bad = cleaned.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
      if (bad) return res.status(400).json({ error: `"${bad}" is not a valid email address` });
      data.digestRecipients = cleaned.join(', ') || null;
    }
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

// Send a digest right now to the caller, so they can preview it. ?type=daily|weekly.
router.post(
  '/digests/test',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    const orgId = targetOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'organisationId is required' });
    if (!req.portalUser.email) return res.status(400).json({ error: 'Your account has no email address to send a test to.' });
    const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { id: true, name: true } });
    if (!org) return res.status(404).json({ error: 'Company not found' });
    const setting = await getMonitoringSettings(orgId);
    const type = req.query.type === 'weekly' ? 'weekly' : 'daily';
    // ?to=me sends only to the caller (quiet preview); default sends to the REAL
    // recipient list (admins/managers + extras) so delivery to everyone is tested.
    const toCaller = req.query.to === 'me';
    const result = await sendDigest({ org, setting, type, to: toCaller ? req.portalUser.email : undefined });
    res.json({
      ok: true,
      type,
      recipients: result.recipients || [],
      emailConfigured,
      mode: result.mode, // 'resend' sent, 'logmode' until the key is set, 'error' on failure, 'skipped' = no recipients
      error: result.error || null,
    });
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
    if (isActive !== undefined) {
      // Reactivating a removed user takes a seat — enforce the company limit.
      if (isActive && !target.isActive && target.organisationId) {
        const org = await prisma.organisation.findUnique({ where: { id: target.organisationId }, select: { seatLimit: true } });
        if (org?.seatLimit != null) {
          const active = await prisma.monitoredEmployee.count({ where: { organisationId: target.organisationId, isActive: true } });
          if (active >= org.seatLimit) return res.status(409).json({ error: `Seat limit reached (${org.seatLimit}). Remove a monitored user first.` });
        }
      }
      data.isActive = !!isActive;
    }
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
    // Removing a user retires their device too, so an uninstalled / removed laptop
    // drops out of the active-device count.
    if (data.isActive === false && target.primaryDeviceId) {
      await prisma.monitoredDevice.updateMany({
        where: { id: target.primaryDeviceId, ...deviceWhere(req.portalUser) },
        data: { status: 'DISABLED' },
      });
    }
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

    const { status, rotateToken, deviceName } = req.body || {};
    const data = {};
    if (status) data.status = status;
    if (typeof deviceName === 'string' && deviceName.trim()) data.deviceName = deviceName.trim();
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
