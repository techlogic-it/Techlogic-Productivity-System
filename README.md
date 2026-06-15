# Techlogic Productivity System

Multi-tenant employee-productivity monitoring: a Windows agent captures foreground
app usage, a Node/Express + PostgreSQL backend ingests and rolls it up, and a React
portal shows per-company productivity, overtime, and per-app/site breakdowns.

Each **company** is an isolated tenant with its own enrolment key, users, office
hours, and app classification. Admins are scoped strictly to their own company.

## Architecture

```
agent-windows/   Windows agent (C#/.NET) — captures foreground app + idle, uploads events
agent/           Cross-platform reference agent (Node) — same enrol→ingest protocol
backend/         Express API + Prisma (Postgres): agent plane + portal (dashboard) plane
frontend/        React + Vite + Tailwind portal (email+password auth)
```

- **Agent plane** (`/api/monitoring/*`): `enroll` → per-device token, `config`, `ingest`. No login.
- **Portal plane** (`/api/portal/*`): email+password JWT. Roles: Provider Admin → Admin → Manager → Viewer.
- Classification resolves per company: company override → global catalogue → title rule → uncategorised.

## Prerequisites
- **Node.js 20+**
- **PostgreSQL 14+**
- **.NET SDK 10** — only to (re)build the Windows agent

## 1. Backend
```bash
cd backend
cp .env.example .env          # set DATABASE_URL + PORTAL_JWT_SECRET + provider login
npm install
npm run db:setup              # prisma db push + seed apps + provider admin + demo company
npm run dev                   # API on http://localhost:3001
```

## 2. Frontend
```bash
cd frontend
npm install
npm run dev                   # http://localhost:5173  → /portal/login
```

Logins after `db:setup`:
- **Provider** (all companies): the `PORTAL_PROVIDER_EMAIL` / password from `.env`
- **Org admin** (Demo Co): `demo@demo.local` / `Demo-Pass-2026!`

## 3. Windows agent (optional)
```powershell
cd agent-windows
dotnet publish -c Release -r win-x64 -o publish    # → publish\ProductivityAgent.exe
```
Point the backend at it with `AGENT_EXE_PATH` so the portal can serve the per-company
installer (Admin → Company enrolment key → **Download installer (.bat)**), or run it
directly:
```powershell
.\publish\ProductivityAgent.exe --server http://<host>:3001 --key <ENROLMENT_KEY>
```
On a LAN pilot set `MON_PUBLIC_SERVER_URL` to the host's LAN IP so the installer
targets the right address, and open inbound TCP 3001 on the host firewall.

## Deployment (Railway — single service, one domain)

The repo deploys as **one Railway service**: the build compiles the portal and the
backend serves both the portal and the API on the same origin (so the agent and the
portal share `https://productivity.techlogicservices.co.uk`). Config is in
`railway.toml` (root).

1. **Railway → New Project → Deploy from GitHub repo** → this repo. Leave the root
   directory as the repo root.
2. **Add a PostgreSQL** database (New → Database → PostgreSQL).
3. **Variables** on the app service:
   - `DATABASE_URL` → reference the Postgres service's `DATABASE_URL`
   - `PORTAL_JWT_SECRET` → a long random string
   - `ENROLLMENT_KEY_SECRET` → a long random string (must stay stable)
   - `PORTAL_PROVIDER_EMAIL` / `PORTAL_PROVIDER_PASSWORD` → the first admin login
   - `MON_PUBLIC_SERVER_URL` → `https://productivity.techlogicservices.co.uk`
   - `NODE_ENV` → `production`  (`PORT` is provided by Railway automatically)
4. **Settings → Networking → Custom Domain** → `productivity.techlogicservices.co.uk`.
   Railway shows a target host; add a **CNAME** for `productivity` → that host at your
   DNS provider. The cert provisions automatically once DNS resolves.

The start command runs `prisma db push` plus the idempotent seeds (app catalogue +
provider admin) on every deploy.

> **Agent download in production:** `/api/monitoring/agent-download` serves a prebuilt
> Windows exe from `AGENT_EXE_PATH`. The Linux build can't compile it, so host the
> `win-x64` exe (e.g. a GitHub release) and point `AGENT_EXE_PATH` at it, or run the
> agent with the `--server … --key …` command shown in the portal.

## Notes
- Schema changes use `prisma db push` (no migrations): `npm run db:push`.
- Productivity rollup runs every 5 min (`MON_ROLLUP_INTERVAL_MIN`).
- `ENROLLMENT_KEY_SECRET` must stay stable in production (it decrypts stored company keys).
