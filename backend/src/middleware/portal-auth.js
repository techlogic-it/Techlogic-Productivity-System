import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../prisma.js';

// Auth plane for the standalone productivity PRODUCT. Self-contained email +
// password (no Microsoft Entra). Distinct from middleware/auth.js (Entra, the
// internal MSP app) and middleware/agent-auth.js (per-device agent tokens).

const JWT_SECRET = process.env.PORTAL_JWT_SECRET || 'dev-portal-secret-change-me';
const TOKEN_TTL = process.env.PORTAL_JWT_TTL || '12h';

export function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

export function verifyPassword(plain, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(plain, hash);
}

// Invite / password-reset tokens: a random url-safe token goes to the user by
// email; we only ever persist its SHA-256 hash (mirrors the agent-token rule).
export function generateInviteToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashInviteToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function signPortalToken(portalUser) {
  return jwt.sign(
    { sub: portalUser.id, role: portalUser.role, org: portalUser.organisationId ?? null },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL },
  );
}

// Verifies the product JWT, loads the live PortalUser (so a deactivated user is
// rejected immediately), and attaches req.portalUser.
export async function authenticatePortal(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.slice('Bearer '.length).trim();

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const user = await prisma.portalUser.findUnique({ where: { id: decoded.sub } });
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Account not found or inactive' });
    }

    // Scoped provider staff (support/viewer) carry the set of companies they may
    // reach. PROVIDER_ADMIN leaves this undefined — it reaches every company.
    if (user.role === 'PROVIDER_SUPPORT' || user.role === 'PROVIDER_VIEWER') {
      const assignments = await prisma.providerAssignment.findMany({
        where: { portalUserId: user.id },
        select: { organisationId: true },
      });
      user.assignedOrgIds = assignments.map((a) => a.organisationId);
    }

    req.portalUser = user;
    next();
  } catch (err) {
    next(err);
  }
}

// Role hierarchy. A higher rank inherits every capability of the ranks below it,
// so requirePortalRole('MANAGER') also admits ORG_ADMIN and PROVIDER_ADMIN.
export const ROLE_RANK = {
  VIEWER: 0,
  GROUP_ADMIN: 1,
  MANAGER: 2,
  ORG_ADMIN: 3,
  // Provider (Techlogic) staff sit above org roles so they pass every org READ
  // gate. WRITE limits for the scoped tiers are enforced explicitly (a read-only
  // guard for PROVIDER_VIEWER; per-route capability checks for PROVIDER_SUPPORT),
  // never by rank alone.
  PROVIDER_VIEWER: 4,
  PROVIDER_SUPPORT: 5,
  PROVIDER_ADMIN: 6,
};

// The Techlogic-internal (cross-company) roles.
export const PROVIDER_ROLES = ['PROVIDER_ADMIN', 'PROVIDER_SUPPORT', 'PROVIDER_VIEWER'];
export function isProviderRole(role) {
  return PROVIDER_ROLES.includes(role);
}

// Blocks every state-changing request from a read-only provider account. Mount
// AFTER authenticatePortal on any router a PROVIDER_VIEWER can reach.
export function blockReadOnlyProvider(req, res, next) {
  if (req.portalUser?.role === 'PROVIDER_VIEWER' && req.method !== 'GET') {
    return res.status(403).json({ error: 'This is a read-only provider account.' });
  }
  next();
}

// Role gate. Pass the MINIMUM role(s) a route needs; anyone at or above the lowest
// listed rank is admitted (so 'MANAGER' admits ORG_ADMIN/PROVIDER_ADMIN too).
export function requirePortalRole(...roles) {
  const min = Math.min(...roles.map((r) => ROLE_RANK[r] ?? 99));
  return (req, res, next) => {
    if (!req.portalUser) return res.status(401).json({ error: 'Not authenticated' });
    if ((ROLE_RANK[req.portalUser.role] ?? -1) < min) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// The multi-tenancy boundary. Returns a Prisma `where` fragment limiting a query
// to what the caller may see. Because organisationId/groupId are denormalised
// onto MonitoredDevice/Employee and ActivitySummary, this one helper enforces
// tenant isolation AND the "group admin sees only his group" rule on every read.
export function scopeFor(portalUser) {
  switch (portalUser.role) {
    case 'PROVIDER_ADMIN':
      return {};
    case 'PROVIDER_SUPPORT':
    case 'PROVIDER_VIEWER': {
      // Limited to the companies this provider user is assigned to.
      const ids = portalUser.assignedOrgIds || [];
      return { organisationId: { in: ids.length ? ids : ['__none__'] } };
    }
    case 'ORG_ADMIN':
    case 'MANAGER':
      // Both see the whole company; MANAGER just can't manage users/settings
      // (enforced by requirePortalRole on those write routes, not by read scope).
      return { organisationId: portalUser.organisationId };
    case 'GROUP_ADMIN':
      return { organisationId: portalUser.organisationId, groupId: portalUser.groupId };
    case 'VIEWER':
      return portalUser.groupId
        ? { organisationId: portalUser.organisationId, groupId: portalUser.groupId }
        : { organisationId: portalUser.organisationId };
    default:
      // Fail closed: an unknown role sees nothing.
      return { organisationId: '__none__' };
  }
}

// Safe public projection of a PortalUser for API responses.
export function publicPortalUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    organisationId: u.organisationId,
    groupId: u.groupId,
    isActive: u.isActive,
    passwordSetAt: u.passwordSetAt ?? null,
    lastLoginAt: u.lastLoginAt,
  };
}
