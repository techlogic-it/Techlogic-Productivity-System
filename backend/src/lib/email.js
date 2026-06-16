// Email transport for the product. Provider-agnostic: if SMTP is configured via
// env, send for real (nodemailer works with SendGrid/SES/Mailgun/M365/etc.);
// otherwise run in "log mode" — render the email to the server log so the whole
// notification feature is testable before a provider is connected. Wiring a
// provider later is just setting the SMTP_* env vars; no code change.

import nodemailer from 'nodemailer';

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_SECURE, // "true" for 465; otherwise STARTTLS on 587
  MAIL_FROM,
} = process.env;

export const emailConfigured = !!SMTP_HOST;
const FROM = MAIL_FROM || 'Techlogic Productivity <no-reply@productivity.techlogicservices.co.uk>';

let transporter = null;
function getTransport() {
  if (!emailConfigured) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 587,
      secure: SMTP_SECURE === 'true' || Number(SMTP_PORT) === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

// Send (or, unconfigured, log) one email. Returns { sent, mode }.
export async function sendEmail({ to, subject, html, text }) {
  const recipients = (Array.isArray(to) ? to : [to]).map((s) => String(s || '').trim()).filter(Boolean);
  if (recipients.length === 0) return { sent: false, mode: 'skipped', reason: 'no recipients' };

  const t = getTransport();
  if (!t) {
    // Log mode — prove the content without sending.
    console.log(`[email:logmode] would send "${subject}" to ${recipients.join(', ')} (${(text || html || '').length} chars). Set SMTP_* to send for real.`);
    return { sent: false, mode: 'logmode', recipients };
  }
  await t.sendMail({ from: FROM, to: recipients.join(', '), subject, html, text });
  console.log(`[email] sent "${subject}" to ${recipients.length} recipient(s)`);
  return { sent: true, mode: 'smtp', recipients };
}
