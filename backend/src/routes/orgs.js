import { Router } from 'express';
import asyncHandler from 'express-async-handler';

import prisma from '../prisma.js';
import {
  authenticatePortal,
  requirePortalRole,
  scopeFor,
  generateInviteToken,
  hashInviteToken,
  publicPortalUser,
  isProviderRole,
  blockReadOnlyProvider,
} from '../middleware/portal-auth.js';
import {
  generateEnrollmentKey,
  hashEnrollmentKey,
  generateClaimCode,
  encryptEnrollmentKey,
  decryptEnrollmentKey,
} from '../lib/enrollment.js';

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const ASSIGNABLE_ROLES = ['ORG_ADMIN', 'MANAGER', 'GROUP_ADMIN', 'VIEWER'];
const PROVIDER_ASSIGNABLE_ROLES = ['PROVIDER_ADMIN', 'PROVIDER_SUPPORT', 'PROVIDER_VIEWER'];

// Editable tenant detail fields (everything except name/slug/status/relations).
const COMPANY_DETAIL_FIELDS = ['address', 'phone', 'email', 'website', 'contactName', 'contactEmail', 'contactPhone'];

function pickCompanyDetails(body) {
  const out = {};
  for (const f of COMPANY_DETAIL_FIELDS) {
    if (body?.[f] !== undefined) out[f] = String(body[f] || '').trim() || null;
  }
  return out;
}

const router = Router();
router.use(authenticatePortal);
router.use(blockReadOnlyProvider); // PROVIDER_VIEWER may read but never write

// Provider/org administration for the product: organisations, groups, enrolment
// keys, and per-user claim codes. Enough to drive enrolment and the two linking
// flows; the full management UI lands in Phase 3/4.

function slugify(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// May this caller see/operate on this company at all? Provider admin → any;
// scoped provider → only assigned companies; everyone else → their own company.
function canAccessOrg(portalUser, orgId) {
  if (portalUser.role === 'PROVIDER_ADMIN') return true;
  if (isProviderRole(portalUser.role)) return (portalUser.assignedOrgIds || []).includes(orgId);
  return portalUser.organisationId === orgId;
}

// Who may run a company's OWN administration (departments, company logins): the
// company's own ORG_ADMIN, or the provider superuser. Scoped provider staff are
// deliberately excluded — they support companies, they don't run them.
function isOrgSelfAdmin(portalUser, orgId) {
  if (portalUser.role === 'PROVIDER_ADMIN') return true;
  return portalUser.role === 'ORG_ADMIN' && portalUser.organisationId === orgId;
}

// The public base URL the agent should target (the installer bakes it in next to
// the key). Behind the dev Vite proxy this resolves to the backend host the
// portal request reached; set MON_PUBLIC_SERVER_URL to pin it in production.
function serverUrlFrom(req) {
  if (process.env.MON_PUBLIC_SERVER_URL) return process.env.MON_PUBLIC_SERVER_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

// One canonical, re-displayable enrolment key per company. Returns the existing
// primary or mints one (deactivating any stray legacy keys so a company has a
// single active key). `rotate` forces a fresh value on the same primary row.
async function getOrCreatePrimaryKey(orgId, { rotate = false } = {}) {
  let primary = await prisma.enrollmentKey.findFirst({
    where: { organisationId: orgId, isPrimary: true },
  });

  if (primary && !rotate) {
    // Legacy primary minted before encryption existed — back-fill a fresh value.
    if (primary.keyCipher && decryptEnrollmentKey(primary.keyCipher)) return primary;
  }

  const key = generateEnrollmentKey();
  const data = {
    keyHash: hashEnrollmentKey(key),
    keyCipher: encryptEnrollmentKey(key),
    isActive: true,
  };

  if (primary) {
    primary = await prisma.enrollmentKey.update({ where: { id: primary.id }, data });
  } else {
    primary = await prisma.enrollmentKey.create({
      data: { organisationId: orgId, label: 'Company key', isPrimary: true, ...data },
    });
  }
  // Enforce "one active key per company": disable any other keys.
  await prisma.enrollmentKey.updateMany({
    where: { organisationId: orgId, id: { not: primary.id } },
    data: { isActive: false },
  });
  return primary;
}

// ── Organisations (provider) ────────────────────────────────────────────────

router.post(
  '/organisations',
  requirePortalRole('PROVIDER_ADMIN'),
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const slug = slugify(req.body?.slug || name);
    const existing = await prisma.organisation.findUnique({ where: { slug } });
    if (existing) return res.status(409).json({ error: 'An organisation with that slug exists' });

    const org = await prisma.organisation.create({
      data: { name, slug, customerId: req.body?.customerId || null, ...pickCompanyDetails(req.body) },
    });
    res.status(201).json(org);
  }),
);

