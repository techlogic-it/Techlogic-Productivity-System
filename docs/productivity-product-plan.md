# Productivity Monitoring — Standalone Product Plan (Scenario A)

**Status:** Draft for review · **Date:** 2026-06-12
**Owner:** Techlogic IT Services Ltd
**Builds on:** [`productivity-monitoring-plan.md`](productivity-monitoring-plan.md) (the internal "Scenario B" build, already shipped)

> This promotes the existing internal-staff monitoring module into a
> **standalone, multi-tenant product** that client organisations can buy. It is
> **not a rewrite** — the agent ingest protocol, storage model, rollup engine,
> and `/monitoring` dashboard pages all carry over. The work is adding a
> tenancy layer, a self-contained login, and a local (non-Entra) identity path.

---

## 0. Confirmed decisions (2026-06-12)

| Decision | Choice |
|---|---|
| **Codebase** | Multi-tenant **in-place** inside `msp-platform`; run the product as a **separate deployment** of the same repo. |
| **Agent → user linking** | **Hybrid**: per-user *claim codes* for assigned laptops **and** *capture-then-map* for VDI/shared machines. |
| **Hierarchy** | **Provider → Organisation → Group → User** (4 levels). Techlogic is the Provider, above client Organisations. |
| **Dashboard login** | **Email + password** now (hashed, invite-based), designed so an **optional per-org SSO/OIDC** connector can be added later without rework. |

### What this explicitly removes
- **No Office 365 / Entra dependency** for the product. The internal MSP app keeps its Entra login; the product gets its own local auth plane. One codebase, two auth planes selected per route group / per deployment.
- **No Entra-derived identity.** `MonitoredEmployee` is no longer keyed on `entraUserId`; it's keyed on a tenant-scoped local account key (Windows SID/username) plus the claim-code binding.

---

## 1. Deployment topology (one repo, two products)

```
                          ┌──────────────────────────────────────┐
  Internal MSP deploy     │ msp-platform (existing)               │
  (sales.techlogic…)      │  Entra/MSAL login · MSP features      │
                          │  + internal monitoring (Scenario B)   │
                          └──────────────────────────────────────┘

                          ┌──────────────────────────────────────┐
  PRODUCT deploy (NEW)    │ same repo, PRODUCT_MODE=true          │
  (e.g. monitor.techlogic…)│  Local email+password login (portal) │
                          │  Provider/Org/Group/User tenancy      │
                          │  /monitoring dashboard, tenant-scoped │
                          │  Agent ingest plane (token auth)      │
                          └──────────────────────────────────────┘
```

A single env flag (`PRODUCT_MODE`) and route-mounting decides which surface a
given deployment exposes. The agent ingest plane (`/api/monitoring/enroll|ingest|config`)
is identical in both — it never used Entra.

### Three auth planes
1. **Agent plane** — per-device bearer token (`authenticateAgent`). *Unchanged.*
2. **MSP plane** — Entra JWT (`authenticate`). *Unchanged, internal deploy only.*
3. **Portal plane (NEW)** — product JWT issued from email+password (`authenticatePortal`). Mounted on all product dashboard/admin routes.

---

## 2. Data model changes

### 2.1 New models

