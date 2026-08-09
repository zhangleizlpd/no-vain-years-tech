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

/**
 * 034 T004 全 boot IT (真 DI 容器 + Testcontainers PG/Redis + Fastify, per plan
 * 「NO LIFECYCLE MOCKING」)。覆盖 PATCH /ideation/sessions/{id}/repo (选/切接地目标仓):
 *  ① 选仓写入 idea_session.repo 落库 / ② 切仓覆盖 (后续轮换命名空间) /
 *  ③ 切仓只影响 session.repo, 既有 turn 不回改 (FR-006) /
 *  ④ 越权 / 不存在 / 非 open → 404 字节级一致 (反枚举) /
 *  ⑤ 空白 repo → 400 / ⑥ 未认证 → 401。
 */
describe('034 ideation set-session-repo (Testcontainers PG + Redis + Fastify)', () => {
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
    process.env.AUTH_JWT_SECRET = 'ideation-t004-jwt-secret-min-32-bytes-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'ideation-t004-hmac-secret-min-32-bytes-zy';

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
  const nextPhone = () => `+8613917${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const setRepo = (token: string, id: string, repo: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/ideation/sessions/${id}/repo`,
      headers: auth(token),
      payload: { repo },
    });

  async function seedSession(
    accountId: bigint,
    opts: { status?: string; repo?: string | null; turns?: number } = {},
  ): Promise<bigint> {
    const s = await prisma.ideaSession.create({
      data: {
        accountId,
        title: '种子会话',
        status: opts.status ?? 'open',
        repo: opts.repo ?? null,
      },
      select: { id: true },
    });
    for (let i = 0; i < (opts.turns ?? 0); i++) {
      await prisma.ideaTurn.create({
        data: {
          sessionId: s.id,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `轮次 ${i}`,
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

  // ── ① 选仓写入 ──────────────────────────────────────────────────────────────
  it('① PATCH repo → 200, 写入 idea_session.repo 落库', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id);
    const res = await setRepo(me.token, sid.toString(), 'no-vain-years-mono');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { repo: string; status: string };
    expect(body.repo).toBe('no-vain-years-mono');
    expect(body.status).toBe('open');
    const row = await prisma.ideaSession.findUnique({ where: { id: sid } });
    expect(row?.repo).toBe('no-vain-years-mono');
  });

  // ── ② 切仓覆盖 ──────────────────────────────────────────────────────────────
  it('② 已选 repoA 切到 repoB → session.repo 覆盖为 repoB', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id, { repo: 'repoA' });
    const res = await setRepo(me.token, sid.toString(), 'repoB');
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { repo: string }).repo).toBe('repoB');
    expect((await prisma.ideaSession.findUnique({ where: { id: sid } }))?.repo).toBe('repoB');
  });

  // ── ③ 切仓不回改既有 turn (FR-006) ──────────────────────────────────────────
  it('③ 切仓只改 session.repo, 既有 turn 不回改 (FR-006)', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id, { repo: 'repoA', turns: 3 });
    const before = await prisma.ideaTurn.findMany({
      where: { sessionId: sid },
      orderBy: { id: 'asc' },
      select: { id: true, content: true },
    });
    await setRepo(me.token, sid.toString(), 'repoB');
    const after = await prisma.ideaTurn.findMany({
      where: { sessionId: sid },
      orderBy: { id: 'asc' },
      select: { id: true, content: true },
    });
    expect(after).toEqual(before); // 既有轮无任何变更
  });

  // ── ④ 越权 / 不存在 / 非 open → 404 字节级一致 (反枚举) ───────────────────────
  it('④ 越权 / 不存在 / 非数字 / 非 open → 404 字节级一致 (反枚举)', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const theirs = await seedSession(other.id);
    const convergedMine = await seedSession(me.id, { status: 'converged' });

    const otherRes = await setRepo(me.token, theirs.toString(), 'r');
    const unknownRes = await setRepo(me.token, '888888888888', 'r');
    const nonNumericRes = await setRepo(me.token, 'abc', 'r');
    const nonOpenRes = await setRepo(me.token, convergedMine.toString(), 'r');

    expect(otherRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(nonNumericRes.statusCode).toBe(404);
    expect(nonOpenRes.statusCode).toBe(404);
    // 字节级一致: 越权 vs 不存在 vs 非数字 vs 非 open 同构 (反枚举)
    expect(strip(otherRes.body)).toEqual(strip(unknownRes.body));
    expect(strip(nonNumericRes.body)).toEqual(strip(unknownRes.body));
    expect(strip(nonOpenRes.body)).toEqual(strip(unknownRes.body));

    // 他人会话 + 非 open 会话 repo 未被波及
    expect((await prisma.ideaSession.findUnique({ where: { id: theirs } }))?.repo).toBeNull();
    expect(
      (await prisma.ideaSession.findUnique({ where: { id: convergedMine } }))?.repo,
    ).toBeNull();
  });

  // ── ⑤ 空白 repo → 400 ───────────────────────────────────────────────────────
  it('⑤ 空白 repo → 400 (own-resource 输入校验)', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id);
    const res = await setRepo(me.token, sid.toString(), '   ');
    expect(res.statusCode).toBe(400);
    expect((await prisma.ideaSession.findUnique({ where: { id: sid } }))?.repo).toBeNull();
  });

  // ── ⑥ 未认证 → 401 ─────────────────────────────────────────────────────────
  it('⑥ 未认证 → 401', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/ideation/sessions/1/repo',
      payload: { repo: 'r' },
    });
    expect(res.statusCode).toBe(401);
  });
});
