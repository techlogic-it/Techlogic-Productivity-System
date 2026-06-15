# Laptop Productivity Monitoring — Architecture & Implementation Plan

**Status:** Draft for review · **Date:** 2026-05-29
**Owner:** Techlogic IT Services Ltd
**Codebase:** extends the existing `msp-platform` (backend API + admin dashboard); the Windows agent is a new standalone C#/.NET project.

> This is a planning document only. No code has been written yet. Where it
> proposes Prisma models, routes, or React pages it follows the conventions
> already established in `msp-platform` so implementation is a mechanical fit.

---

## 0. Scope decision (CONFIRMED 2026-05-29): internal staff first

**Confirmed: Scenario B — monitor Techlogic's own staff only, for now.**
Window titles **are** collected (see §9 — this is the most privacy-sensitive
field and raises the compliance bar). Dashboard access is **Techlogic-only**.
A customer-facing version is a *possible future* and would likely ship as
**separate software / a separate deployment**, not by exposing this dashboard to
customers — so we do **not** build customer tenant-scoping now, but we keep the
data model from painting us into a corner.

| Scenario | Monitored population | Tenant | Status |
|---|---|---|---|
| **B — Internal** | Techlogic's own staff | Techlogic's own Entra tenant | ✅ **building now** |
| A — Productised | Customers' employees | each `Customer.m365TenantId` | future, separate product |
| C — Both | both | mixed | not planned |

**Consequence for the data model.** In Scenario B the monitored people are largely
the same humans already in `User` (engineers, admins…). We still keep a separate
`MonitoredEmployee` entity rather than bolting activity data onto `User`, because:

- it keeps the high-volume monitoring domain decoupled from the auth/identity
  model, so the future "separate software" can lift it out cleanly;
- not every monitored Windows account necessarily has a dashboard `User` row;
- it gives one place to attach the agent/device relationships.

