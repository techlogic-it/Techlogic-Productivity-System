# Productivity Agent — reference implementation

A small **cross-platform reference agent** for the productivity-monitoring product.
It implements the full device protocol — **enrol → capture → ingest** — against
the product backend (`/api/monitoring/*`), and runs on macOS/Linux so the loop can
be exercised end-to-end without a Windows box.

> This is the **spec, not the shipping client**. The production agent is a
> **C#/.NET Windows** port that swaps two modules (identity + capture) and adds an
> installer/service. See [Production Windows port](#production-windows-port). The
> wire protocol and JSON shapes are identical, so the server needs no changes.

---

## What it does

1. **Enrol** (first run): `POST /api/monitoring/enroll` with the per-org
   **enrolment key** → receives a one-time **agent token** (only its hash is
   stored server-side) and the device's `deviceId`. Saved to `agent.state.json`.
2. **Capture**: every `sampleIntervalSec`, reads the **foreground app + window
   title** and **idle time**, building foreground-usage intervals (a new interval
   starts when the app or idle-state changes).
3. **Ingest**: every `uploadIntervalSec`, batches intervals to
   `POST /api/monitoring/ingest`, identified by the **OS account**
   (`localAccountKey`). Offline batches are spooled to disk and retried
   (idempotent — each event carries a UUID).

---

## Configuration

Resolved in order: **CLI flags → environment → config file**.

| Field | CLI | Env | Meaning |
|---|---|---|---|
| `serverUrl` | `--server` | `AGENT_SERVER_URL` | Product backend base URL |
| `enrollmentKey` | `--key` | `AGENT_ENROLLMENT_KEY` | **Per-organisation (per-group)** enrolment key |
| `claimCode` | `--claim` | `AGENT_CLAIM_CODE` | Optional — binds this install to a pre-created named person |

A config file (`agent.config.json`, or `$AGENT_CONFIG`, or `--config`) may also set
`statePath`, `spoolPath`, and a local `policy` override. See
[`agent.config.example.json`](agent.config.example.json). The server returns the
authoritative policy (sample/upload intervals, idle threshold, whether to collect
window titles); a local `policy` block overrides it per-field.

### Run

```bash
# One enrol + capture + upload, then exit (handy for testing)
node src/agent.js --once --server https://monitor.example.com --key <ENROLMENT_KEY>

# Continuous (Ctrl-C flushes and exits)
node src/agent.js --server https://monitor.example.com --key <ENROLMENT_KEY>

# Assigned laptop, pre-created person (claim code overrides the key's default group)
node src/agent.js --server https://monitor.example.com --key <KEY> --claim K7F2-9QXM
```

`agent.state.json` (deviceId + token, `0600`) and `agent.spool.jsonl` are created
next to the config. Delete `agent.state.json` to force re-enrolment.

---

## How a device/person gets its group

The agent **never carries a group**. The server decides it, in priority order:

1. **Claim code** → the person was pre-created in the dashboard *with a group*; the
   code binds this install to that person (and their group), overriding the device
   default. Use for **assigned laptops**.
2. **Enrolment key's default group** → captured users default into the group the
   key was minted with. **Mint one key per group/department** and ship that key in
   that department's install, so users auto-land in the right group.
3. **Neither** → the person is captured `UNMAPPED` with no group; an admin maps
   them in the dashboard's **People** screen.

So **the group a fresh install shows in = the default group on the enrolment key it
used** (unless a claim code says otherwise). For shared/VDI machines where mixed
groups log in, prefer claim codes or map-after-capture, because the key's default
is per-device.

---

## Production Windows port

Keep everything; replace two modules and add packaging.

| Concern | Reference (this repo) | Windows production (C#/.NET) |
|---|---|---|
| **Identity** (`identity.js`) | login username | the user **SID** (`S-1-5-21-…`) from the access token — immutable across renames; use as `localAccountKey` |
| **Foreground app** (`capture.js`) | AppleScript via `osascript` | `GetForegroundWindow` → `GetWindowThreadProcessId` → process image name |
| **Window title** | AppleScript `AXTitle` | `GetWindowText` |
| **Idle seconds** | `ioreg HIDIdleTime` | `GetLastInputInfo` (ticks since last input) |
| **Token storage** | `0600` JSON file | **DPAPI**-encrypted under `%ProgramData%\ProductivityAgent\` |
| **Run model** | foreground process | **Windows Service** (or per-user scheduled task for VDI) |
| **Config delivery** | file/env/CLI | registry (`HKLM\SOFTWARE\ProductivityAgent`) or `%ProgramData%` config, written by the installer |
| **Packaging** | n/a | **MSI / Win32** app, deployed via **Intune / GPO / RMM** with the enrolment key (+ optional claim code) as silent-install parameters: `msiexec /i Agent.msi SERVER=… KEY=… /qn` |

The HTTP calls (`enroll`/`config`/`ingest`), the batching/idempotency model, the
offline spool, and the `employee.localAccountKey` + claim-code semantics carry over
unchanged — this README's protocol is the contract.

### Privacy
`collectWindowTitles` (server policy) gates the most sensitive field — titles can
reveal document names and email subjects. For the product, default it **OFF
per-organisation** and enable only with the customer's documented consent (DPIA).
