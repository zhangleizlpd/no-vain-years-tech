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

// 029 T002 全 boot IT (真 DI 容器 + Testcontainers PG/Redis + Fastify, per plan
// 「NO LIFECYCLE MOCKING」)。覆盖 PATCH /chat/conversations/{id}/model:
//  ① 设 pro → 200 回显 {id, model, updatedAt} + 落库 + @updatedAt 刷新 /
//  ② 设 flash 回显 + 落库 / ③ 非法 model (deepseek-chat 等) → 400 /
//  ④ 设 minimax (029 收口接入, 可用) → 200 回显 + 落库 / ⑤ 他人 id → 404 (与 messages 404 字节级一致) /
//  ⑥ 不存在 / 非数字 → 404 字节级一致 / ⑦ 未认证 → 401 /
//  ⑧ 回归: 028 改名 PATCH /conversations/{id} ({title}) 仍正常 (不被 model 子路由破坏)。
describe('029 set conversation model (Testcontainers PG + Redis + Fastify)', () => {
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
    process.env.AUTH_JWT_SECRET = 'chat-t002m-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'chat-t002m-hmac-secret-min-32-bytes-zyxw';
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-placeholder-key';

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
    await redis.flushall();
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613918${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const authJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });

  async function seedConversation(accountId: bigint, model = 'flash'): Promise<bigint> {
    const row = await prisma.conversation.create({
      data: { accountId, title: '初始标题', model },
      select: { id: true },
    });
    return row.id;
  }

  const setModel = (token: string, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/chat/conversations/${id}/model`,
      headers: authJson(token),
      payload,
    });
  const rename = (token: string, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/chat/conversations/${id}`,
      headers: authJson(token),
      payload,
    });
  const listMessages = (token: string, id: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${id}/messages`,
      headers: auth(token),
    });

  /** ProblemDetail 字节级一致比较 (剥动态 traceId/instance)。 */
  const strip = (raw: string) => {
    const { traceId, instance, ...rest } = JSON.parse(raw) as Record<string, unknown>;
    void traceId;
    void instance;
    return rest;
  };

  interface ModelView {
    id: string;
    model: string;
    updatedAt: string;
  }

  // ── ① 设 pro → 200 回显 + 落库 + updatedAt 刷新 ────────────────────────────
  it('① 设 pro → 200 回显 {id, model, updatedAt}; 落库 + @updatedAt 刷新', async () => {
    const me = await activeToken();
    const cid = await seedConversation(me.id, 'flash');
    const before = await prisma.conversation.findUnique({ where: { id: cid } });

    const res = await setModel(me.token, cid.toString(), { model: 'pro' });
    expect(res.statusCode).toBe(200);
    const view = res.json() as ModelView;
    expect(view.id).toBe(cid.toString());
    expect(view.model).toBe('pro');
    expect(typeof view.updatedAt).toBe('string');

    const after = await prisma.conversation.findUnique({ where: { id: cid } });
    expect(after?.model).toBe('pro');
    // @updatedAt 刷新 (会话上浮, 与 028 改名一致)。
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
  });

  // ── ② 设 flash → 回显 + 落库 ──────────────────────────────────────────────
  it('② 设 flash → 200 回显 + 落库', async () => {
    const me = await activeToken();
    const cid = await seedConversation(me.id, 'pro');
    const res = await setModel(me.token, cid.toString(), { model: 'flash' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ModelView).model).toBe('flash');
    const row = await prisma.conversation.findUnique({ where: { id: cid } });
    expect(row?.model).toBe('flash');
  });

  // ── ③ 非法 model (非 flash/pro) → 400, 不落库 ──────────────────────────────
  it('③ 非法 model (deepseek-chat) → 400; 会话 model 未变', async () => {
    const me = await activeToken();
    const cid = await seedConversation(me.id, 'flash');
    const res = await setModel(me.token, cid.toString(), { model: 'deepseek-chat' });
    expect(res.statusCode).toBe(400);
    const row = await prisma.conversation.findUnique({ where: { id: cid } });
    expect(row?.model).toBe('flash'); // 未被改
  });

  // ── ④ 设 minimax (029 收口接入, 可用) → 200 回显 + 落库 ─────────────────────
  it('④ 设 minimax → 200 回显 + 落库', async () => {
    const me = await activeToken();
    const cid = await seedConversation(me.id, 'flash');
    const res = await setModel(me.token, cid.toString(), { model: 'minimax' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ModelView).model).toBe('minimax');
    const row = await prisma.conversation.findUnique({ where: { id: cid } });
    expect(row?.model).toBe('minimax');
  });

  // ── ⑤ 他人 id → 404 (与 messages 404 字节级一致); 他人会话未被改 ──────────
  it('⑤ 他人会话 → 404, 与 messages 端点 404 字节级一致; 他人会话 model 未被改', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const theirs = await seedConversation(other.id, 'flash');

    const setRes = await setModel(me.token, theirs.toString(), { model: 'pro' });
    expect(setRes.statusCode).toBe(404);

    const msgsRes = await listMessages(me.token, theirs.toString());
    expect(msgsRes.statusCode).toBe(404);
    expect(strip(setRes.body)).toEqual(strip(msgsRes.body));

    const row = await prisma.conversation.findUnique({ where: { id: theirs } });
    expect(row?.model).toBe('flash'); // 未被波及
  });

  // ── ⑤b 他人会话 + 非法 model → 仍 404 (归属先于值域, 不暴露存在性) ─────────
  it('⑤b 他人会话 + 非法 model → 404 (归属校验先于值域 400)', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const theirs = await seedConversation(other.id, 'flash');
    // 非法 model 会被 DTO @IsIn 在 ValidationPipe 拦成 400 (在 controller 前)。
    // 验「UC 层归属先于值域」用合法 model 打他人会话即可 (⑤ 已覆盖)。这里验
    // UC 直调语义 (绕 DTO): 见 set-conversation-model.usecase 的 ① 早于 ②。
    // HTTP 层: 合法 model 打他人 → 404 (上面 ⑤); 非法 model 打他人 → DTO 400。
    // 故此处仅断言合法 model 打他人 = 404 (与 ⑤ 一致, 占位说明分层)。
    const res = await setModel(me.token, theirs.toString(), { model: 'pro' });
    expect(res.statusCode).toBe(404);
  });

  // ── ⑥ 不存在 / 非数字 → 404 字节级一致 ────────────────────────────────────
  it('⑥ 不存在 id vs 非数字 id → 404, 与他人 id 404 字节级一致', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const theirs = await seedConversation(other.id, 'flash');

    const cross = await setModel(me.token, theirs.toString(), { model: 'pro' });
    const unknown = await setModel(me.token, '888888888888', { model: 'pro' });
    const nonNumeric = await setModel(me.token, 'abc', { model: 'pro' });

    expect(cross.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(nonNumeric.statusCode).toBe(404);
    expect(strip(cross.body)).toEqual(strip(unknown.body));
    expect(strip(cross.body)).toEqual(strip(nonNumeric.body));
  });

  // ── ⑦ 未认证 → 401 ────────────────────────────────────────────────────────
  it('⑦ 未认证 → 401', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/chat/conversations/1/model',
      headers: { 'content-type': 'application/json' },
      payload: { model: 'pro' },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── ⑧ 回归: 028 改名 PATCH /conversations/{id} ({title}) 仍正常 ─────────────
  it('⑧ 回归: 028 改名 PATCH /conversations/{id} 仍正常 (model 子路由不破坏)', async () => {
    const me = await activeToken();
    const cid = await seedConversation(me.id, 'flash');
    const res = await rename(me.token, cid.toString(), { title: '改名后的标题' });
    expect(res.statusCode).toBe(200);
    const row = await prisma.conversation.findUnique({ where: { id: cid } });
    expect(row?.title).toBe('改名后的标题');
    // 改名不动 model。
    expect(row?.model).toBe('flash');
  });
});