But we add an **optional `userId` link** from `MonitoredEmployee` → `User`, so
internal monitoring can correlate with your existing engineer-productivity
features (`DailyEntry`, the Engineer Productivity / Time Report tabs). Tenant is
modelled as `azureTenantId` (Techlogic's, single value for now) plus an **optional**
`customerId` left null for internal staff — present only so the future productised
build can reuse the schema.

> ⚠️ **Compliance still applies to your own staff.** Scenario B makes Techlogic
> the *controller* for its employees' data. You must still inform staff before
> monitoring, run a DPIA, set retention, and limit/audit access. Collecting
> **window titles** specifically must be justified in that DPIA because titles
> can reveal document names and email subjects. See §9.

---

## 1. How it fits the existing platform

```
┌─────────────────────────┐         ┌──────────────────────────────────────┐
│  Windows Agent (NEW)     │  HTTPS  │  msp-platform backend (Express)        │
│  C#/.NET, Intune Win32   │ ──────► │  NEW: /api/monitoring/* ingest routes  │
│  - foreground app        │  batch  │  - agent-token auth (NOT Entra JWT)    │
│  - active/idle           │  events │  - validates + stores ActivityEvent    │
│  - lock/unlock           │         │  - rollups → ActivitySummary           │
│  - offline cache         │         └───────────────┬──────────────────────┘
│  - AES-encrypted spool   │                         │ Prisma
└─────────────────────────┘                         ▼
                                          ┌────────────────────────┐
┌─────────────────────────┐  Entra JWT   │  PostgreSQL (existing)  │
│  Admin Dashboard         │ ◄──────────► │  + new monitoring models│
│  React/Vite (existing)   │  role-gated  └────────────────────────┘
│  NEW pages under /monitoring             ▲
│  reuse Layout/Sidebar/DataTable/StatCard │
└──────────────────────────────────────────┘
```

Two **separate auth planes** — this is the most important backend distinction:

- **Agent plane** (`/api/monitoring/ingest`, `/api/monitoring/enroll`): authenticated
  by a per-device **agent token**, not a human Entra JWT. New middleware
  `authenticateAgent` (sibling of `middleware/auth.js`). High write volume, no UI.
- **Dashboard plane** (`/api/monitoring/...` read/admin endpoints): the existing
  `authenticate` + `requireRole` from `middleware/auth.js`. Human users only.

Everything else reuses existing infrastructure: Prisma client (`src/prisma.js`),
the `AuditLog` model and pattern, the Express router-per-file convention
(`router.use(authenticate)` at top), the React `api.js` axios instance, and the
`Layout`/`Sidebar`/`DataTable`/`StatCard`/`Modal` components.

---

## 2. Data model (new Prisma models)

All follow existing conventions: `String @id @default(uuid())`,
`createdAt`/`updatedAt`, explicit relations, enums in `PascalCase` with
`SCREAMING_SNAKE` members.

### 2.1 Enums

```prisma
enum AppCategory {
  PRODUCTIVE
  COMMUNICATION
  DEVELOPMENT
  ADMIN_BACKOFFICE
  RESEARCH
  SOCIAL
  ENTERTAINMENT
  UNCATEGORISED
  BLOCKED_HIGH_RISK
}

enum ProductivityWeight {
  PRODUCTIVE
  NEUTRAL
  NON_PRODUCTIVE
}

enum SessionEventType {
  LOGIN
  LOGOUT
  LOCK
  UNLOCK
}

enum AgentDeviceStatus { ACTIVE  DISABLED  RETIRED }
```

### 2.2 Models

```prisma
// One physical/managed laptop running the agent.
// Scenario B: belongs to Techlogic's own tenant (azureTenantId).
// customerId stays null now; reserved for the future productised build.
model MonitoredDevice {
  id            String   @id @default(uuid())
  customerId    String?                      // null for internal staff (future use)
  customer      Customer? @relation(fields: [customerId], references: [id])
  deviceName    String                       // Windows device name
  entraDeviceId String?  @unique             // Entra/Intune device ID
  azureTenantId String?                      // Techlogic's tenant for now
  status        AgentDeviceStatus @default(ACTIVE)
  agentVersion  String?
  // Auth: store only a SHA-256 hash of the agent token, never the token itself.
  agentTokenHash String?  @unique
  enrolledAt    DateTime @default(now())
  lastSeenAt    DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  employees     MonitoredEmployee[]
  events        ActivityEvent[]
  sessionEvents SessionEvent[]
  summaries     ActivitySummary[]
}

// A monitored person (Entra user). Kept separate from `User` so the monitoring
// domain stays decoupled. In Scenario B, userId links to the Techlogic staff
// record so monitoring correlates with existing engineer-productivity features.
model MonitoredEmployee {
  id            String   @id @default(uuid())
  customerId    String?                       // null for internal staff (future use)
  customer      Customer? @relation(fields: [customerId], references: [id])
  userId        String?                        // optional link to dashboard User (Scenario B)
  user          User?     @relation("MonitoredEmployeeUser", fields: [userId], references: [id])
  entraUserId   String?                        // Entra object id (oid)
  upn           String?                        // user principal name / email
  displayName   String?
  isActive      Boolean  @default(true)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  events        ActivityEvent[]
  sessionEvents SessionEvent[]
  summaries     ActivitySummary[]

  @@unique([entraUserId])   // one tenant for now; see note
}
// NOTE: @@unique([entraUserId]) is correct while there's a single internal
// tenant. When the productised build adds real per-customer tenants, switch to
// @@unique([customerId, entraUserId]) so the same Entra id can exist per tenant.

// The catalogue of known applications + their classification (admin-editable).
model MonitoredApp {
  id            String   @id @default(uuid())
  // Match key — the executable / friendly name reported by the agent.
  processName   String   @unique              // e.g. "OUTLOOK.EXE"
  displayName   String                         // e.g. "Outlook"
  category      AppCategory        @default(UNCATEGORISED)
  weight        ProductivityWeight @default(NEUTRAL)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  events        ActivityEvent[]
}

// Raw foreground-usage interval. The high-volume table.
model ActivityEvent {
  id            String   @id @default(uuid())
  deviceId      String
  device        MonitoredDevice   @relation(fields: [deviceId], references: [id])
  employeeId    String
  employee      MonitoredEmployee @relation(fields: [employeeId], references: [id])
  appId         String?
  app           MonitoredApp?     @relation(fields: [appId], references: [id])
  processName   String                          // denormalised for unmatched apps
  windowTitle   String?                          // COLLECTED (policy on); privacy-sensitive, see §9
  startTime     DateTime
  endTime       DateTime
  durationSec   Int
  isIdle        Boolean  @default(false)         // interval was idle (no input)
  // Idempotency: agent assigns a UUID per event so retried uploads don't double-count.
  clientEventId String   @unique
  createdAt     DateTime @default(now())

  @@index([deviceId, startTime])
  @@index([employeeId, startTime])
}

model SessionEvent {
  id            String   @id @default(uuid())
  deviceId      String
  device        MonitoredDevice   @relation(fields: [deviceId], references: [id])
  employeeId    String
  employee      MonitoredEmployee @relation(fields: [employeeId], references: [id])
  type          SessionEventType
  occurredAt    DateTime
  clientEventId String   @unique
  createdAt     DateTime @default(now())

  @@index([deviceId, occurredAt])
}

// Pre-aggregated per-employee-per-day rollup that powers the dashboard fast.
model ActivitySummary {
  id              String   @id @default(uuid())
  customerId      String
  employeeId      String
  employee        MonitoredEmployee @relation(fields: [employeeId], references: [id])
  deviceId        String?
  device          MonitoredDevice?  @relation(fields: [deviceId], references: [id])
  summaryDate     DateTime                       // UTC midnight (see dateOnly() pattern)
  activeSec       Int      @default(0)
  idleSec         Int      @default(0)
  productiveSec   Int      @default(0)
  neutralSec      Int      @default(0)
  nonProductiveSec Int     @default(0)
  byCategory      Json                            // { PRODUCTIVE: 1234, SOCIAL: 56, ... }
  topApps         Json                            // [{ processName, displayName, sec }]
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([employeeId, summaryDate])
  @@index([customerId, summaryDate])
}

// Tamper-evident log of who viewed/exported monitoring data (ICO requirement).
model MonitoringAccessLog {
  id          String   @id @default(uuid())
  userId      String                            // existing dashboard User
  user        User     @relation(fields: [userId], references: [id])
  action      String                            // VIEW_EMPLOYEE | EXPORT_CSV | EXPORT_PDF ...
  customerId  String?
  targetEmployeeId String?
  meta        Json?
  createdAt   DateTime @default(now())

  @@index([userId, createdAt])
}
```

Add the back-relations to existing models: `Customer` gets
`monitoredDevices`, `monitoredEmployees` (both optional/future); `User` gets
`monitoringAccessLogs` and `monitoredAs MonitoredEmployee[] @relation("MonitoredEmployeeUser")`.

**Retention** (configurable, ICO): a scheduled job (same `setInterval` pattern as
`runNinjaSync` in `index.js`) deletes `ActivityEvent`/`SessionEvent` rows older
than N days while keeping `ActivitySummary` for trend reporting. Default 90 days
raw / 13 months aggregated — confirm with each customer's DPIA.

---

## 3. Backend API surface

New file `backend/src/routes/monitoring.js` (mounted `app.use('/api/monitoring', monitoringRouter)`),
plus admin sub-routes. Webhook-style ingest needs no Entra JWT.

### 3.1 Agent plane (agent-token auth)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/monitoring/enroll` | First-run handshake. Body: device name, Entra device id, tenant id, enrollment secret (provisioned via Intune). Returns a one-time **agent token**; server stores only its SHA-256 hash. |
| `POST` | `/api/monitoring/ingest` | Batched upload of `ActivityEvent[]` + `SessionEvent[]`. Idempotent via `clientEventId`. Updates `device.lastSeenAt`. |
| `GET` | `/api/monitoring/config` | Agent pulls policy: idle threshold, upload interval, whether window titles are collected, app blocklist. |

`authenticateAgent` middleware: reads `Authorization: Bearer <agentToken>`,
hashes it, looks up `MonitoredDevice.agentTokenHash`, rejects if disabled/retired,
attaches `req.device`. Rate-limit ingest per device.

### 3.2 Dashboard plane (`authenticate` + `requireRole`)

| Method | Path | Roles | Purpose |
|---|---|---|---|
| `GET` | `/api/monitoring/devices` | manager+ | list/filter devices, last-seen |
| `GET` | `/api/monitoring/employees` | manager+ | monitored employees per customer |
| `GET` | `/api/monitoring/summary` | manager+ | KPIs for employee/team/customer over a date range (reads `ActivitySummary`) |
| `GET` | `/api/monitoring/timeline` | manager+ | per-employee activity timeline (reads `ActivityEvent`) |
| `GET` | `/api/monitoring/apps` | admin | app catalogue |
| `PATCH` | `/api/monitoring/apps/:id` | admin | edit category/weight (writes `AuditLog`) |
| `POST` | `/api/monitoring/apps` | admin | add app classification |
| `GET` | `/api/monitoring/export` | manager+ | CSV/PDF export (writes `MonitoringAccessLog`) |
| `PATCH` | `/api/monitoring/devices/:id` | admin | disable/retire device, rotate token |

Every read of identifiable employee data and every export **must** write a
`MonitoringAccessLog` row (§9). Reuse the `resolveTargetUser`-style scoping seen
in `daily-reports.js`, but scoped by `customerId` + role rather than self.

### 3.3 Summary rollup job

`backend/src/lib/monitoring-rollup.js`, invoked from `index.js` on the existing
deferred-startup + `setInterval` pattern. Reads new/changed `ActivityEvent`s,
joins `MonitoredApp` for category/weight, upserts `ActivitySummary`
per `(employeeId, summaryDate)`. Keep it incremental (track a high-water mark)
so it stays cheap as volume grows.

---

## 4. Windows agent (new C#/.NET project)

Separate repo/solution (e.g. `productivity-agent/`), **not** inside msp-platform.
Target **.NET 8**, packaged as a single self-contained `.exe`. Runs as a per-user
background process (tray-optional) so it sees the interactive desktop session — a
Windows *service* runs in session 0 and cannot read the foreground window of a
user session without extra plumbing, so prefer a user-session app launched at
logon (or a service + per-session helper). Decide explicitly; this plan assumes
**per-user logon app**.

### 4.1 Signals & APIs (no keylogging, no content)

| Signal | Windows API |
|---|---|
| Foreground window + process | `GetForegroundWindow` → `GetWindowThreadProcessId` → `Process.GetProcessById` (process name = match key) |
| Window title (collected; policy `collectWindowTitles=true`) | `GetWindowText` — kept behind a config flag so it can be turned off per future tenant |
| Idle time | `GetLastInputInfo` (returns ms since last keyboard/mouse input; **no key contents**) |
| Lock / unlock | `SystemEvents.SessionSwitch` (`SessionLock` / `SessionUnlock`) |
| Login / logout | session start at process launch; logout via `SessionEnding` / process shutdown |
| Identity | `WindowsIdentity.GetCurrent()` for UPN; Entra device id from registry / `dsregcmd` / Graph |

### 4.2 Local pipeline

1. **Sampler** ticks every ~1–5 s: reads foreground process + idle time, coalesces
   consecutive same-app samples into one `ActivityEvent` interval; marks the
   interval idle when idle ms exceeds the policy threshold (e.g. 5 min).
2. **Spool**: events written to an **encrypted local cache** (SQLite + AES, key
   from **DPAPI** so it's bound to the machine/user) so nothing is lost offline.
3. **Uploader**: every N minutes, batch-POST spooled events to `/ingest`; delete
   on 200. Each event carries a `clientEventId` UUID for idempotency.
4. **Config refresh**: periodic `GET /config` to pick up policy changes.
5. **Tamper resistance**: minimise local privilege, detect/restart if killed
   (Intune can redeploy), sign the binary, validate server TLS cert.

### 4.3 Enrollment

On first launch the agent reads an **enrollment secret** provisioned by Intune
(app config / registry key set at deployment), calls `/enroll` with device
identity, receives and DPAPI-stores its agent token. No interactive Entra login
required on the agent — device-scoped tokens keep it headless.

---

## 5. Categorisation engine

- `MonitoredApp` is the admin-editable catalogue (`processName` → category + weight).
- On rollup, each `ActivityEvent.processName` is matched to a `MonitoredApp`;
  unmatched → `UNCATEGORISED` (surfaced in the dashboard so admins can classify).
- **Productivity %** = `productiveSec / (activeSec)` (idle excluded), with
  `NEUTRAL` configurable to count as half or excluded — make the formula a single
  documented function so the definition is consistent everywhere.
- Seed the catalogue with common apps (Outlook→Communication, Excel→Productive,
  Teams→Communication/Neutral, YouTube→Entertainment, Facebook→Social) via the
  existing `prisma/seed.js` approach.

---

## 6. Dashboard (extends existing React app)

New pages under `frontend/src/pages/monitoring/`, registered in `App.jsx`,
linked from `Sidebar.jsx` behind a role check. Reuse `DataTable`, `StatCard`,
`Modal`, `Badge`, and `lib/exports.js` for CSV/PDF.

| Page | Route | Content |
|---|---|---|
| Monitoring overview | `/monitoring` | per-customer/team KPIs, StatCards (active/idle/productive/social, top app, last active) |
| Employee detail | `/monitoring/employees/:id` | timeline, app breakdown, daily/weekly/monthly summaries, productivity % |
| Devices | `/monitoring/devices` | last-seen, agent version, status; disable/retire/rotate-token |
| App categories | `/monitoring/apps` | admin-only category/weight editor |

Gate all monitoring pages to `ENGINEER_MANAGER`/`ADMIN`/`SUPER_ADMIN` (and
whatever customer-facing role you add). KPIs map directly to §5 of the brief.

---

## 7. Security

- **In transit:** HTTPS/TLS only; agent pins/validates server cert.
- **At rest:** local spool AES-encrypted with DPAPI-derived key; DB column-level
  encryption optional for `windowTitle` if collected.
- **Agent auth:** per-device bearer token; **store only SHA-256 hash** server-side;
  support rotation + disable/retire.
- **Dashboard auth:** existing Entra JWT + `requireRole`; destructive ops via
  `requireSuperAdmin`.
- **Audit:** app re-classification → `AuditLog`; data views/exports →
  `MonitoringAccessLog`.
- **Abuse limits:** rate-limit `/ingest` and `/enroll`; cap batch size (reuse the
  existing 10 mb body limit as a ceiling, but validate counts).

---

## 8. Intune / Entra deployment

- Package the agent `.exe` + dependencies as a **Win32 app (`.intunewin`)** via the
  Microsoft Win32 Content Prep Tool; deploy to Entra-joined, Intune-enrolled
  laptops. Provision the per-tenant enrollment secret through the app's install
  command / a registry value set at deployment.
- Use **detection rules** (file/registry/version) so Intune reports install state
  and **auto-updates** by superseding the app version.
- Optionally use **Microsoft Graph** (`deviceManagement/managedDevices`,
  `devices`) to reconcile `MonitoredDevice.entraDeviceId` and pull device/last-seen
  metadata — fits the existing integration pattern (NinjaOne, QuickBooks).

---

## 9. Privacy & compliance (UK ICO) — *not optional*

The brief is explicit and correct: build **activity analytics, not spyware**.
Hard rules baked into the design:

- **No** keystrokes, content, screenshots, webcam, mic, files, or browser page
  content. Idle detection uses `GetLastInputInfo` timing only — never key data.
- **Window titles ARE collected** (your decision) but kept behind a config flag so
  they can be disabled later (e.g. per future customer tenant). They are the most
  sensitive field — they can reveal document names and email subjects — so this
  collection **must be explicitly justified in the DPIA and in the staff notice**,
  and consider storing the column encrypted at rest.
- **Transparency:** staff must be informed *before* monitoring; provide a
  plain-English notice of what's collected and why.
- **DPIA** per deploying organisation; **retention** configurable and enforced by
  the cleanup job (§2); **access** limited to authorised managers by role; every
  view/export audited via `MonitoringAccessLog`.
- **Scenario B controller duty:** Techlogic is the *controller* for its own staff
  → Techlogic runs the DPIA, issues the staff notice, and owns retention/access.
  (A future productised build flips this to processor-per-customer.)

Encode these as actual config defaults and access checks, not just prose.

---

## 10. Phased implementation (maps to brief §10)

**Phase 1 — MVP**
1. Confirm Scenario A/B/C (§0). *(blocking)*
2. Prisma: add enums + models, migration, seed app catalogue.
3. `authenticateAgent` middleware + `/enroll` + `/ingest` + `/config`.
4. Rollup job → `ActivitySummary`; retention cleanup job.
5. Agent v0.1: foreground app, idle/active, lock/unlock, encrypted spool, upload.
6. Dashboard: overview + employee detail + app-category editor (role-gated).
7. Intune Win32 packaging + enrollment-secret provisioning.

**Phase 2** — team/department reporting, weekly trends, unusual-activity alerts,
CSV/PDF export (`MonitoringAccessLog`), Graph device reconciliation, refined roles.

**Phase 3** — policy-based reporting, advanced productivity scoring, API
integrations, SIEM export, Power BI.

---

## 11. Decisions

**Resolved 2026-05-29:**
- ✅ **Scope:** Scenario B — Techlogic's own staff only (future customer version = separate software).
- ✅ **Window titles:** collected, behind a config flag, DPIA-justified (§9).
- ✅ **Dashboard access:** Techlogic only; no customer tenant-scoping now.

**Still open (needed before / during Phase 1 build):**
1. **Agent process model** — per-user logon app (assumed) vs service+helper.
2. **Retention defaults** — proposed 90 days raw `ActivityEvent` / 13 months `ActivitySummary`.
3. **Productivity % formula** — how does `NEUTRAL` time count (half / excluded)?
4. **Sampling + upload intervals**, **idle threshold** — proposed 1–5 s sample,
   5 min idle, ~5 min upload batch.
5. **Link monitored staff to `User`?** — auto-match `MonitoredEmployee.userId` by
   Entra `oid`/UPN so monitoring feeds the existing engineer-productivity views?
   (Recommended — low cost, high value internally.)
