import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';

/**
 * US4 e2e — FROZEN / ANONYMIZED account holding a valid unexpired token → 401.
 *
 * FR-009: JwtAuthGuard must query DB after token verification and reject
 * any account whose status != ACTIVE, returning the same unified 401 as
 * every other auth failure (anti-enumeration, FR-002 / SC-005).
 *
 * Strategy: use SMS auto-register flow to obtain a real token while
 * the account is ACTIVE, then mutate status via Prisma, then call GET /me.
 */
describe('US4 e2e — FROZEN / ANONYMIZED + valid token → 401 (FR-009)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mockSms: MockSmsGateway;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'us4-e2e-test-jwt-secret-min-32-bytes-pad-xyz';
    process.env.SMS_CODE_HMAC_SECRET = 'us4-e2e-hmac-secret-min-32-bytes-pad-zzzzzz';

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

  /**
   * Auto-register a new phone via SMS flow and return its access token.
   * The created account starts with status=ACTIVE.
   */
  async function acquireToken(phone: string): Promise<string> {
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
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accessToken: string };
    return body.accessToken;
  }

  it('SC-005: FROZEN account + valid unexpired token → 401 (FR-009)', async () => {
    const phone = '+8613800138901';
    const token = await acquireToken(phone);

    await prisma.account.update({
      where: { phone },
      data: { status: 'FROZEN', freezeUntil: new Date('2030-01-01T00:00:00Z') },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('SC-005: ANONYMIZED account + valid unexpired token → 401 (FR-009)', async () => {
    const phone = '+8613800138902';
    const token = await acquireToken(phone);

    await prisma.account.update({
      where: { phone },
      data: { status: 'ANONYMIZED' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('反枚举不变性: FROZEN / ANONYMIZED 401 body shape 与其他 401 路径一致 (FR-002)', async () => {
    // FROZEN account: obtain token while ACTIVE, then freeze
    const phoneFrozen = '+8613800138903';
    const tokenFrozen = await acquireToken(phoneFrozen);
    await prisma.account.update({
      where: { phone: phoneFrozen },
      data: { status: 'FROZEN', freezeUntil: new Date('2030-06-01T00:00:00Z') },
    });

    // ANONYMIZED account: same flow
    const phoneAnonymized = '+8613800138904';
    const tokenAnonymized = await acquireToken(phoneAnonymized);
    await prisma.account.update({
      where: { phone: phoneAnonymized },
      data: { status: 'ANONYMIZED' },
    });

    const resFrozen = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${tokenFrozen}` },
    });

    const resAnonymized = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${tokenAnonymized}` },
    });

    // No Authorization header → 401
    const resMissingToken = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
    });

    // Structurally invalid JWT → 401
    const resInvalidToken = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: 'Bearer invalid.garbage.token' },
    });

    // All paths must return 401
    expect(resFrozen.statusCode).toBe(401);
    expect(resAnonymized.statusCode).toBe(401);
    expect(resMissingToken.statusCode).toBe(401);
    expect(resInvalidToken.statusCode).toBe(401);

    const bodyKeys = (res: { body: string }): string[] =>
      Object.keys((JSON.parse(res.body) as Record<string, unknown>) ?? {}).sort();

    const ct = (res: { headers: Record<string, unknown> }) => res.headers['content-type'];

    // Body shape (keys) must be identical across all 401 paths
    expect(bodyKeys(resFrozen)).toEqual(bodyKeys(resMissingToken));
    expect(bodyKeys(resAnonymized)).toEqual(bodyKeys(resMissingToken));
    expect(bodyKeys(resInvalidToken)).toEqual(bodyKeys(resMissingToken));

    // Content-type must be identical (RFC 9457 problem+json throughout)
    expect(ct(resFrozen)).toEqual(ct(resMissingToken));
    expect(ct(resAnonymized)).toEqual(ct(resMissingToken));
    expect(ct(resInvalidToken)).toEqual(ct(resMissingToken));
  });
});
