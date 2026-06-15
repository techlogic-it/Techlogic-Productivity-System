import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import monitoringRouter from './routes/monitoring.js';
import portalAuthRouter from './routes/portal-auth.js';
import orgsRouter from './routes/orgs.js';
import portalMonitoringRouter from './routes/portal-monitoring.js';
import { runMonitoringRollup, runMonitoringRetention } from './lib/monitoring-rollup.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors({ origin: process.env.FRONTEND_URL || true }));
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Agent plane (enrol / config / ingest / download) — per-device token, no Entra.
app.use('/api/monitoring', monitoringRouter);
// Portal (dashboard) plane — email+password JWT.
app.use('/api/portal/auth', portalAuthRouter);
app.use('/api/portal/orgs', orgsRouter);
app.use('/api/portal/monitoring', portalMonitoringRouter);

// Single-service deploy: serve the built portal (frontend/dist) and SPA-fallback
// non-API routes to index.html. Skipped in dev where Vite serves the frontend.
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

async function runRollup(trigger) {
  try {
    const r = await runMonitoringRollup();
    console.log(`[rollup ${trigger}] events=${r.eventsProcessed} summaries=${r.summariesUpserted}`);
  } catch (err) {
    console.error('[rollup] failed:', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`Techlogic Productivity System API on port ${PORT}`);
  // Productivity rollup cadence (default every 5 min; MON_ROLLUP_INTERVAL_MIN to override).
  const rollupMin = Number(process.env.MON_ROLLUP_INTERVAL_MIN) || 5;
  setTimeout(() => runRollup('startup'), 5000);
  setInterval(() => runRollup('periodic'), rollupMin * 60 * 1000);
  // Retention sweep daily.
  setTimeout(() => runMonitoringRetention().catch(() => {}), 15000);
  setInterval(() => runMonitoringRetention().catch(() => {}), 24 * 60 * 60 * 1000);
});
