import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { narrowTestModule } from '../_support/narrow-boot';
import { ChatModule } from '../../src/chat/chat.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';

// 027 T006 全 boot IT (真 DI 容器 + Testcontainers PG/Redis + Fastify, per plan
// Architecture Notes「NO LIFECYCLE MOCKING」: JwtAuthGuard / AccountIdThrottlerGuard
// 等绝不 jest.mock / new XxxGuard())。覆盖 T006 5 条:
//  ① 建会话 → 201 回显 {id, title, model=flash (029 D7)} + 落库归属 accountId /
//  ② 取空会话 → [] / ③ 取本人消息 → 按插入序 (id asc) /
//  ④ 他人 / 不存在 conversationId → 404 字节级一致 (反枚举) /
//  ⑤ 未认证 → 401 (vs 非 ACTIVE 字节级一致)。
// (流式发消息 / state_branches 全 8 条归 T007/T008; FakeProvider 注入亦归 T007。)
describe('027 chat conversation CRUD (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'chat-t006-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'chat-t006-hmac-secret-min-32-bytes-zyxwv';

    const moduleRef: TestingModule = await Test.createTestingModule({
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
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    await redis.flushall(); // 隔离限流桶
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613915${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }

  interface ConversationView {
    id: string;
    title: string;
    model: string;
  }
  interface MessageView {
    id: string;
    role: string;
    content: string;
    status: string;
    createdAt: string;
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const authJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });

  const createConversation = (token: string, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/chat/conversations',
      headers: authJson(token),
      payload,
    });
  const listMessages = (token: string, id: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${id}/messages`,
      headers: auth(token),
    });

  const conversationOf = (res: { json: () => unknown }) => res.json() as ConversationView;
  const messagesOf = (res: { json: () => unknown }) =>
    (res.json() as { messages: MessageView[] }).messages;

  /** ProblemDetail 字节级一致比较 (剥动态 traceId/instance)。 */
  const strip = (raw: string) => {
    const { traceId, instance, ...rest } = JSON.parse(raw) as Record<string, unknown>;
    void traceId;
    void instance;
    return rest;
  };

  // ── ① 建会话 → 201 回显 + 落库归属 ───────────────────────────────────────
  it('① 建空会话 → 201 回显 {id, title, model=flash}; 落库归属 accountId', async () => {
    const { id, token } = await activeToken();
    const res = await createConversation(token);
    expect(res.statusCode).toBe(201);
    const conv = conversationOf(res);
    // 029 D7: 新建会话默认逻辑 model flash (027 旧默认 deepseek-chat 已迁; send-message 按此路由)。
    expect(conv.model).toBe('flash');
    expect(conv.title).toBe('新对话'); // 无 title → 兜底
    expect(conv.id).toMatch(/^\d+$/); // BigInt id → 数字串

    // 落库: 归属本账号
    const row = await prisma.conversation.findUnique({ where: { id: BigInt(conv.id) } });
    expect(row?.accountId).toBe(id);
    expect(row?.model).toBe('flash');
  });

  it('① 建会话带 title → 回显并落库 trim 后标题', async () => {
    const { token } = await activeToken();
    const conv = conversationOf(await createConversation(token, { title: '  分析贵州茅台  ' }));
    expect(conv.title).toBe('分析贵州茅台');
  });

  // ── ② 取空会话 → [] ──────────────────────────────────────────────────────
  it('② 取本人空会话 → 200 空数组', async () => {
    const { token } = await activeToken();
    const conv = conversationOf(await createConversation(token));
    const res = await listMessages(token, conv.id);
    expect(res.statusCode).toBe(200);
    expect(messagesOf(res)).toEqual([]);
  });

  // ── ③ 取本人消息 → 按插入序 (id asc) ─────────────────────────────────────
  it('③ 取本人消息 → 按插入序 (id asc), role/status/content 投影', async () => {
    const { token } = await activeToken();
    const conv = conversationOf(await createConversation(token));
    const cid = BigInt(conv.id);
    // 直插两条消息 (T006 无发消息端点, 用 prisma 种子验读侧按序)。
    await prisma.message.create({
      data: { conversationId: cid, role: 'user', content: '你好', status: 'completed' },
    });
    await prisma.message.create({
      data: {
        conversationId: cid,
        role: 'assistant',
        content: '你好,有什么可以帮你',
        status: 'completed',
      },
    });

    const msgs = messagesOf(await listMessages(token, conv.id));
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']); // id asc 即插入序
    expect(msgs[0]).toMatchObject({ role: 'user', content: '你好', status: 'completed' });
    expect(msgs[1]!.content).toBe('你好,有什么可以帮你');
    expect(msgs[0]!.id).toMatch(/^\d+$/);
    expect(typeof msgs[0]!.createdAt).toBe('string');
  });

  // ── ④ 他人 / 不存在 conversationId → 404 字节级一致 (反枚举) ───────────────
  it('④ 他人会话 vs 不存在 id vs 非数字 id → 均 404 字节级一致', async () => {
    const { token } = await activeToken();
    const other = await activeToken();
    const theirs = conversationOf(await createConversation(other.token));

    const cross = await listMessages(token, theirs.id);
    const unknown = await listMessages(token, '888888888888');
    const nonNumeric = await listMessages(token, 'abc');

    expect(cross.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(nonNumeric.statusCode).toBe(404);
    expect(strip(cross.body)).toEqual(strip(unknown.body));
    expect(strip(cross.body)).toEqual(strip(nonNumeric.body));

    // 他人会话未被波及 (本人取不到 ≠ 删除)
    expect(messagesOf(await listMessages(other.token, theirs.id))).toEqual([]);
  });

  // ── ⑤ 未认证 → 401 (vs 非 ACTIVE 字节级一致) ─────────────────────────────
  it('⑤ 未认证 vs 非 ACTIVE → 均 401 字节级一致 (反枚举)', async () => {
    const frozen = await prisma.account.create({ data: { phone: nextPhone(), status: 'FROZEN' } });
    const frozenToken = jwt.signAccessToken({ accountId: frozen.id });

    const noAuth = await app.inject({ method: 'POST', url: '/api/v1/chat/conversations' });
    const nonActive = await createConversation(frozenToken);
    expect(noAuth.statusCode).toBe(401);
    expect(nonActive.statusCode).toBe(401);
    const stripTrace = (raw: string) => {
      const { traceId, ...rest } = JSON.parse(raw) as Record<string, unknown>;
      void traceId;
      return rest;
    };
    expect(stripTrace(noAuth.body)).toEqual(stripTrace(nonActive.body));
  });
});
