/**
 * Dev seed — cross-dev baseline data shared by every contributor.
 *
 * Per ADR-0035 § 3: idempotent UPSERT only. Running this script N times must
 * leave the database in the same end state. PK conflicts MUST throw (not
 * caught) — they signal a design bug in seed ↔ unique constraint shape.
 *
 * Empty for now: Plan 1 PoC + Plan 2 phase-A shipped without persistent
 * baseline state requirements (no default admin account, no SMS templates
 * yet). The 3-layer seed scaffold per ADR-0035 is in place so the next
 * feature that needs a baseline row has an obvious landing site.
 *
 * Usage:
 *   pnpm -C apps/server tsx prisma/seeds/dev.ts
 */
import { PrismaClient } from '../../src/generated/prisma/client.js';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // Example shape (kept commented for the first contributor to extend):
  //
  // await prisma.account.upsert({
  //   where: { phone: '+8613800000000' },
  //   create: { phone: '+8613800000000', status: 'ACTIVE' },
  //   update: { status: 'ACTIVE' },
  // });
  console.log('[seed:dev] no baseline rows yet — extend prisma/seeds/dev.ts when first needed.');
}

main()
  .catch((err) => {
    console.error('[seed:dev] failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
