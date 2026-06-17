import prisma from '../prisma.js';

// Normalise a date string ("2026-05-25") or Date to UTC midnight of that day.
// Matches the dateOnly() convention used in routes/daily-reports.js.
export function dateOnly(d) {
  if (!d) return null;
  const dt = new Date(d);
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
}

// Default productivity weight for a category — used when an admin classifies an
// app without setting a weight explicitly. Keep this the single source of truth.
const CATEGORY_WEIGHT = {
  PRODUCTIVE: 'PRODUCTIVE',
  DEVELOPMENT: 'PRODUCTIVE',
  ADMIN_BACKOFFICE: 'PRODUCTIVE',
  RMM_SUPPORT: 'PRODUCTIVE',
  RESEARCH: 'PRODUCTIVE',
  COMMUNICATION: 'NEUTRAL',
  UNCATEGORISED: 'NEUTRAL',
  SOCIAL: 'NON_PRODUCTIVE',
  ENTERTAINMENT: 'NON_PRODUCTIVE',
  BLOCKED_HIGH_RISK: 'NON_PRODUCTIVE',
};

export function weightForCategory(category) {
  return CATEGORY_WEIGHT[category] || 'NEUTRAL';
}

// Title rules, most-specific (longest keyword) first so they win on overlap.
export async function getTitleRules() {
  const rules = await prisma.titleRule.findMany();
  return rules.sort((a, b) => b.keyword.length - a.keyword.length);
}

// Resolve an event's category/weight from the app catalogue + title rules.
// A PRODUCTIVE app keeps its classification (so a leisure keyword in a code
// file name doesn't flag dev work); otherwise a matching title rule wins, then
// the app catalogue, then Uncategorised/Neutral.
export function resolveClassification(processName, windowTitle, appByProc, titleRules) {
  const app = appByProc.get((processName || '').toUpperCase());
  if (app && app.weight === 'PRODUCTIVE') {
    return { category: app.category, weight: app.weight, displayName: app.displayName };
  }
  const title = (windowTitle || '').toLowerCase();
  const rule = (titleRules || []).find((r) => r.keyword && title.includes(r.keyword));
  if (rule) return { category: rule.category, weight: rule.weight, displayName: app?.displayName || processName || '' };
  if (app) return { category: app.category, weight: app.weight, displayName: app.displayName };
  return { category: 'UNCATEGORISED', weight: 'NEUTRAL', displayName: processName || '' };
}

// Build the effective (process-name → classification) map and title-rule list for
// one organisation: the global catalogue/rules with that company's overrides
// layered on top. Used by the timeline endpoint so on-screen classification
// matches what the rollup computed. Pass null for the plain global view.
export async function effectiveClassification(organisationId) {
  const apps = await prisma.monitoredApp.findMany({
    select: { processName: true, displayName: true, weight: true, category: true },
  });
  const byProc = new Map(apps.map((a) => [a.processName.toUpperCase(), a]));
  let rules = await getTitleRules();
  if (organisationId) {
    const ov = await prisma.orgAppClassification.findMany({
      where: { organisationId },
      select: { processName: true, displayName: true, weight: true, category: true, customCategory: true },
    });
    // Effective category folds in a company's custom category name (if set).
    for (const a of ov) byProc.set(a.processName.toUpperCase(), { ...a, category: a.customCategory || a.category });
    const orules = await prisma.orgTitleRule.findMany({
      where: { organisationId },
      select: { keyword: true, weight: true, category: true },
    });
    if (orules.length) rules = [...orules, ...rules].sort((a, b) => (b.keyword?.length || 0) - (a.keyword?.length || 0));
  }
  return { byProc, titleRules: rules };
}