router.get(
  '/organisations',
  asyncHandler(async (req, res) => {
    // Provider admin sees all; scoped provider staff see only assigned companies;
    // everyone else sees only their own org.
    let where;
    if (req.portalUser.role === 'PROVIDER_ADMIN') {
      where = {};
    } else if (isProviderRole(req.portalUser.role)) {
      const ids = req.portalUser.assignedOrgIds || [];
      where = { id: { in: ids.length ? ids : ['__none__'] } };
    } else {
      where = { id: req.portalUser.organisationId || '__none__' };
    }
    const orgs = await prisma.organisation.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { _count: { select: { groups: true, employees: true, devices: true, portalUsers: true } } },
    });
    // Active-device count per org (the delete guard + a useful stat). _count can't
    // filter, so fold in a grouped count of ACTIVE devices.
    const active = await prisma.monitoredDevice.groupBy({
      by: ['organisationId'],
      where: { status: 'ACTIVE', organisationId: { in: orgs.map((o) => o.id) } },
      _count: { _all: true },
    });
    const activeByOrg = Object.fromEntries(active.map((a) => [a.organisationId, a._count._all]));
    // Active monitored-user count per org (the seat-limit usage figure).
    const activeEmp = await prisma.monitoredEmployee.groupBy({
      by: ['organisationId'],
      where: { isActive: true, organisationId: { in: orgs.map((o) => o.id) } },
      _count: { _all: true },
    });
    const empByOrg = Object.fromEntries(activeEmp.map((a) => [a.organisationId, a._count._all]));
    // Monthly revenue = price/seat × licences (seat limit); unlimited-seat companies
    // use the flat fee. null = not priced yet.
    const monthlyRevenueOf = (o) => {
      if (o.seatLimit != null && o.pricePerSeat != null) return o.pricePerSeat * o.seatLimit;
      if (o.seatLimit == null && o.flatMonthlyFee != null) return o.flatMonthlyFee;
      return null;
    };
    res.json(orgs.map((o) => ({
      ...o,
      activeDeviceCount: activeByOrg[o.id] || 0,
      monitoredUserCount: empByOrg[o.id] || 0,
      monthlyRevenue: monthlyRevenueOf(o),
    })));
  }),
);

// Full details of one company (drives the edit form). Own org for non-providers.
router.get(
  '/organisations/:id',
  asyncHandler(async (req, res) => {
    if (!canAccessOrg(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const org = await prisma.organisation.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { groups: true, employees: true, devices: true, portalUsers: true } } },
    });
    if (!org) return res.status(404).json({ error: 'Company not found' });
    res.json(org);
  }),
);

// Edit company name + tenant details (org admin for own company; provider any).
router.patch(
  '/organisations/:id',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!canAccessOrg(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const data = pickCompanyDetails(req.body);
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'name cannot be empty' });
      data.name = name;
    }
    // Seat limit (licensing) is provider-only; org admins can't change their own.
    if (req.body?.seatLimit !== undefined && (req.portalUser.role === 'PROVIDER_ADMIN' || req.portalUser.role === 'PROVIDER_SUPPORT')) {
      const raw = req.body.seatLimit;
      const n = raw === null || raw === '' ? null : Number(raw);
      if (n !== null && (!Number.isInteger(n) || n < 0)) {
        return res.status(400).json({ error: 'seatLimit must be a non-negative whole number (or blank for unlimited)' });
      }
      data.seatLimit = n;
    }
    // Billing (price per seat, flat fee, renewal date) is provider-set too.
    if (req.portalUser.role === 'PROVIDER_ADMIN' || req.portalUser.role === 'PROVIDER_SUPPORT') {
      for (const f of ['pricePerSeat', 'flatMonthlyFee']) {
        if (req.body?.[f] !== undefined) {
          const raw = req.body[f];
          const n = raw === null || raw === '' ? null : Number(raw);
          if (n !== null && (!Number.isFinite(n) || n < 0)) {
            return res.status(400).json({ error: `${f} must be a non-negative amount (or blank)` });
          }
          data[f] = n;
        }
      }
      if (req.body?.renewalDate !== undefined) {
        const raw = req.body.renewalDate;
        if (raw === null || raw === '') {
          data.renewalDate = null;
        } else {
          const d = new Date(raw);
          if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'renewalDate is not a valid date' });
          data.renewalDate = d;
        }
      }
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Nothing to update' });
    const org = await prisma.organisation.update({ where: { id: req.params.id }, data });
    res.json(org);
  }),
);

