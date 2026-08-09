import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';

/**
 * US2 (002 spec) e2e — Onboarding 提交：PATCH /api/v1/accounts/me 设置 displayName。
 *
 * FR-003: PATCH endpoint accepts {displayName}, returns full E1 shape
 * FR-004: auth required — missing / invalid token → unified 401
 * FR-005: DisplayName validation rules (SC-006 8-case matrix)
 */
describe('US2-002 e2e — Onboarding PATCH /me 设置 displayName (FR-003, FR-004, FR-005, SC-006)', () => {
  let app: NestFastifyApplication;
  let mockSms: MockSmsGateway;
  // Pre-acquired once in beforeAll; reused across all SC-006 validation cases (8 < me-patch limit of 10)
  let validationToken: string;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'us2-002-e2e-jwt-secret-min-32-bytes-pad-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'us2-002-e2e-hmac-secret-min-32-bytes-pad-zzz';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    mockSms = moduleRef.get<MockSmsGateway>(SMS_GATEWAY);

    // Register a dedicated account for the SC-006 validation battery
    validationToken = await acquireToken('+8613800150010');
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

  // ── Happy path (FR-003) ────────────────────────────────────────────────────

  it('PATCH /me 成功设置 displayName → 200 + 更新后 E1 shape (FR-003 主路径)', async () => {
    const phone = '+8613800150001';
    const token = await acquireToken(phone);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: 'Alice' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['displayName']).toBe('Alice');
    expect(body['phone']).toBe(phone);
    expect(body['status']).toBe('ACTIVE');
    expect(typeof body['accountId']).toBe('string');
    expect(typeof body['createdAt']).toBe('string');
    expect(new Date(body['createdAt'] as string).getTime()).not.toBeNaN();
  });

  it('response 含全部 E1 字段且类型正确 (FR-003 response shape)', async () => {
    const token = await acquireToken('+8613800150002');

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: 'TestUser' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('accountId');
    expect(body).toHaveProperty('phone');
    expect(body).toHaveProperty('displayName');
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('createdAt');
    expect(body['displayName']).toBe('TestUser');
  });

  it('PATCH 后 GET /me 返回已更新的 displayName（持久化验证）', async () => {
    const token = await acquireToken('+8613800150003');

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: '不虚此生' },
    });

    const getRes = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json() as { displayName: string };
    expect(getBody.displayName).toBe('不虚此生');
  });

  it('trim 行为：前后空白被 trim，存储 trim 后的值（FR-005）', async () => {
    const token = await acquireToken('+8613800150004');

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: '  Alice  ' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { displayName: string };
    expect(body.displayName).toBe('Alice');
  });

  // ── Auth guard (FR-004) ────────────────────────────────────────────────────

  it('无 Authorization 头 → 401（FR-004）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      payload: { displayName: 'Alice' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('非法 Authorization token → 401（FR-004）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      headers: { authorization: 'Bearer invalid.garbage.token' },
      payload: { displayName: 'Alice' },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── SC-006: FR-005 displayName 校验规则 8-case matrix ─────────────────────
  //
  // Reject cases (400): empty / whitespace-only / control-char / zero-width / 33-codepoints
  // Accept cases (200): CJK-32 / emoji-only / mixed-valid

  it('SC-006 case 1 — 空字符串 → 400（FR-005）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${validationToken}` },
      payload: { displayName: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('SC-006 case 2 — 仅空白 (trim → 0 码点) → 400（FR-005）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${validationToken}` },
      payload: { displayName: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('SC-006 case 3 — 控制字符 (U+0001) → 400（FR-005）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${validationToken}` },
      payload: { displayName: 'abc\x01def' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('SC-006 case 4 — 零宽字符 (U+200B) → 400（FR-005）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${validationToken}` },
      payload: { displayName: 'abc' + String.fromCodePoint(0x200b) + 'def' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('SC-006 case 5 — 33 码点超长 (ASCII) → 400（FR-005）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${validationToken}` },
      payload: { displayName: 'a'.repeat(33) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('SC-006 case 6 — CJK 32 字 (上限边界) → 200（FR-005）', async () => {
    const thirtyCJK = '字'.repeat(32);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${validationToken}` },
      payload: { displayName: thirtyCJK },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { displayName: string };
    expect(body.displayName).toBe(thirtyCJK);
  });

  it('SC-006 case 7 — emoji only (多字节码点，每个 emoji = 1 码点) → 200（FR-005）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${validationToken}` },
      payload: { displayName: '🎉🔥✨' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { displayName: string };
    expect(body.displayName).toBe('🎉🔥✨');
  });

  it('SC-006 case 8 — 混合合法 (CJK + 拉丁 + 数字 + emoji) → 200（FR-005）', async () => {
    const mixed = '不虚此生 2026 🎯';
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${validationToken}` },
      payload: { displayName: mixed },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { displayName: string };
    expect(body.displayName).toBe(mixed);
  });
});