```prisma
enum PortalRole {
  PROVIDER_ADMIN   // Techlogic — sees/manages all organisations
  ORG_ADMIN        // client org admin — sees the whole org
  GROUP_ADMIN      // sees ONLY their group's reports
  VIEWER           // read-only, scoped like its group/org
}

// The tenant. A client company that buys the product.
model Organisation {
  id            String   @id @default(uuid())
  name          String
  slug          String   @unique
  status        String   @default("ACTIVE")   // ACTIVE | SUSPENDED
  // Optional link to the MSP Customer record, for internal cross-sell/billing.
  customerId    String?
  customer      Customer? @relation(fields: [customerId], references: [id])
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  groups          Group[]
  portalUsers     PortalUser[]
  enrollmentKeys  EnrollmentKey[]
  devices         MonitoredDevice[]
  employees       MonitoredEmployee[]
  setting         MonitoringSetting?
}

// A team/department within an org. The unit of GROUP_ADMIN scoping.
model Group {
  id              String   @id @default(uuid())
  organisationId  String
  organisation    Organisation @relation(fields: [organisationId], references: [id])
  name            String
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  portalUsers     PortalUser[]
  employees       MonitoredEmployee[]
  @@unique([organisationId, name])
}

// Dashboard login identity for the product. Separate from `User` (the Entra-
// bound MSP staff model) so the product stays decoupled and password-based.
model PortalUser {
  id              String   @id @default(uuid())
  organisationId  String?                  // null only for PROVIDER_ADMIN
  organisation    Organisation? @relation(fields: [organisationId], references: [id])
  groupId         String?                  // set for GROUP_ADMIN / group-scoped VIEWER
  group           Group?   @relation(fields: [groupId], references: [id])
  email           String   @unique
  passwordHash    String?                  // null until invite accepted
  name            String
  role            PortalRole @default(VIEWER)
  isActive        Boolean  @default(true)
  inviteToken     String?  @unique         // single-use, hashed in prod
  invitedAt       DateTime?
  passwordSetAt   DateTime?
  lastLoginAt     DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

// Replaces the single global MONITORING_ENROLLMENT_SECRET. Per-org install key.
model EnrollmentKey {
  id              String   @id @default(uuid())
  organisationId  String
  organisation    Organisation @relation(fields: [organisationId], references: [id])
  defaultGroupId  String?               // devices enrolled with this key default here
  keyHash         String   @unique      // store only the SHA-256 of the key
  label           String
  isActive        Boolean  @default(true)
  expiresAt       DateTime?
  createdAt       DateTime @default(now())
}
```

### 2.2 Changes to existing monitoring models

- **`MonitoredDevice`** — add `organisationId String?` (+ relation), keep `customerId`. Set on enrol from the `EnrollmentKey`.
- **`MonitoredEmployee`** — add `organisationId String?`, `groupId String?`, `localAccountKey String?` (Windows SID, fallback username), `claimCode String?`, `claimStatus` (`PENDING|CLAIMED|UNMAPPED`).
  - **Change the unique key** from `@@unique([entraUserId])` → `@@unique([organisationId, localAccountKey])`. Keep `entraUserId` as an optional column for the internal build.
- **`ActivitySummary`** — add `organisationId String?` and `groupId String?` (denormalised, like the existing `customerId`) so dashboard queries filter without joins.
- **`MonitoringSetting`** — drop the hard `id="singleton"`; key by `organisationId` (`@@unique`) so office hours/timezone are **per-org**. Keep a null-org row as the internal/global default.
- **`MonitoringAccessLog`** — add `organisationId` (already has `customerId`/`userId`); the access actor becomes a `PortalUser` on the product plane (add a nullable `portalUserId`, keep `userId` for internal).

### 2.3 App catalogue & title rules (scoping choice — see §8)
`MonitoredApp` and `TitleRule` stay **global defaults** in v1. Per-org overrides
are a phase-2 add (an `OrgAppOverride` table) so we don't blow up scope now.

### 2.4 Migration of existing internal data
Create one `Organisation` ("Techlogic — Internal") and backfill `organisationId`
onto existing devices/employees/summaries so the unique keys and scoping work
uniformly. Existing internal monitoring keeps functioning unchanged.

---

## 3. Agent → user linking (hybrid)

The installer is configured with an **org enrolment key** (per `EnrollmentKey`).
That alone binds a device to an Organisation (and optional default Group) — no
Office 365 anywhere.

**Path A — Claim code (assigned laptops, precise):**
1. Org/Group admin creates the user in the dashboard → server generates a short **claim code** (e.g. `K7F-9QX`) on a `MonitoredEmployee` row (`claimStatus=PENDING`).
2. At install / first run, the user (or admin) enters the claim code.
3. Agent's first call sends `{ enrollmentKey, claimCode, localAccountKey, displayName }`. Server binds that install's `localAccountKey` to the pre-created employee, sets group, flips `claimStatus=CLAIMED`.

**Path B — Capture-then-map (VDI/shared, low friction):**
1. Install with only the org enrolment key.
2. Agent reports the Windows account (`localAccountKey` = SID, plus username/displayName). Server upserts a `MonitoredEmployee` keyed by `(organisationId, localAccountKey)` with `claimStatus=UNMAPPED`.
3. Admin later maps captured accounts → named users and assigns a Group — **this reuses the UI you already built** ("link captured employees to users", "assign user to devices with no captured employee").

Both paths converge on the same `(organisationId, localAccountKey)` identity, so
a device can run either flow.