// Permanently delete a company and ALL its data. Guarded: every monitoring device
// must be retired (status != ACTIVE) first, so a live agent can't be orphaned.
router.delete(
  '/organisations/:id',
  requirePortalRole('PROVIDER_ADMIN'),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const org = await prisma.organisation.findUnique({ where: { id } });
    if (!org) return res.status(404).json({ error: 'Company not found' });

    const activeDevices = await prisma.monitoredDevice.count({ where: { organisationId: id, status: 'ACTIVE' } });
    if (activeDevices > 0) {
      return res.status(409).json({
        error: `Cannot delete: ${activeDevices} active monitoring device(s) still enrolled. Retire them first.`,
        activeDevices,
      });
    }

    const deviceIds = (await prisma.monitoredDevice.findMany({ where: { organisationId: id }, select: { id: true } })).map((d) => d.id);
    const empIds = (await prisma.monitoredEmployee.findMany({ where: { organisationId: id }, select: { id: true } })).map((e) => e.id);
    const userIds = (await prisma.portalUser.findMany({ where: { organisationId: id }, select: { id: true } })).map((u) => u.id);

    // Delete children before parents to satisfy FK constraints.
    await prisma.$transaction([
      prisma.activityEvent.deleteMany({ where: { OR: [{ deviceId: { in: deviceIds } }, { employeeId: { in: empIds } }] } }),
      prisma.sessionEvent.deleteMany({ where: { OR: [{ deviceId: { in: deviceIds } }, { employeeId: { in: empIds } }] } }),
      prisma.activitySummary.deleteMany({ where: { OR: [{ employeeId: { in: empIds } }, { organisationId: id }] } }),
      prisma.monitoringAccessLog.deleteMany({ where: { OR: [{ organisationId: id }, { targetEmployeeId: { in: empIds } }, { portalUserId: { in: userIds } }] } }),
      prisma.monitoredEmployee.deleteMany({ where: { organisationId: id } }),
      prisma.monitoredDevice.deleteMany({ where: { organisationId: id } }),
      prisma.enrollmentKey.deleteMany({ where: { organisationId: id } }),
      prisma.orgAppClassification.deleteMany({ where: { organisationId: id } }),
      prisma.orgTitleRule.deleteMany({ where: { organisationId: id } }),
      prisma.monitoringSetting.deleteMany({ where: { organisationId: id } }),
      prisma.providerAssignment.deleteMany({ where: { organisationId: id } }),
      prisma.portalUser.deleteMany({ where: { organisationId: id } }),
      prisma.group.deleteMany({ where: { organisationId: id } }),
      prisma.organisation.delete({ where: { id } }),
    ]);
    res.json({ ok: true, deleted: { name: org.name, devices: deviceIds.length, employees: empIds.length, users: userIds.length } });
  }),
);

// ── Groups ──────────────────────────────────────────────────────────────────

router.post(
  '/organisations/:id/groups',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!isOrgSelfAdmin(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Departments are managed by the company admin.' });
    }
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const group = await prisma.group.create({
      data: { organisationId: req.params.id, name },
    });
    res.status(201).json(group);
  }),
);

router.get(
  '/organisations/:id/groups',
  asyncHandler(async (req, res) => {
    if (!canAccessOrg(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const where = { organisationId: req.params.id };
    // A group admin only sees their own group.
    if (req.portalUser.role === 'GROUP_ADMIN') where.id = req.portalUser.groupId || '__none__';
    const groups = await prisma.group.findMany({ where, orderBy: { name: 'asc' } });
    res.json(groups);
  }),
);

// Rename a department.
router.patch(
  '/organisations/:id/groups/:groupId',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!isOrgSelfAdmin(req.portalUser, req.params.id)) return res.status(403).json({ error: 'Departments are managed by the company admin.' });
    const group = await prisma.group.findFirst({ where: { id: req.params.groupId, organisationId: req.params.id } });
    if (!group) return res.status(404).json({ error: 'Department not found' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
      res.json(await prisma.group.update({ where: { id: group.id }, data: { name } }));
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ error: 'A department with that name already exists' });
      throw e;
    }
  }),
);

