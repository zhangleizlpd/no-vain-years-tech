import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Redis } from 'ioredis';
import { AppModule } from '../../src/app/app.module';
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
import { MinimaxProvider } from '../../src/integrations/llm/minimax.provider';
import {
  FakeIdeationLlmProvider,
  type FakeIdeationLlmConfig,
} from '../../src/ideation/fake-ideation-llm.provider';
import { interviewToolsFor, PRODUCE_PHASE_TOOLS } from '../../src/ideation/ideation-tools';

// 仅供下方 env-gated 真 vendor 块读 apps/server/.env 的真 key 用（vitest cwd = apps/server）。
// 共享 PG fixture 转正后主体不再需要它，但那个块仍要 —— 2026-08-02 P4.1 曾连同删掉，
// 因该块恒 skip（T-4）+ test/ 不 typecheck 也不 lint（T-2），断了两天没人发现。
const SERVER_DIR = process.cwd();

/** 访谈相菜单 fixture (已选仓 = codeindex+ask; 034 T003 后 INTERVIEW_PHASE_TOOLS→interviewToolsFor)。 */
const INTERVIEW_PHASE_TOOLS = interviewToolsFor('mono');

/**
 * 032 T010 state_branches 全覆盖 IT —— EXHAUSTIVE BRANCHING 收口门 (plan Testing Invariants /
 * ADR-0040 multi-layer gate)。spec.md `state_branches` 段 ~19 条 (实际枚举 21 条, 含 401 / 接地
 * stub) 逐条一个 `it()`, 与 T007/T008/T009 per-endpoint IT 有重叠是**预期且允许的** —— 本文件是
 * 穷举门, 保证每个状态机分支有一个对应断言锚。
 *
 * 装配 (与 T007-T009 一致, per plan「NO LIFECYCLE MOCKING」): 全 boot AppModule + Testcontainers
 * PG/Redis + Fastify; 经 DI `.overrideProvider(LLM_PROVIDER)` 注入 SwappableFake (内核
 * FakeIdeationLlmProvider 逐 test 可换两相剧本), guard/SSE/interceptor 真 DI, 绝不 jest.mock。
 *
 * 末尾 env-gated 真 M3 IT (`RUN_LLM_IT`, 默认 skip, CI 不打外网): 直读 apps/server/.env 的真
 * MINIMAX_API_KEY 手建 MinimaxProvider, 真发驱动两相 (访谈出 ask ± chips / 产出 forced emit)
 * 验结构化 emit 稳定 + DS 降级路径由 T009⑥ fake 兜底覆盖。
 */

/** 单 DI override, 内核 fake 逐 test 可换。 */
class SwappableFake implements LlmProvider {
  private inner: FakeIdeationLlmProvider = new FakeIdeationLlmProvider({ script: [] });

  setFake(config: FakeIdeationLlmConfig): void {
    this.inner = new FakeIdeationLlmProvider(config);
  }

  stream(messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    return this.inner.stream(messages, opts);
  }
}

/** T1 五段齐的 brief (T2/T3 全空, 接地 stub 期形态)。 */
const T1_COMPLETE = {
  problem: '行情页缺收藏入口',
  user_stories: 'P1: 作为用户我想收藏股票...',
  functional_requirements: 'FR-001 提供收藏按钮',
  success_criteria: '收藏成功率 > 99%',
  non_goals: '不做分组管理',
};

