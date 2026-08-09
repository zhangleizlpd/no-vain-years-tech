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

// 028 T003 全 boot IT (真 DI 容器 + Testcontainers PG/Redis + Fastify, per plan
// 「NO LIFECYCLE MOCKING」)。覆盖 DELETE /chat/conversations/{id}:
//  ① 删后 conversation 不存在 + message 表无残留 (单事务连带, 防孤儿, plan D3) /
//  ② 删完该 id get-messages → 404 / ③ 他人 id → 404 (与 messages 字节级一致, 他人会话未删) /
//  ④ 不存在 / 非数字 id → 404 / ⑤ 未认证 → 401。
describe('028 delete conversation (Testcontainers PG + Redis + Fastify)', () => {
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
    process.env.AUTH_JWT_SECRET = 'chat-t003-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'chat-t003-hmac-secret-min-32-bytes-zyxwv';

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

  /** 种一条会话 + N 条消息 (验连带删)。 */
  async function seedConversationWithMessages(accountId: bigint, msgCount = 3): Promise<bigint> {
    const conv = await prisma.conversation.create({
      data: { accountId, title: '待删会话', model: 'deepseek-chat' },
      select: { id: true },
    });
    for (let i = 0; i < msgCount; i++) {
      await prisma.message.create({
        data: {
          conversationId: conv.id,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `消息 ${i}`,
          status: 'completed',
        },
      });
    }
    return conv.id;
  }

  const del = (token: string, id: string) =>
    app.inject({ method: 'DELETE', url: `/api/v1/chat/conversations/${id}`, headers: auth(token) });
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

  // ── ① 删后 conversation 不存在 + message 无残留 (防孤儿) ────────────────────
  it('① 删除 → 204; conversation 不存在 + message 表无残留行 (单事务连带)', async () => {
    const me = await activeToken();
    const cid = await seedConversationWithMessages(me.id, 3);
    // 删前确有 3 条消息
    expect(await prisma.message.count({ where: { conversationId: cid } })).toBe(3);

    const res = await del(me.token, cid.toString());
    expect(res.statusCode).toBe(204);

    // conversation 物理删
    expect(await prisma.conversation.findUnique({ where: { id: cid } })).toBeNull();
    // message 无残留 (防孤儿, plan D3)
    expect(await prisma.message.count({ where: { conversationId: cid } })).toBe(0);
  });

  // ── ② 删完该 id get-messages → 404 ─────────────────────────────────────────
  it('② 删除后 get-messages 该 id → 404', async () => {
    const me = await activeToken();
    const cid = await seedConversationWithMessages(me.id, 2);
    await del(me.token, cid.toString());
    const res = await listMessages(me.token, cid.toString());
    expect(res.statusCode).toBe(404);
  });

  // ── ③ 他人 id → 404 (与 messages 字节级一致; 他人会话未删) ─────────────────
  it('③ 他人会话 → 404, 与 messages 端点 404 字节级一致; 他人会话+消息未被删', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const theirs = await seedConversationWithMessages(other.id, 2);

    const delRes = await del(me.token, theirs.toString());
    expect(delRes.statusCode).toBe(404);
    const msgsRes = await listMessages(me.token, theirs.toString());
    expect(msgsRes.statusCode).toBe(404);
    expect(strip(delRes.body)).toEqual(strip(msgsRes.body));

    // 他人会话 + 消息未被波及
    expect(await prisma.conversation.findUnique({ where: { id: theirs } })).not.toBeNull();
    expect(await prisma.message.count({ where: { conversationId: theirs } })).toBe(2);
  });

  // ── ④ 不存在 / 非数字 id → 404 (与他人 id 字节级一致) ──────────────────────
  it('④ 不存在 id vs 非数字 id → 404, 与他人 id 404 字节级一致', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const theirs = await seedConversationWithMessages(other.id, 1);

    const cross = await del(me.token, theirs.toString());
    const unknown = await del(me.token, '888888888888');
    const nonNumeric = await del(me.token, 'abc');

    expect(cross.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(nonNumeric.statusCode).toBe(404);
    expect(strip(cross.body)).toEqual(strip(unknown.body));
    expect(strip(cross.body)).toEqual(strip(nonNumeric.body));
  });

  // ── ⑤ 未认证 → 401 ─────────────────────────────────────────────────────────
  it('⑤ 未认证 → 401', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/chat/conversations/1' });
    expect(res.statusCode).toBe(401);
  });
});
