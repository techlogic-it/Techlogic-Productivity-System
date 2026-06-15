import crypto from 'crypto';
import prisma from '../prisma.js';

// The Windows agent authenticates with a per-device bearer token. We only ever
// store the SHA-256 hash of that token (never the token itself), so this is the
// canonical place to hash + generate them.

export function hashAgentToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateAgentToken() {
  // 32 random bytes → 43-char url-safe token. Returned once at enrollment.
  return crypto.randomBytes(32).toString('base64url');
}

// Authenticates an agent request by its device token. Attaches req.device.
// Distinct from the human `authenticate` middleware — agents never present an
// Entra JWT.
export async function authenticateAgent(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No agent token provided' });
    }
    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) return res.status(401).json({ error: 'No agent token provided' });

    const device = await prisma.monitoredDevice.findUnique({
      where: { agentTokenHash: hashAgentToken(token) },
    });

    if (!device) return res.status(401).json({ error: 'Invalid agent token' });
    if (device.status !== 'ACTIVE') {
      return res.status(403).json({ error: `Device is ${device.status.toLowerCase()}` });
    }

    req.device = device;
    next();
  } catch (err) {
    next(err);
  }
}
