import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from './prisma.service';
import { RefreshTokenService } from './refresh-token.service';
import { JwtTokenService } from './jwt-token.service';
import { hashRefreshToken } from './refresh-token-hasher';
import type { RefreshToken } from '../generated/prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('RefreshTokenService.rotate (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let service: RefreshTokenService;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    service = new RefreshTokenService(
      prisma,
      new JwtTokenService(new JwtService({ secret: 'rotate-test-secret-min-32-bytes-pad-xx' })),
    );
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  async function seedActive(): Promise<RefreshToken> {
    seq += 1;
    return prisma.refreshToken.create({
      data: {
        tokenHash: `seed${seq}`.padEnd(64, '0'),
        accountId: 8000n + BigInt(seq),
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
        deviceId: `dev-rot-${seq}`,
        deviceName: 'Rot Device',
        deviceType: 'PHONE',
        loginMethod: 'PHONE_SMS',
        ipAddress: '203.0.113.1',
      },
    });
  }

  it('happy: 撤旧 + 插新 active, 继承 device 血缘 (id/name/type/loginMethod), 更 IP, 新 30d, 单 active', async () => {
    const old = await seedActive();
    const before = Date.now();
    const result = await service.rotate(old, '198.51.100.7');

    expect(result.accountId).toBe(old.accountId);
    expect(result.accessToken).toContain('.');
    expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rows = await prisma.refreshToken.findMany({
      where: { accountId: old.accountId },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(2);
    const oldRow = rows.find((r) => r.id === old.id)!;
    const newRow = rows.find((r) => r.id !== old.id)!;
    expect(oldRow.revokedAt).not.toBeNull(); // 旧撤
    expect(newRow.revokedAt).toBeNull(); // 新 active
    expect(newRow.tokenHash).toBe(hashRefreshToken(result.refreshToken));
    expect(newRow.deviceId).toBe(old.deviceId);
    expect(newRow.deviceName).toBe(old.deviceName);
    expect(newRow.deviceType).toBe(old.deviceType);
    expect(newRow.loginMethod).toBe(old.loginMethod);
    expect(newRow.ipAddress).toBe('198.51.100.7'); // 更 IP (公网原样)
    const exp = newRow.expiresAt.getTime();
    expect(exp).toBeGreaterThanOrEqual(before + 30 * DAY_MS - 10_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS + 10_000);
  });

  it('单次使用: 旧 token 已被撤 (count===0) → 401, tx 回滚不插新行', async () => {
    const old = await seedActive();
    // 模拟并发: rotate 调用前该行已被撤销
    await prisma.refreshToken.update({ where: { id: old.id }, data: { revokedAt: new Date() } });

    await expect(service.rotate(old, '8.8.8.8')).rejects.toBeInstanceOf(UnauthorizedException);

    const rows = await prisma.refreshToken.findMany({ where: { accountId: old.accountId } });
    expect(rows).toHaveLength(1); // 无新行
  });

  it('rotate clientIp 私网 → 新行 ipAddress 落 null', async () => {
    const old = await seedActive();
    await service.rotate(old, '10.0.0.5');
    const active = await prisma.refreshToken.findMany({
      where: { accountId: old.accountId, revokedAt: null },
    });
    expect(active).toHaveLength(1);
    expect(active[0]!.ipAddress).toBeNull();
  });
});