### Ingest change
`/ingest` no longer requires `entraUserId`. New body shape:
```
{ employee: { localAccountKey, displayName, claimCode? }, events, sessionEvents }
```
Employee resolution is scoped to `req.device.organisationId`.

---

## 4. Auth & tenant scoping (the core of "group admin sees only his group")

### 4.1 New middleware
- `middleware/portal-auth.js`: `authenticatePortal` verifies the product JWT, loads the `PortalUser`, attaches `req.portalUser = { id, organisationId, groupId, role }`. `requirePortalRole(...roles)` mirrors the existing `requireRole`.
- Password hashing with `bcrypt`/`argon2`; JWT signed with a product secret (`PORTAL_JWT_SECRET`); refresh via httpOnly cookie or short-lived access token + refresh — TBD in build.

### 4.2 The scope helper (used by EVERY product query)
```js
// returns a Prisma `where` fragment for the caller's visibility
function scopeFor(portalUser) {
  switch (portalUser.role) {
    case 'PROVIDER_ADMIN': return {};                                  // all orgs
    case 'ORG_ADMIN':      return { organisationId: portalUser.organisationId };
    case 'GROUP_ADMIN':    return { organisationId: portalUser.organisationId,
                                    groupId: portalUser.groupId };
    case 'VIEWER':         return { organisationId: portalUser.organisationId,
                                    ...(portalUser.groupId ? { groupId: portalUser.groupId } : {}) };
  }
}
```
This single helper enforces the multi-tenancy and the "group admin only sees his
group" requirement. Because `organisationId`/`groupId` are denormalised onto
`ActivitySummary` (and `MonitoredEmployee`/`Device`), it applies cleanly to every
read, export, and timeline endpoint.

### 4.3 Provider console (PROVIDER_ADMIN only)
- Create/suspend Organisations, issue enrolment keys, invite the first ORG_ADMIN, see cross-org usage. An org-switcher in the header when acting as provider.

---

## 5. Backend work (routes)

- **New** `routes/portal-auth.js`: `POST /login`, `POST /logout`, `POST /accept-invite`, `POST /forgot|reset-password`, `GET /me`.
- **New** `routes/orgs.js` (provider+org admin): orgs CRUD, groups CRUD, portal-user invites, enrolment-key management, claim-code generation.
- **Refactor** `routes/monitoring.js`:
  - `/enroll` → validate `EnrollmentKey` (not the global secret), set `device.organisationId` + default group.
  - `/ingest` → resolve employee by `(organisationId, localAccountKey)`, honour claim codes.
  - Dashboard reads (`/devices`, `/employees`, `/summary`, `/timeline`, `/export`, `/apps`, `/settings`, `/title-rules`) → swap `authenticate`/`requireRole` for `authenticatePortal`/`requirePortalRole`, and apply `scopeFor(req.portalUser)` to every query. Replace the hard-coded `VIEW_ROLES`/`ADMIN_ROLES` (MSP roles) with portal roles.
  - `/settings` → read/write the **per-org** `MonitoringSetting`.
- **Rollup** (`lib/monitoring-rollup.js`): stamp `organisationId`/`groupId` onto `ActivitySummary`; read per-org office hours.
- Keep the internal MSP monitoring routes working by mounting the Entra-auth variant under the internal deploy (or gating on `PRODUCT_MODE`).

---

## 6. Frontend work

- **New product login page** (email+password) + invite-accept / password-reset pages. Bypasses MSAL entirely when `PRODUCT_MODE`.
- **Org/Group/User admin UI**: organisations list (provider), groups, invite users with role, enrolment keys, per-user claim codes.
- **Reuse** the existing `monitoring/` pages (Overview, Devices, Employee, Report, Apps, Settings) — they become tenant-scoped automatically via the API. Add a group filter and (for provider) an org switcher.
- Sidebar/role-gating driven by `PortalRole` instead of MSP `Role`.

---

## 7. Windows agent (separate C#/.NET workstream)

The agent does **not** yet exist in this repo (server protocol only). Product changes vs. the original plan:
- Config holds `{ serverUrl, enrollmentKey, claimCode? }` instead of an Entra device context.
- Identity = OS account: capture **Windows SID** (stable) + username/display name as `localAccountKey`; no Entra token needed.
- First-run enrol → store returned agent token (DPAPI-encrypted), then batch-upload as today.
- Installer (MSI/Win32) takes the enrolment key (and optional claim code) as parameters for silent deployment via Intune/GPO/RMM.

