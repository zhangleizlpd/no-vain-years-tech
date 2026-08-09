import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';

/**
 * 007 US2 e2e — 个人简介编辑：PATCH /api/v1/accounts/me/bio 设置 / 清空 bio。
 *
 * SC-002 / FR-S01..S06:
 *  - PATCH 合法 bio → 200 + 持久化 + GET /me 回读 (FR-S02, FR-S06)
 *  - 空串 → 清空 bio (200，回读 null) (FR-S03 允许清空)
 *  - 超 120 码点 / 控制字符 / 零宽 → 400 (FR-S03)
 *  - 缺 / 失效 token → 401 (FR-S04，沿用既有 authed 守卫)
 *  - GET /me 响应含 bio：已设回读、未设为 null (FR-S06 / T003)
 */
describe('007 bio e2e — PATCH /me/bio + GET /me 回读 (FR-S02..S06, SC-002)', () => {
  let app: NestFastifyApplication;
  let mockSms: MockSmsGateway;
  // Pre-acquired once; reused across the FR-S03 validation battery (6 < me-patch limit of 10)
  let validationToken: string;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'bio-007-e2e-jwt-secret-min-32-bytes-pad-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'bio-007-e2e-hmac-secret-min-32-bytes-pad-zzz';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    mockSms = moduleRef.get<MockSmsGateway>(SMS_GATEWAY);

    validationToken = await acquireToken('+8613800160010');
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

  // ── Happy path + persistence (FR-S02, FR-S06) ──────────────────────────────

  it('PATCH /me/bio 成功设置 bio → 200 + 更新后 profile (含 bio)', async () => {
    const phone = '+8613800160001';
    const token = await acquireToken(phone);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me/bio',
      headers: { authorization: `Bearer ${token}` },
      payload: { bio: '美股研究员' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['bio']).toBe('美股研究员');
    expect(body['phone']).toBe(phone);
    expect(body['status']).toBe('ACTIVE');
    expect(typeof body['accountId']).toBe('string');
    expect(body).toHaveProperty('displayName');
  });

  it('PATCH 后 GET /me 回读已更新的 bio（FR-S06 持久化 + 回读）', async () => {
    const token = await acquireToken('+8613800160002');

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me/bio',
      headers: { authorization: `Bearer ${token}` },
      payload: { bio: '不虚此生 2026 🎯' },
    });

    const getRes = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json() as { bio: string };
    expect(getBody.bio).toBe('不虚此生 2026 🎯');
  });

  it('GET /me bio 为 null 当未设置（FR-S06 默认）', async () => {
    const token = await acquireToken('+8613800160003');

    const getRes = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json() as { bio: string | null };
    expect(getBody.bio).toBeNull();
  });

  it('trim 行为：前后空白被 trim，存储 trim 后的值（FR-S03）', async () => {
    const token = await acquireToken('+8613800160004');

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me/bio',
      headers: { authorization: `Bearer ${token}` },
      payload: { bio: '  量化交易员  ' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { bio: string };
    expect(body.bio).toBe('量化交易员');
  });

  // ── Clear bio (FR-S03 允许清空) ────────────────────────────────────────────

  it('空串清空 bio → 200 + bio 回读 null（FR-S03 允许清空）', async () => {
    const token = await acquireToken('+8613800160005');

    // 先设
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me/bio',
      headers: { authorization: `Bearer ${token}` },
      payload: { bio: '旧简介' },
    });
    // 再清空
    const clearRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me/bio',
      headers: { authorization: `Bearer ${token}` },
      payload: { bio: '' },
    });
    expect(clearRes.statusCode).toBe(200);
    expect((clearRes.json() as { bio: string | null }).bio).toBeNull();

    const getRes = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((getRes.json() as { bio: string | null }).bio).toBeNull();
  });

  // ── Auth guard (FR-S04) ────────────────────────────────────────────────────

  it('无 Authorization 头 → 401（FR-S04）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me/bio',
      payload: { bio: '美股研究员' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('非法 Authorization token → 401（FR-S04）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me/bio',
      headers: { authorization: 'Bearer invalid.garbage.token' },
      payload: { bio: '美股研究员' },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── FR-S03 validation battery（reuse validationToken，6 PATCH < limit 10）──

  it('FR-S03 — 121 码点超长 → 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me/bio',
      headers: { authorization: `Bearer ${validationToken}` },
      payload: { bio: 'a'.repeat(121) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('FR-S03 — 控制字符 (U+0001) → 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me/bio',
      headers: { authorization: `Bearer ${validationToken}` },
      payload: { bio: 'abc\x01def' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('FR-S03 — 零宽字符 (U+200B) → 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me/bio',
      headers: { authorization: `Bearer ${validationToken}` },
      payload: { bio: 'abc' + String.fromCodePoint(0x200b) + 'def' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('FR-S03 — CJK 120 字 (上限边界) → 200', async () => {
    const oneTwentyCJK = '字'.repeat(120);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me/bio',
      headers: { authorization: `Bearer ${validationToken}` },
      payload: { bio: oneTwentyCJK },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { bio: string }).bio).toBe(oneTwentyCJK);
  });

  it('FR-S03 — emoji (多字节码点，每 emoji = 1 码点) → 200', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me/bio',
      headers: { authorization: `Bearer ${validationToken}` },
      payload: { bio: '🎉🔥✨ 美股研究员' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { bio: string }).bio).toBe('🎉🔥✨ 美股研究员');
  });

  it('FR-S03 — 空串清空 → 200 (allowed clear)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/accounts/me/bio',
      headers: { authorization: `Bearer ${validationToken}` },
      payload: { bio: '' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { bio: string | null }).bio).toBeNull();
  });
});
