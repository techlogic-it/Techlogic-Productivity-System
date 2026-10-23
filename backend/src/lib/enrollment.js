import crypto from 'crypto';

// Helpers for the product's per-organisation enrolment keys and per-user claim
// codes. Like agent tokens, enrolment keys are stored only as a SHA-256 hash.

export function generateEnrollmentKey() {
  // 24 random bytes → 32-char url-safe key. Returned once when minted.
  return crypto.randomBytes(24).toString('base64url');
}

export function hashEnrollmentKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

// Reversible at-rest encryption for the company enrolment key, so the portal can
// re-display it (the installer carries it), and for customer storage secrets
// (lib/screenshots.js reuses encrypt/decryptEnrollmentKey for those). AES-256-GCM;
// the 32-byte key is derived from ENROLLMENT_KEY_SECRET. In production this must
// be its own secret — falling back to PORTAL_JWT_SECRET would mean leaking either
// one leaks both — and there is no hardcoded fallback, since a secret baked into
// public source is no secret at all. Outside production a fixed dev value keeps
// `npm run dev` working without extra setup.
// Format: base64(iv[12] || authTag[16] || ciphertext). hashEnrollmentKey stays
// the lookup index — enrolment never decrypts, only the admin reveal does.
const ENROLLMENT_SECRET = process.env.ENROLLMENT_KEY_SECRET
  || (process.env.NODE_ENV !== 'production' ? (process.env.PORTAL_JWT_SECRET || 'dev-insecure-enrollment-secret') : null);
if (!ENROLLMENT_SECRET) {
  throw new Error('ENROLLMENT_KEY_SECRET must be set in production — refusing to start with no encryption secret.');
}
const ENC_KEY = crypto.createHash('sha256').update(ENROLLMENT_SECRET).digest();

export function encryptEnrollmentKey(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptEnrollmentKey(b64) {
  if (!b64) return null;
  try {
    const raw = Buffer.from(b64, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong secret or corrupt ciphertext
  }
}

// Human-friendly claim code (entered by a person at install). Avoids ambiguous
// characters (0/O, 1/I/L) and groups as XXXX-XXXX for readability.
const CLAIM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateClaimCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += CLAIM_ALPHABET[bytes[i] % CLAIM_ALPHABET.length];
    if (i === 3) out += '-';
  }
  return out;
}
