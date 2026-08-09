import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';

/**
 * US3 (002 spec) e2e — 老用户回访：GET /api/v1/accounts/me 返回已存 displayName。
 *
 * FR-001: response shape { accountId, phone, displayName, status, createdAt }
 * FR-007: new account displayName starts null
 * SC-003: displayName must not leak into phone-sms-auth response (anti-enumeration)
 */
describe('US3-002 e2e — GET /me returns saved displayName (FR-001, FR-007)', () => {
  let app: NestFastifyApplication;
  let mockSms: MockSmsGateway;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'us3-002-e2e-jwt-secret-min-32-bytes-pad-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'us3-002-e2e-hmac-secret-min-32-bytes-pad-zzz';

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

  it('新用户 GET /me → displayName: null (FR-007)', async () => {
    const phone = '+8613800139001';
    const token = await acquireToken(phone);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      phone: string;
      displayName: string | null;
      status: string;
    };
    expect(body.displayName).toBeNull();
    expect(body.phone).toBe(phone);
    expect(body.status).toBe('ACTIVE');
  });

  it('PATCH /me 设置 displayName 后 GET /me 返回已存值 (US3 主路径)', async () => {
    const phone = '+8613800139002';
    const token = await acquireToken(phone);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: '张三' },
    });
    expect(patchRes.statusCode).toBe(200);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      phone: string;
      displayName: string | null;
      status: string;
    };
    expect(body.displayName).toBe('张三');
    expect(body.phone).toBe(phone);
    expect(body.status).toBe('ACTIVE');
  });

  it('response 含全部 E1 字段且类型正确 (FR-001)', async () => {
    const phone = '+8613800139003';
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

  it('SC-003: displayName 不出现在 phone-sms-auth 响应（反枚举不变性）', async () => {
    const phone = '+8613800139004';
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
