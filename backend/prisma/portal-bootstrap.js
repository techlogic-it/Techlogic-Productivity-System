import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Idempotent bootstrap for the standalone productivity product:
//   1. ensure the "Techlogic — Internal" Organisation exists,
//   2. backfill organisationId onto pre-existing monitoring rows so the new
//      tenant-scoped unique keys and scope filters apply uniformly,
//   3. ensure a PROVIDER_ADMIN portal login exists.
// Run: node prisma/portal-bootstrap.js

const INTERNAL_SLUG = 'techlogic-internal';
const PROVIDER_EMAIL = (process.env.PORTAL_PROVIDER_EMAIL || 'admin@techlogicservices.co.uk').toLowerCase();

async function main() {
  // 1. Internal organisation (represents Techlogic's own staff, Scenario B data).
  const org = await prisma.organisation.upsert({
    where: { slug: INTERNAL_SLUG },
    update: {},
    create: { name: 'Techlogic — Internal', slug: INTERNAL_SLUG },
  });
  console.log(`Organisation: ${org.name} (${org.id})`);

  // 2. Backfill existing monitoring rows onto the internal org. localAccountKey
  //    is seeded from entraUserId so the (organisationId, localAccountKey) key is
  //    populated for already-captured internal employees.
  const devUpd = await prisma.monitoredDevice.updateMany({
    where: { organisationId: null },
    data: { organisationId: org.id },
  });

  const employees = await prisma.monitoredEmployee.findMany({
    where: { organisationId: null },
    select: { id: true, localAccountKey: true, entraUserId: true },
  });
  let empUpd = 0;
  for (const e of employees) {
    await prisma.monitoredEmployee.update({
      where: { id: e.id },
      data: {
        organisationId: org.id,
        localAccountKey: e.localAccountKey ?? e.entraUserId ?? `legacy:${e.id}`,
        claimStatus: 'CLAIMED',
      },
    });
    empUpd += 1;
  }

  const sumUpd = await prisma.activitySummary.updateMany({
    where: { organisationId: null },
    data: { organisationId: org.id },
  });

  console.log(
    `Backfilled → devices: ${devUpd.count}, employees: ${empUpd}, summaries: ${sumUpd.count}`,
  );

  // 3. Provider admin login. Password from PORTAL_PROVIDER_PASSWORD, else a random
  //    one printed once here (rotate after first login).
  const existing = await prisma.portalUser.findUnique({ where: { email: PROVIDER_EMAIL } });
  if (existing) {
    console.log(`Provider admin already exists: ${PROVIDER_EMAIL} (${existing.role})`);
  } else {
    const plain = process.env.PORTAL_PROVIDER_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const passwordHash = await bcrypt.hash(plain, 12);
    const admin = await prisma.portalUser.create({
      data: {
        email: PROVIDER_EMAIL,
        name: 'Provider Admin',
        role: 'PROVIDER_ADMIN',
        passwordHash,
        passwordSetAt: new Date(),
      },
    });
    console.log(`Provider admin created: ${admin.email} (${admin.id})`);
    if (!process.env.PORTAL_PROVIDER_PASSWORD) {
      console.log('─────────────────────────────────────────────');
      console.log(`  Temp password (shown once): ${plain}`);
      console.log('  Change it after first login.');
      console.log('─────────────────────────────────────────────');
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