// Delete a department: members fall back to no department; a department manager is
// demoted to a department viewer; the company key's default is cleared if it pointed here.
router.delete(
  '/organisations/:id/groups/:groupId',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!isOrgSelfAdmin(req.portalUser, req.params.id)) return res.status(403).json({ error: 'Departments are managed by the company admin.' });
    const group = await prisma.group.findFirst({ where: { id: req.params.groupId, organisationId: req.params.id } });
    if (!group) return res.status(404).json({ error: 'Department not found' });
    await prisma.$transaction([
      prisma.portalUser.updateMany({ where: { groupId: group.id, role: 'GROUP_ADMIN' }, data: { role: 'VIEWER', groupId: null } }),
      prisma.portalUser.updateMany({ where: { groupId: group.id }, data: { groupId: null } }),
      prisma.monitoredEmployee.updateMany({ where: { groupId: group.id }, data: { groupId: null } }),
      prisma.enrollmentKey.updateMany({ where: { defaultGroupId: group.id }, data: { defaultGroupId: null } }),
      prisma.group.delete({ where: { id: group.id } }),
    ]);
    res.json({ ok: true });
  }),
);

// Set (or clear) a department's manager. Demotes the current manager(s) to a
// department viewer; promotes the chosen user to Department Manager.
router.put(
  '/organisations/:id/groups/:groupId/manager',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!isOrgSelfAdmin(req.portalUser, req.params.id)) return res.status(403).json({ error: 'Departments are managed by the company admin.' });
    const group = await prisma.group.findFirst({ where: { id: req.params.groupId, organisationId: req.params.id } });
    if (!group) return res.status(404).json({ error: 'Department not found' });
    const userId = req.body?.userId || null;
    if (userId) {
      const u = await prisma.portalUser.findFirst({ where: { id: userId, organisationId: req.params.id } });
      if (!u) return res.status(400).json({ error: 'User is not in this company' });
    }
    await prisma.portalUser.updateMany({
      where: { organisationId: req.params.id, role: 'GROUP_ADMIN', groupId: group.id, ...(userId ? { id: { not: userId } } : {}) },
      data: { role: 'VIEWER' }, // keep groupId → a department-scoped viewer
    });
    if (userId) {
      await prisma.portalUser.update({ where: { id: userId }, data: { role: 'GROUP_ADMIN', groupId: group.id } });
    }
    res.json({ ok: true });
  }),
);

// ── Enrolment keys (the installer carries one of these) ──────────────────────

router.post(
  '/organisations/:id/enrollment-keys',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!canAccessOrg(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const label = String(req.body?.label || '').trim() || 'Default';
    const key = generateEnrollmentKey();
    const record = await prisma.enrollmentKey.create({
      data: {
        organisationId: req.params.id,
        defaultGroupId: req.body?.defaultGroupId || null,
        label,
        keyHash: hashEnrollmentKey(key),
        expiresAt: req.body?.expiresAt ? new Date(req.body.expiresAt) : null,
      },
    });
    // The raw key is shown exactly once; only its hash is stored.
    res.status(201).json({ id: record.id, label: record.label, enrollmentKey: key });
  }),
);