---

## 8. Open scoping choices (call before/while building)

1. **App classification per-org?** v1 = global catalogue (proposed). Per-org overrides = phase 2. Different clients may disagree on what's "productive."
2. **VIEWER granularity** — is there a "user sees only their *own* report" self-service tier, or is VIEWER always group/org-wide? (Affects whether we add a `monitoredEmployeeId` link on `PortalUser`.)
3. **Window-title collection** — defaults on internally; for a product this is the highest privacy/compliance surface. Recommend **per-org toggle, default OFF**, surfaced at onboarding.
4. **Provider visibility into client data** — should PROVIDER_ADMIN see raw employee activity across all client orgs, or only aggregate/billing metrics? (Data-protection contracting question.)

## 9. Compliance (carries over, now sharper)
Each client Organisation becomes the **data controller** for its staff; Techlogic
is a **data processor**. Needs: per-org DPA, configurable retention, the existing
`MonitoringAccessLog` audit (now portal-user aware), per-org window-title consent,
and a documented DPIA template clients can adapt.

---

## 10. Phased delivery

| Phase | Deliverable | Notes |
|---|---|---|
| **1. Tenancy + auth foundation** ✅ | New models + schema push; `authenticatePortal`; login/invite/reset; `scopeFor` helper; default-org backfill | **DONE 2026-06-12** — see §11. No behaviour change for internal build |
| **2. Multi-tenant ingest** ✅ | Per-org `EnrollmentKey` enrol; local-account identity; claim-code binding; capture-then-map | **DONE 2026-06-12** — see §12 |
| **3. Scoped dashboard** ✅ | Portal-auth on all reads; group/org scoping; per-org settings; org/group/user admin UI | **DONE 2026-06-12** — backend §13, frontend §14 |
| **4. Provider console** | Org lifecycle, cross-org view, enrolment-key + first-admin invite | PROVIDER_ADMIN only |
| **5. Agent + installer** 🟡 | C#/.NET agent productised: enrolment key/claim code, SID identity, silent installer | **Reference agent DONE 2026-06-12** (§15); C#/.NET port deferred to a Windows session |
| **6. Hardening** | Retention jobs, per-org DPA/DPIA, rate limits, SSO-ready auth seam | Pre-GA |

**Suggested start:** Phase 1 — it's self-contained, doesn't disturb the live
internal monitoring, and unblocks everything else.

---

## 11. Phase 1 — built 2026-06-12

**Schema** (`backend/prisma/schema.prisma`, applied to local dev DB via `prisma db push`):
- New enums `PortalRole`, `ClaimStatus`; new models `Organisation`, `Group`, `PortalUser`, `EnrollmentKey`.
- Tenancy fields added: `MonitoredDevice.organisationId`; `MonitoredEmployee.{organisationId, groupId, localAccountKey, claimCode, claimStatus}` with the unique key changed to `@@unique([organisationId, localAccountKey])`; `ActivitySummary.{organisationId, groupId}` (+ indexes); `MonitoringSetting.organisationId @unique` (now per-org); `MonitoringAccessLog` actor relaxed to optional `userId` + new `portalUserId`/`organisationId`. `Customer` gained `organisations`.

**Auth** (`backend/src/middleware/portal-auth.js`):
- `hashPassword`/`verifyPassword` (bcryptjs, cost 12), invite/reset token gen + SHA-256 hashing.
- `signPortalToken` (HS256, `PORTAL_JWT_SECRET`), `authenticatePortal` (loads live `PortalUser`, rejects inactive), `requirePortalRole` (PROVIDER_ADMIN auto-allowed wherever ORG_ADMIN is).
- **`scopeFor(portalUser)`** — the tenant boundary used by every product read. Unknown role fails closed.

**Routes** (`backend/src/routes/portal-auth.js`, mounted `/api/portal/auth`):
`POST /login` (5-fail/60s throttle), `/logout`, `GET /me`, `POST /accept-invite`, `/reset-password`, `/forgot-password` (no email-enumeration; dev returns the token until email transport is wired).

**Bootstrap** (`backend/prisma/portal-bootstrap.js`, idempotent): ensures the
"Techlogic — Internal" org, backfills `organisationId` onto existing monitoring
rows, ensures a `PROVIDER_ADMIN`. First run backfilled 2 devices / 2 employees /
2 summaries.