describe('032 ideation state_branches 全覆盖 (Testcontainers PG + Redis + Fastify)', () => {
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
    process.env.AUTH_JWT_SECRET = 'ideation-t010-jwt-secret-min-32-bytes-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'ideation-t010-hmac-secret-min-32-bytes-zy';

    provider = new SwappableFake();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
  const nextPhone = () => `+8613921${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const sendJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });

  // 端点 helper (4 family: session CRUD + clarify SSE + brief gen/export)。
  const create = (token: string, title: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/ideation/sessions',
      headers: sendJson(token),
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
  const turn = (token: string, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/ideation/sessions/${id}/turns`,
      headers: sendJson(token),
      payload,
    });
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

  /** 直接种一条会话 (可指定 status + 子行) 验生命周期/连带删/列表/越权。 */
  async function seedSession(
    accountId: bigint,
    opts: { title?: string; status?: string; userTurns?: number; brief?: boolean } = {},
  ): Promise<bigint> {
    const s = await prisma.ideaSession.create({
      data: { accountId, title: opts.title ?? '种子会话', status: opts.status ?? 'open' },
      select: { id: true },
    });
    // 预置 user/assistant turn 对 (推进 turnIndex, 让 chips 闸不被第一问拦)。
    for (let i = 0; i < (opts.userTurns ?? 0); i++) {
      await prisma.ideaTurn.create({
        data: { sessionId: s.id, role: 'user', content: `历史 ${i}` },
      });
      await prisma.ideaTurn.create({
        data: { sessionId: s.id, role: 'assistant', content: `回复 ${i}` },
      });
    }
    if (opts.brief) {
      await prisma.requirementsDraft.create({
        data: {
          sessionId: s.id,
          briefJson: T1_COMPLETE,
        },
      });
    }
    return s.id;
  }

  /** SSE body → 帧 payload (去 data: 前缀, 丢空帧)。 */
  const frames = (body: string): string[] =>
    body
      .split('\n\n')
      .filter((f) => f.startsWith('data:'))
      .map((f) => f.slice('data:'.length));

  const turnsOf = (sessionId: bigint) =>
    prisma.ideaTurn.findMany({
      where: { sessionId },
      orderBy: { id: 'asc' },
      select: { role: true, content: true, suggestion: true },
    });
  const sessionOf = (id: bigint) =>
    prisma.ideaSession.findUnique({ where: { id }, select: { status: true, accountId: true } });
  const draftsOf = (sessionId: bigint) =>
    prisma.requirementsDraft.findMany({ where: { sessionId }, select: { briefJson: true } });

  /** ProblemDetail 字节级一致比较 (剥动态 traceId/instance)。 */
  const strip = (raw: string) => {
    const { traceId, instance, ...rest } = JSON.parse(raw) as Record<string, unknown>;
    void traceId;
    void instance;
    return rest;
  };

  // ════════════════════════════════════════════════════════════════════════
  // state_branches 逐条覆盖 (spec.md frontmatter 顺序)
  // ════════════════════════════════════════════════════════════════════════

  // [1] 从 + FAB 创建入口 → 新建 idea session (title + status=open) → 落库归属 accountId。
  it('[1] 建会话 → status=open + repo=null + 归属当前 accountId', async () => {
    const me = await activeToken();
    const res = await create(me.token, '给行情页加收藏');
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string; status: string; repo: unknown };
    expect(body.status).toBe('open');
    expect(body.repo).toBeNull();
    const row = await prisma.ideaSession.findUnique({ where: { id: BigInt(body.id) } });
    expect(row?.accountId).toBe(me.id);
  });

  // [2] open 态输入模糊初衷 → AI 反问澄清 (流式) → user/assistant turn 逐轮持久化。
  it('[2] 模糊初衷 → SSE 流式澄清反问 → user + assistant turn 落库', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id);
    provider.setFake({ script: [{ ask: { question: '你想达成什么?' } }] });

    const res = await turn(me.token, sid.toString(), { content: '想给行情页加点东西' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const fr = frames(res.body);
    expect(fr.at(-1)).toBe('[DONE]');
    const text = fr
      .filter((f) => f !== '[DONE]')
      .map((f) => (JSON.parse(f) as { token?: string }).token)
      .filter((t): t is string => typeof t === 'string')
      .join('');
    expect(text).toBe('你想达成什么?');

    const rows = await turnsOf(sid);
    expect(rows).toEqual([
      { role: 'user', content: '想给行情页加点东西', suggestion: null },
      { role: 'assistant', content: '你想达成什么?', suggestion: null },
    ]);
  });

  // [3] 答案空间可枚举 + 有可辩护推荐 → 附 2-4 建议选项 (推荐项标注 + 逃生项) → 可点选回填。
  it('[3] 过两闸 (可枚举 + 有推荐, 非第一问) → suggestion 帧含推荐标注 + 逃生项 + 落库', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id, { userTurns: 1 }); // turnIndex 推到 1
    provider.setFake({
      script: [
        {
          ask: {
            question: '输出流走 SSE 还是一次性?',
            options: [{ label: 'SSE 流式', recommended: true }, { label: '一次性全文' }],
            multi_select: false,
            allow_freetext: true,
          },
        },
      ],
    });

    const res = await turn(me.token, sid.toString(), { content: '关于输出方式' });
    expect(res.statusCode).toBe(200);
    const fr = frames(res.body);
    const sugFrame = fr
      .map((f) => (f === '[DONE]' ? null : (JSON.parse(f) as { suggestion?: unknown })))
      .find((p) => p !== null && p.suggestion !== undefined);
    expect(sugFrame).toBeDefined();
    const sug = (sugFrame as { suggestion: Record<string, unknown> }).suggestion;
    const opts = sug.options as { label: string; recommended?: boolean }[];
    expect(opts.length).toBeGreaterThanOrEqual(2);
    expect(opts.length).toBeLessThanOrEqual(4);
    expect(opts[0].recommended).toBe(true); // 推荐项排首 (recommended；「（推荐）」由前端渲染、落库 label 干净)
    expect(opts.at(-1)?.label).toBe('都不是/自己填'); // 末位逃生项
    expect(sug.allow_freetext).toBe(true);

    const assistant = (await turnsOf(sid)).at(-1)!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.suggestion).not.toBeNull();
  });

  // [4] 开放/创意/无可辩护推荐 → 仅自由文本 (不强给选项)。
  it('[4] 不过闸 (开放型 / 无可辩护推荐) → 无 suggestion 帧 + assistant.suggestion=null', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id, { userTurns: 1 });
    provider.setFake({
      script: [{ ask: { question: '这功能想达成什么?' } }], // 纯文本问题, 无 options
    });

    const res = await turn(me.token, sid.toString(), { content: '关于目标' });
    expect(res.statusCode).toBe(200);
    const fr = frames(res.body);
    const hasSug = fr.some(
      (f) => f !== '[DONE]' && (JSON.parse(f) as { suggestion?: unknown }).suggestion !== undefined,
    );
    expect(hasSug).toBe(false);
    expect((await turnsOf(sid)).at(-1)!.suggestion).toBeNull();
  });

  // [5] 带选项的轮 → 用户不点选项直接自由文本输入 → 照常推进 (自由文本永远可用)。
  it('[5] 带选项的轮直接自由文本作答 → 照常推进 (自由文本永驻)', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id, { userTurns: 1 });
    // 上一 assistant 轮带 chips; 本轮用户直接打字 (非点选项), 应照常落 user turn + 推进。
    provider.setFake({ script: [{ ask: { question: '下一个澄清问题?' } }] });

    const res = await turn(me.token, sid.toString(), { content: '我自己写一段自由文本回答' });
    expect(res.statusCode).toBe(200);
    const rows = await turnsOf(sid);
    // 历史 2 轮 + 本轮 user + assistant = 4。
    expect(rows.at(-2)).toEqual({
      role: 'user',
      content: '我自己写一段自由文本回答',
      suggestion: null,
    });
    expect(rows.at(-1)!.role).toBe('assistant');
  });

  // [6] 触发「生成 brief」→ 核心必填段齐 → 落 requirements draft + status=converged。
  it('[6] 生成 brief (T1 齐) → 落 draft + session converged', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id);
    provider.setFake({ script: [{ emit: T1_COMPLETE }] });

    const res = await genBrief(me.token, sid.toString());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { converged: boolean; missing: string[] };
    expect(body.converged).toBe(true);
    expect(body.missing).toEqual([]);
    expect((await sessionOf(sid))?.status).toBe('converged');
    const drafts = await draftsOf(sid);
    expect(drafts).toHaveLength(1);
    expect((drafts[0].briefJson as { problem: string }).problem).toBe('行情页缺收藏入口');
  });

  // [7] 收敛时核心必填段未齐 → AI 继续追问缺失维度 (不产出半截 brief)。
  it('[7] 缺 T1 段 → 不落 brief + converged=false + missing 列表 + session 仍 open', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id);
    provider.setFake({
      script: [{ emit: { problem: 'p', user_stories: 'u', functional_requirements: 'f' } }],
    });

    const res = await genBrief(me.token, sid.toString());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { converged: boolean; missing: string[] };
    expect(body.converged).toBe(false);
    expect(body.missing).toEqual(['success_criteria', 'non_goals']);
    expect(await draftsOf(sid)).toEqual([]); // 不落半截
    expect((await sessionOf(sid))?.status).toBe('open');
  });

  // [8] 小颗粒需求 (小改) → brief 仅核心必填段、可选段自适应跳过 (不强凑大 PRD)。
  it('[8] 小颗粒需求 → T1 齐 + T3 可选段全省 → 照样收敛 (不强凑)', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id);
    // 仅 T1 五段, 无任何 T2/T3 段 (小改场景)。
    provider.setFake({ script: [{ emit: T1_COMPLETE }] });

    const res = await genBrief(me.token, sid.toString());
    const body = JSON.parse(res.body) as { converged: boolean; briefJson: Record<string, unknown> };
    expect(body.converged).toBe(true);
    // 落库 brief 不含可选段 (自适应跳过, 非补空)。
    const stored = (await draftsOf(sid))[0].briefJson as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(
      [
        'functional_requirements',
        'non_goals',
        'problem',
        'success_criteria',
        'user_stories',
      ].sort(),
    );
  });

  // [9] 已 converged → 导出/复制 brief markdown → status=handed-off。
  it('[9] 导出 brief → markdown + session handed-off', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id);
    provider.setFake({ script: [{ emit: T1_COMPLETE }] });
    await genBrief(me.token, sid.toString());

    const res = await exportBrief(me.token, sid.toString());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { markdown: string; status: string };
    expect(body.status).toBe('handed-off');
    expect(body.markdown).toContain('行情页缺收藏入口');
    expect((await sessionOf(sid))?.status).toBe('handed-off');
  });

  // [10] 已 converged/handed-off → 重开继续 → status 回流 open → 可再追加澄清 / 重新生成。
  it('[10] converged/handed-off → reopen 回流 open (状态非单向终态)', async () => {
    const me = await activeToken();
    const converged = await seedSession(me.id, { status: 'converged' });
    const handedOff = await seedSession(me.id, { status: 'handed-off' });

    const r1 = await reopen(me.token, converged.toString());
    expect(r1.statusCode).toBe(200);
    expect((JSON.parse(r1.body) as { status: string }).status).toBe('open');
    expect((await sessionOf(converged))?.status).toBe('open');

    const r2 = await reopen(me.token, handedOff.toString());
    expect((JSON.parse(r2.body) as { status: string }).status).toBe('open');
    expect((await sessionOf(handedOff))?.status).toBe('open');

    // 回流后可再生成 brief (追加路径连通)。
    provider.setFake({ script: [{ emit: T1_COMPLETE }] });
    const gen = await genBrief(me.token, converged.toString());
    expect((JSON.parse(gen.body) as { converged: boolean }).converged).toBe(true);
  });

  // [11] 重新生成 brief → 覆盖上一版 (1:1 单份, 不留多版本) → status 回 converged。
  it('[11] 重生 brief (reopen + generate 两步) → 1:1 覆盖单份, status 回 converged', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id);

    provider.setFake({ script: [{ emit: T1_COMPLETE }] });
    await genBrief(me.token, sid.toString());
    expect((await sessionOf(sid))?.status).toBe('converged');

    // 重生 = reopen 回 open 再 generate (T009 决策两步流)。
    const re = await reopen(me.token, sid.toString());
    expect((JSON.parse(re.body) as { status: string }).status).toBe('open');
    provider.setFake({ script: [{ emit: { ...T1_COMPLETE, problem: '改写后的问题' } }] });
    await genBrief(me.token, sid.toString());

    const drafts = await draftsOf(sid);
    expect(drafts).toHaveLength(1); // 单份覆盖, 无 v1/v2
    expect((drafts[0].briefJson as { problem: string }).problem).toBe('改写后的问题');
    expect((await sessionOf(sid))?.status).toBe('converged');
  });

  // [12] 删除自己的会话 → 移除会话 + turn + brief; 越权删他人被拒字节级一致。
  it('[12] 删除自己会话 → 连带 turn + brief 全删 (防孤儿)', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id, { userTurns: 3, brief: true });
    expect(await prisma.ideaTurn.count({ where: { sessionId: sid } })).toBe(6);

    const res = await del(me.token, sid.toString());
    expect(res.statusCode).toBe(204);
    expect(await prisma.ideaSession.findUnique({ where: { id: sid } })).toBeNull();
    expect(await prisma.ideaTurn.count({ where: { sessionId: sid } })).toBe(0);
    expect(await prisma.requirementsDraft.findUnique({ where: { sessionId: sid } })).toBeNull();
  });

  // [13] 中途退出会话 → 进度 (turn + 草稿) 保留为 open → 重进可继续。
  it('[13] 中途退出 → 进度保留为 open, 重进列表可见可继续', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id, { userTurns: 2 }); // 澄清到一半
    // 「重进」= 再 GET 详情, 进度 (历史 turn) 仍在, status 仍 open。
    const detail = await getOne(me.token, sid.toString());
    expect(detail.statusCode).toBe(200);
    const body = JSON.parse(detail.body) as {
      status: string;
      turns: Array<{ content: string }>;
    };
    expect(body.status).toBe('open');
    expect(body.turns).toHaveLength(4); // 2 user + 2 assistant 历史保留

    // 可继续: 再发一轮澄清成功落库。
    provider.setFake({ script: [{ ask: { question: '继续追问?' } }] });
    const res = await turn(me.token, sid.toString(), { content: '继续' });
    expect(res.statusCode).toBe(200);
    expect((await turnsOf(sid)).length).toBe(6);
  });

  // [14] 查看/列出自己的历史 → 仅见本 accountId 名下会话。
  it('[14] 列表仅本账号会话 (不串他人), updatedAt desc', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const a = await seedSession(me.id, { title: 'A' });
    await new Promise((r) => setTimeout(r, 10));
    const b = await seedSession(me.id, { title: 'B' });
    await seedSession(other.id, { title: '他人' });

    const res = await listAll(me.token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { items: Array<{ id: string; title: string }> };
    expect(body.items.map((i) => i.id)).toEqual([b.toString(), a.toString()]);
    expect(body.items.every((i) => i.title !== '他人')).toBe(true);
  });

  // [15] 越权读/写/删他人 session/turn/draft → 拒 (字节级一致反枚举)。
  it('[15] 越权 read/write/delete 他人 → 404 字节级一致 (跨端点 + 不存在 + 非数字)', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const theirs = await seedSession(other.id, { status: 'open', userTurns: 1, brief: true });
    provider.setFake({ script: [{ ask: { question: 'Q' } }] });

    const getRes = await getOne(me.token, theirs.toString());
    const delRes = await del(me.token, theirs.toString());
    const reopenRes = await reopen(me.token, theirs.toString());
    const turnRes = await turn(me.token, theirs.toString(), { content: 'x' }); // 越权写
    const briefRes = await genBrief(me.token, theirs.toString()); // 越权写 draft
    const unknownRes = await getOne(me.token, '888888888888');
    const nonNumericRes = await getOne(me.token, 'abc');

    for (const r of [getRes, delRes, reopenRes, turnRes, briefRes, unknownRes, nonNumericRes]) {
      expect(r.statusCode).toBe(404);
    }
    // 字节级一致 (剥 traceId/instance): 越权 (各动词) vs 不存在 vs 非数字 同构。
    expect(strip(getRes.body)).toEqual(strip(unknownRes.body));
    expect(strip(delRes.body)).toEqual(strip(unknownRes.body));
    expect(strip(reopenRes.body)).toEqual(strip(unknownRes.body));
    expect(strip(turnRes.body)).toEqual(strip(unknownRes.body));
    expect(strip(briefRes.body)).toEqual(strip(unknownRes.body));
    expect(strip(nonNumericRes.body)).toEqual(strip(unknownRes.body));

    // 他人数据未被波及。
    expect(await prisma.ideaSession.findUnique({ where: { id: theirs } })).not.toBeNull();
    expect(await prisma.ideaTurn.count({ where: { sessionId: theirs } })).toBe(2);
    expect((await draftsOf(theirs)).length).toBe(1);
  });

  // [16] 未认证/token 失效 → 401 (触发 003 refresh 拦截器, server 侧验 401 即可)。
  it('[16] 未认证 → 401 (各端点)', async () => {
    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/ideation/sessions',
      payload: { title: 'x' },
    });
    const get = await app.inject({ method: 'GET', url: '/api/v1/ideation/sessions' });
    const detail = await app.inject({ method: 'GET', url: '/api/v1/ideation/sessions/1' });
    const briefNoAuth = await app.inject({
      method: 'POST',
      url: '/api/v1/ideation/sessions/1/brief',
    });
    expect(post.statusCode).toBe(401);
    expect(get.statusCode).toBe(401);
    expect(detail.statusCode).toBe(401);
    expect(briefNoAuth.statusCode).toBe(401);
  });

  // [17] LLM provider 失败 (非 abort) → 不落半截 assistant turn + 可见错误可重试。
  it('[17] provider 失败 → 不落 assistant turn + error 帧 (user turn 在)', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id);
    provider.setFake({ script: [{ ask: { question: 'Q' } }], errorAfter: 0 });

    const res = await turn(me.token, sid.toString(), { content: '触发失败' });
    expect(res.statusCode).toBe(200); // 流已开
    const fr = frames(res.body);
    const errFrame = fr
      .map((f) => (f === '[DONE]' ? null : (JSON.parse(f) as { error?: unknown })))
      .find((p) => p !== null && p.error !== undefined);
    expect(errFrame).toBeDefined();
    // 不落半截 assistant; user turn 在。
    expect(await turnsOf(sid)).toEqual([{ role: 'user', content: '触发失败', suggestion: null }]);
  });

  // [18] 用户停止生成 (abort) → 已生成半成品 turn 保留 (split-tx stopped 语义)。
  it('[18] abort 中流 → 保留半成品 assistant turn', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id);
    provider.setFake({ script: [{ ask: { question: '这是一个长问题' } }], delayMs: 200 });

    const ac = new AbortController();
    const pending = app.inject({
      method: 'POST',
      url: `/api/v1/ideation/sessions/${sid.toString()}/turns`,
      headers: sendJson(me.token),
      payload: { content: '触发 abort' },
      signal: ac.signal,
    } as never);
    setTimeout(() => ac.abort(), 50);
    await pending.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300)); // 给 UC 落库时间

    const rows = await turnsOf(sid);
    expect(rows[0]).toEqual({ role: 'user', content: '触发 abort', suggestion: null });
    expect(rows.some((r) => r.role === 'assistant')).toBe(true); // 半成品保留
  });

  // [19] 空/纯空白初衷或回答 → 拒 + 可见校验 (不落空 turn)。
  it('[19] 空白回答 → 400 (user turn 不落); 空白标题建会话 → 400', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id);
    provider.setFake({ script: [{ ask: { question: 'Q' } }] });

    const turnRes = await turn(me.token, sid.toString(), { content: '   ' });
    expect(turnRes.statusCode).toBe(400);
    expect(await turnsOf(sid)).toEqual([]); // 无 turn 落

    const createRes = await create(me.token, '   ');
    expect(createRes.statusCode).toBe(400);
  });

  // [20] repo 接地段 (T2) 本期 stub 无数据 → 留空/手填, 不阻塞收敛门 (ADR-0059 / SC-007)。
  it('[20] 接地 stub (T2 全空) → 不阻塞收敛 + 导出占位行', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id);
    // T1 齐, T2 接地段完全省略 (repo-blind stub 期)。
    provider.setFake({ script: [{ emit: T1_COMPLETE }] });

    const res = await genBrief(me.token, sid.toString());
    const body = JSON.parse(res.body) as { converged: boolean };
    expect(body.converged).toBe(true); // 收敛门只查 T1, T2 缺不阻塞
    expect((await sessionOf(sid))?.status).toBe('converged');

    // 导出: T2 接地段 → 占位行 (留空/手填)。
    const exp = await exportBrief(me.token, sid.toString());
    expect((JSON.parse(exp.body) as { markdown: string }).markdown).toContain('_本期留空/手填_');
  });

  // [21] DS 降级 (纯文本吐 JSON) → 正则兜底捞出照样收敛 (FR-010 / 契约 doc §4.3)。
  it('[21] DS 降级 (纯文本含 brief JSON) → 正则兜底 + 收敛', async () => {
    const me = await activeToken();
    const sid = await seedSession(me.id);
    // 模型吐不出 tool_call, 降级把 brief JSON 当正文吐 (前后裹噪声)。
    provider.setFake({
      script: [{ text: ['好的, 这是 brief: ', JSON.stringify(T1_COMPLETE), ' 以上。'] }],
    });

    const res = await genBrief(me.token, sid.toString());
    expect((JSON.parse(res.body) as { converged: boolean }).converged).toBe(true);
    expect((await sessionOf(sid))?.status).toBe('converged');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// env-gated 真 M3 IT (RUN_LLM_IT, 默认 skip — CI 不打外网 + 占位 key)
//
// 本地显式 `RUN_LLM_IT=1 env -u OSS_* nx test server test/integration/ideation.it.spec.ts`
// 真连 MiniMax M3 验两相驱动结构化 emit 稳定:
//   ① 访谈相 (INTERVIEW_PHASE_TOOLS, tool_choice 'auto'): 真发 → 模型吐 ask_clarifying_question
//      tool_call (或纯文本降级, 不硬断言 tool, 验流连通 + 非空)。
//   ② 产出相 (PRODUCE_PHASE_TOOLS): 真发 → 期望吐 emit_requirements_brief 结构化 tool_call。
// DS 降级路径 (纯文本吐 JSON → 正则兜底) 由 fake [21] / T009⑥ 覆盖, 本块不重复真发 DS。
//
// ⚠️ key 来源: vitest test.env 注占位会覆盖 process.env, 故直读 apps/server/.env 真
// MINIMAX_API_KEY 手建 MinimaxProvider (绕 DI 与占位), 验真 vendor 连通 + 两相结构化能力。
// ════════════════════════════════════════════════════════════════════════════
const RUN_LLM_IT = process.env.RUN_LLM_IT === '1' || process.env.RUN_LLM_IT === 'true';

describe.skipIf(!RUN_LLM_IT)('032 真 MiniMax M3 两相 IT (env-gated RUN_LLM_IT, 默认 skip)', () => {
  let realProvider: MinimaxProvider;

  beforeAll(() => {
    // 真 key 从 .env 读 (绕 vitest test.env 占位); .env 不在 git 但本地存在。
    const envText = readFileSync(resolve(SERVER_DIR, '.env'), 'utf8');
    const apiKey = envText
      .split('\n')
      .find((l) => l.startsWith('MINIMAX_API_KEY='))
      ?.slice('MINIMAX_API_KEY='.length)
      .trim();
    if (!apiKey) {
      throw new Error('RUN_LLM_IT set but real MINIMAX_API_KEY missing in apps/server/.env');
    }
    realProvider = new MinimaxProvider({
      apiKey,
      baseUrl: process.env.MINIMAX_BASE_URL ?? 'https://api.minimaxi.com/v1',
    });
  });

  it('① 访谈相: 真发 → 收到流式 event (tool_call 或纯文本), 流连通', async () => {
    const controller = new AbortController();
    let events = 0;
    let sawAsk = false;
    let text = '';
    for await (const ev of realProvider.stream(
      [
        {
          role: 'system',
          content:
            '你是需求澄清助手。用 ask_clarifying_question 工具向用户提一个澄清问题, 不要直接给方案。',
        },
        { role: 'user', content: '我想给行情页加个收藏功能, 但不确定范围。' },
      ],
      { signal: controller.signal, model: 'minimax', tools: INTERVIEW_PHASE_TOOLS },
    )) {
      events += 1;
      if (ev.kind === 'tool_call') {
        sawAsk = ev.calls.some((c) => c.function.name === 'ask_clarifying_question');
      } else if (ev.kind === 'token') {
        text += ev.text;
      }
    }
    // 不硬断言 tool (真模型可能纯文本降级); 验流连通 + 有产出。
    expect(events).toBeGreaterThan(0);
    expect(sawAsk || text.length > 0).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`[RUN_LLM_IT 访谈相] events=${events} sawAsk=${sawAsk} textLen=${text.length}`);
  }, 60_000);

  it('② 产出相: 真发 (forced emit) → 期望 emit_requirements_brief 结构化 tool_call', async () => {
    const controller = new AbortController();
    let emitArgs: string | null = null;
    let text = '';
    for await (const ev of realProvider.stream(
      [
        {
          role: 'system',
          content:
            '根据对话收敛产出需求 brief。必须调用 emit_requirements_brief 工具输出结构化 brief, ' +
            '含 problem / user_stories / functional_requirements / success_criteria / non_goals 五段。',
        },
        {
          role: 'user',
          content:
            '需求: 行情页加收藏。范围: 个股收藏按钮 + 收藏列表 tab。验收: 收藏成功率>99%。非目标: 不做分组。',
        },
      ],
      { signal: controller.signal, model: 'minimax', tools: PRODUCE_PHASE_TOOLS },
    )) {
      if (ev.kind === 'tool_call') {
        const emit = ev.calls.find((c) => c.function.name === 'emit_requirements_brief');
        if (emit) emitArgs = emit.function.arguments;
      } else if (ev.kind === 'token') {
        text += ev.text;
      }
    }
    // M3 tool_choice auto 通常吐结构化 emit; 真模型偶尔纯文本降级则放宽 (验流连通)。
    if (emitArgs !== null) {
      const parsed = JSON.parse(emitArgs) as Record<string, unknown>;
      expect(typeof parsed.problem === 'string' || parsed.problem === undefined).toBe(true);
    } else {
      expect(text.length).toBeGreaterThan(0);
    }
    // eslint-disable-next-line no-console
    console.log(`[RUN_LLM_IT 产出相] emit=${emitArgs !== null} textLen=${text.length}`);
  }, 60_000);
});