// ─── Office hours ──────────────────────────────────────────────────────────
// Activity inside office hours on a working day counts toward active/productive
// time (and the productivity %); activity outside it is tallied as overtime.
// Settings live in the MonitoringSetting singleton (admin-editable); env vars
// provide the initial defaults.
const DEFAULT_SETTINGS = {
  officeStart: process.env.MON_OFFICE_START || '08:00',
  officeEnd: process.env.MON_OFFICE_END || '18:00',
  workingDays: process.env.MON_OFFICE_DAYS || '1,2,3,4,5', // 1=Mon … 7=Sun
  timezone: process.env.MON_OFFICE_TZ || 'Europe/London',
};

// Load the settings row. With an organisationId, returns that org's row (product
// build), falling back to the global singleton / defaults if the org hasn't set
// its own. Without one, returns the global singleton (internal build), creating
// it with defaults on first use.
export async function getMonitoringSettings(organisationId = null) {
  if (organisationId) {
    const orgRow = await prisma.monitoringSetting.findUnique({ where: { organisationId } });
    if (orgRow) return orgRow;
    const global = await prisma.monitoringSetting.findUnique({ where: { id: 'singleton' } });
    return global || { id: 'singleton', ...DEFAULT_SETTINGS };
  }
  const existing = await prisma.monitoringSetting.findUnique({ where: { id: 'singleton' } });
  if (existing) return existing;
  try {
    return await prisma.monitoringSetting.create({ data: { id: 'singleton', ...DEFAULT_SETTINGS } });
  } catch {
    return { id: 'singleton', ...DEFAULT_SETTINGS };
  }
}

// Build a map of organisationId → officeConfig for the rollup, plus the default
// config used for employees whose org hasn't customised office hours (and for the
// internal build, where organisationId is null).
export async function loadOrgConfigs() {
  const rows = await prisma.monitoringSetting.findMany();
  const byOrg = new Map();
  let global = null;
  for (const r of rows) {
    if (r.organisationId) byOrg.set(r.organisationId, officeConfig(r));
    else global = officeConfig(r);
  }
  return { byOrg, defaultCfg: global || officeConfig(DEFAULT_SETTINGS) };
}

function parseHHMM(value, fallbackMin) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value || '').trim());
  if (!m) return fallbackMin;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Derive computed config (minutes, day-set, tz) from a settings row.
export function officeConfig(settings) {
  const s = settings || DEFAULT_SETTINGS;
  return {
    startMin: parseHHMM(s.officeStart, 8 * 60),
    endMin: parseHHMM(s.officeEnd, 18 * 60),
    days: new Set(String(s.workingDays || '').split(',').map((d) => Number(d.trim())).filter((n) => n >= 1 && n <= 7)),
    timezone: s.timezone || 'Europe/London',
  };
}

const WEEKDAY_NUM = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

// Local weekday + minutes-since-midnight for an instant, in the office timezone.
export function localTimeInfo(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const v = (t) => parts.find((p) => p.type === t)?.value;
  return { dayNum: WEEKDAY_NUM[v('weekday')] || 0, minutesOfDay: Number(v('hour')) * 60 + Number(v('minute')) };
}

// Split an interval's seconds into "inside office hours" vs "overtime".
// Non-working days are entirely overtime. Intervals are short, so we treat the
// whole interval as starting at its local start time (no DST split mid-interval).
export function splitOfficeOvertime(startTime, durationSec, cfg) {
  const sec = durationSec || 0;
  const c = cfg || officeConfig(DEFAULT_SETTINGS);
  const { dayNum, minutesOfDay } = localTimeInfo(startTime, c.timezone);
  if (!c.days.has(dayNum)) return { officeSec: 0, overtimeSec: sec };
  const startMin = minutesOfDay;
  const endMin = startMin + sec / 60;
  const overlapMin = Math.max(0, Math.min(endMin, c.endMin) - Math.max(startMin, c.startMin));
  const officeSec = Math.min(sec, Math.round(overlapMin * 60));
  return { officeSec, overtimeSec: sec - officeSec };
}

