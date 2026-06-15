import fs from 'fs';

// Offline spool: when an upload fails (laptop offline), events are appended to a
// JSONL file and retried on the next successful cycle. Each event carries a
// client-assigned UUID, so re-sending after a partial failure is idempotent on
// the server (clientEventId is unique). The production agent uses an
// AES-encrypted spool; the protocol is identical.

export function append(spoolPath, events) {
  if (!events.length) return;
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(spoolPath, lines, { mode: 0o600 });
}

export function readAll(spoolPath) {
  if (!fs.existsSync(spoolPath)) return [];
  return fs.readFileSync(spoolPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function clear(spoolPath) {
  if (fs.existsSync(spoolPath)) fs.rmSync(spoolPath);
}
