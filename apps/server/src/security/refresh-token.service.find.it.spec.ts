import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from './prisma.service';
import { RefreshTokenService } from './refresh-token.service';
import { JwtTokenService } from './jwt-token.service';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('RefreshTokenService.findActiveByHash (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let service: RefreshTokenService;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    service = new RefreshTokenService(prisma, new JwtTokenService(new JwtService({ secret: 's' })));
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const NOW = new Date('2026-05-25T12:00:00Z');

  async function seed(tokenHash: string, opts: { expiresAt: Date; revokedAt?: Date | null }) {
    await prisma.refreshToken.create({
      data: {
        tokenHash,
        accountId: 7001n,
        expiresAt: opts.expiresAt,
        revokedAt: opts.revokedAt ?? null,
        deviceId: 'dev-find',
        loginMethod: 'PHONE_SMS',
      },
    });
  }

  it('active 命中 → 返回 record', async () => {
    await seed('a'.repeat(64), { expiresAt: new Date(NOW.getTime() + 30 * DAY_MS) });
    const found = await service.findActiveByHash('a'.repeat(64), NOW);
    expect(found).not.toBeNull();
    expect(found!.tokenHash).toBe('a'.repeat(64));
  });

  it('expired (expiresAt < now) → null', async () => {
    await seed('b'.repeat(64), { expiresAt: new Date(NOW.getTime() - 1000) });
    expect(await service.findActiveByHash('b'.repeat(64), NOW)).toBeNull();
  });

  it('revoked (revokedAt set) → null', async () => {
    await seed('c'.repeat(64), {
      expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
      revokedAt: new Date(NOW.getTime() - 1000),
    });
    expect(await service.findActiveByHash('c'.repeat(64), NOW)).toBeNull();
  });

  it('not-found (无此 hash) → null', async () => {
    expect(await service.findActiveByHash('f'.repeat(64), NOW)).toBeNull();
  });
});
