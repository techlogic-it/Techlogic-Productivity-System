import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Reproducible demo tenant for the productivity product, so a fresh database has
// something to explore: one company ("Demo Co"), three groups, an org-admin login,
// a handful of monitored people, and a few days of summaries. Idempotent — safe to
// re-run. Run AFTER portal-bootstrap.js (which creates the provider admin).
//
//   node prisma/seed-portal-demo.js
//
// Override the demo passwords via DEMO_ORG_ADMIN_PASSWORD / DEMO_GROUP_ADMIN_PASSWORD.

const ORG_ADMIN_EMAIL = 'demo@demo.local';
const ORG_ADMIN_PW = process.env.DEMO_ORG_ADMIN_PASSWORD || 'Demo-Pass-2026!';
const GROUP_ADMIN_EMAIL = 'sales-admin@demo.local';
const GROUP_ADMIN_PW = process.env.DEMO_GROUP_ADMIN_PASSWORD || 'Demo-Sales-2026!';

function dateOnly(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function findOrCreateGroup(organisationId, name) {
  const existing = await prisma.group.findFirst({ where: { organisationId, name } });
  return existing ?? prisma.group.create({ data: { organisationId, name } });
}

async function upsertPortalUser(email, name, role, organisationId, groupId, plainPw) {
  const passwordHash = await bcrypt.hash(plainPw, 12);
  return prisma.portalUser.upsert({
    where: { email },
    update: { name, role, organisationId, groupId, isActive: true },
    create: { email, name, role, organisationId, groupId, isActive: true, passwordHash, passwordSetAt: new Date() },
  });
}

async function upsertEmployee(organisationId, groupId, localAccountKey, displayName) {
  return prisma.monitoredEmployee.upsert({
    where: { organisationId_localAccountKey: { organisationId, localAccountKey } },
    update: { displayName, groupId, claimStatus: 'CLAIMED', isActive: true },
    create: { organisationId, groupId, localAccountKey, displayName, claimStatus: 'CLAIMED', isActive: true },
  });
}

async function seedSummaries(emp, profile) {
  for (let d = 1; d <= 3; d += 1) {
    const summaryDate = dateOnly(d);
    const fields = {
      organisationId: emp.organisationId,
      groupId: emp.groupId,
      activeSec: profile.active, idleSec: profile.idle,
      productiveSec: profile.productive, neutralSec: profile.neutral, nonProductiveSec: profile.nonProductive,
      overtimeSec: profile.overtime, overtimeProductiveSec: profile.overtimeProductive,
      byCategory: profile.byCategory, topApps: profile.topApps,
    };
    await prisma.activitySummary.upsert({
      where: { employeeId_summaryDate: { employeeId: emp.id, summaryDate } },
      update: fields,
      create: { employeeId: emp.id, summaryDate, ...fields },
    });
  }
}

async function main() {
  const org = await prisma.organisation.upsert({
    where: { slug: 'demo-co' },
    update: {},
    create: { name: 'Demo Co', slug: 'demo-co' },
  });
  console.log(`Organisation: ${org.name} (${org.id})`);

  const sales = await findOrCreateGroup(org.id, 'Sales');
  const ops = await findOrCreateGroup(org.id, 'Operations');
  const eng = await findOrCreateGroup(org.id, 'Engineering');
  console.log(`Groups: Sales, Operations, Engineering`);

  await upsertPortalUser(ORG_ADMIN_EMAIL, 'Demo Org Admin', 'ORG_ADMIN', org.id, null, ORG_ADMIN_PW);
  await upsertPortalUser(GROUP_ADMIN_EMAIL, 'Demo Sales Lead', 'GROUP_ADMIN', org.id, sales.id, GROUP_ADMIN_PW);
  console.log(`Portal users: ${ORG_ADMIN_EMAIL} (ORG_ADMIN), ${GROUP_ADMIN_EMAIL} (GROUP_ADMIN/Sales)`);

  const people = [
    await upsertEmployee(org.id, sales.id, 'demo-alice', 'Alice Brown'),
    await upsertEmployee(org.id, sales.id, 'demo-bob', 'Bob Carter'),
    await upsertEmployee(org.id, ops.id, 'demo-sara', 'Sara Patel'),
    await upsertEmployee(org.id, ops.id, 'demo-tom', 'Tom Lee'),
    await upsertEmployee(org.id, eng.id, 'demo-ravi', 'Ravi Shah'),
  ];
  console.log(`Employees: ${people.length}`);

  await seedSummaries(people[0], {
    active: 25200, idle: 3600, productive: 19800, neutral: 3600, nonProductive: 1800,
    overtime: 1800, overtimeProductive: 1200,
    byCategory: { DEVELOPMENT: 14400, COMMUNICATION: 5400, BROWSING: 3600 },
    topApps: [{ processName: 'CHROME.EXE', displayName: 'Google Chrome', sec: 9000 }, { processName: 'OUTLOOK.EXE', displayName: 'Outlook', sec: 5400 }],
  });
  await seedSummaries(people[2], {
    active: 21600, idle: 5400, productive: 14400, neutral: 5400, nonProductive: 1800,
    overtime: 0, overtimeProductive: 0,
    byCategory: { OFFICE: 10800, COMMUNICATION: 7200, BROWSING: 3600 },
    topApps: [{ processName: 'EXCEL.EXE', displayName: 'Excel', sec: 8000 }, { processName: 'TEAMS.EXE', displayName: 'Teams', sec: 6000 }],
  });
  console.log('Sample summaries: Alice Brown, Sara Patel (last 3 days)');

  console.log('\nDemo tenant ready. Log in at /portal/login:');
  console.log(`  Org admin:   ${ORG_ADMIN_EMAIL} / ${ORG_ADMIN_PW}`);
  console.log(`  Group admin: ${GROUP_ADMIN_EMAIL} / ${GROUP_ADMIN_PW}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
