import { Router } from 'express';
import asyncHandler from 'express-async-handler';

import prisma from '../prisma.js';
import {
  authenticatePortal,
  hashPassword,
  verifyPassword,
  signPortalToken,
  generateInviteToken,
  hashInviteToken,
  publicPortalUser,
} from '../middleware/portal-auth.js';

const router = Router();

// Auth endpoints for the standalone product. Login issues a product JWT the
// frontend stores and sends as a Bearer token (same pattern as the MSAL token in
// the internal app's api.js interceptor).

// Tiny in-memory failed-login throttle: 5 misses per email → 60s lockout.
// In-process only; a durable limiter is a Phase 6 hardening item.
const attempts = new Map(); // email → { count, until }
const MAX_FAILS = 5;
const LOCK_MS = 60_000;

function lockedOut(email) {
  const a = attempts.get(email);
  return a?.until && a.until > Date.now();
}

function recordFail(email) {
  const a = attempts.get(email) || { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= MAX_FAILS) {
    a.until = Date.now() + LOCK_MS;
    a.count = 0;
  }
  attempts.set(email, a);
}

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (lockedOut(email)) {
      return res.status(429).json({ error: 'Too many attempts, try again shortly' });
    }

    const user = await prisma.portalUser.findUnique({ where: { email } });
    const ok = user && user.isActive && (await verifyPassword(password, user.passwordHash));
    if (!ok) {
      recordFail(email);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    attempts.delete(email);
    await prisma.portalUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    res.json({ token: signPortalToken(user), user: publicPortalUser(user) });
  }),
);

// Stateless JWT — logout is client-side (drop the token). Endpoint exists so the
// frontend has a symmetric call and we can hang server-side revocation off it later.
router.post('/logout', (req, res) => res.json({ ok: true }));

router.get(
  '/me',
  authenticatePortal,
  asyncHandler(async (req, res) => {
    const ctx = { organisation: null, group: null };
    if (req.portalUser.organisationId) {
      ctx.organisation = await prisma.organisation.findUnique({
        where: { id: req.portalUser.organisationId },
        select: { id: true, name: true, slug: true, status: true },
      });
    }
    if (req.portalUser.groupId) {
      ctx.group = await prisma.group.findUnique({
        where: { id: req.portalUser.groupId },
        select: { id: true, name: true },
      });
    }
    res.json({ user: publicPortalUser(req.portalUser), ...ctx });
  }),
);

// Redeem an invite OR a password-reset token to set a new password. Both flows
// use the same single-use, hashed, time-limited token on PortalUser.
async function redeemToken(token, password, res) {
  if (!token || !password) {
    return res.status(400).json({ error: 'Token and password are required' });
  }
  if (String(password).length < 10) {
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  }
  const user = await prisma.portalUser.findUnique({
    where: { inviteTokenHash: hashInviteToken(token) },
  });
  if (!user || !user.inviteExpiresAt || user.inviteExpiresAt < new Date()) {
    return res.status(400).json({ error: 'Invalid or expired token' });
  }
  await prisma.portalUser.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(password),
      passwordSetAt: new Date(),
      inviteTokenHash: null,
      inviteExpiresAt: null,
      isActive: true,
    },
  });
  return res.json({ ok: true });
}

router.post(
  '/accept-invite',
  asyncHandler((req, res) => redeemToken(req.body?.token, req.body?.password, res)),
);

router.post(
  '/reset-password',
  asyncHandler((req, res) => redeemToken(req.body?.token, req.body?.password, res)),
);

// Issue a reset token. Always responds 200 so the endpoint can't be used to probe
// which emails exist. In dev (no email transport wired yet) the token is returned
// in the response; in production it must be delivered by email instead.
router.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = email ? await prisma.portalUser.findUnique({ where: { email } }) : null;

    let devToken;
    if (user && user.isActive) {
      const token = generateInviteToken();
      await prisma.portalUser.update({
        where: { id: user.id },
        data: {
          inviteTokenHash: hashInviteToken(token),
          inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });
      // TODO(Phase 3): send `token` via the org's email transport instead.
      if (process.env.NODE_ENV !== 'production') devToken = token;
    }

    res.json({ ok: true, ...(devToken ? { devToken } : {}) });
  }),
);

export default router;
