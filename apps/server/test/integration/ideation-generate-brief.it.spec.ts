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
import type {
  LlmProvider,
  LlmStreamEvent,
  LlmStreamOptions,
  Msg,
} from '../../src/integrations/llm/llm-provider.port';
import {
  FakeIdeationLlmProvider,
  type FakeIdeationLlmConfig,
} from '../../src/ideation/fake-ideation-llm.provider';

/**
 * 032 T009 生成/重生 brief + 导出 markdown IT (真 DI 容器 + Testcontainers PG/Redis +
 * Fastify, per plan「NO LIFECYCLE MOCKING」: DI override LLM_PROVIDER 注 FakeIdeationLlmProvider
 * 驱动产出相)。
 *
 * 覆盖 T009 (契约 doc §3 产出相 / §3.4 收敛门):
 *  ① T1 齐 (emit tool_call) → 落 brief + session converged /
 *  ② 缺段 → 不落 brief + 回 missing 信号 (converged=false) /
 *  ③ 重生 → upsert 1:1 覆盖单份 (不留历史 v1/v2) /
 *  ④ 导出 → markdown + session handed-off /
 *  ⑤ 接地 stub (T2 全空) 照样收敛 (SC-007) /
 *  ⑥ DS 降级 (纯文本吐 JSON) → 正则兜底捞出照样收敛 /
 *  ⑦ 越权 / 非 open → 404 (反枚举)。
 */

/** 单 DI override, 内核 fake 逐 test 可换; 记录最近一次 stream 的 messages 供 emit persona 断言。 */
class SwappableFake implements LlmProvider {
  private inner: FakeIdeationLlmProvider = new FakeIdeationLlmProvider({ script: [] });
  lastMessages: Msg[] = [];

  setFake(config: FakeIdeationLlmConfig): void {
    this.inner = new FakeIdeationLlmProvider(config);
    this.lastMessages = [];
  }

  stream(messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    this.lastMessages = messages;
    return this.inner.stream(messages, opts);
  }
}

/** T1 五段齐的 brief (T2/T3 全空)。 */
const T1_COMPLETE = {
  problem: '行情页缺收藏入口',
  user_stories: 'P1: 作为用户我想收藏股票...',
  functional_requirements: 'FR-001 提供收藏按钮',
  success_criteria: '收藏成功率 > 99%',
  non_goals: '不做分组管理',
};