router.get(
  '/organisations/:id/enrollment-keys',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!canAccessOrg(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const keys = await prisma.enrollmentKey.findMany({
      where: { organisationId: req.params.id },
      select: { id: true, label: true, defaultGroupId: true, isActive: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(keys);
  }),
);

// ── Company enrolment key (single, re-displayable, used by the installer) ─────

function keyResponse(req, record) {
  const enrollmentKey = decryptEnrollmentKey(record.keyCipher);
  const serverUrl = serverUrlFrom(req);
  return {
    id: record.id,
    label: record.label,
    enrollmentKey,
    serverUrl,
    defaultGroupId: record.defaultGroupId || '',
    createdAt: record.createdAt,
    // Ready-to-run installer command (the agent reaches the backend directly).
    installCommand: `ProductivityAgent.exe --server ${serverUrl} --key ${enrollmentKey}`,
  };
}

// GET the company's one key (mints it on first access).
router.get(
  '/organisations/:id/enrollment-key',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!canAccessOrg(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const record = await getOrCreatePrimaryKey(req.params.id);
    res.json(keyResponse(req, record));
  }),
);

// Rotate the company key (old key stops working immediately on next enrol).
// Provider-only: an org admin rotating it would break every installer already
// deployed for that company.
router.post(
  '/organisations/:id/enrollment-key/regenerate',
  requirePortalRole('PROVIDER_SUPPORT'), // provider staff only; never the company's own admins
  asyncHandler(async (req, res) => {
    if (!canAccessOrg(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const record = await getOrCreatePrimaryKey(req.params.id, { rotate: true });
    res.json(keyResponse(req, record));
  }),
);

// Set the default group new machines (and currently ungrouped users) land in.
router.put(
  '/organisations/:id/enrollment-key',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!canAccessOrg(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const groupId = req.body?.defaultGroupId || null;
    if (groupId) {
      const g = await prisma.group.findFirst({ where: { id: groupId, organisationId: req.params.id } });
      if (!g) return res.status(400).json({ error: 'Group is not in this organisation' });
    }
    const primary = await getOrCreatePrimaryKey(req.params.id);
    await prisma.enrollmentKey.update({ where: { id: primary.id }, data: { defaultGroupId: groupId } });

    // Apply to future enrolments AND back-fill anything still ungrouped, so users
    // captured before the group was set (e.g. UNMAPPED accounts) join it too.
    if (groupId) {
      await prisma.monitoredDevice.updateMany({
        where: { organisationId: req.params.id, defaultGroupId: null },
        data: { defaultGroupId: groupId },
      });
      await prisma.monitoredEmployee.updateMany({
        where: { organisationId: req.params.id, groupId: null },
        data: { groupId },
      });
    }
    res.json(keyResponse(req, await getOrCreatePrimaryKey(req.params.id)));
  }),
);

// A self-contained Windows .bat the admin hands to a user. It carries the
// company key, downloads the agent exe from the server, installs to the user's
// LocalAppData (no admin), and registers a hidden autostart-at-login launcher.
// %% escapes to a literal % in the .bat; ^& escapes & inside the echoed VBS.
function buildInstallerBat({ serverUrl, key, exeUrl }) {
  const vbs = '%STARTUP%\\TechlogicProductivity.vbs';
  const lines = [
    '@echo off',
    'rem ===== Techlogic Productivity System - SILENT agent installer =====',
    'rem First launch flashes briefly, relaunches itself hidden, then installs in',
    'rem the background with no window and no prompts.',
    'if /i "%~1"=="/silent" goto install',
    `> "%TEMP%\\tps-install.vbs" echo CreateObject("WScript.Shell").Run "cmd /c ""%~f0"" /silent", 0, False`,
    `wscript "%TEMP%\\tps-install.vbs"`,
    'exit /b',
    '',
    ':install',
    'setlocal',
    `set "SERVER=${serverUrl}"`,
    `set "KEY=${key}"`,
    `set "EXEURL=${exeUrl}"`,
    'set "INSTALL_DIR=%LOCALAPPDATA%\\TechlogicProductivity"',
    'set "STARTUP=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"',
    '',
    'taskkill /F /IM ProductivityAgent.exe >nul 2>&1',
    'if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"',
    // curl.exe (Windows 10 1803+) is fast and follows the redirect to the release.
    // Fall back to Invoke-WebRequest with the progress bar OFF — leaving it on makes
    // large downloads crawl (PowerShell renders the bar per chunk).
    `where curl.exe >nul 2>&1 && curl.exe -L -f -s -S -o "%INSTALL_DIR%\\ProductivityAgent.exe" "%EXEURL%" || powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri '%EXEURL%' -OutFile '%INSTALL_DIR%\\ProductivityAgent.exe' -UseBasicParsing } catch { Write-Host $_.Exception.Message; exit 1 }"`,
    'if not exist "%INSTALL_DIR%\\ProductivityAgent.exe" exit /b 1',
    '',
    `> "${vbs}" echo Set W = CreateObject("WScript.Shell")`,
    `>> "${vbs}" echo exe = W.ExpandEnvironmentStrings("%%LOCALAPPDATA%%\\TechlogicProductivity\\ProductivityAgent.exe")`,
    `>> "${vbs}" echo W.Run Chr(34) ^& exe ^& Chr(34) ^& " --server %SERVER% --key %KEY%", 0, False`,
    '',
    `wscript "${vbs}"`,
    'del "%TEMP%\\tps-install.vbs" >nul 2>&1',
    'endlocal',
  ];
  return lines.join('\r\n') + '\r\n';
}

// Silent per-user uninstaller — stop the agent, retire it on the server (so the
// machine drops out of the portal), remove the autostart, delete the install folder.
function buildUninstallerBat({ serverUrl }) {
  const stateFile = '%LOCALAPPDATA%\\TechlogicProductivity\\agent.state.json';
  const lines = [
    '@echo off',
    'rem ===== Techlogic Productivity System - SILENT uninstaller (per user) =====',
    'if /i "%~1"=="/silent" goto uninstall',
    `> "%TEMP%\\tps-uninstall.vbs" echo CreateObject("WScript.Shell").Run "cmd /c ""%~f0"" /silent", 0, False`,
    `wscript "%TEMP%\\tps-uninstall.vbs"`,
    'exit /b',
    '',
    ':uninstall',
    'setlocal',
    'taskkill /F /IM ProductivityAgent.exe >nul 2>&1',
    'rem Best-effort: tell the server to retire this device (uses the stored token).',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $s = Get-Content '${stateFile}' -Raw | ConvertFrom-Json; if ($s.AgentToken) { Invoke-RestMethod -Uri '${serverUrl}/api/monitoring/retire' -Method Post -Headers @{ Authorization = 'Bearer ' + $s.AgentToken } -TimeoutSec 20 | Out-Null } } catch {}"`,
    'del "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\TechlogicProductivity.vbs" >nul 2>&1',
    'rmdir /S /Q "%LOCALAPPDATA%\\TechlogicProductivity" >nul 2>&1',
    'del "%TEMP%\\tps-uninstall.vbs" >nul 2>&1',
    'endlocal',
  ];
  return lines.join('\r\n') + '\r\n';
}

router.get(
  '/organisations/:id/installer.bat',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!canAccessOrg(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const record = await getOrCreatePrimaryKey(req.params.id);
    const serverUrl = serverUrlFrom(req);
    const bat = buildInstallerBat({
      serverUrl,
      key: decryptEnrollmentKey(record.keyCipher),
      exeUrl: `${serverUrl}/api/monitoring/agent-download`,
    });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="install-techlogic-productivity.bat"');
    res.send(bat);
  }),
);

