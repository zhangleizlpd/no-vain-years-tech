import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';

const DAY_MS = 24 * 60 * 60 * 1000;

// US1 Independent Test: 账号 N 活跃 (含私网 + 公网 IP) + 已撤 + 他人行 → authed GET
// (带 x-device-id) → 仅本账号活跃、createdAt DESC、字段齐、私网行 location 空、
// 响应无 raw IP、当前设备 isCurrent。全 boot (PG+Redis+Fastify) 亦验 IpGeoService.onModuleInit。
describe('US1 设备列表 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let mockSms: MockSmsGateway;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'us1-devices-jwt-secret-min-32-bytes-pad-ab';
    process.env.SMS_CODE_HMAC_SECRET = 'us1-devices-hmac-secret-min-32-bytes-pad-z';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtTokenService);
    mockSms = moduleRef.get<MockSmsGateway>(SMS_GATEWAY);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  async function seedRow(
    accountId: bigint,
    opts: {
      deviceId: string;
      ipAddress?: string | null;
      createdAt?: Date;
      revokedAt?: Date | null;
    },
  ) {
    seq += 1;
    return prisma.refreshToken.create({
      data: {
        tokenHash: `us1dev${String(seq).padStart(4, '0')}`.padEnd(64, '0'),
        accountId,
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
        revokedAt: opts.revokedAt ?? null,
        createdAt: opts.createdAt,
        deviceId: opts.deviceId,
        ipAddress: opts.ipAddress ?? null,
        loginMethod: 'PHONE_SMS',
      },
    });
  }

  function listDevices(token?: string, opts: { deviceId?: string; query?: string } = {}) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/auth/devices${opts.query ?? ''}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts.deviceId ? { 'x-device-id': opts.deviceId } : {}),
      },
    });
  }

  it('仅本账号活跃 + createdAt DESC + 私网行 location 空 + 无 raw IP + isCurrent', async () => {
    const A = await prisma.account.create({ data: { phone: '+8613800145001', status: 'ACTIVE' } });
    const B = await prisma.account.create({ data: { phone: '+8613800145002', status: 'ACTIVE' } });
    // A: 3 活跃 (公网 / 私网 / null IP) + 1 已撤; B: 1 活跃
    await seedRow(A.id, {
      deviceId: 'A-current',
      ipAddress: '114.114.114.114', // 公网 → 江苏省南京市
      createdAt: new Date('2026-05-03T00:00:00Z'),
    });
    await seedRow(A.id, {
      deviceId: 'A-private',
      ipAddress: '10.0.0.1', // 私网 → location 空
      createdAt: new Date('2026-05-02T00:00:00Z'),
    });
    await seedRow(A.id, {
      deviceId: 'A-noip',
      ipAddress: null,
      createdAt: new Date('2026-05-01T00:00:00Z'),
    });
    await seedRow(A.id, { deviceId: 'A-revoked', revokedAt: new Date() });
    await seedRow(B.id, { deviceId: 'B-1', ipAddress: '223.5.5.5' });

    const token = jwt.signAccessToken({ accountId: A.id });
    const res = await listDevices(token, { deviceId: 'A-current' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totalElements: number;
      items: Array<Record<string, unknown>>;
    };
    expect(body.totalElements).toBe(3); // 已撤 + 他人不计
    expect(body.items.map((i) => i.deviceId)).toEqual(['A-current', 'A-private', 'A-noip']); // DESC

    const [current, priv, noip] = body.items;
    expect(current.location).toBe('江苏省南京市');
    expect(current.isCurrent).toBe(true);
    expect(priv.location).toBeNull(); // 私网 → 空
    expect(priv.isCurrent).toBe(false);
    expect(noip.location).toBeNull();
    // 字段齐 + 无 ipAddress 字段
    expect(current).not.toHaveProperty('ipAddress');
    expect(Object.keys(current).sort()).toEqual(
      [
        'deviceId',
        'deviceName',
        'deviceType',
        'id',
        'isCurrent',
        'lastActiveAt',
        'location',
        'loginMethod',
      ].sort(),
    );
    // FR-S04: 整个响应体无任何 raw IP 字面值
    expect(res.body).not.toContain('114.114.114.114');
    expect(res.body).not.toContain('10.0.0.1');
    // 他人 / 已撤不出现
    expect(res.body).not.toContain('B-1');
    expect(res.body).not.toContain('A-revoked');
  });

  it('size 超 100 → 实际每页 ≤ 100 (截断)', async () => {
    const C = await prisma.account.create({ data: { phone: '+8613800145003', status: 'ACTIVE' } });
    await prisma.refreshToken.createMany({
      data: Array.from({ length: 105 }, (_, i) => ({
        tokenHash: `us1clamp${String(i).padStart(4, '0')}`.padEnd(64, '0'),
        accountId: C.id,
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
        deviceId: `C-${i}`,
        loginMethod: 'PHONE_SMS',
      })),
    });
    const token = jwt.signAccessToken({ accountId: C.id });
    const res = await listDevices(token, { query: '?page=0&size=500' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { size: number; totalElements: number; items: unknown[] };
    expect(body.items.length).toBe(100); // 截断
    expect(body.size).toBe(100);
    expect(body.totalElements).toBe(105);
  });

  it('鉴权缺失 / 无效 token → 401 (JwtAccessGuard)', async () => {
    expect((await listDevices()).statusCode).toBe(401);
    expect((await listDevices('garbage.invalid.token')).statusCode).toBe(401);
  });

  it('query 非法 (page 非 int) → 400 (FORM_VALIDATION code 由 main.ts exceptionFactory 映射, 此 IT 用简化 pipe 同其他 IT, 仅断状态)', async () => {
    const D = await prisma.account.create({ data: { phone: '+8613800145004', status: 'ACTIVE' } });
    const token = jwt.signAccessToken({ accountId: D.id });
    const res = await listDevices(token, { query: '?page=abc' });
    expect(res.statusCode).toBe(400);
  });

  // FR-S14 采集补强 e2e: 经真 login controller 带 x-device-name/x-device-type 头 → persist
  // 落库 → GET devices 该设备显真实名/类型 (验 @Headers 抽取 → usecase → persist 全链)。
  // 不带头的存量行降级 null/UNKNOWN 由 persist.spec + usecase 单测覆盖。
  async function loginWithDeviceHeaders(
    phone: string,
    deviceId: string,
    name: string,
    type: string,
  ) {
    await app.inject({ method: 'POST', url: '/api/v1/accounts/sms-codes', payload: { phone } });
    const code = mockSms.getLastCode(phone)!;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/phone-sms-auth',
      headers: { 'x-device-id': deviceId, 'x-device-name': name, 'x-device-type': type },
      payload: { phone, code },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { accessToken: string }).accessToken;
  }

  it('FR-S14: login 带 x-device-name/x-device-type 头 → 设备列表显真实名/类型', async () => {
    const phone = '+8613800145005';
    await prisma.account.create({ data: { phone, status: 'ACTIVE' } });
    const token = await loginWithDeviceHeaders(phone, 'fr-s14-dev', 'Pixel 8', 'phone');

    const res = await listDevices(token, { deviceId: 'fr-s14-dev' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<Record<string, unknown>> };
    const row = body.items.find((i) => i.deviceId === 'fr-s14-dev');
    expect(row).toBeDefined();
    expect(row!.deviceName).toBe('Pixel 8');
    expect(row!.deviceType).toBe('PHONE'); // normalizeDeviceType('phone') → PHONE
    expect(row!.isCurrent).toBe(true);
  });
});