**Verification:** 15/15 checks passed via a throwaway minimal-Express harness
(login good/bad paths, `/me` auth gate, forgot→reset→re-login, single-use token,
`scopeFor` for every role).

**Not yet done:** `PRODUCT_MODE` route-gating; emailing invite/reset tokens; the
frontend product login page (Phase 3). New deps: `bcryptjs`.

---

## 12. Phase 2 — built 2026-06-12

**Enrolment** (`backend/src/routes/monitoring.js` `/enroll`): now accepts a per-org
`enrollmentKey` (resolved via SHA-256 hash → `EnrollmentKey` → Organisation +
optional default Group, stamped onto the device). The legacy global
`enrollmentSecret` path still works for the internal build (org stays null); with
neither configured, enrol is refused. New helper lib `backend/src/lib/enrollment.js`
(`generateEnrollmentKey`/`hashEnrollmentKey`/`generateClaimCode` — readable
`XXXX-XXXX` codes, no ambiguous chars).

**Ingest** (`/ingest` + new `resolveEmployee()`): identity is now the OS account
(`localAccountKey`), not Entra. Three resolution paths —
- **A. Claim code:** binds a pre-created named employee to the reporting OS account, flips `PENDING → CLAIMED`.
- **B. Capture-then-map:** upserts by `(organisationId, localAccountKey)`, `UNMAPPED`, auto-grouped from the device's `defaultGroupId`.
- **Legacy:** devices with no org still key by `entraUserId` (internal build unchanged).

**Rollup** (`backend/src/lib/monitoring-rollup.js`): denormalises
`organisationId`/`groupId` (alongside `customerId`) onto every `ActivitySummary`.

**Admin API** (`backend/src/routes/orgs.js`, mounted `/api/portal/orgs`, portal-auth
guarded): create/list organisations (provider), create/list groups, mint/list
enrolment keys (raw key shown once), pre-create employees with a claim code,
re-issue claim codes — all scope-checked (`canAccessOrg`, `scopeFor`).

**Schema delta:** `MonitoredDevice.defaultGroupId` added (denormalised from the key).

**Verification:** 15/15 via a throwaway minimal-Express harness covering the full
chain — provider login → create org/group → mint key → pre-create employee → enrol
(rejected without key, accepted with) → ingest via claim code (Alice bound + CLAIMED
+ scoped) → ingest a second OS account (Bob captured UNMAPPED + auto-grouped) →
rollup stamps org/group → event-count isolation. Test data cleaned up afterwards.

**Not yet done:** dashboard read routes still use Entra auth + MSP roles (they need
swapping to `authenticatePortal` + `scopeFor` in **Phase 3**); per-org
`MonitoringSetting` is in the schema but the rollup still reads the global singleton
(also Phase 3).

---

## 13. Phase 3 (backend) — built 2026-06-12

Chosen approach: **option (a) — split routes.** The internal Entra monitoring
routes are untouched; the product gets a parallel, scoped read plane.

**Scoped product reads** (`backend/src/routes/portal-monitoring.js`, mounted
`/api/portal/monitoring`, `authenticatePortal`): `/summary`, `/devices`,
`/employees`, `/timeline`, `/export`, `/apps`, `/title-rules`, per-org GET/PUT
`/settings`, plus admin actions `PATCH /employees/:id` (map a captured account →
name/group, auto-`CLAIMED`; a GROUP_ADMIN is forced into their own group) and
`PATCH /devices/:id` (status / token rotation). Every query is filtered by
`scopeFor(req.portalUser)`; devices (no `groupId` column) are group-scoped via
`employees: { some: { groupId } }`. Access is logged to `MonitoringAccessLog` by
`portalUserId`.

**Per-org rollup** (`backend/src/lib/monitoring-rollup.js`): `getMonitoringSettings`
now takes an optional `organisationId`; new `loadOrgConfigs()` builds an
`orgId → officeConfig` map; `runMonitoringRollup` resolves each employee's org once
and applies that org's office hours in the productive-vs-overtime split.

**Admin API additions** (`backend/src/routes/orgs.js`): invite portal users
(`POST /organisations/:id/users`, role ∈ {ORG_ADMIN, GROUP_ADMIN, VIEWER}, group
required for GROUP_ADMIN, returns an invite token redeemed via
`/api/portal/auth/accept-invite`) and list them.

