import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../src/security/prisma.service';
import { RefreshTokenService } from '../../src/security/refresh-token.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { hashRefreshToken } from '../../src/security/refresh-token-hasher';

const DAY_MS = 24 * 60 * 60 * 1000;

// US4 Independent Test: rotate 的 exactly-once 并发保证 (affected-count 乐观锁 +
// Serializable + P2034 retry)。在 service 层直测 (绕开 HTTP 的 per-token 5/60s +
// per-IP 100/60s 限流, 否则 10 并发同 token 会被限流成 429 而非 401, 混淆并发不变量)。
describe('US4 refresh 并发 exactly-once (Testcontainers PG, service-level)', () => {
  let prisma: PrismaService;
  let service: RefreshTokenService;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    // connection_limit 调高: 100 并发 interactive tx 需足够连接 (默认池小 → 大量 tx
    // 超 maxWait 拿不到连接 = 池耗尽,非轮换正确性问题)。PG 容器 max_connections=100。
    prisma = new PrismaService(`${url}?connection_limit=50&pool_timeout=20`);
    service = new RefreshTokenService(
      prisma,
      new JwtTokenService(new JwtService({ secret: 'us4-conc-secret-min-32-bytes-pad-xyz' })),
    );
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  it('10 并发持同一 token rotate → 恰 1 成功 + 9×401, DB 该账号 active=1', async () => {
    const accountId = 9100n;
    const record = await prisma.refreshToken.create({
      data: {
        tokenHash: hashRefreshToken('conc-same-token'),
        accountId,
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
        deviceId: 'dev-conc',
        loginMethod: 'PHONE_SMS',
      },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => service.rotate(record, '8.8.8.8')),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1); // 恰 1 成功 (affected-count 乐观锁)
    expect(rejected).toHaveLength(9);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(UnauthorizedException);
    }

    const active = await prisma.refreshToken.findMany({ where: { accountId, revokedAt: null } });
    expect(active).toHaveLength(1); // DB 恰 1 active (无双签 / 无零签)
  });

  it('100 并发各不同 token rotate → 0 错误 (独立行无争用)', async () => {
    const records = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        prisma.refreshToken.create({
          data: {
            tokenHash: hashRefreshToken(`multi-${i}`),
            accountId: 9200n + BigInt(i),
            expiresAt: new Date(Date.now() + 30 * DAY_MS),
            deviceId: `dev-multi-${i}`,
            loginMethod: 'PHONE_SMS',
          },
        }),
      ),
    );

    const results = await Promise.allSettled(records.map((r) => service.rotate(r, null)));
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(0);

    // 每个账号恰 1 active (各自轮换成功)
    const activeCount = await prisma.refreshToken.count({
      where: { accountId: { gte: 9200n, lt: 9300n }, revokedAt: null },
    });
    expect(activeCount).toBe(100);
  });
});
