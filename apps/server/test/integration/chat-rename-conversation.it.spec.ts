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

// 028 T002 全 boot IT (真 DI 容器 + Testcontainers PG/Redis + Fastify, per plan
// 「NO LIFECYCLE MOCKING」)。覆盖 PATCH /chat/conversations/{id}:
//  ① 改名回显 {id, title, updatedAt} + 落库 / ② 空 title → 400 / ③ 纯空白 → 400 /
//  ④ 他人 id → 404 (与 messages 404 字节级一致) / ⑤ 不存在 → 404 / ⑥ 未认证 → 401。
describe('028 rename conversation (Testcontainers PG + Redis + Fastify)', () => {
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
    process.env.AUTH_JWT_SECRET = 'chat-t002-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'chat-t002-hmac-secret-min-32-bytes-zyxwv';

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
  const nextPhone = () => `+8613917${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const authJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });

  async function seedConversation(accountId: bigint, title = '初始标题'): Promise<bigint> {
    const row = await prisma.conversation.create({
      data: { accountId, title, model: 'deepseek-chat' },
      select: { id: true },
    });
    return row.id;
  }

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

  interface RenamedView {
    id: string;
    title: string;
    updatedAt: string;
  }

  // ── ① 改名回显 + 落库 ──────────────────────────────────────────────────────
  it('① 改名 → 200 回显 {id, title, updatedAt}; 落库 trim 后标题', async () => {
    const me = await activeToken();
    const cid = await seedConversation(me.id);
    const res = await rename(me.token, cid.toString(), { title: '  分析贵州茅台  ' });
    expect(res.statusCode).toBe(200);
    const view = res.json() as RenamedView;
    expect(view.id).toBe(cid.toString());
    expect(view.title).toBe('分析贵州茅台'); // trim 后
    expect(typeof view.updatedAt).toBe('string');

    const row = await prisma.conversation.findUnique({ where: { id: cid } });
    expect(row?.title).toBe('分析贵州茅台');
  });

  // ── ② 空 title → 400 ───────────────────────────────────────────────────────
  it('② 空 title → 400', async () => {
    const me = await activeToken();
    const cid = await seedConversation(me.id);
    const res = await rename(me.token, cid.toString(), { title: '' });
    expect(res.statusCode).toBe(400);
  });

  // ── ③ 纯空白 title → 400 (DTO @IsString 过, UC trim 后判空) ─────────────────
  it('③ 纯空白 title → 400', async () => {
    const me = await activeToken();
    const cid = await seedConversation(me.id);
    const res = await rename(me.token, cid.toString(), { title: '    ' });
    expect(res.statusCode).toBe(400);
    // 未被改 (空白拒后标题不变)
    const row = await prisma.conversation.findUnique({ where: { id: cid } });
    expect(row?.title).toBe('初始标题');
  });

  // ── ④ 他人 id → 404 (与 messages 404 字节级一致) ──────────────────────────
  it('④ 他人会话 → 404, 与 messages 端点 404 字节级一致; 他人会话未被改', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const theirs = await seedConversation(other.id, '别人的标题');

    const renameRes = await rename(me.token, theirs.toString(), { title: '试图改名' });
    expect(renameRes.statusCode).toBe(404);

    // 与 messages 端点对同一 (他人) id 的 404 字节级一致 (反枚举一致体)
    const msgsRes = await listMessages(me.token, theirs.toString());
    expect(msgsRes.statusCode).toBe(404);
    expect(strip(renameRes.body)).toEqual(strip(msgsRes.body));

    // 他人会话未被波及
    const row = await prisma.conversation.findUnique({ where: { id: theirs } });
    expect(row?.title).toBe('别人的标题');
  });

  // ── ⑤ 不存在 id → 404 (与他人 id 404 字节级一致) ──────────────────────────
  it('⑤ 不存在 id vs 非数字 id → 404, 与他人 id 404 字节级一致', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const theirs = await seedConversation(other.id);

    const cross = await rename(me.token, theirs.toString(), { title: 'x' });
    const unknown = await rename(me.token, '888888888888', { title: 'x' });
    const nonNumeric = await rename(me.token, 'abc', { title: 'x' });

    expect(cross.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(nonNumeric.statusCode).toBe(404);
    expect(strip(cross.body)).toEqual(strip(unknown.body));
    expect(strip(cross.body)).toEqual(strip(nonNumeric.body));
  });

  // ── ⑥ 未认证 → 401 ─────────────────────────────────────────────────────────
  it('⑥ 未认证 → 401', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/chat/conversations/1',
      headers: { 'content-type': 'application/json' },
      payload: { title: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });
});
