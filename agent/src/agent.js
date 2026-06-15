#!/usr/bin/env node
import { randomUUID } from 'crypto';
import { loadConfig, loadState, saveState, defaultPolicy } from './config.js';
import { enroll, fetchPolicy, ingest } from './api.js';
import { getIdentity } from './identity.js';
import { getForeground, getIdleSec } from './capture.js';
import * as spool from './spool.js';

const log = (msg) => console.log(`[agent ${new Date().toISOString()}] ${msg}`);

const cfg = loadConfig();
const state = loadState(cfg);
const id = getIdentity();

// State: completed events awaiting upload, plus the currently-open segment.
let buffer = [];
let current = null;

function employeePayload() {
  return {
    localAccountKey: id.localAccountKey,
    displayName: id.displayName,
    // Claim code is sent until the server has bound this account (Path A).
    ...(cfg.claimCode && !state.claimed ? { claimCode: cfg.claimCode } : {}),
  };
}

function closeSegment(end) {
  if (!current) return;
  const durationSec = Math.max(1, Math.round((end - current.start) / 1000));
  buffer.push({
    clientEventId: randomUUID(),
    processName: current.processName,
    windowTitle: current.windowTitle,
    startTime: current.start.toISOString(),
    endTime: end.toISOString(),
    durationSec,
    isIdle: current.isIdle,
  });
  current = null;
}

function sampleOnce(policy) {
  const fg = getForeground();
  const isIdle = getIdleSec() >= policy.idleThresholdSec;
  const title = policy.collectWindowTitles ? fg.windowTitle : null;
  const now = new Date();
  // Start a new segment when the app or idle-state changes.
  if (current && (current.processName !== fg.processName || current.isIdle !== isIdle)) {
    closeSegment(now);
  }
  if (!current) current = { processName: fg.processName, windowTitle: title, isIdle, start: now };
  else if (current.windowTitle == null) current.windowTitle = title;
}

async function flush(policy) {
  closeSegment(new Date());
  const pending = [...spool.readAll(cfg.spoolPath), ...buffer];
  if (!pending.length) return;
  // Respect the server's max batch size.
  const batch = pending.slice(0, policy.maxBatchSize);
  try {
    const r = await ingest(cfg, state.agentToken, employeePayload(), batch);
    spool.clear(cfg.spoolPath);
    buffer = pending.slice(policy.maxBatchSize);
    if (cfg.claimCode && !state.claimed) { state.claimed = true; saveState(cfg, state); }
    log(`uploaded ${r.acceptedEvents} event(s)`);
  } catch (e) {
    if (e.fatal) {
      log(`FATAL: ${e.message} — token rejected; re-enrol required. Exiting.`);
      process.exit(1);
    }
    spool.append(cfg.spoolPath, buffer);
    buffer = [];
    log(`offline — spooled ${pending.length} event(s) for retry`);
  }
}

async function ensureEnrolled() {
  if (state.agentToken) return;
  if (!cfg.enrollmentKey) throw new Error('Not enrolled and no enrollmentKey provided');
  log(`enrolling device "${id.deviceName}"…`);
  const e = await enroll(cfg, id.deviceName);
  state.deviceId = e.deviceId;
  state.agentToken = e.agentToken;
  saveState(cfg, state);
  log(`enrolled (deviceId ${e.deviceId})`);
}

async function main() {
  await ensureEnrolled();

  const serverPolicy = await fetchPolicy(cfg, state.agentToken).catch(() => ({}));
  const policy = { ...defaultPolicy(), ...serverPolicy, ...cfg.policyOverride };
  log(`policy: sample ${policy.sampleIntervalSec}s · upload ${policy.uploadIntervalSec}s · idle ${policy.idleThresholdSec}s · titles ${policy.collectWindowTitles}`);
  log(`identity: ${id.displayName} (${id.localAccountKey})${cfg.claimCode ? ` · claim ${cfg.claimCode}` : ''}`);

  if (cfg.once) {
    sampleOnce(policy);
    await new Promise((r) => setTimeout(r, 2000));
    sampleOnce(policy);
    await flush(policy);
    log('done (--once)');
    return;
  }

  const sampleTimer = setInterval(() => sampleOnce(policy), policy.sampleIntervalSec * 1000);
  const uploadTimer = setInterval(() => flush(policy), policy.uploadIntervalSec * 1000);
  sampleOnce(policy);

  const shutdown = async () => {
    clearInterval(sampleTimer); clearInterval(uploadTimer);
    log('shutting down — final flush…');
    await flush(policy);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log('running — Ctrl-C to stop');
}

main().catch((e) => { log(`error: ${e.message}`); process.exit(1); });
