// Productivity email digests (daily + weekly) for a company's admins/managers.
// Built from the ActivitySummary rollups; sent (or logged) via lib/email.js.
// A scheduler tick (runDigests) fires them once per day/week, in each company's
// own timezone, de-duped via the *SentOn markers on MonitoringSetting.

import prisma from '../prisma.js';
import { dateOnly } from './monitoring-rollup.js';
import { sendEmail, emailConfigured } from './email.js';

const WEEKDAY_NUM = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

// Org-local calendar info for "now": YYYY-MM-DD, hour (0-23), weekday (1=Mon).
function localNow(timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date());
  const v = (t) => parts.find((p) => p.type === t)?.value;
  return { dateStr: `${v('year')}-${v('month')}-${v('day')}`, hour: Number(v('hour')), weekday: WEEKDAY_NUM[v('weekday')] || 0 };
}

// Add days to a YYYY-MM-DD string (UTC arithmetic, returns YYYY-MM-DD).
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

const fmtDate = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// Aggregate ActivitySummary rows for one org over [fromStr, toStr] into a total
// plus a per-employee list — the same shape the dashboard uses.
async function buildDigest(orgId, fromStr, toStr) {
  const summaries = await prisma.activitySummary.findMany({
    where: { organisationId: orgId, summaryDate: { gte: dateOnly(fromStr), lte: dateOnly(toStr) } },
    include: { employee: { select: { displayName: true, upn: true } } },
  });
  const total = { activeSec: 0, idleSec: 0, productiveSec: 0, neutralSec: 0, nonProductiveSec: 0, overtimeSec: 0 };
  const byEmp = new Map();
  for (const s of summaries) {
    total.activeSec += s.activeSec; total.idleSec += s.idleSec;
    total.productiveSec += s.productiveSec; total.neutralSec += s.neutralSec;
    total.nonProductiveSec += s.nonProductiveSec; total.overtimeSec += s.overtimeSec || 0;
    const key = s.employeeId;
    if (!byEmp.has(key)) byEmp.set(key, { name: s.employee?.displayName || s.employee?.upn || 'Unnamed', activeSec: 0, productiveSec: 0, overtimeSec: 0 });
    const e = byEmp.get(key);
    e.activeSec += s.activeSec; e.productiveSec += s.productiveSec; e.overtimeSec += s.overtimeSec || 0;
  }
  const pct = (p, a) => (a > 0 ? Math.round((p / a) * 100) : 0);
  const employees = [...byEmp.values()]
    .map((e) => ({ ...e, productivityPct: pct(e.productiveSec, e.activeSec) }))
    .sort((a, b) => b.activeSec - a.activeSec);
  return { total: { ...total, productivityPct: pct(total.productiveSec, total.activeSec) }, employees };
}

