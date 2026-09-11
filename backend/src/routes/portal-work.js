// Portal plane for the work-tracker feature: each company's Clients list
// (admin-managed) and the "time by client" report. Mounted at the same
// /api/portal/monitoring base as portal-monitoring.js, same auth/scoping
// conventions — kept in its own file since portal-monitoring.js was already
// large before this.

import { Router } from 'express';
import asyncHandler from 'express-async-handler';

import prisma from '../prisma.js';
import { authenticatePortal, requirePortalRole, scopeFor, blockReadOnlyProvider } from '../middleware/portal-auth.js';
import { dateOnly } from '../lib/monitoring-rollup.js';

const router = Router();
router.use(authenticatePortal);
router.use(blockReadOnlyProvider);

// Mirrors portal-monitoring.js's targetOrgId: which company a request targets.
function targetOrgId(req) {
  const u = req.portalUser;
  if (u.role === 'PROVIDER_ADMIN') return req.query.organisationId || req.body?.organisationId || null;
  if (u.role === 'PROVIDER_SUPPORT' || u.role === 'PROVIDER_VIEWER') {
    const want = req.query.organisationId || req.body?.organisationId || null;
    return want && (u.assignedOrgIds || []).includes(want) ? want : null;
  }
  return u.organisationId;
}

// WorkSession has no direct groupId column — group-scoped roles filter via
// the employee relation, same pattern as portal-monitoring.js's deviceWhere.
function workSessionWhere(portalUser) {
  const s = scopeFor(portalUser);
  if (s.groupId !== undefined) {
    const { groupId, ...rest } = s;
    return { ...rest, employee: { groupId } };
  }
  return s;
}

// ── Clients ──────────────────────────────────────────────────────────────

router.get('/clients', asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  if (!orgId) return res.json([]);
  const clients = await prisma.client.findMany({
    where: { organisationId: orgId, ...(req.query.activeOnly === 'true' ? { isActive: true } : {}) },
    orderBy: { name: 'asc' },
  });
  res.json(clients);
}));

router.post('/clients', requirePortalRole('ORG_ADMIN'), asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  if (!orgId) return res.status(400).json({ error: 'organisationId is required' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Client name is required' });
  try {
    const row = await prisma.client.create({ data: { organisationId: orgId, name } });
    res.status(201).json(row);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A client with that name already exists' });
    throw e;
  }
}));

router.patch('/clients/:id', requirePortalRole('ORG_ADMIN'), asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  const client = await prisma.client.findFirst({ where: { id: req.params.id, organisationId: orgId } });
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const data = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Client name cannot be blank' });
    data.name = name;
  }
  if (req.body?.isActive !== undefined) data.isActive = !!req.body.isActive;
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  try {
    const row = await prisma.client.update({ where: { id: client.id }, data });
    res.json(row);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A client with that name already exists' });
    throw e;
  }
}));

// POST /clients/import — bulk-add clients from a CSV the browser already
// parsed into plain names (simplest: no server-side CSV/multipart parsing
// needed). Creates whatever's new, quietly skips names that already exist or
// are blank, and reactivates a matching client that had been deactivated.
router.post('/clients/import', requirePortalRole('ORG_ADMIN'), asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  if (!orgId) return res.status(400).json({ error: 'organisationId is required' });
  const names = Array.isArray(req.body?.names) ? req.body.names : [];
  const clean = [...new Set(names.map((n) => String(n || '').trim()).filter(Boolean))];
  if (clean.length === 0) return res.status(400).json({ error: 'No client names found in the file' });
  if (clean.length > 2000) return res.status(400).json({ error: 'Too many rows (max 2000 at a time)' });

  const existing = await prisma.client.findMany({
    where: { organisationId: orgId, name: { in: clean } },
    select: { id: true, name: true, isActive: true },
  });
  const existingByName = new Map(existing.map((c) => [c.name, c]));

  const toCreate = clean.filter((n) => !existingByName.has(n));
  const toReactivate = existing.filter((c) => !c.isActive);

  const [created] = await Promise.all([
    toCreate.length ? prisma.client.createMany({ data: toCreate.map((name) => ({ organisationId: orgId, name })) }) : { count: 0 },
    toReactivate.length ? prisma.client.updateMany({ where: { id: { in: toReactivate.map((c) => c.id) } }, data: { isActive: true } }) : null,
  ]);

  res.json({
    created: created.count,
    reactivated: toReactivate.length,
    alreadyActive: clean.length - toCreate.length - toReactivate.length,
    total: clean.length,
  });
}));

// ── Task types (picklist for the widget's task field) ───────────────────

router.get('/tasks', asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  if (!orgId) return res.json([]);
  const tasks = await prisma.taskType.findMany({
    where: { organisationId: orgId, ...(req.query.activeOnly === 'true' ? { isActive: true } : {}) },
    orderBy: { name: 'asc' },
  });
  res.json(tasks);
}));

router.post('/tasks', requirePortalRole('ORG_ADMIN'), asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  if (!orgId) return res.status(400).json({ error: 'organisationId is required' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Task name is required' });
  try {
    const row = await prisma.taskType.create({ data: { organisationId: orgId, name } });
    res.status(201).json(row);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A task with that name already exists' });
    throw e;
  }
}));

router.patch('/tasks/:id', requirePortalRole('ORG_ADMIN'), asyncHandler(async (req, res) => {
  const orgId = targetOrgId(req);
  const task = await prisma.taskType.findFirst({ where: { id: req.params.id, organisationId: orgId } });
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const data = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Task name cannot be blank' });
    data.name = name;
  }
  if (req.body?.isActive !== undefined) data.isActive = !!req.body.isActive;
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  try {
    const row = await prisma.taskType.update({ where: { id: task.id }, data });
    res.json(row);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A task with that name already exists' });
    throw e;
  }
}));

// ── Time-by-client report ───────────────────────────────────────────────
// Raw session rows for a date range — the report page groups/sums client-side,
// same approach as the existing Timeline / Apps & sites breakdowns.

router.get('/work-sessions', asyncHandler(async (req, res) => {
  const { fromDate, toDate, clientId, employeeId } = req.query;
  const where = { ...workSessionWhere(req.portalUser) };
  if (employeeId) where.employeeId = employeeId;
  if (clientId) where.clientId = clientId;
  if (fromDate || toDate) {
    where.startTime = {};
    if (fromDate) where.startTime.gte = dateOnly(fromDate);
    if (toDate) { const end = dateOnly(toDate); end.setUTCDate(end.getUTCDate() + 1); where.startTime.lt = end; }
  }

  const sessions = await prisma.workSession.findMany({
    where,
    orderBy: { startTime: 'desc' },
    take: 5000,
    include: {
      employee: { select: { id: true, displayName: true, upn: true } },
      client: { select: { id: true, name: true } },
    },
  });

  const now = Date.now();
  res.json(sessions.map((s) => ({
    id: s.id,
    employeeId: s.employeeId,
    employeeName: s.employee?.displayName || s.employee?.upn || 'Unnamed',
    clientId: s.clientId,
    clientName: s.client?.name ?? null,
    taskName: s.taskName,
    notes: s.notes,
    startTime: s.startTime,
    endTime: s.endTime,
    running: !s.endTime,
    durationSec: Math.max(0, Math.round(((s.endTime ? s.endTime.getTime() : now) - s.startTime.getTime()) / 1000)),
  })));
}));

export default router;
