import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';

/**
 * US1 (002 spec) e2e — 新用户首登：GET /api/v1/accounts/me 返回 displayName=null。
 *
 * FR-001: response shape { accountId, phone, displayName, status, createdAt }
 * FR-002: missing / invalid token → unified 401 (anti-enumeration)
 * FR-007: new account auto-created with displayName = null
 */
describe('US1-002 e2e — 新用户首登 GET /me returns displayName=null (FR-001, FR-002, FR-007)', () => {
  let app: NestFastifyApplication;
  let mockSms: MockSmsGateway;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'us1-002-e2e-jwt-secret-min-32-bytes-pad-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'us1-002-e2e-hmac-secret-min-32-bytes-pad-zzz';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    mockSms = moduleRef.get<MockSmsGateway>(SMS_GATEWAY);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

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

  it('新用户首登 GET /me → displayName: null (FR-007 主路径)', async () => {
    const phone = '+8613800140001';
    const token = await acquireToken(phone);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { displayName: string | null; status: string; phone: string };
    expect(body.displayName).toBeNull();
    expect(body.phone).toBe(phone);
    expect(body.status).toBe('ACTIVE');
  });

  it('response 含全部 E1 字段且类型正确 (FR-001)', async () => {
    const phone = '+8613800140002';
    const token = await acquireToken(phone);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body).toHaveProperty('accountId');
    expect(body).toHaveProperty('phone');
    expect(body).toHaveProperty('displayName');
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('createdAt');

    expect(typeof body['accountId']).toBe('string');
    expect(body['phone']).toBe(phone);
    expect(body['displayName']).toBeNull();
    expect(body['status']).toBe('ACTIVE');
    expect(typeof body['createdAt']).toBe('string');
    expect(new Date(body['createdAt'] as string).getTime()).not.toBeNaN();
  });

  it('Authorization 头缺失 → 401 (FR-002)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
    });

    expect(res.statusCode).toBe(401);
  });

  it('Authorization 头格式非法 → 401 (FR-002)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: 'Bearer invalid.garbage.token' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('SC-003: displayName 不出现在 phone-sms-auth 响应（反枚举不变性）', async () => {
    const phone = '+8613800140003';
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
    const body = res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('displayName');
  });
});
