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
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmStreamEvent,
  type LlmStreamOptions,
} from '../../src/integrations/llm/llm-provider.port';
import { FakeLlmProvider } from '../../src/integrations/llm/fake-llm.provider';
import type { Msg } from '../../src/chat/chat-context.rules';

// 029 T004 全 boot state_branches IT (真 DI 容器 + Testcontainers PG/Redis + Fastify +
// FakeProvider 经 DI override 注入, per plan「NO LIFECYCLE MOCKING」)。覆盖 spec 11 条
// state_branches 中 server 可验的分支:
//  ① models 清单: flash/pro 可用 + minimax 不可用 (字段 id/label/description/available) /
//  ② 设 flash·pro 持久化 + 会话级记忆 (建 2 会话各设不同 model, 分别读回正确) /
//  ③ 默认 flash (新会话首发落 flash + provider 收 flash) /
//  ④ send 按会话 model 路由 (FakeProvider 断言收到的逻辑 model 随会话变) /
//  ⑤ 设 model 越权 → 404 (与 messages 404 字节级一致, 反枚举) /
//  ⑥ 非法 / 不可用 model (minimax) → 400 / ⑦ 未认证 → 401。
// (流中切先 abort / 元数据降级 / 下拉 UI = mobile 侧分支, 不在本 IT。)
class SwappableFakeProvider implements LlmProvider {
  private inner = new FakeLlmProvider({ tokens: ['你好', '。'] });
  lastModel: string | undefined;
  setFake(tokens: string[]): void {
    this.inner = new FakeLlmProvider({ tokens });
  }
  stream(messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    this.lastModel = opts.model;
    return this.inner.stream(messages, opts);
  }
}

