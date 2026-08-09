import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from './prisma.service';
import { RefreshTokenService } from './refresh-token.service';
import { JwtTokenService } from './jwt-token.service';

const DAY_MS = 24 * 60 * 60 * 1000;

// T003: persist / revokeAllForAccount tx-client 重载 —— 跨 ctx 写入 caller 持有的
// $transaction (R2 sync, plan D3)。验证 tx 传入时操作与 caller tx 的 commit/rollback
// 联动 (撤 token 失败 → 整请求回滚, FR-S04/S10 原子性)。无 tx arg 的既有行为由
// refresh-token.service.{revoke,persist}.spec.ts 覆盖 (回归)。
describe('RefreshTokenService tx-client 重载 (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let service: RefreshTokenService;
  let seq = 0;

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

  async function seedActive(accountId: bigint) {
    seq += 1;
    return prisma.refreshToken.create({
      data: {
        tokenHash: `tx${seq}`.padEnd(64, '0'),
        accountId,
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
        revokedAt: null,
        deviceId: `dev-tx-${seq}`,
        loginMethod: 'PHONE_SMS',
      },
    });
  }

  it('revokeAllForAccount(tx): caller tx 回滚 → token 未撤 (撤 token 失败回滚整请求)', async () => {
    const A = 6001n;
    await seedActive(A);
    await seedActive(A);

    await expect(
      prisma.$transaction(async (tx) => {
        await service.revokeAllForAccount(A, new Date(), tx);
        throw new Error('boom'); // 模拟后续步骤失败 → 整 tx 回滚
      }),
    ).rejects.toThrow('boom');

    const active = await prisma.refreshToken.count({ where: { accountId: A, revokedAt: null } });
    expect(active).toBe(2); // 回滚 → 撤销未生效
  });

  it('revokeAllForAccount(tx): caller tx 提交 → token 全撤', async () => {
    const B = 6002n;
    await seedActive(B);
    await seedActive(B);

    await prisma.$transaction(async (tx) => {
      await service.revokeAllForAccount(B, new Date(), tx);
    });

    const active = await prisma.refreshToken.count({ where: { accountId: B, revokedAt: null } });
    expect(active).toBe(0); // 提交 → 撤销生效
  });

  it('persist(tx): caller tx 回滚 → 新 token 行未落库', async () => {
    const C = 6003n;
    const before = await prisma.refreshToken.count({ where: { accountId: C } });
    expect(before).toBe(0);

    await expect(
      prisma.$transaction(async (tx) => {
        await service.persist(C, 'raw-refresh-token-c', { loginMethod: 'PHONE_SMS' }, tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const after = await prisma.refreshToken.count({ where: { accountId: C } });
    expect(after).toBe(0); // 回滚 → 未持久化
  });

  it('persist(tx): caller tx 提交 → 新 token 行落库 (active)', async () => {
    const D = 6004n;
    await prisma.$transaction(async (tx) => {
      await service.persist(D, 'raw-refresh-token-d', { loginMethod: 'PHONE_SMS' }, tx);
    });

    const active = await prisma.refreshToken.count({ where: { accountId: D, revokedAt: null } });
    expect(active).toBe(1);
  });
});
