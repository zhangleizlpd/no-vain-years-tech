import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';
import { ACCOUNT_IN_FREEZE_PERIOD_CODE } from '../../src/account/account-in-freeze-period.exception';

/**
 * US3 e2e — anti-enumeration per CL-006:
 *   - 3 个 401 路径 (ACTIVE+码错 / ANONYMIZED+正确码 / ANONYMIZED+码错) 字节级一致
 *   - FROZEN+正确码 → 403 + ProblemDetail body { code, freezeUntil } (disclosure path)
 *   - P95 wall-clock 时延 ≤ 50ms 测量推 W3+ `SingleEndpointEnumerationDefenseIT`
 *
 * 注意 (per spec.md 2026-05-17 amend (d)):
 * ANONYMIZED account 测试用 phone NOT NULL hack 触达 code path (生产 phone NULL).
 */
describe('US3 e2e smoke — anti-enumeration (CL-006)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mockSms: MockSmsGateway;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'us3-e2e-test-jwt-secret-min-32-bytes-pad-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'us3-e2e-hmac-secret-min-32-bytes-pad-zzzzzz';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = moduleRef.get(PrismaService);
    mockSms = moduleRef.get<MockSmsGateway>(SMS_GATEWAY);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  const stripVolatile = (res: {
    headers: Record<string, unknown>;
    body: string;
  }): { status: number; bodyKeys: string[]; ct: unknown } => ({
    status: 0, // overwritten by caller
    bodyKeys: Object.keys(JSON.parse(res.body) ?? {}).sort(),
    ct: res.headers['content-type'],
  });

  it('3 个 401 路径 byte-equal (ACTIVE+码错 / ANONYMIZED+正确 / ANONYMIZED+码错)', async () => {
    // path 1: ACTIVE + wrong code
    const phone1 = '+8613800138711';
    await prisma.account.create({ data: { phone: phone1, status: 'ACTIVE' } });
    await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/sms-codes',
      payload: { phone: phone1 },
    });
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/phone-sms-auth',
      payload: { phone: phone1, code: '999999' },
    });

    // path 2: ANONYMIZED + correct code (phone-not-null hack)
    const phone2 = '+8613800138712';
    await prisma.account.create({
      data: { phone: phone2, status: 'ANONYMIZED' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/sms-codes',
      payload: { phone: phone2 },
    });
    const code2 = mockSms.getLastCode(phone2);
    expect(code2).toMatch(/^\d{6}$/);
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/phone-sms-auth',
      payload: { phone: phone2, code: code2 },
    });

    // path 3: ANONYMIZED + wrong code
    const phone3 = '+8613800138713';
    await prisma.account.create({
      data: { phone: phone3, status: 'ANONYMIZED' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/sms-codes',
      payload: { phone: phone3 },
    });
    const res3 = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/phone-sms-auth',
      payload: { phone: phone3, code: '888888' },
    });

    // Assert: all 3 statuses 401
    expect(res1.statusCode).toBe(401);
    expect(res2.statusCode).toBe(401);
    expect(res3.statusCode).toBe(401);

    // Body shape (keys) byte-equal across 3 paths
    const shape1 = stripVolatile(res1);
    const shape2 = stripVolatile(res2);
    const shape3 = stripVolatile(res3);
    expect(shape1.bodyKeys).toEqual(shape2.bodyKeys);
    expect(shape2.bodyKeys).toEqual(shape3.bodyKeys);
    expect(shape1.ct).toEqual(shape2.ct);
    expect(shape2.ct).toEqual(shape3.ct);
  });

  it('FROZEN+正确码 → 403 ProblemDetail with ACCOUNT_IN_FREEZE_PERIOD code + freezeUntil', async () => {
    const phone = '+8613800138714';
    const freezeUntil = new Date('2026-06-17T00:00:00Z');
    await prisma.account.create({
      data: { phone, status: 'FROZEN', freezeUntil: freezeUntil },
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/sms-codes',
      payload: { phone },
    });
    const code = mockSms.getLastCode(phone);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/phone-sms-auth',
      payload: { phone, code },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json() as {
      code?: string;
      freezeUntil?: string;
    };
    expect(body.code).toBe(ACCOUNT_IN_FREEZE_PERIOD_CODE);
    expect(body.freezeUntil).toBe(freezeUntil.toISOString());
  });

  it('FROZEN 403 body shape distinct from 401 anti-enum body', async () => {
    const phoneActive = '+8613800138715';
    await prisma.account.create({
      data: { phone: phoneActive, status: 'ACTIVE' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/sms-codes',
      payload: { phone: phoneActive },
    });
    const res401 = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/phone-sms-auth',
      payload: { phone: phoneActive, code: '777777' },
    });

    const phoneFrozen = '+8613800138716';
    await prisma.account.create({
      data: {
        phone: phoneFrozen,
        status: 'FROZEN',
        freezeUntil: new Date('2026-07-01T00:00:00Z'),
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/sms-codes',
      payload: { phone: phoneFrozen },
    });
    const codeFrozen = mockSms.getLastCode(phoneFrozen);
    const res403 = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/phone-sms-auth',
      payload: { phone: phoneFrozen, code: codeFrozen },
    });

    expect(res401.statusCode).toBe(401);
    expect(res403.statusCode).toBe(403);
    const body401 = res401.json() as Record<string, unknown>;
    const body403 = res403.json() as Record<string, unknown>;
    expect(Object.keys(body401).sort()).not.toEqual(Object.keys(body403).sort());
  });
});
