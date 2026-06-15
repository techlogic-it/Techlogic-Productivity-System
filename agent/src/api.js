// Thin client for the product's agent plane (/api/monitoring/*). Uses the global
// fetch (Node ≥ 18). The production C# agent uses HttpClient against the same
// endpoints and identical JSON shapes.

export async function enroll(cfg, deviceName) {
  const res = await fetch(`${cfg.serverUrl}/api/monitoring/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enrollmentKey: cfg.enrollmentKey, deviceName, agentVersion: 'ref-0.1.0' }),
  });
  if (!res.ok) throw new Error(`enroll failed: ${res.status} ${await res.text()}`);
  return res.json(); // { deviceId, agentToken, policy }
}

export async function fetchPolicy(cfg, token) {
  const res = await fetch(`${cfg.serverUrl}/api/monitoring/config`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`config failed: ${res.status}`);
  return (await res.json()).policy;
}

export async function ingest(cfg, token, employee, events, sessionEvents = []) {
  const res = await fetch(`${cfg.serverUrl}/api/monitoring/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ employee, events, sessionEvents, agentVersion: 'ref-0.1.0' }),
  });
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`ingest auth error: ${res.status}`), { fatal: true });
  }
  if (!res.ok) throw new Error(`ingest failed: ${res.status} ${await res.text()}`);
  return res.json(); // { acceptedEvents, acceptedSessionEvents }
}
