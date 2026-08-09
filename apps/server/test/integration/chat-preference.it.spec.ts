import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ChatModule } from '../../src/chat/chat.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { GetChatPreferenceUseCase } from '../../src/chat/get-chat-preference.usecase';
import { UpsertChatPreferenceUseCase } from '../../src/chat/upsert-chat-preference.usecase';

// 031 chat 偏好 IT (真 DI 容器 + Testcontainers PG/Redis + 全 boot Fastify, per plan
// 「NO LIFECYCLE MOCKING」)。两段:
//  A. T003 UC 层直驱 (读/upsert 幂等/清空/多账号不串)。
//  B. T004 端点层 (GET/PUT /api/v1/chat/preferences):
//     ① GET 未设置 → 空串 / ② PUT happy 真落库 + GET 回显 /
//     ③ PUT 超长 2001 字符 → 400 不落库半截 (FR-005) / ④ 空串 PUT = 清空 (D9) /
//     ⑤ 未认证 GET/PUT → 401 / ⑥ 不同 token 各读各的 (不串账号, 端点 token 自绑)。
describe('031 chat preference (Testcontainers PG + Redis)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let getUc: GetChatPreferenceUseCase;
  let upsertUc: UpsertChatPreferenceUseCase;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'chat-t004-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'chat-t004-hmac-secret-min-32-bytes-zyxwv';

    moduleRef = await Test.createTestingModule({
      imports: narrowTestModule([ChatModule]),
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtTokenService);
    redis = moduleRef.get(REDIS_CLIENT);
    getUc = moduleRef.get(GetChatPreferenceUseCase);
    upsertUc = moduleRef.get(UpsertChatPreferenceUseCase);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  const nextPhone = () => `+8613915${String(++seq).padStart(6, '0')}`;
  async function account(): Promise<bigint> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return acc.id;
  }
  async function activeAccount(): Promise<{ id: bigint; token: string }> {
    const id = await account();
    return { id, token: jwt.signAccessToken({ accountId: id }) };
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const sendJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });
  const getPref = (token?: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/chat/preferences',
      headers: token ? auth(token) : {},
    });
  const putPref = (token: string | undefined, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: '/api/v1/chat/preferences',
      headers: token ? sendJson(token) : { 'content-type': 'application/json' },
      payload,
    });

  // ── A. UC 层 (T003) ─────────────────────────────────────────────────────────
  describe('A. UC 层读/upsert', () => {
    it('① 读未设置偏好 → 空串 (无行 = 未设置)', async () => {
      const accountId = await account();
      const result = await getUc.execute(accountId);
      expect(result).toEqual({ customInstruction: '' });
    });

    it('② upsert 写后再读 → 回显写入内容', async () => {
      const accountId = await account();
      await upsertUc.execute(accountId, '请用简洁中文回答, 多举例子。');
      const result = await getUc.execute(accountId);
      expect(result.customInstruction).toBe('请用简洁中文回答, 多举例子。');
    });

    it('③ 二次 upsert 覆盖 → 内容更新且单账号仍单行 (幂等)', async () => {
      const accountId = await account();
      await upsertUc.execute(accountId, '第一版偏好');
      await upsertUc.execute(accountId, '第二版偏好');

      const result = await getUc.execute(accountId);
      expect(result.customInstruction).toBe('第二版偏好');

      const count = await prisma.chatPreference.count({ where: { accountId } });
      expect(count).toBe(1);
    });

    it("④ 空串 upsert → 清空 (行存在但 customInstruction='')", async () => {
      const accountId = await account();
      await upsertUc.execute(accountId, '有内容的偏好');
      await upsertUc.execute(accountId, '');

      const result = await getUc.execute(accountId);
      expect(result.customInstruction).toBe('');

      const row = await prisma.chatPreference.findUnique({ where: { accountId } });
      expect(row).not.toBeNull();
      expect(row?.customInstruction).toBe('');
    });

    it('⑤ 多账号各读各的偏好 (不串账号)', async () => {
      const a = await account();
      const b = await account();
      await upsertUc.execute(a, '账号 A 的偏好');
      await upsertUc.execute(b, '账号 B 的偏好');

      expect((await getUc.execute(a)).customInstruction).toBe('账号 A 的偏好');
      expect((await getUc.execute(b)).customInstruction).toBe('账号 B 的偏好');
    });
  });

  // ── B. 端点层 (T004) ────────────────────────────────────────────────────────
  describe('B. GET/PUT /api/v1/chat/preferences 端点', () => {
    it('① GET 未设置 → 200 空串', async () => {
      const { token } = await activeAccount();
      const res = await getPref(token);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ customInstruction: '' });
    });

    it('② PUT happy → 200 + 真落库 + GET 回显', async () => {
      const { id, token } = await activeAccount();
      const put = await putPref(token, { customInstruction: '先给结论再展开。' });
      expect(put.statusCode).toBe(200);
      expect(JSON.parse(put.body)).toEqual({ customInstruction: '先给结论再展开。' });

      // 真落库
      const row = await prisma.chatPreference.findUnique({ where: { accountId: id } });
      expect(row?.customInstruction).toBe('先给结论再展开。');

      // GET 回显
      const get = await getPref(token);
      expect(JSON.parse(get.body)).toEqual({ customInstruction: '先给结论再展开。' });
    });

    it('③ PUT 超长 2001 字符 → 400 + 不落库半截 (FR-005)', async () => {
      const { id, token } = await activeAccount();
      const tooLong = '字'.repeat(2001);
      const res = await putPref(token, { customInstruction: tooLong });
      expect(res.statusCode).toBe(400);

      // 不落库 (行不存在)
      const row = await prisma.chatPreference.findUnique({ where: { accountId: id } });
      expect(row).toBeNull();
    });

    it('③b PUT 恰好 2000 字符 → 200 (边界合法)', async () => {
      const { token } = await activeAccount();
      const exact = '字'.repeat(2000);
      const res = await putPref(token, { customInstruction: exact });
      expect(res.statusCode).toBe(200);
    });

    it('④ PUT 空串 → 200 清空语义 (D9)', async () => {
      const { id, token } = await activeAccount();
      await putPref(token, { customInstruction: '有内容' });
      const res = await putPref(token, { customInstruction: '' });
      expect(res.statusCode).toBe(200);

      const row = await prisma.chatPreference.findUnique({ where: { accountId: id } });
      expect(row?.customInstruction).toBe('');
      const get = await getPref(token);
      expect(JSON.parse(get.body)).toEqual({ customInstruction: '' });
    });

    it('⑤ 未认证 GET → 401', async () => {
      const res = await getPref(undefined);
      expect(res.statusCode).toBe(401);
    });

    it('⑤b 未认证 PUT → 401', async () => {
      const res = await putPref(undefined, { customInstruction: '试图越权写' });
      expect(res.statusCode).toBe(401);
    });

    it('⑥ 不同 token 各读各的 (端点 token 自绑, 不串账号)', async () => {
      const a = await activeAccount();
      const b = await activeAccount();
      await putPref(a.token, { customInstruction: 'A 的自定义指令' });
      await putPref(b.token, { customInstruction: 'B 的自定义指令' });

      const getA = await getPref(a.token);
      const getB = await getPref(b.token);
      // 字节级一致: 各自只看到自己的内容, 互不串。
      expect(JSON.parse(getA.body)).toEqual({ customInstruction: 'A 的自定义指令' });
      expect(JSON.parse(getB.body)).toEqual({ customInstruction: 'B 的自定义指令' });
    });
  });
});
