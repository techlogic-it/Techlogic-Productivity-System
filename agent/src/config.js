import fs from 'fs';
import path from 'path';
import os from 'os';

// Agent configuration + persistent state.
//
// Config (read-only, provisioned at install) holds the server URL, the per-org
// enrolment key, and an optional claim code. It is resolved from, in order:
//   1. CLI flags (--server, --key, --claim, --config)
//   2. environment (AGENT_SERVER_URL, AGENT_ENROLLMENT_KEY, AGENT_CLAIM_CODE)
//   3. a JSON config file (default ./agent.config.json or $AGENT_CONFIG)
//
// State (read-write, created at runtime) holds the deviceId + agent token handed
// back at enrolment. On Windows this lives in ProgramData and the token is
// DPAPI-encrypted; here it's a 0600 JSON file next to the config.

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--server') out.serverUrl = argv[++i];
    else if (a === '--key') out.enrollmentKey = argv[++i];
    else if (a === '--claim') out.claimCode = argv[++i];
    else if (a === '--config') out.configPath = argv[++i];
    else if (a === '--once') out.once = true;
  }
  return out;
}

export function loadConfig(argv = process.argv.slice(2)) {
  const cli = parseArgs(argv);
  const configPath = cli.configPath || process.env.AGENT_CONFIG || path.resolve('agent.config.json');

  let file = {};
  if (fs.existsSync(configPath)) {
    try { file = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch (e) { throw new Error(`Invalid config file ${configPath}: ${e.message}`); }
  }

  const cfg = {
    serverUrl: cli.serverUrl || process.env.AGENT_SERVER_URL || file.serverUrl,
    enrollmentKey: cli.enrollmentKey || process.env.AGENT_ENROLLMENT_KEY || file.enrollmentKey,
    claimCode: cli.claimCode || process.env.AGENT_CLAIM_CODE || file.claimCode || null,
    once: !!cli.once,
    // Where to keep runtime state + the offline spool. Defaults next to config.
    statePath: file.statePath || path.join(path.dirname(configPath), 'agent.state.json'),
    spoolPath: file.spoolPath || path.join(path.dirname(configPath), 'agent.spool.jsonl'),
    // Local policy overrides (the server's policy still wins unless set here).
    policyOverride: file.policy || {},
  };

  if (!cfg.serverUrl) throw new Error('serverUrl is required (--server / AGENT_SERVER_URL / config.serverUrl)');
  cfg.serverUrl = cfg.serverUrl.replace(/\/+$/, '');
  return cfg;
}

export function loadState(cfg) {
  if (fs.existsSync(cfg.statePath)) {
    try { return JSON.parse(fs.readFileSync(cfg.statePath, 'utf8')); }
    catch { /* fall through to empty */ }
  }
  return {};
}

export function saveState(cfg, state) {
  fs.writeFileSync(cfg.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function defaultPolicy() {
  return {
    sampleIntervalSec: 5,
    idleThresholdSec: 300,
    uploadIntervalSec: 60,
    collectWindowTitles: true,
    maxBatchSize: 1000,
  };
}