describe('029 model switch state_branches (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let provider: SwappableFakeProvider;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'chat-t004-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'chat-t004-hmac-secret-min-32-bytes-zyxw';
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-placeholder-key';

    provider = new SwappableFakeProvider();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([ChatModule]),
    })
      .overrideProvider(LLM_PROVIDER)
      .useValue(provider)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
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
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613919${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const authJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });

  async function seedConversation(accountId: bigint, model = 'flash'): Promise<bigint> {
    const row = await prisma.conversation.create({
      data: { accountId, title: '会话', model },
      select: { id: true },
    });
    return row.id;
  }

  const listModels = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/chat/models', headers: auth(token) });
  const setModel = (token: string, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/chat/conversations/${id}/model`,
      headers: authJson(token),
      payload,
    });
  const send = (token: string, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${id}/messages`,
      headers: authJson(token),
      payload,
    });
  const getMessages = (token: string, id: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${id}/messages`,
      headers: auth(token),
    });

  const strip = (raw: string) => {
    const { traceId, instance, ...rest } = JSON.parse(raw) as Record<string, unknown>;
    void traceId;
    void instance;
    return rest;
  };

  interface ModelMetaView {
    id: string;
    label: string;
    description: string;
    available: boolean;
  }

  // ── ① models 清单: flash/pro/minimax 均可用, 字段齐 ─────────────────────────
  it('① GET /chat/models → flash/pro/minimax 均可用; id/label/description/available 字段齐', async () => {
    const me = await activeToken();
    const res = await listModels(me.token);
    expect(res.statusCode).toBe(200);
    const models = (res.json() as { models: ModelMetaView[] }).models;
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));

    expect(byId.flash?.available).toBe(true);
    expect(byId.pro?.available).toBe(true);
    expect(byId.minimax?.available).toBe(true);
    for (const m of models) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.label).toBe('string');
      expect(typeof m.description).toBe('string');
      expect(typeof m.available).toBe('boolean');
    }
  });

  // ── ② 设 flash·pro 持久化 + 会话级记忆 (2 会话各异, 分别读回) ────────────────
  it('② 两会话各设不同 model → 持久化 + 会话级记忆 (互不串)', async () => {
    const me = await activeToken();
    const convA = await seedConversation(me.id, 'flash');
    const convB = await seedConversation(me.id, 'flash');

    expect((await setModel(me.token, convA.toString(), { model: 'pro' })).statusCode).toBe(200);
    expect((await setModel(me.token, convB.toString(), { model: 'flash' })).statusCode).toBe(200);

    const rowA = await prisma.conversation.findUnique({ where: { id: convA } });
    const rowB = await prisma.conversation.findUnique({ where: { id: convB } });
    expect(rowA?.model).toBe('pro'); // A 记 pro
    expect(rowB?.model).toBe('flash'); // B 记 flash (不被 A 波及)
  });

  // ── ③ 默认 flash: 新会话首发 → provider 收 flash + 落库 flash ────────────────
  it('③ 默认 flash: 会话 model=flash 首发 → provider 收 flash', async () => {
    const me = await activeToken();
    const cid = await seedConversation(me.id, 'flash');
    provider.setFake(['答']);

    const res = await send(me.token, cid.toString(), { content: '你好' });
    expect(res.statusCode).toBe(200);
    expect(provider.lastModel).toBe('flash');

    const row = await prisma.conversation.findUnique({ where: { id: cid } });
    expect(row?.model).toBe('flash'); // 持久化未变
  });

  // ── ④ send 按会话 model 路由: 设 pro 后发送 → provider 收 pro ────────────────
  it('④ send 按会话 model 路由: 设 pro 后发送 → provider 收 pro', async () => {
    const me = await activeToken();
    const cid = await seedConversation(me.id, 'flash');
    provider.setFake(['答']);

    expect((await setModel(me.token, cid.toString(), { model: 'pro' })).statusCode).toBe(200);
    const res = await send(me.token, cid.toString(), { content: '深度分析' });
    expect(res.statusCode).toBe(200);
    expect(provider.lastModel).toBe('pro');
  });

  // ── ④b legacy model 会话发送 → 归一化默认 flash 路由 ─────────────────────────
  it('④b legacy model (deepseek-chat) 会话发送 → provider 收归一化 flash', async () => {
    const me = await activeToken();
    const cid = await seedConversation(me.id, 'deepseek-chat');
    provider.setFake(['答']);
    await send(me.token, cid.toString(), { content: '问题' });
    expect(provider.lastModel).toBe('flash');
  });

  // ── ④c send 按会话 model 路由: 设 minimax 后发送 → provider 收 minimax + 落库 ──
  it('④c 设 minimax 后发送 → provider 收 minimax + 持久化 minimax', async () => {
    const me = await activeToken();
    const cid = await seedConversation(me.id, 'flash');
    provider.setFake(['答']);

    expect((await setModel(me.token, cid.toString(), { model: 'minimax' })).statusCode).toBe(200);
    const res = await send(me.token, cid.toString(), { content: '长文分析' });
    expect(res.statusCode).toBe(200);
    expect(provider.lastModel).toBe('minimax');

    const row = await prisma.conversation.findUnique({ where: { id: cid } });
    expect(row?.model).toBe('minimax');
  });

  // ── ⑤ 设 model 越权 → 404 (与 messages 404 字节级一致, 反枚举) ───────────────
  it('⑤ 设他人会话 model → 404, 与 messages 404 字节级一致; 他人会话未被改', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const theirs = await seedConversation(other.id, 'flash');

    const setRes = await setModel(me.token, theirs.toString(), { model: 'pro' });
    const msgsRes = await getMessages(me.token, theirs.toString());
    expect(setRes.statusCode).toBe(404);
    expect(msgsRes.statusCode).toBe(404);
    expect(strip(setRes.body)).toEqual(strip(msgsRes.body));

    const row = await prisma.conversation.findUnique({ where: { id: theirs } });
    expect(row?.model).toBe('flash'); // 未被波及
  });

  // ── ⑥ 非法 / 不可用 model → 400 ────────────────────────────────────────────
  it('⑥ 非法 model (legacy deepseek-chat + 未知 gpt-4) → 400; 会话 model 未变', async () => {
    const me = await activeToken();
    const cid = await seedConversation(me.id, 'flash');

    expect((await setModel(me.token, cid.toString(), { model: 'deepseek-chat' })).statusCode).toBe(
      400,
    );
    expect((await setModel(me.token, cid.toString(), { model: 'gpt-4' })).statusCode).toBe(400);

    const row = await prisma.conversation.findUnique({ where: { id: cid } });
    expect(row?.model).toBe('flash'); // 两次 400 均未落库
  });

  // ── ⑦ 未认证 → 401 (models 读 + set-model 写) ──────────────────────────────
  it('⑦ 未认证 → 401 (GET models + PATCH model 均拒)', async () => {
    const noAuthModels = await app.inject({ method: 'GET', url: '/api/v1/chat/models' });
    expect(noAuthModels.statusCode).toBe(401);

    const noAuthSet = await app.inject({
      method: 'PATCH',
      url: '/api/v1/chat/conversations/1/model',
      headers: { 'content-type': 'application/json' },
      payload: { model: 'pro' },
    });
    expect(noAuthSet.statusCode).toBe(401);
  });
});
