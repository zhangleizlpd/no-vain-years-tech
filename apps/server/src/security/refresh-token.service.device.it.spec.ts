import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from './prisma.service';
import { RefreshTokenService } from './refresh-token.service';
import { JwtTokenService } from './jwt-token.service';

const DAY_MS = 24 * 60 * 60 * 1000;

// 005 T003: listActiveByAccount / findById / revokeOneForAccount (设备列表 + 单行撤销)。
// 既有 rotate / revokeAllForAccount / persist 行为由 .{rotate,revoke,persist,tx}.spec 覆盖 (回归)。
describe('RefreshTokenService 设备列表 + 单行撤销 (Testcontainers PG)', () => {
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

  // padStart 固定宽度避免 padEnd 前缀撞名 (dev1 + 0×60 === dev10 + 0×59 → P2002)。
  async function seedRow(
    accountId: bigint,
    opts: { createdAt?: Date; revokedAt?: Date | null; deviceId?: string } = {},
  ) {
    seq += 1;
    return prisma.refreshToken.create({
      data: {
        tokenHash: `dev${String(seq).padStart(4, '0')}`.padEnd(64, '0'),
        accountId,
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
        revokedAt: opts.revokedAt ?? null,
        createdAt: opts.createdAt,
        deviceId: opts.deviceId ?? `dev-${seq}`,
        loginMethod: 'PHONE_SMS',
      },
    });
  }

  // ---------- listActiveByAccount ----------

  it('list: 仅本账号 active 行, createdAt DESC, 已撤/他人不计', async () => {
    const A = 7001n;
    const B = 7002n;
    await seedRow(A, { createdAt: new Date('2026-05-01T00:00:00Z'), deviceId: 'A-1' });
    await seedRow(A, { createdAt: new Date('2026-05-02T00:00:00Z'), deviceId: 'A-2' });
    await seedRow(A, { createdAt: new Date('2026-05-03T00:00:00Z'), deviceId: 'A-3' });
    await seedRow(A, { revokedAt: new Date(), deviceId: 'A-revoked' });
    await seedRow(B, { deviceId: 'B-1' });

    const { rows, total } = await service.listActiveByAccount(A, 0, 10);
    expect(total).toBe(3); // 已撤 + 他人不计
    expect(rows.map((r) => r.deviceId)).toEqual(['A-3', 'A-2', 'A-1']); // createdAt DESC
  });

  it('list: 分页切片, total 为全活跃数, 超末页 → 空', async () => {
    const C = 7003n;
    const base = Date.parse('2026-05-10T00:00:00Z');
    for (let i = 0; i < 5; i += 1) {
      await seedRow(C, { createdAt: new Date(base + i * 1000), deviceId: `C-${i}` });
    }
    const p0 = await service.listActiveByAccount(C, 0, 2);
    expect(p0.total).toBe(5);
    expect(p0.rows.map((r) => r.deviceId)).toEqual(['C-4', 'C-3']);
    const p1 = await service.listActiveByAccount(C, 1, 2);
    expect(p1.rows.map((r) => r.deviceId)).toEqual(['C-2', 'C-1']);
    const p2 = await service.listActiveByAccount(C, 2, 2);
    expect(p2.rows.map((r) => r.deviceId)).toEqual(['C-0']);
    const beyond = await service.listActiveByAccount(C, 9, 2);
    expect(beyond.rows).toHaveLength(0);
    expect(beyond.total).toBe(5);
  });

  it('list: size 超 100 → 截断到 100 (total 仍反映全量)', async () => {
    const D = 7004n;
    await prisma.refreshToken.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({
        tokenHash: `clamp${String(i).padStart(4, '0')}`.padEnd(64, '0'),
        accountId: D,
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
        deviceId: `D-${i}`,
        loginMethod: 'PHONE_SMS',
      })),
    });
    const { rows, total } = await service.listActiveByAccount(D, 0, 500);
    expect(rows).toHaveLength(100);
    expect(total).toBe(101);
  });

  it('list: 0 活跃 → 空列表', async () => {
    const { rows, total } = await service.listActiveByAccount(7005n, 0, 10);
    expect(rows).toHaveLength(0);
    expect(total).toBe(0);
  });

  // ---------- findById ----------

  it('findById: 命中返回行 / miss → null', async () => {
    const F = 7006n;
    const row = await seedRow(F, { deviceId: 'F-1' });
    const found = await service.findById(row.id);
    expect(found?.id).toBe(row.id);
    expect(found?.deviceId).toBe('F-1');
    expect(await service.findById(999999999n)).toBeNull();
  });

  // ---------- revokeOneForAccount ----------

  it('revokeOne: 本账号 active → won=true + revokedAt 置', async () => {
    const G = 7007n;
    const row = await seedRow(G, { deviceId: 'G-1' });
    const now = new Date();
    expect(await service.revokeOneForAccount(row.id, G, now)).toEqual({ won: true });
    const after = await prisma.refreshToken.findUnique({ where: { id: row.id } });
    expect(after?.revokedAt?.getTime()).toBe(now.getTime());
  });

  it('revokeOne: 跨账号 → won=false, 行不撤 (WHERE accountId 双保险)', async () => {
    const H = 7008n;
    const row = await seedRow(H, { deviceId: 'H-1' });
    expect(await service.revokeOneForAccount(row.id, 7009n, new Date())).toEqual({ won: false });
    const after = await prisma.refreshToken.findUnique({ where: { id: row.id } });
    expect(after?.revokedAt).toBeNull();
  });

  it('revokeOne: 已撤行重复撤 → won=false (幂等, count=0)', async () => {
    const I = 7010n;
    const row = await seedRow(I, { deviceId: 'I-1' });
    expect(await service.revokeOneForAccount(row.id, I, new Date())).toEqual({ won: true });
    expect(await service.revokeOneForAccount(row.id, I, new Date())).toEqual({ won: false });
  });

  it('revokeOne(tx): caller tx 回滚 → 行未撤 (撤+发事件原子性兜底)', async () => {
    const J = 7011n;
    const row = await seedRow(J, { deviceId: 'J-1' });
    await expect(
      prisma.$transaction(async (tx) => {
        expect(await service.revokeOneForAccount(row.id, J, new Date(), tx)).toEqual({ won: true });
        throw new Error('boom'); // 模拟 outbox.publish 失败 → 整 tx 回滚
      }),
    ).rejects.toThrow('boom');
    const after = await prisma.refreshToken.findUnique({ where: { id: row.id } });
    expect(after?.revokedAt).toBeNull();
  });
});
