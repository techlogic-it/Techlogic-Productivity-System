// Email transport for the product — same provider as the Techlogic CRM (Resend),
// so it reuses the already-verified techlogicservices.co.uk sending domain. If
// RESEND_API_KEY is set it sends for real; otherwise it runs in "log mode" and
// renders the email to the server log, so the notification feature is fully
// testable before the key is added. Wiring it on later is env-only.

import { Resend } from 'resend';

const { RESEND_API_KEY, MAIL_FROM } = process.env;

export const emailConfigured = !!RESEND_API_KEY;
// Any address on the verified domain works; override with MAIL_FROM if wanted.
const FROM = MAIL_FROM || 'Techlogic Productivity <no-reply@techlogicservices.co.uk>';

let client = null;
function getClient() {
  if (!emailConfigured) return null;
  if (!client) client = new Resend(RESEND_API_KEY);
  return client;
}

// Send (or, unconfigured, log) one email. Returns { sent, mode }.
export async function sendEmail({ to, subject, html, text }) {
  const recipients = (Array.isArray(to) ? to : [to]).map((s) => String(s || '').trim()).filter(Boolean);
  if (recipients.length === 0) return { sent: false, mode: 'skipped', reason: 'no recipients' };

  const resend = getClient();
  if (!resend) {
    console.log(`[email:logmode] would send "${subject}" to ${recipients.join(', ')} (${(text || html || '').length} chars). Set RESEND_API_KEY to send for real.`);
    return { sent: false, mode: 'logmode', recipients };
  }

  const { error } = await resend.emails.send({ from: FROM, to: recipients, subject, html, text });
  if (error) {
    console.error(`[email] Resend error sending "${subject}":`, error.message || error);
    return { sent: false, mode: 'error', recipients, error: error.message || String(error) };
  }
  console.log(`[email] sent "${subject}" to ${recipients.length} recipient(s)`);
  return { sent: true, mode: 'resend', recipients };
}