describe('032 ideation generate/export brief (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let provider: SwappableFake;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'ideation-t009-jwt-secret-min-32-bytes-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'ideation-t009-hmac-secret-min-32-bytes-zy';

    provider = new SwappableFake();
    moduleRef = await Test.createTestingModule({ imports: narrowTestModule([IdeationModule]) })
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
  const nextPhone = () => `+8613920${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function seedSession(accountId: bigint, status = 'open'): Promise<bigint> {
    const s = await prisma.ideaSession.create({
      data: { accountId, title: '种子会话', status },
      select: { id: true },
    });
    return s.id;
  }

  const genBrief = (token: string, id: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/ideation/sessions/${id}/brief`,
      headers: auth(token),
    });
  const exportBrief = (token: string, id: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/ideation/sessions/${id}/brief/export`,
      headers: auth(token),
    });

  const sessionOf = (id: bigint) =>
    prisma.ideaSession.findUnique({ where: { id }, select: { status: true } });
  const draftsOf = (sessionId: bigint) =>
    prisma.requirementsDraft.findMany({ where: { sessionId }, select: { briefJson: true } });

  const strip = (raw: string) => {
    const { traceId, instance, ...rest } = JSON.parse(raw) as Record<string, unknown>;
    void traceId;
    void instance;
    return rest;
  };

  // ── ① T1 齐 (emit tool_call) → 落 brief + converged ─────────────────────────
  it('① T1 齐 (emit) → 落 requirements_draft + session converged', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    provider.setFake({ script: [{ emit: T1_COMPLETE }] });

    const res = await genBrief(token, sid.toString());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { converged: boolean; missing: string[] };
    expect(body.converged).toBe(true);
    expect(body.missing).toEqual([]);

    expect((await sessionOf(sid))?.status).toBe('converged');
    const drafts = await draftsOf(sid);
    expect(drafts).toHaveLength(1);
    expect((drafts[0].briefJson as { problem: string }).problem).toBe('行情页缺收藏入口');
  });

  // ── ② 缺段 → 不落 brief + 回 missing 信号 ────────────────────────────────────
  it('② 缺 T1 段 → 不落 brief + converged=false + missing 列表', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    // 缺 success_criteria + non_goals。
    provider.setFake({
      script: [
        {
          emit: {
            problem: 'p',
            user_stories: 'u',
            functional_requirements: 'f',
          },
        },
      ],
    });

    const res = await genBrief(token, sid.toString());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { converged: boolean; missing: string[] };
    expect(body.converged).toBe(false);
    expect(body.missing).toEqual(['success_criteria', 'non_goals']);

    // 不落 brief; session 仍 open。
    expect(await draftsOf(sid)).toEqual([]);
    expect((await sessionOf(sid))?.status).toBe('open');
  });

  // ── ③ 重生 → upsert 1:1 覆盖单份 (不留历史) ──────────────────────────────────
  it('③ 重生 → upsert 1:1 覆盖, 仅留单份 (无 v1/v2)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);

    provider.setFake({ script: [{ emit: T1_COMPLETE }] });
    await genBrief(token, sid.toString());

    // reopen 回 open 才能重生 (与 reopen 闭环对齐)。
    await prisma.ideaSession.update({ where: { id: sid }, data: { status: 'open' } });
    provider.setFake({
      script: [{ emit: { ...T1_COMPLETE, problem: '改写后的问题' } }],
    });
    await genBrief(token, sid.toString());

    const drafts = await draftsOf(sid);
    expect(drafts).toHaveLength(1); // 单份, 覆盖
    expect((drafts[0].briefJson as { problem: string }).problem).toBe('改写后的问题');
  });

  // ── ④ 导出 → markdown + handed-off ───────────────────────────────────────────
  it('④ 导出 → markdown + session handed-off', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    provider.setFake({ script: [{ emit: T1_COMPLETE }] });
    await genBrief(token, sid.toString());

    const res = await exportBrief(token, sid.toString());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { markdown: string; status: string };
    expect(body.status).toBe('handed-off');
    expect(body.markdown).toContain('## 问题 / 动机');
    expect(body.markdown).toContain('行情页缺收藏入口');
    // T2 空 → 占位行。
    expect(body.markdown).toContain('_本期留空/手填_');

    expect((await sessionOf(sid))?.status).toBe('handed-off');
  });

  // ── ⑤ 接地 stub (T2 全空) 照样收敛 (SC-007) ──────────────────────────────────
  it('⑤ T2 接地段全空 → 照样收敛 (收敛门只查 T1, SC-007)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    // T1 齐, T2/T3 完全省略 (接地 stub 期)。
    provider.setFake({ script: [{ emit: T1_COMPLETE }] });

    const res = await genBrief(token, sid.toString());
    const body = JSON.parse(res.body) as { converged: boolean };
    expect(body.converged).toBe(true);
    expect((await sessionOf(sid))?.status).toBe('converged');
  });

  // ── ⑥ DS 降级 (纯文本吐 JSON) → 正则兜底捞出照样收敛 ─────────────────────────
  it('⑥ DS 降级 (纯文本含 JSON) → 正则兜底捞出 + 收敛', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    // 模型吐不出 tool_call, 降级把 brief JSON 当正文吐 (前后裹噪声文字)。
    provider.setFake({
      script: [
        {
          text: ['好的, 这是 brief: ', JSON.stringify(T1_COMPLETE), ' 以上。'],
        },
      ],
    });

    const res = await genBrief(token, sid.toString());
    const body = JSON.parse(res.body) as { converged: boolean };
    expect(body.converged).toBe(true);
    expect((await sessionOf(sid))?.status).toBe('converged');
  });

  // ── ⑦ 越权 / 非 open → 404 (反枚举) ─────────────────────────────────────────
  it('⑦ 他人 / 非 open / unknown → 404 字节级一致', async () => {
    const owner = await activeToken();
    const other = await activeToken();
    const sid = await seedSession(owner.id);
    const convergedSid = await seedSession(owner.id, 'converged');
    provider.setFake({ script: [{ emit: T1_COMPLETE }] });

    const otherRes = await genBrief(other.token, sid.toString());
    const nonOpenRes = await genBrief(owner.token, convergedSid.toString());
    const unknownRes = await genBrief(owner.token, '99999999');

    expect(otherRes.statusCode).toBe(404);
    expect(nonOpenRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(strip(otherRes.body)).toEqual(strip(unknownRes.body));
    expect(strip(nonOpenRes.body)).toEqual(strip(unknownRes.body));
  });

  // ── ⑧ emit 产出指令 system prompt 置于 messages 首 ───────────────────────────
  it('⑧ emit 产出指令 system prompt 置于 messages 首', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    provider.setFake({ script: [{ emit: T1_COMPLETE }] });

    await genBrief(token, sid.toString());
    expect(provider.lastMessages[0]?.role).toBe('system');
    expect(provider.lastMessages[0]?.content).toContain('emit_requirements_brief');
  });
});