**Verification:** 17/17 via a throwaway harness across two orgs — ORG_ADMIN sees
the whole org, GROUP_ADMIN sees only their group (employees, summary totals,
timeline), cross-org reads 404, per-org office hours isolated, GROUP_ADMIN blocked
from settings + out-of-group employees, invite→accept→login works. Test data
cleaned up.

---

## 14. Phase 3 (frontend) — built 2026-06-12

A **separate `/portal` app shell** (decision: option a), wired in `main.jsx` to
render *outside* `MsalProvider` so it never touches Entra:
`const isPortal = location.pathname.startsWith('/portal')`.

New `frontend/src/portal/`:
- `portalApi.js` — axios instance, `localStorage` JWT (`portal_token`), 401 →
  `/portal/login` redirect.
- `PortalAuthContext.jsx` — login/logout/me, `isAtLeast(role,min)` helper.
- `PortalLogin.jsx`, `PortalLayout.jsx` (role-based nav), `PortalApp.jsx`
  (routing + `RequireAuth` with `minRole`).
- `pages/`: `PortalDashboard` (date range, KPI tiles, per-employee table with
  productivity %, CSV export), `PortalEmployees` (list + map-captured modal),
  `PortalEmployee` (per-day timeline with resolved app classes), `PortalAdmin`
  (orgs [provider] · groups · user invites · enrolment keys · people + claim
  codes, with one-time secret reveal), `PortalSettings` (per-org office hours).

All call `/api/portal/*`. The internal `frontend/src/pages/monitoring/*` (Entra)
pages are untouched.

**Verification:** `vite build` passes; verified live in the preview browser
against a seeded "Demo Co" tenant — login as an ORG_ADMIN, dashboard renders
scoped KPIs (97h30m active / 72% productivity) + the 3 demo people, the
per-employee timeline resolves app categories (VS Code → productive, YouTube →
neutral), no console errors.

**Remaining (later phases):** Phase 4 provider console polish (cross-org views,
org lifecycle); Phase 5 the C#/.NET agent + installer; Phase 6 hardening (email
the invite/reset tokens — currently dev-returned; `PRODUCT_MODE` route-gating;
retention/DPA). The app catalogue/title rules remain a shared global default
(doc §8) — no per-org override UI yet.

---

## 15. Phase 5 (reference agent) — built 2026-06-12

Decision: **build a runnable cross-platform reference agent now** (the C#/.NET
Windows port is deferred to a dedicated Windows session); **mixed grouping**
(per-group keys + claim codes).

New project `msp-platform/agent/` (Node ESM, zero deps, runs on macOS/Linux):
- `config.js` — config from CLI → env → JSON file; `0600` state (`deviceId` +
  token) + spool paths; policy override.
- `api.js` — `enroll` / `config` / `ingest` against `/api/monitoring/*`.
- `identity.js` — OS-account identity; `localAccountKey` = username here, **user
  SID** on Windows.
- `capture.js` — the one platform module: macOS foreground app (`osascript`),
  window title (`AXTitle`), idle (`ioreg HIDIdleTime`). Windows port → Win32
  `GetForegroundWindow`/`GetWindowText`/`GetLastInputInfo`.
- `spool.js` — offline JSONL queue, idempotent retry (UUID per event).
- `agent.js` — enrol-once, sample loop (new interval on app/idle change), batch
  upload honouring server policy, claim code until bound, `--once` mode, graceful
  flush on SIGINT.
- `README.md` — config, the **grouping model**, and the full **C#/.NET port spec**
  (SID, Win32 APIs, DPAPI token, Windows Service, MSI/Win32 + Intune silent
  install `msiexec … SERVER= KEY= /qn`). `.gitignore` excludes config/state/spool.

**Verified live** against the running backend: minted a per-group enrolment key
for Demo Co's *Operations* group, ran `node src/agent.js --once --key …`. Result:
device `Atauls-MacBook-Pro.local` enrolled under Demo Co, captured person
**"Ataul Kashif" (key `ataul`) auto-grouped into Operations, UNMAPPED**, 2 events
uploaded and visible via the org-admin API — proving the per-group-key default
grouping end-to-end. (Claim-code binding is proven at the ingest level in §12's
Phase-2 test; the agent forwards `claimCode` unchanged.) Local agent token/state
cleaned up after.

**Remaining for Phase 5:** the actual **C#/.NET Windows agent + MSI/Intune
packaging** (this README is its contract).

