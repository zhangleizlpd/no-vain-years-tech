import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { IdeationModule } from '../../src/ideation/ideation.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { LLM_PROVIDER } from '../../src/integrations/llm/llm.module';

/**
 * 032 T007 全 boot IT (真 DI 容器 + Testcontainers PG/Redis + Fastify, per plan
 * 「NO LIFECYCLE MOCKING」)。覆盖 ideation 会话 CRUD + 生命周期:
 *  ① 建 open 会话 (repo=null) / ② 列表仅本人 (updatedAt desc) / ③ 查含 turns+brief, scope /
 *  ④ 删连带 turn+brief (防孤儿) / ⑤ 重开 converged/handed-off → open (回流) + 已 open 幂等 /
 *  ⑥ 越权读/写/删 → 404 字节级一致 (反枚举) / ⑦ 未认证 → 401 / ⑧ 空白标题 → 400 /
 *  ⑨ module 装配: LLM_PROVIDER 真 DI 可解析 (供 T008/T009)。
 */
describe('032 ideation session CRUD + lifecycle (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'ideation-t007-jwt-secret-min-32-bytes-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'ideation-t007-hmac-secret-min-32-bytes-zy';

    moduleRef = await Test.createTestingModule({
      imports: narrowTestModule([IdeationModule]),
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

  const create = (token: string, title: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/ideation/sessions',
      headers: auth(token),
      payload: { title },
    });
  const listAll = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/ideation/sessions', headers: auth(token) });
  const getOne = (token: string, id: string) =>
    app.inject({ method: 'GET', url: `/api/v1/ideation/sessions/${id}`, headers: auth(token) });
  const del = (token: string, id: string) =>
    app.inject({ method: 'DELETE', url: `/api/v1/ideation/sessions/${id}`, headers: auth(token) });
  const reopen = (token: string, id: string) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/ideation/sessions/${id}/reopen`,
      headers: auth(token),
    });

  /** 直接种一条会话 (可指定 status + 子行) 验生命周期/连带删。 */
  async function seedSession(
    accountId: bigint,
    opts: { title?: string; status?: string; turns?: number; brief?: boolean } = {},
  ): Promise<bigint> {
    const s = await prisma.ideaSession.create({
      data: { accountId, title: opts.title ?? '种子会话', status: opts.status ?? 'open' },
      select: { id: true },
    });
    for (let i = 0; i < (opts.turns ?? 0); i++) {
      await prisma.ideaTurn.create({
        data: {
          sessionId: s.id,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `轮次 ${i}`,
          suggestion:
            i % 2 === 1 ? { question: 'Q', options: [], allow_freetext: true } : undefined,
        },
      });
    }
    if (opts.brief) {
      await prisma.requirementsDraft.create({
        data: {
          sessionId: s.id,
          briefJson: {
            problem: 'p',
            user_stories: 'u',
            functional_requirements: 'f',
            success_criteria: 's',
            non_goals: 'n',
          },
        },
      });
    }
    return s.id;
  }

  /** ProblemDetail 字节级一致比较 (剥动态 traceId/instance)。 */
  const strip = (raw: string) => {
    const { traceId, instance, ...rest } = JSON.parse(raw) as Record<string, unknown>;
    void traceId;
    void instance;
    return rest;
  };

  // ── ⑨ module 装配: LLM_PROVIDER 真 DI 可解析 ────────────────────────────────
  it('⑨ IdeationModule 装配: LLM_PROVIDER 经真 DI 可解析 (供 T008/T009)', () => {
    const provider = moduleRef.get(LLM_PROVIDER);
    expect(provider).toBeDefined();
    expect(typeof provider.stream).toBe('function');
  });

  // ── ① 建 open 会话 (repo=null) ──────────────────────────────────────────────
  it('① POST 建 open 会话 → 201, status=open, repo=null, 落库', async () => {
    const me = await activeToken();
    const res = await create(me.token, '给行情页加收藏');
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.status).toBe('open');
    expect(body.repo).toBeNull();
    expect(body.title).toBe('给行情页加收藏');
    const row = await prisma.ideaSession.findUnique({ where: { id: BigInt(body.id as string) } });
    expect(row?.accountId).toBe(me.id);
    expect(row?.repo).toBeNull();
  });

  // ── ⑧ 空白标题 → 400 ───────────────────────────────────────────────────────
  it('⑧ 空白标题 → 400 (own-resource 输入校验)', async () => {
    const me = await activeToken();
    const res = await create(me.token, '   ');
    expect(res.statusCode).toBe(400);
  });

  // ── ② 列表仅本人 (updatedAt desc) ──────────────────────────────────────────
  it('② GET 列表只返本人会话, 按 updatedAt desc', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const a = await seedSession(me.id, { title: 'A' });
    await new Promise((r) => setTimeout(r, 10));
    const b = await seedSession(me.id, { title: 'B' });
    await seedSession(other.id, { title: '他人' });

    const res = await listAll(me.token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { items: Array<{ id: string; title: string }> };
    const ids = body.items.map((i) => i.id);
    expect(ids).toEqual([b.toString(), a.toString()]); // updatedAt desc (b 后建)
    expect(body.items.every((i) => i.title !== '他人')).toBe(true);
  });

  // ── ③ 查含 turns + brief, scope ─────────────────────────────────────────────
  it('③ GET 详情含 turns (插入序) + brief (1:1); 无 brief → null', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id, { turns: 3, brief: true });
    const res = await getOne(me.token, sid.toString());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      turns: Array<{ content: string; role: string; suggestion: unknown }>;
      brief: { briefJson: Record<string, unknown> } | null;
    };
    expect(body.turns.map((t) => t.content)).toEqual(['轮次 0', '轮次 1', '轮次 2']);
    expect(body.turns[1].suggestion).not.toBeNull(); // assistant 轮携 chips
    expect(body.brief).not.toBeNull();
    expect(body.brief?.briefJson.problem).toBe('p');

    // 无 brief 的会话 → brief null
    const sid2 = await seedSession(me.id, { turns: 1 });
    const res2 = await getOne(me.token, sid2.toString());
    expect((JSON.parse(res2.body) as { brief: unknown }).brief).toBeNull();
  });

  // ── ④ 删连带 turn + brief (防孤儿) ──────────────────────────────────────────
  it('④ DELETE → 204; session + turn + brief 全删 (单事务连带, 防孤儿)', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id, { turns: 4, brief: true });
    expect(await prisma.ideaTurn.count({ where: { sessionId: sid } })).toBe(4);

    const res = await del(me.token, sid.toString());
    expect(res.statusCode).toBe(204);
    expect(await prisma.ideaSession.findUnique({ where: { id: sid } })).toBeNull();
    expect(await prisma.ideaTurn.count({ where: { sessionId: sid } })).toBe(0);
    expect(await prisma.requirementsDraft.findUnique({ where: { sessionId: sid } })).toBeNull();
  });

  // ── ⑤ 重开回流 + 幂等 ───────────────────────────────────────────────────────
  it('⑤ PATCH reopen: converged → open / handed-off → open / 已 open 幂等', async () => {
    const me = await activeToken();
    const converged = await seedSession(me.id, { status: 'converged' });
    const handedOff = await seedSession(me.id, { status: 'handed-off' });
    const alreadyOpen = await seedSession(me.id, { status: 'open' });

    const r1 = await reopen(me.token, converged.toString());
    expect(r1.statusCode).toBe(200);
    expect((JSON.parse(r1.body) as { status: string }).status).toBe('open');
    expect((await prisma.ideaSession.findUnique({ where: { id: converged } }))?.status).toBe(
      'open',
    );

    const r2 = await reopen(me.token, handedOff.toString());
    expect((JSON.parse(r2.body) as { status: string }).status).toBe('open');

    // 已 open → 幂等 200, 仍 open (无副作用)
    const r3 = await reopen(me.token, alreadyOpen.toString());
    expect(r3.statusCode).toBe(200);
    expect((JSON.parse(r3.body) as { status: string }).status).toBe('open');
  });

  // ── ⑥ 越权读/写/删 → 404 字节级一致 (反枚举) ────────────────────────────────
  it('⑥ 越权 get/delete/reopen 他人会话 → 404, 三端点 + 不存在 + 非数字 字节级一致', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const theirs = await seedSession(other.id, { status: 'converged', turns: 2, brief: true });

    const getRes = await getOne(me.token, theirs.toString());
    const delRes = await del(me.token, theirs.toString());
    const reopenRes = await reopen(me.token, theirs.toString());
    const unknownRes = await getOne(me.token, '888888888888');
    const nonNumericRes = await getOne(me.token, 'abc');

    expect(getRes.statusCode).toBe(404);
    expect(delRes.statusCode).toBe(404);
    expect(reopenRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(nonNumericRes.statusCode).toBe(404);
    // 字节级一致 (反枚举): 越权 vs 不存在 vs 非数字 vs 三动词 同构
    expect(strip(getRes.body)).toEqual(strip(unknownRes.body));
    expect(strip(delRes.body)).toEqual(strip(unknownRes.body));
    expect(strip(reopenRes.body)).toEqual(strip(unknownRes.body));
    expect(strip(nonNumericRes.body)).toEqual(strip(unknownRes.body));

    // 他人会话 + 子行未被波及
    expect(await prisma.ideaSession.findUnique({ where: { id: theirs } })).not.toBeNull();
    expect(await prisma.ideaTurn.count({ where: { sessionId: theirs } })).toBe(2);
    expect((await prisma.ideaSession.findUnique({ where: { id: theirs } }))?.status).toBe(
      'converged',
    ); // reopen 未改他人状态
  });

  // ── ⑦ 未认证 → 401 ─────────────────────────────────────────────────────────
  it('⑦ 未认证 → 401 (各端点)', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/ideation/sessions',
      payload: { title: 'x' },
    });
    const get = await app.inject({ method: 'GET', url: '/api/v1/ideation/sessions' });
    const detail = await app.inject({ method: 'GET', url: '/api/v1/ideation/sessions/1' });
    expect(post.statusCode).toBe(401);
    expect(get.statusCode).toBe(401);
    expect(detail.statusCode).toBe(401);
  });
});
