import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationError, ValidationPipe, BadRequestException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';
import { AppModule } from '../../src/app/app.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import {
  ASR_PROVIDER,
  type AsrProvider,
  type AsrTranscribeOneShotOptions,
} from '../../src/integrations/asr/asr.module';

const TRANSCRIBE_URL = '/api/v1/ideation/asr/transcribe';
/** 与 main.ts per-route hook 一致 (此 IT 复制以忠实 prod 路由行为)。 */
const ASR_TRANSCRIBE_BODY_LIMIT = 15 * 1024 * 1024;

/**
 * 035 T004 全 boot IT (真 DI 容器 + Testcontainers PG/Redis + Fastify, per plan
 * 「NO LIFECYCLE MOCKING」)。覆盖 POST /ideation/asr/transcribe (一次性语音转写):
 *  ① JWT 有效 → 200 {text} (fake 注 text) / ② 无 JWT → 401 /
 *  ③ 静音 (fake 空 text) → 200 {text:''} / ④ 转写失败 (fake throw) → 503
 *     ASR_TRANSCRIBE_FAILED (非裸 500, 不泄 vendor 细节, 会话不受影响) /
 *  ⑤ 非法 mimeType → 400 FORM_VALIDATION / ⑥ >1MB body → 200 (per-route bodyLimit 已抬高,
 *     默认 1MB 会 413) / ⑦ env-gated 真 DashScope (RUN_ASR_SYNC_IT, 默认 skip)。
 *
 * ASR_PROVIDER 经 DI override 注一个可切换状态的确定性 fake (不 jest.mock, per plan)。
 */
type FakeState = { text: string; fail: boolean };

