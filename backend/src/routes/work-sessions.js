// Agent plane for the desktop work-tracker widget: client picker + start/stop
// timed tasks. Per-device token auth (authenticateAgent), same as monitoring.js
// — no Entra anywhere here. Mounted at the same /api/monitoring base.

import { Router } from 'express';
import asyncHandler from 'express-async-handler';

import { authenticateAgent } from '../middleware/agent-auth.js';
import { resolveEmployee } from './monitoring.js';
import prisma from '../prisma.js';

const router = Router();

// GET /api/monitoring/clients — this company's active clients, for the picker.
router.get('/clients', authenticateAgent, asyncHandler(async (req, res) => {
  const device = req.device;
  if (!device.organisationId) return res.json([]);
  const clients = await prisma.client.findMany({
    where: { organisationId: device.organisationId, isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  res.json(clients);
}));

// GET /api/monitoring/tasks — this company's predefined task names, offered as
// suggestions in the widget's task picker (still free-text underneath).
router.get('/tasks', authenticateAgent, asyncHandler(async (req, res) => {
  const device = req.device;
  if (!device.organisationId) return res.json([]);
  const tasks = await prisma.taskType.findMany({
    where: { organisationId: device.organisationId, isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  res.json(tasks);
}));

// GET /api/monitoring/work/open?localAccountKey= — this employee's still-open
// sessions, so the widget can restore its running timers after the PC
// restarts instead of losing track of (or duplicating) them.
router.get('/work/open', authenticateAgent, asyncHandler(async (req, res) => {
  const device = req.device;
  const localKey = req.query.localAccountKey;
  if (!localKey || !device.organisationId) return res.json([]);

  const emp = await prisma.monitoredEmployee.findUnique({
    where: { organisationId_localAccountKey: { organisationId: device.organisationId, localAccountKey: String(localKey) } },
  });
  if (!emp) return res.json([]);

  const open = await prisma.workSession.findMany({
    where: { employeeId: emp.id, endTime: null },
    include: { client: { select: { id: true, name: true } } },
    orderBy: { startTime: 'asc' },
  });
  res.json(open.map((s) => ({
    agentSessionId: s.agentSessionId,
    clientId: s.clientId,
    clientName: s.client?.name ?? null,
    taskName: s.taskName,
    notes: s.notes,
    startTime: s.startTime,
  })));
}));

// POST /api/monitoring/work/start
// Body: { employee: { localAccountKey, displayName }, clientId?, taskName, notes?, agentSessionId }
// agentSessionId is a GUID the widget mints per Start click — makes retries
// (a flaky connection) idempotent instead of creating duplicate sessions.
router.post('/work/start', authenticateAgent, asyncHandler(async (req, res) => {
  const device = req.device;
  if (!device.organisationId) return res.status(403).json({ error: 'Work tracking is a product-build feature' });

  const { employee, clientId, taskName, notes, agentSessionId } = req.body || {};
  const localKey = employee?.localAccountKey;
  if (!localKey) return res.status(400).json({ error: 'employee.localAccountKey is required' });
  if (!taskName || !String(taskName).trim()) return res.status(400).json({ error: 'taskName is required' });
  if (!agentSessionId) return res.status(400).json({ error: 'agentSessionId is required' });

  const existing = await prisma.workSession.findUnique({ where: { agentSessionId } });
  if (existing) return res.status(200).json({ id: existing.id, agentSessionId });

  const emp = await resolveEmployee(device, employee, localKey);
  if (!emp) return res.status(403).json({ error: 'Not monitored (over the company seat limit, or removed)' });

  if (clientId) {
    const client = await prisma.client.findFirst({ where: { id: clientId, organisationId: device.organisationId, isActive: true } });
    if (!client) return res.status(400).json({ error: 'Unknown or inactive client' });
  }

  const session = await prisma.workSession.create({
    data: {
      organisationId: device.organisationId,
      employeeId: emp.id,
      deviceId: device.id,
      clientId: clientId || null,
      taskName: String(taskName).trim(),
      notes: notes ? String(notes).trim() : null,
      startTime: new Date(),
      agentSessionId,
    },
  });
  res.status(201).json({ id: session.id, agentSessionId });
}));

// POST /api/monitoring/work/end — Body: { agentSessionId }
router.post('/work/end', authenticateAgent, asyncHandler(async (req, res) => {
  const { agentSessionId } = req.body || {};
  if (!agentSessionId) return res.status(400).json({ error: 'agentSessionId is required' });

  const session = await prisma.workSession.findUnique({ where: { agentSessionId } });
  if (!session || session.organisationId !== req.device.organisationId) {
    return res.status(404).json({ error: 'Unknown session' });
  }
  if (!session.endTime) {
    await prisma.workSession.update({ where: { id: session.id }, data: { endTime: new Date() } });
  }
  res.json({ ok: true });
}));

export default router;