// How many trailing days to recompute each run. A rolling window keeps the job
// cheap and idempotent while still absorbing late uploads from laptops that
// were offline. Bump if devices are commonly offline longer than this.
const ROLLUP_WINDOW_DAYS = Number(process.env.MON_ROLLUP_WINDOW_DAYS) || 7;

// Raw-event retention. Daily ActivitySummary rows are kept longer (they're the
// aggregate that powers trends); raw events are pruned. ICO: configurable.
const RETENTION_DAYS = Number(process.env.MON_RETENTION_DAYS) || 90;

// Recompute ActivitySummary for every (employee, day) touched in the trailing
// window. Idempotent: re-running produces the same rows (upsert on the unique
// [employeeId, summaryDate]).
export async function runMonitoringRollup() {
  const windowStart = dateOnly(new Date());
  windowStart.setUTCDate(windowStart.getUTCDate() - (ROLLUP_WINDOW_DAYS - 1));

  const { byOrg, defaultCfg } = await loadOrgConfigs();

  const events = await prisma.activityEvent.findMany({
    where: { startTime: { gte: windowStart } },
  });

  // Resolve each employee's tenant once: drives both the per-org office-hours
  // split below and the denormalised columns on each summary row.
  const employeeIds = [...new Set(events.map((e) => e.employeeId))];
  const employees = await prisma.monitoredEmployee.findMany({
    where: { id: { in: employeeIds } },
    select: { id: true, customerId: true, organisationId: true, groupId: true },
  });
  const metaByEmp = new Map(employees.map((e) => [e.id, e]));
  const cfgForEmp = (employeeId) => {
    const orgId = metaByEmp.get(employeeId)?.organisationId;
    return (orgId && byOrg.get(orgId)) || defaultCfg;
  };

  // Resolve category/weight from the CURRENT catalogue keyed by process name,
  // not from the appId stamped at upload time. This makes (re)classifying an app
  // apply to every user and retroactively to existing events in the rollup window.
  const apps = await prisma.monitoredApp.findMany({
    select: { processName: true, displayName: true, weight: true, category: true },
  });
  const appByProc = new Map(apps.map((a) => [a.processName.toUpperCase(), a]));
  const titleRules = await getTitleRules();

  // Per-company overrides, layered over the global catalogue/rules. Present for an
  // org ⇒ wins for that org; absent ⇒ the global default applies.
  const orgAppRows = await prisma.orgAppClassification.findMany({
    select: { organisationId: true, processName: true, displayName: true, weight: true, category: true, customCategory: true },
  });
  const orgAppByOrg = new Map();
  for (const r of orgAppRows) {
    if (!orgAppByOrg.has(r.organisationId)) orgAppByOrg.set(r.organisationId, new Map());
    // Effective category folds in the company's custom category name (if set).
    orgAppByOrg.get(r.organisationId).set(r.processName.toUpperCase(), { ...r, category: r.customCategory || r.category });
  }
  const orgTitleRows = await prisma.orgTitleRule.findMany({
    select: { organisationId: true, keyword: true, weight: true, category: true },
  });
  const orgTitleByOrg = new Map();
  for (const r of orgTitleRows) {
    if (!orgTitleByOrg.has(r.organisationId)) orgTitleByOrg.set(r.organisationId, []);
    orgTitleByOrg.get(r.organisationId).push(r);
  }
  // Effective (merged) maps per org, cached. Company override wins; company title
  // rules take precedence and the longest keyword matches first.
  const mergedCache = new Map();
  const mergedFor = (orgId) => {
    const key = orgId || '__global__';
    if (mergedCache.has(key)) return mergedCache.get(key);
    let appMap = appByProc;
    const ov = orgId && orgAppByOrg.get(orgId);
    if (ov && ov.size) { appMap = new Map(appByProc); for (const [p, a] of ov) appMap.set(p, a); }
    let rules = titleRules;
    const orules = orgId && orgTitleByOrg.get(orgId);
    if (orules && orules.length) {
      rules = [...orules, ...titleRules].sort((a, b) => (b.keyword?.length || 0) - (a.keyword?.length || 0));
    }
    const merged = { appMap, rules };
    mergedCache.set(key, merged);
    return merged;
  };

  // group key = `${employeeId}|${YYYY-MM-DD}`
  const groups = new Map();
  for (const e of events) {
    const day = dateOnly(e.startTime);
    const key = `${e.employeeId}|${day.toISOString()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        employeeId: e.employeeId,
        summaryDate: day,
        activeSec: 0, idleSec: 0, productiveSec: 0, neutralSec: 0, nonProductiveSec: 0,
        overtimeSec: 0, overtimeProductiveSec: 0, byCategory: {}, appSec: new Map(),
      });
    }
    const g = groups.get(key);
    const sec = e.durationSec || 0;
    const { officeSec, overtimeSec } = splitOfficeOvertime(e.startTime, sec, cfgForEmp(e.employeeId));

    if (e.isIdle) {
      g.idleSec += officeSec; // only idle during office hours counts as idle
      continue;
    }

    // Active time outside office hours is overtime, not part of the productivity %.
    g.overtimeSec += overtimeSec;
    g.activeSec += officeSec;

    const merged = mergedFor(metaByEmp.get(e.employeeId)?.organisationId);
    const cls = resolveClassification(e.processName, e.windowTitle, merged.appMap, merged.rules);
    if (cls.weight === 'PRODUCTIVE') { g.productiveSec += officeSec; g.overtimeProductiveSec += overtimeSec; }
    else if (cls.weight === 'NON_PRODUCTIVE') g.nonProductiveSec += officeSec;
    else g.neutralSec += officeSec;

    g.byCategory[cls.category] = (g.byCategory[cls.category] || 0) + officeSec;

    const appKey = e.processName;
    const prev = g.appSec.get(appKey) || { processName: appKey, displayName: merged.appMap.get((e.processName || '').toUpperCase())?.displayName || e.processName, sec: 0 };
    prev.sec += sec; // top-apps reflect total usage (office + overtime)
    g.appSec.set(appKey, prev);
  }

  // Tenant + customer are denormalised onto each summary (resolved above via
  // metaByEmp) so dashboard reads filter without joins and `scopeFor` applies.
  let summariesUpserted = 0;
  for (const g of groups.values()) {
    const meta = metaByEmp.get(g.employeeId);
    const topApps = [...g.appSec.values()].sort((a, b) => b.sec - a.sec).slice(0, 5);
    const fields = {
      customerId: meta?.customerId ?? null,
      organisationId: meta?.organisationId ?? null,
      groupId: meta?.groupId ?? null,
      activeSec: g.activeSec, idleSec: g.idleSec,
      productiveSec: g.productiveSec, neutralSec: g.neutralSec, nonProductiveSec: g.nonProductiveSec,
      overtimeSec: g.overtimeSec, overtimeProductiveSec: g.overtimeProductiveSec,
      byCategory: g.byCategory, topApps,
    };
    await prisma.activitySummary.upsert({
      where: { employeeId_summaryDate: { employeeId: g.employeeId, summaryDate: g.summaryDate } },
      update: fields,
      create: { employeeId: g.employeeId, summaryDate: g.summaryDate, ...fields },
    });
    summariesUpserted++;
  }

  return { eventsProcessed: events.length, summariesUpserted };
}

// Delete raw events older than the retention window. Summaries are untouched.
export async function runMonitoringRetention() {
  const cutoff = dateOnly(new Date());
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);

  const [act, sess] = await Promise.all([
    prisma.activityEvent.deleteMany({ where: { startTime: { lt: cutoff } } }),
    prisma.sessionEvent.deleteMany({ where: { occurredAt: { lt: cutoff } } }),
  ]);

  return { deletedEvents: act.count, deletedSessionEvents: sess.count };
}