describe('035 ideation asr transcribe (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let seq = 0;

  // 可切换的 fake 配置 (每个 it 重置 → 驱动正常 / 静音空 / 失败)。
  const fakeState: FakeState = { text: '', fail: false };
  const fakeAsr: AsrProvider = {
    transcribeOneShot(_audio: Uint8Array, _opts: AsrTranscribeOneShotOptions): Promise<string> {
      if (fakeState.fail) return Promise.reject(new Error('asr-failed'));
      return Promise.resolve(fakeState.text);
    },
  };

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'ideation-t004-jwt-secret-min-32-bytes-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'ideation-t004-hmac-secret-min-32-bytes-zy';

    const builder = Test.createTestingModule({ imports: [AppModule] });
    // ⑦ env-gated 真 DashScope: 不 override → 走真 DashscopeAsrProvider (需 ASR_PROVIDER=dashscope
    //    + 真 DASHSCOPE_API_KEY env); 否则注 fake 驱动 state_branches。
    if (!process.env.RUN_ASR_SYNC_IT) {
      builder.overrideProvider(ASR_PROVIDER).useValue(fakeAsr);
    }
    moduleRef = await builder.compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        // 与 main.ts 同款 FORM_VALIDATION 映射 (ProblemDetailFilter 读 code), 否则 IT 默认裸 400。
        exceptionFactory: (errors: ValidationError[]) =>
          new BadRequestException({ code: 'FORM_VALIDATION', invalidAttributes: errors }),
      }),
    );
    app.setGlobalPrefix('api');
    // per-route bodyLimit (复制 main.ts onRoute hook, 须在 init/route mount 前挂)。
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRoute', (routeOptions) => {
        const method = routeOptions.method;
        const isPost = Array.isArray(method) ? method.includes('POST') : method === 'POST';
        if (isPost && routeOptions.url === TRANSCRIBE_URL) {
          routeOptions.bodyLimit = ASR_TRANSCRIBE_BODY_LIMIT;
        }
      });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtTokenService);
    redis = moduleRef.get(REDIS_CLIENT);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    await redis.flushall();
    fakeState.text = '';
    fakeState.fail = false;
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613916${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<string> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return jwt.signAccessToken({ accountId: acc.id });
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (token: string | null, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: TRANSCRIBE_URL,
      headers: token ? auth(token) : {},
      payload: payload as object,
    });
  const tinyAudioB64 = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]).toString('base64');

  // ── ① JWT 有效 → 200 {text} ─────────────────────────────────────────────────
  it.skipIf(process.env.RUN_ASR_SYNC_IT)(
    '① JWT 有效 + base64 → 200 {text} (fake 注 text)',
    async () => {
      fakeState.text = '你想给行情页加收藏';
      const token = await activeToken();
      const res = await post(token, { audioBase64: tinyAudioB64, mimeType: 'audio/aac' });
      expect(res.statusCode).toBe(200);
      expect((JSON.parse(res.body) as { text: string }).text).toBe('你想给行情页加收藏');
    },
  );

  // ── ② 无 JWT → 401 ──────────────────────────────────────────────────────────
  it('② 无 JWT → 401', async () => {
    const res = await post(null, { audioBase64: tinyAudioB64, mimeType: 'audio/aac' });
    expect(res.statusCode).toBe(401);
  });

  // ── ③ 静音 (空 text) → 200 {text:''} ────────────────────────────────────────
  it.skipIf(process.env.RUN_ASR_SYNC_IT)('③ 静音 → 200 {text:""} (非错误)', async () => {
    fakeState.text = '';
    const token = await activeToken();
    const res = await post(token, { audioBase64: tinyAudioB64, mimeType: 'audio/aac' });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { text: string }).text).toBe('');
  });

  // ── ④ 转写失败 → 503 ASR_TRANSCRIBE_FAILED (不泄 vendor 细节) ─────────────────
  it.skipIf(process.env.RUN_ASR_SYNC_IT)(
    '④ 转写失败 → 503 ASR_TRANSCRIBE_FAILED (非裸 500, 不泄内部)',
    async () => {
      fakeState.fail = true;
      const token = await activeToken();
      const res = await post(token, { audioBase64: tinyAudioB64, mimeType: 'audio/aac' });
      expect(res.statusCode).toBe(503); // 可重试错误态, 会话不受影响
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body.code).toBe('ASR_TRANSCRIBE_FAILED');
      // 底层 reason / vendor 细节 / stack 不外泄
      expect(JSON.stringify(body)).not.toContain('asr-failed');
      expect(JSON.stringify(body)).not.toContain('stack');
    },
  );

  // ── ⑤ 非法 mimeType → 400 FORM_VALIDATION ───────────────────────────────────
  it('⑤ 非法 mimeType → 400 FORM_VALIDATION', async () => {
    const token = await activeToken();
    const res = await post(token, { audioBase64: tinyAudioB64, mimeType: 'audio/ogg' });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { code?: string }).code).toBe('FORM_VALIDATION');
  });

  // ── ⑥ >1MB body → 200 (per-route bodyLimit 已抬高; 默认 1MB 会 413) ───────────
  it.skipIf(process.env.RUN_ASR_SYNC_IT)(
    '⑥ >1MB body 被接受 (per-route bodyLimit 生效, 默认 1MB 会 413)',
    async () => {
      fakeState.text = 'ok';
      const token = await activeToken();
      // 2MB base64 (> Fastify 默认 1MB bodyLimit, < 14MB DTO @MaxLength)。
      const bigB64 = 'A'.repeat(2 * 1024 * 1024);
      const res = await post(token, { audioBase64: bigB64, mimeType: 'audio/aac' });
      expect(res.statusCode).toBe(200);
      expect((JSON.parse(res.body) as { text: string }).text).toBe('ok');
    },
  );

  // ── ⑦ env-gated 真 DashScope (RUN_ASR_SYNC_IT, 默认 skip) ─────────────────────
  // 真打 qwen3-asr-flash compatible-mode 喂 G-1 样本 m4a 验真转写无复读。需:
  //   RUN_ASR_SYNC_IT=1 + ASR_PROVIDER=dashscope + 真 DASHSCOPE_API_KEY +
  //   ASR_SYNC_IT_SAMPLE=<path to G-1 m4a/aac 样本>。
  it.skipIf(!process.env.RUN_ASR_SYNC_IT)(
    '⑦ 真 DashScope 一次性识别 G-1 样本 → 非空且无复读',
    async () => {
      const samplePath = process.env.ASR_SYNC_IT_SAMPLE;
      if (!samplePath) throw new Error('ASR_SYNC_IT_SAMPLE (G-1 样本路径) 未设');
      const audioB64 = readFileSync(samplePath).toString('base64');
      const token = await activeToken();
      const res = await post(token, { audioBase64: audioB64, mimeType: 'audio/aac' });
      expect(res.statusCode).toBe(200);
      const text = (JSON.parse(res.body) as { text: string }).text;
      expect(text.length).toBeGreaterThan(0); // 真转写非空
      // 复读检测: 相邻重复子串 (G-1 复读病灶) —— 简单启发, 人工核对样本预期文本为准。
      expect(/(.{4,})\1{2,}/.test(text)).toBe(false);
    },
  );
});