function renderHtml({ orgName, periodLabel, total, employees }) {
  const rows = employees.map((e) => `
    <tr>
      <td style="padding:6px 10px;border-top:1px solid #eee">${escapeHtml(e.name)}</td>
      <td style="padding:6px 10px;border-top:1px solid #eee;text-align:right">${fmtDur(e.activeSec)}</td>
      <td style="padding:6px 10px;border-top:1px solid #eee;text-align:right">${fmtDur(e.productiveSec)}</td>
      <td style="padding:6px 10px;border-top:1px solid #eee;text-align:right;font-weight:600">${e.productivityPct}%</td>
    </tr>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
  <div style="max-width:640px;margin:0 auto;padding:24px">
    <div style="font-weight:700;font-size:18px;color:#0f766e">Techlogic Productivity</div>
    <div style="color:#6b7280;font-size:13px;margin-bottom:16px">${escapeHtml(orgName)} · ${escapeHtml(periodLabel)}</div>
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:16px">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          ${kpi('Active', fmtDur(total.activeSec))}
          ${kpi('Productive', fmtDur(total.productiveSec))}
          ${kpi('Productivity', `${total.productivityPct}%`)}
          ${kpi('Overtime', fmtDur(total.overtimeSec))}
        </tr>
      </table>
    </div>
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="background:#f9fafb;color:#6b7280;font-size:12px;text-transform:uppercase">
          <th style="text-align:left;padding:8px 10px">Employee</th>
          <th style="text-align:right;padding:8px 10px">Active</th>
          <th style="text-align:right;padding:8px 10px">Productive</th>
          <th style="text-align:right;padding:8px 10px">Productivity</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="4" style="padding:14px 10px;color:#9ca3af">No activity recorded in this period.</td></tr>`}</tbody>
      </table>
    </div>
    <div style="color:#9ca3af;font-size:11px;margin-top:16px">You're receiving this because you administer ${escapeHtml(orgName)} in Techlogic Productivity. Turn digests off in Settings → Notifications.</div>
  </div></body></html>`;
}

const kpi = (label, value) => `<td style="text-align:center;padding:6px">
  <div style="font-size:11px;color:#6b7280;text-transform:uppercase">${label}</div>
  <div style="font-size:18px;font-weight:700;color:#1f2937">${value}</div></td>`;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function plainText({ orgName, periodLabel, total, employees }) {
  const lines = [`${orgName} — ${periodLabel}`, '',
    `Active ${fmtDur(total.activeSec)} · Productive ${fmtDur(total.productiveSec)} · Productivity ${total.productivityPct}% · Overtime ${fmtDur(total.overtimeSec)}`, ''];
  for (const e of employees) lines.push(`${e.name}: ${fmtDur(e.activeSec)} active, ${fmtDur(e.productiveSec)} productive (${e.productivityPct}%)`);
  if (!employees.length) lines.push('No activity recorded in this period.');
  return lines.join('\n');
}

// Recipients = this company's active admins + managers, plus any extra addresses.
async function recipientsFor(orgId, setting) {
  const admins = await prisma.portalUser.findMany({
    where: { organisationId: orgId, role: { in: ['ORG_ADMIN', 'MANAGER'] }, isActive: true },
    select: { email: true },
  });
  const extra = String(setting?.digestRecipients || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...admins.map((a) => a.email).filter(Boolean), ...extra])];
}

// Build + send one digest. type: 'daily' | 'weekly'. Returns the send result.
// `to` overrides recipients (used by the test-send). `skipEmpty` skips sending
// when there was no activity at all (avoids empty weekend emails on a schedule).
export async function sendDigest({ org, setting, type, to, skipEmpty = false }) {
  const tz = setting?.timezone || 'Europe/London';
  const { dateStr } = localNow(tz);
  let fromStr, toStr, periodLabel;
  if (type === 'weekly') {
    const { weekday } = localNow(tz);
    const thisMonday = addDays(dateStr, -((weekday || 1) - 1));
    fromStr = addDays(thisMonday, -7);
    toStr = addDays(fromStr, 6);
    periodLabel = `Week of ${fmtDate(fromStr)} – ${fmtDate(toStr)}`;
  } else {
    fromStr = toStr = addDays(dateStr, -1); // yesterday
    periodLabel = fmtDate(fromStr);
  }
  const digest = await buildDigest(org.id, fromStr, toStr);
  if (skipEmpty && digest.total.activeSec === 0 && digest.employees.length === 0) {
    return { sent: false, mode: 'skipped-empty' };
  }
  const model = { orgName: org.name, periodLabel, ...digest };
  const recipients = to ? (Array.isArray(to) ? to : [to]) : await recipientsFor(org.id, setting);
  const subject = `${type === 'weekly' ? 'Weekly' : 'Daily'} productivity — ${org.name} — ${periodLabel}`;
  return sendEmail({ to: recipients, subject, html: renderHtml(model), text: plainText(model) });
}

// Scheduler tick — send any due daily/weekly digests, each in its org's timezone,
// once per day/week. Called on an interval from index.js. Errors are isolated
// per company so one failure can't stop the rest.
export async function runDigests() {
  const settings = await prisma.monitoringSetting.findMany({
    where: { organisationId: { not: null }, OR: [{ dailyDigest: true }, { weeklyDigest: true }] },
  });
  if (settings.length === 0) return;
  const sendHour = Number(process.env.MON_DIGEST_HOUR) || 7;

  for (const s of settings) {
    try {
      const org = await prisma.organisation.findUnique({ where: { id: s.organisationId }, select: { id: true, name: true } });
      if (!org) continue;
      const { dateStr, hour, weekday } = localNow(s.timezone || 'Europe/London');

      if (s.dailyDigest && hour >= sendHour && s.dailyDigestSentOn !== dateStr) {
        await sendDigest({ org, setting: s, type: 'daily', skipEmpty: true });
        await prisma.monitoringSetting.update({ where: { id: s.id }, data: { dailyDigestSentOn: dateStr } });
      }
      if (s.weeklyDigest && weekday === 1 && hour >= sendHour && s.weeklyDigestSentOn !== dateStr) {
        await sendDigest({ org, setting: s, type: 'weekly', skipEmpty: true });
        await prisma.monitoringSetting.update({ where: { id: s.id }, data: { weeklyDigestSentOn: dateStr } });
      }
    } catch (err) {
      console.error(`[digests] failed for org ${s.organisationId}:`, err.message);
    }
  }
}

export { emailConfigured };
