/**
 * Staging seed — grayscale environment baseline.
 *
 * Per ADR-0035 § 3: idempotent UPSERT only. Staging seed typically holds:
 *   - synthetic but realistic accounts for E2E test runs
 *   - reference rows the staging UI demos against
 *
 * Empty for now (Plan 3 Phase 1 stand-up will populate). Same idempotency
 * contract as dev.ts — runs N times → same end state, PK conflicts throw.
 *
 * Usage:
 *   pnpm -C apps/server tsx prisma/seeds/staging.ts
 */
import { PrismaClient } from '../../src/generated/prisma/client.js';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log(
    '[seed:staging] no baseline rows yet — extend prisma/seeds/staging.ts when staging stands up (Plan 3 Phase 1).',
  );
}

main()
  .catch((err) => {
    console.error('[seed:staging] failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