router.get(
  '/organisations/:id/uninstaller.bat',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!canAccessOrg(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="uninstall-techlogic-productivity.bat"');
    res.send(buildUninstallerBat({ serverUrl: serverUrlFrom(req) }));
  }),
);

// ── Portal users (invite an org/group admin or viewer) ───────────────────────

router.post(
  '/organisations/:id/users',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!isOrgSelfAdmin(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Company logins are managed by the company admin.' });
    }
    const email = String(req.body?.email || '').trim().toLowerCase();
    const name = String(req.body?.name || '').trim();
    const role = String(req.body?.role || 'VIEWER');
    if (!email || !name) return res.status(400).json({ error: 'email and name are required' });
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of ${ASSIGNABLE_ROLES.join(', ')}` });
    }
    let groupId = req.body?.groupId || null;
    if (role === 'GROUP_ADMIN' && !groupId) {
      return res.status(400).json({ error: 'groupId is required for a GROUP_ADMIN' });
    }
    if (groupId) {
      const g = await prisma.group.findFirst({ where: { id: groupId, organisationId: req.params.id } });
      if (!g) return res.status(400).json({ error: 'groupId is not in this organisation' });
    }
    if (await prisma.portalUser.findUnique({ where: { email } })) {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }

    const token = generateInviteToken();
    const user = await prisma.portalUser.create({
      data: {
        organisationId: req.params.id,
        groupId: role === 'VIEWER' ? groupId : (role === 'GROUP_ADMIN' ? groupId : null),
        email,
        name,
        role,
        isActive: true,
        inviteTokenHash: hashInviteToken(token),
        inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
        invitedAt: new Date(),
      },
    });
    // The invitee sets their password via POST /api/portal/auth/accept-invite.
    // No email transport yet, so always return the token: the admin copies the
    // invite link from the portal and delivers it. Single-use, 7-day expiry, and
    // only its hash is stored.
    res.status(201).json({
      user: publicPortalUser(user),
      inviteToken: token,
    });
  }),
);

router.get(
  '/organisations/:id/users',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!canAccessOrg(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const users = await prisma.portalUser.findMany({
      where: { organisationId: req.params.id },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users.map(publicPortalUser));
  }),
);

// Edit a user: change role (e.g. promote a department manager to Admin),
// department, name, or active state.
router.patch(
  '/organisations/:id/users/:userId',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!isOrgSelfAdmin(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Company logins are managed by the company admin.' });
    }
    const user = await prisma.portalUser.findFirst({
      where: { id: req.params.userId, organisationId: req.params.id },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const data = {};
    if (req.body?.name !== undefined) {
      const n = String(req.body.name).trim();
      if (n) data.name = n;
    }
    const role = req.body?.role !== undefined ? String(req.body.role) : user.role;
    if (req.body?.role !== undefined) {
      if (!ASSIGNABLE_ROLES.includes(role)) {
        return res.status(400).json({ error: `role must be one of ${ASSIGNABLE_ROLES.join(', ')}` });
      }
      data.role = role;
    }
    // Resolve the department for the (possibly new) role.
    if (req.body?.role !== undefined || req.body?.groupId !== undefined) {
      let groupId = role === 'ORG_ADMIN' || role === 'MANAGER' ? null : (req.body?.groupId ?? user.groupId ?? null);
      if (role === 'GROUP_ADMIN' && !groupId) {
        return res.status(400).json({ error: 'A Department Manager needs a department' });
      }
      if (groupId) {
        const g = await prisma.group.findFirst({ where: { id: groupId, organisationId: req.params.id } });
        if (!g) return res.status(400).json({ error: 'Department is not in this company' });
      }
      data.groupId = groupId;
    }
    if (req.body?.isActive !== undefined) data.isActive = !!req.body.isActive;
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const updated = await prisma.portalUser.update({ where: { id: user.id }, data });
    res.json(publicPortalUser(updated));
  }),
);

// (Re)issue an invite for an existing user — fresh single-use token so the admin
// can copy the link again (e.g. the first link was missed, or it expired).
router.post(
  '/organisations/:id/users/:userId/invite',
  requirePortalRole('ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!canAccessOrg(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const user = await prisma.portalUser.findFirst({
      where: { id: req.params.userId, organisationId: req.params.id },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const token = generateInviteToken();
    await prisma.portalUser.update({
      where: { id: user.id },
      data: {
        inviteTokenHash: hashInviteToken(token),
        inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
        invitedAt: new Date(),
      },
    });
    res.json({ user: publicPortalUser(user), inviteToken: token });
  }),
);

// ── Provider users (internal Techlogic staff) ────────────────────────────────
// Managed only by a PROVIDER_ADMIN. These accounts have organisationId = null;
// PROVIDER_SUPPORT / PROVIDER_VIEWER are scoped to the companies in
// ProviderAssignment, PROVIDER_ADMIN reaches every company.

const providerUserView = (u) => ({
  ...publicPortalUser(u),
  organisationIds: (u.providerAssignments || []).map((a) => a.organisationId),
});

// Replace a provider user's company assignments (no-op for PROVIDER_ADMIN, which
// is unscoped). Validates that every id is a real company.
async function setProviderAssignments(portalUserId, role, organisationIds) {
  await prisma.providerAssignment.deleteMany({ where: { portalUserId } });
  if (role === 'PROVIDER_ADMIN') return; // admin is unscoped — never assigned
  const ids = [...new Set((organisationIds || []).filter(Boolean))];
  if (ids.length === 0) return;
  const found = await prisma.organisation.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const valid = new Set(found.map((o) => o.id));
  await prisma.providerAssignment.createMany({
    data: ids.filter((id) => valid.has(id)).map((organisationId) => ({ portalUserId, organisationId })),
    skipDuplicates: true,
  });
}

router.get(
  '/provider/users',
  requirePortalRole('PROVIDER_ADMIN'),
  asyncHandler(async (req, res) => {
    const users = await prisma.portalUser.findMany({
      where: { role: { in: PROVIDER_ASSIGNABLE_ROLES } },
      orderBy: { createdAt: 'asc' },
      include: { providerAssignments: { select: { organisationId: true } } },
    });
    res.json(users.map(providerUserView));
  }),
);

router.post(
  '/provider/users',
  requirePortalRole('PROVIDER_ADMIN'),
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const name = String(req.body?.name || '').trim();
    const role = String(req.body?.role || 'PROVIDER_VIEWER');
    if (!email || !name) return res.status(400).json({ error: 'email and name are required' });
    if (!PROVIDER_ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of ${PROVIDER_ASSIGNABLE_ROLES.join(', ')}` });
    }
    if (role !== 'PROVIDER_ADMIN' && !(Array.isArray(req.body?.organisationIds) && req.body.organisationIds.length)) {
      return res.status(400).json({ error: 'Assign at least one company (or make them a Provider Admin).' });
    }
    if (await prisma.portalUser.findUnique({ where: { email } })) {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }

    const token = generateInviteToken();
    const user = await prisma.portalUser.create({
      data: {
        organisationId: null,
        email,
        name,
        role,
        isActive: true,
        inviteTokenHash: hashInviteToken(token),
        inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
        invitedAt: new Date(),
      },
    });
    await setProviderAssignments(user.id, role, req.body?.organisationIds);
    const full = await prisma.portalUser.findUnique({ where: { id: user.id }, include: { providerAssignments: { select: { organisationId: true } } } });
    res.status(201).json({ user: providerUserView(full), inviteToken: token });
  }),
);

