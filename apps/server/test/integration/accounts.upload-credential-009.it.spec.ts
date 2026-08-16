import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';
import { ossConfig, type OssConfig } from '../../src/config';

/**
 * Deterministic fake OSS config — injected via `ossConfig.KEY` DI override, NOT
 * process.env. Env-based OSS is flaky in the parallel suite: @nestjs/config caches
 * the ossConfig provider across independent Test DI containers, so a prior
 * AppModule boot (OSS env unset) can poison this IT with a stale `unconfigured`
 * config → credential EP 503 OSS_NOT_CONFIGURED where it expects 200. Explicit
 * `useValue` is hermetic + immune, and avoids leaking OSS_* env to sibling ITs
 * (same pattern as ideation-image-attachment.it.spec.ts). Signing is pure Node
 * crypto — no live bucket call.
 */
const ALIYUN_OSS: OssConfig = {
  kind: 'aliyun',
  region: 'oss-cn-shanghai',
  bucket: 'nvy-profile-images',
  accessKeyId: 'LTAI-it-fake-ak',
  accessKeySecret: 'it-fake-sk',
};

/**
 * 009 US1 IT — POST /api/v1/accounts/me/profile-image/upload-credential (EP1).
 *
 * SC-001 / FR-S02/S05/S06: authed request → scope-restricted V4 PostObject
 * credential (本账号 key 前缀 + content-type 白名单 + size + 短时效); 非法
 * content-type → 400; 缺/失效 token → 401 (既有 authed 守卫).
 *
 * OSS creds set to deterministic fakes in beforeAll — signing is pure Node
 * crypto, OSS is never actually called (backend 0 bytes proxy, SC-007), so the
 * fakes exercise the full sign path without a live bucket.
 */
describe('009 upload-credential IT — EP1 (SC-001, FR-S02/S05/S06)', () => {
  let app: NestFastifyApplication;
  let mockSms: MockSmsGateway;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'upload-009-it-jwt-secret-min-32-bytes-pad-abcd';
    process.env.SMS_CODE_HMAC_SECRET = 'upload-009-it-hmac-secret-min-32-bytes-pad-zz';
    // OSS config injected via ossConfig.KEY override below (NOT process.env) — see ALIYUN_OSS.

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
    })
      .overrideProvider(ossConfig.KEY)
      .useValue(ALIYUN_OSS)
      .compile();

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

  async function acquireToken(phone: string): Promise<{ token: string; accountId: string }> {
    await app.inject({ method: 'POST', url: '/api/v1/accounts/sms-codes', payload: { phone } });
    const code = mockSms.getLastCode(phone);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/phone-sms-auth',
      payload: { phone, code },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accessToken: string; accountId?: string };
    // accountId not in login response (anti-enum); decode from JWT sub.
    const sub = JSON.parse(Buffer.from(body.accessToken.split('.')[1]!, 'base64').toString('utf8'))
      .sub as string;
    return { token: body.accessToken, accountId: sub };
  }

  it('authed avatar request → 200 + V4 credential scoped to <avatar/accountId/> prefix', async () => {
    const { token, accountId } = await acquireToken('+8613800190001');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/me/profile-image/upload-credential',
      headers: { authorization: `Bearer ${token}` },
      payload: { target: 'avatar', contentType: 'image/jpeg' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      host: string;
      objectKey: string;
      expiresAt: string;
      fields: Record<string, string>;
    };

    expect(body.host).toBe('https://nvy-profile-images.oss-cn-shanghai.aliyuncs.com');
    expect(body.objectKey).toMatch(new RegExp(`^avatar/${accountId}/[0-9a-f-]+/img$`));
    expect(body.fields.key).toBe(body.objectKey);
    expect(body.fields['x-oss-signature-version']).toBe('OSS4-HMAC-SHA256');
    expect(body.fields['x-oss-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(body.fields['x-oss-credential']).toContain('/cn-shanghai/oss/aliyun_v4_request');
    expect(body.fields.success_action_status).toBe('200');
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // policy carries the account-scoped prefix + image whitelist + size + status.
    const policy = JSON.parse(Buffer.from(body.fields.policy, 'base64').toString('utf8')) as {
      conditions: unknown[];
    };
    expect(policy.conditions).toContainEqual(['starts-with', '$key', `avatar/${accountId}/`]);
    expect(policy.conditions).toContainEqual([
      'in',
      '$content-type',
      ['image/jpeg', 'image/png', 'image/webp'],
    ]);
    expect(policy.conditions).toContainEqual(['eq', '$success_action_status', '200']);
  });

  it('authed background request → 200 + background/ prefix', async () => {
    const { token, accountId } = await acquireToken('+8613800190002');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/me/profile-image/upload-credential',
      headers: { authorization: `Bearer ${token}` },
      payload: { target: 'background', contentType: 'image/png' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { objectKey: string };
    expect(body.objectKey).toMatch(new RegExp(`^background/${accountId}/`));
  });

  it('non-whitelisted content-type → 400 (FR-S02)', async () => {
    const { token } = await acquireToken('+8613800190003');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/me/profile-image/upload-credential',
      headers: { authorization: `Bearer ${token}` },
      payload: { target: 'avatar', contentType: 'image/gif' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('invalid target → 400 (DTO @IsIn)', async () => {
    const { token } = await acquireToken('+8613800190004');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/me/profile-image/upload-credential',
      headers: { authorization: `Bearer ${token}` },
      payload: { target: 'banner', contentType: 'image/jpeg' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('missing token → 401 (FR-S05)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/me/profile-image/upload-credential',
      payload: { target: 'avatar', contentType: 'image/jpeg' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('invalid token → 401 (FR-S05)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/me/profile-image/upload-credential',
      headers: { authorization: 'Bearer invalid.garbage.token' },
      payload: { target: 'avatar', contentType: 'image/jpeg' },
    });
    expect(res.statusCode).toBe(401);
  });
});