router.patch(
  '/provider/users/:id',
  requirePortalRole('PROVIDER_ADMIN'),
  asyncHandler(async (req, res) => {
    const target = await prisma.portalUser.findFirst({ where: { id: req.params.id, role: { in: PROVIDER_ASSIGNABLE_ROLES } } });
    if (!target) return res.status(404).json({ error: 'Provider user not found' });

    const role = req.body?.role !== undefined ? String(req.body.role) : target.role;
    if (req.body?.role !== undefined && !PROVIDER_ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of ${PROVIDER_ASSIGNABLE_ROLES.join(', ')}` });
    }
    // A provider admin can't lock themselves out (drop their own admin or disable self).
    if (target.id === req.portalUser.id && ((req.body?.role !== undefined && role !== 'PROVIDER_ADMIN') || req.body?.isActive === false)) {
      return res.status(400).json({ error: "You can't change your own provider-admin access." });
    }
    if (role !== 'PROVIDER_ADMIN' && req.body?.organisationIds !== undefined && (!Array.isArray(req.body.organisationIds) || req.body.organisationIds.length === 0)) {
      return res.status(400).json({ error: 'Assign at least one company (or make them a Provider Admin).' });
    }

    const data = {};
    if (req.body?.name !== undefined) { const n = String(req.body.name).trim(); if (n) data.name = n; }
    if (req.body?.role !== undefined) data.role = role;
    if (req.body?.isActive !== undefined) data.isActive = !!req.body.isActive;
    await prisma.portalUser.update({ where: { id: target.id }, data });
    if (req.body?.role !== undefined || req.body?.organisationIds !== undefined) {
      await setProviderAssignments(target.id, role, req.body?.organisationIds ?? undefined);
    }
    const full = await prisma.portalUser.findUnique({ where: { id: target.id }, include: { providerAssignments: { select: { organisationId: true } } } });
    res.json(providerUserView(full));
  }),
);

// (Re)issue an invite / password-reset link for a provider user.
router.post(
  '/provider/users/:id/invite',
  requirePortalRole('PROVIDER_ADMIN'),
  asyncHandler(async (req, res) => {
    const target = await prisma.portalUser.findFirst({ where: { id: req.params.id, role: { in: PROVIDER_ASSIGNABLE_ROLES } } });
    if (!target) return res.status(404).json({ error: 'Provider user not found' });
    const token = generateInviteToken();
    await prisma.portalUser.update({
      where: { id: target.id },
      data: { inviteTokenHash: hashInviteToken(token), inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS), invitedAt: new Date() },
    });
    res.json({ user: publicPortalUser(target), inviteToken: token });
  }),
);

// ── Employees + claim codes (Path A: pre-create a named user, hand out a code) ─

router.post(
  '/organisations/:id/employees',
  requirePortalRole('GROUP_ADMIN', 'ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!canAccessOrg(req.portalUser, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const displayName = String(req.body?.displayName || '').trim();
    if (!displayName) return res.status(400).json({ error: 'displayName is required' });

    // Seat limit (licensing): pre-creating a person reserves a seat.
    const org = await prisma.organisation.findUnique({ where: { id: req.params.id }, select: { seatLimit: true } });
    if (org?.seatLimit != null) {
      const active = await prisma.monitoredEmployee.count({ where: { organisationId: req.params.id, isActive: true } });
      if (active >= org.seatLimit) {
        return res.status(409).json({ error: `Seat limit reached (${org.seatLimit}). Remove a monitored user to free a seat.` });
      }
    }

    // A group admin can only create within their own group.
    let groupId = req.body?.groupId || null;
    if (req.portalUser.role === 'GROUP_ADMIN') groupId = req.portalUser.groupId;

    const claimCode = generateClaimCode();
    const emp = await prisma.monitoredEmployee.create({
      data: {
        organisationId: req.params.id,
        groupId,
        displayName,
        claimCode,
        claimStatus: 'PENDING',
      },
    });
    res.status(201).json({ id: emp.id, displayName: emp.displayName, groupId: emp.groupId, claimCode });
  }),
);

// (Re)issue a claim code for an existing employee, within the caller's scope.
router.post(
  '/employees/:empId/claim-code',
  requirePortalRole('GROUP_ADMIN', 'ORG_ADMIN'),
  asyncHandler(async (req, res) => {
    const emp = await prisma.monitoredEmployee.findFirst({
      where: { id: req.params.empId, ...scopeFor(req.portalUser) },
    });
    if (!emp) return res.status(404).json({ error: 'Employee not found in your scope' });

    const claimCode = generateClaimCode();
    await prisma.monitoredEmployee.update({
      where: { id: emp.id },
      data: { claimCode, claimStatus: 'PENDING' },
    });
    res.json({ id: emp.id, claimCode });
  }),
);

export default router;
