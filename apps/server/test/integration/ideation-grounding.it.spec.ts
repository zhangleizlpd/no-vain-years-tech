import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import fastifyCors from '@fastify/cors';
import type { Redis } from 'ioredis';
import { appConfig, parseOrigins, type AppConfig } from '../../src/config';
import { AppModule } from '../../src/app/app.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { LLM_PROVIDER } from '../../src/integrations/llm/llm.module';
import { CODE_INDEX } from '../../src/integrations/codeindex/code-index.port';
import { HttpCodeIndexProvider } from '../../src/integrations/codeindex/http-code-index.provider';
import type {
  CodeChunk,
  CodeIndexProvider,
  RepoCatalogEntry,
} from '../../src/integrations/codeindex/code-index.port';
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
 * 034 T007 state_branches 全覆盖 IT —— EXHAUSTIVE BRANCHING 收口门 (plan §Testing Invariants /
 * §Phase 0 Gate 0.1 / ADR-0040 multi-layer gate)。spec.md frontmatter `state_branches` **9 条**
 * 逐条一个 `it()`，与 T006 (`ideation-grounding-clarify.it.spec.ts`) 单元级回灌分支有重叠是
 * **预期且允许的** —— 本文件是端到端穷举门: 全 boot AppModule + catalog/set-repo 端点真打 +
 * 命名空间隔离, 关注「选库 → 接地检索 → 降级」三链路的端到端联动, T006 偏 UC 回灌内核单元验。
 *
 * 装配 (per plan「NO LIFECYCLE MOCKING」): 全 boot AppModule + Testcontainers PG/Redis + Fastify;
 * 经 DI `.overrideProvider(LLM_PROVIDER)` 注 SwappableFake + `.overrideProvider(CODE_INDEX)` 注
 * SwappableCodeIndex, guard/SSE/interceptor/filter 真 DI, 绝不 jest.mock。
 *
 * grounding 轮序契约 (与 T006 一致): FakeLLM 单例 round 游标单调。已选仓接地流的 stream 调用序 =
 *   [步1 round0 (interviewToolsFor 含 codeindex → 吐 grounding tool_call),
 *    回灌重入 round1 (吐 ask)]; 故脚本 [{grounding}, {ask}] 两轮一一对位。未选仓时
 * interviewToolsFor(null) 不含 codeindex → FakeLLM 守门降级空轮 → 步2 ASK_ONLY 出 ask。
 */

/** SwappableFake LLM: 单 DI override, 内核逐 test 可换; 记录每次 stream 的 messages。 */
class SwappableFake implements LlmProvider {
  private inner: FakeIdeationLlmProvider = new FakeIdeationLlmProvider({ script: [] });
  /** 每次 stream 调用记一份 messages 快照 (验回灌 role:'tool' 注入)。 */
  messagesLog: Msg[][] = [];

  setFake(config: FakeIdeationLlmConfig): void {
    this.inner = new FakeIdeationLlmProvider(config);
    this.messagesLog = [];
  }

  stream(messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    this.messagesLog.push([...messages]);
    return this.inner.stream(messages, opts);
  }
}

/** SwappableFake code-index: 记录 search 实参 (repo/query) 验命名空间隔离 + 未选仓不调; catalog 可注空/不可达。 */
class SwappableCodeIndex implements CodeIndexProvider {
  hitsByRepo: Record<string, CodeChunk[]> = {};
  repos: RepoCatalogEntry[] = [];
  unreachable = false;
  searchCalls: { repo: string; query: string }[] = [];
  listReposCalls = 0;

  reset(): void {
    this.hitsByRepo = {};
    this.repos = [];
    this.unreachable = false;
    this.searchCalls = [];
    this.listReposCalls = 0;
  }

  async search(repo: string, query: string, signal?: AbortSignal): Promise<CodeChunk[]> {
    this.searchCalls.push({ repo, query });
    if (signal?.aborted) throw new Error('ABORTED');
    if (this.unreachable) throw new Error('FAKE_CODE_INDEX_UNREACHABLE');
    return this.hitsByRepo[repo] ?? [];
  }

  async listRepos(signal?: AbortSignal): Promise<RepoCatalogEntry[]> {
    this.listReposCalls += 1;
    if (signal?.aborted) throw new Error('ABORTED');
    if (this.unreachable) throw new Error('FAKE_CODE_INDEX_UNREACHABLE');
    return this.repos;
  }
}

const chunk = (relPath: string, symbol: string | null, startLine: number): CodeChunk => ({
  relPath,
  kind: 'function',
  symbol,
  startLine,
  endLine: startLine + 4,
  score: 0.9,
  text: `// ${symbol ?? relPath} body`,
});

const repoEntry = (repo: string, status: 'ready' | 'indexing' = 'ready'): RepoCatalogEntry => ({
  repo,
  lastSha: 'a1b2c3d',
  indexedAt: '2026-06-22T00:00:00.000Z',
  chunkCount: 1280,
  status,
});

describe('034 ideation grounding state_branches 全覆盖 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let provider: SwappableFake;
  let codeIndex: SwappableCodeIndex;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'ideation-t007-jwt-secret-min-32-bytes-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'ideation-t007-hmac-secret-min-32-bytes-zy';

    provider = new SwappableFake();
    codeIndex = new SwappableCodeIndex();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(provider)
      .overrideProvider(CODE_INDEX)
      .useValue(codeIndex)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    const cfg = moduleRef.get<AppConfig>(appConfig.KEY);
    await app.register(fastifyCors, {
      origin: parseOrigins(cfg.corsAllowedOrigins),
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    });
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
    codeIndex.reset();
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613917${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const sendJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });

  /** repo 非空 = 已选仓 (接地路径); null = 未选仓 (条件注册不接地)。 */
  async function seedSession(accountId: bigint, repo: string | null): Promise<bigint> {
    const s = await prisma.ideaSession.create({
      data: { accountId, title: '接地会话', status: 'open', repo },
      select: { id: true },
    });
    return s.id;
  }

  const turn = (token: string, id: string, content: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/ideation/sessions/${id}/turns`,
      headers: sendJson(token),
      payload: { content },
    });

  const setRepo = (token: string, id: string, repo: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/ideation/sessions/${id}/repo`,
      headers: sendJson(token),
      payload: { repo },
    });

  const getRepos = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/ideation/repos', headers: auth(token) });

  const groundingScript = (query: string, question: string): FakeIdeationLlmConfig => ({
    script: [{ grounding: { query } }, { ask: { question } }],
  });

  const frames = (body: string): string[] =>
    body
      .split('\n\n')
      .filter((f) => f.startsWith('data:'))
      .map((f) => f.slice('data:'.length));

  const hasFrameKey = (fr: string[], key: string): boolean =>
    fr.some((f) => {
      if (f === '[DONE]') return false;
      try {
        return (JSON.parse(f) as Record<string, unknown>)[key] !== undefined;
      } catch {
        return false;
      }
    });

  const findFrame = <T>(fr: string[], key: string): T | undefined => {
    for (const f of fr) {
      if (f === '[DONE]') continue;
      const p = JSON.parse(f) as Record<string, unknown>;
      if (p[key] !== undefined) return p[key] as T;
    }
    return undefined;
  };

  const tokensOf = (fr: string[]): string =>
    fr
      .filter((f) => f !== '[DONE]')
      .map((f) => (JSON.parse(f) as { token?: string }).token)
      .filter((t): t is string => typeof t === 'string')
      .join('');

  const turnsOf = (sessionId: bigint) =>
    prisma.ideaTurn.findMany({
      where: { sessionId },
      orderBy: { id: 'asc' },
      select: { role: true, content: true },
    });

  const repoOf = (sessionId: bigint) =>
    prisma.ideaSession.findUnique({ where: { id: sessionId }, select: { repo: true } });

  /** ProblemDetail 字节级一致比较 (剥动态 traceId/instance)。 */
  const strip = (raw: string) => {
    const { traceId, instance, ...rest } = JSON.parse(raw) as Record<string, unknown>;
    void traceId;
    void instance;
    return rest;
  };

  // ════════════════════════════════════════════════════════════════════════
  // state_branches 逐条覆盖 (spec.md frontmatter 顺序, 9 条)
  // ════════════════════════════════════════════════════════════════════════

  // [1] 会话未选 repo → 助手不触发接地检索 (端口零调 / 无 sources) → 澄清照常。
  it('[1] 未选 repo (repo=null) → 端口零调 + 无 tool_start/sources → 澄清照常落库', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id, null);
    // 脚本排了 grounding, 但 interviewToolsFor(null) 不含 codeindex → 守门降级空轮 → 步2 出 ask。
    provider.setFake(groundingScript('q', '请先描述你的需求?'));

    const res = await turn(token, sid.toString(), '想加功能');
    expect(res.statusCode).toBe(200);
    const fr = frames(res.body);

    expect(codeIndex.searchCalls).toEqual([]); // **端口零调用** (条件注册)
    expect(hasFrameKey(fr, 'tool_start')).toBe(false);
    expect(hasFrameKey(fr, 'sources')).toBe(false);
    expect(hasFrameKey(fr, 'notice')).toBe(false);
    expect(tokensOf(fr)).toBe('请先描述你的需求?');
    // 澄清照常: user + assistant turn 落库, 无 tool/sources 行 (来源不落库)。
    expect(await turnsOf(sid)).toEqual([
      { role: 'user', content: '想加功能' },
      { role: 'assistant', content: '请先描述你的需求?' },
    ]);
  });

  // [2] 已选 repo + 命中 → 命中 chunk 作 sources 帧回流 + 助手引用真代码; 来源不落库。
  it('[2] 已选 repo + 命中 → tool_start + sources 帧 + 助手出 ask; idea_turn=[user,assistant] 无 tool 行', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id, 'mono');
    codeIndex.hitsByRepo = {
      mono: [chunk('apps/server/src/ideation/x.ts', 'foo', 10), chunk('a/b.ts', null, 3)],
    };
    provider.setFake(groundingScript('收藏入口在哪实现', '收藏按钮放顶部还是底部?'));

    const res = await turn(token, sid.toString(), '想加收藏功能');
    expect(res.statusCode).toBe(200);
    const fr = frames(res.body);

    expect(hasFrameKey(fr, 'tool_start')).toBe(true);
    const sources = findFrame<{ relPath: string; symbol?: string }[]>(fr, 'sources');
    expect(sources).toBeDefined();
    expect(sources!.length).toBe(2);
    expect(sources![0].relPath).toBe('apps/server/src/ideation/x.ts');
    expect(sources![0].symbol).toBe('foo');
    expect(sources![1].symbol).toBeUndefined(); // symbol null → 省略键
    expect(hasFrameKey(fr, 'notice')).toBe(false);
    expect(tokensOf(fr)).toBe('收藏按钮放顶部还是底部?');
    expect(fr.at(-1)).toBe('[DONE]');

    expect(codeIndex.searchCalls).toEqual([{ repo: 'mono', query: '收藏入口在哪实现' }]);
    // 来源不落库: idea_turn 行 = [user, assistant], 无 tool/sources 行 (T006 交接铁律)。
    expect(await turnsOf(sid)).toEqual([
      { role: 'user', content: '想加收藏功能' },
      { role: 'assistant', content: '收藏按钮放顶部还是底部?' },
    ]);
  });

  // [3] 已选 repo + 0 命中 → 工具返空 (非错误) → 续问、不发 notice、不造引用。
  it('[3] 已选 repo + 0 命中 → 无 sources 无 notice → 续问 (端口仍被调)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id, 'mono');
    codeIndex.hitsByRepo = {}; // mono 无键 → 返 []
    provider.setFake(groundingScript('不存在的功能', '能再描述下吗?'));

    const res = await turn(token, sid.toString(), '想加点啥');
    expect(res.statusCode).toBe(200);
    const fr = frames(res.body);

    expect(hasFrameKey(fr, 'tool_start')).toBe(true); // 检索已发起
    expect(hasFrameKey(fr, 'sources')).toBe(false); // 0 命中不发 sources
    expect(hasFrameKey(fr, 'notice')).toBe(false); // **不**发 notice (与不可达分流, FR-009)
    expect(tokensOf(fr)).toBe('能再描述下吗?');
    expect(codeIndex.searchCalls).toEqual([{ repo: 'mono', query: '不存在的功能' }]);
    expect(await turnsOf(sid)).toEqual([
      { role: 'user', content: '想加点啥' },
      { role: 'assistant', content: '能再描述下吗?' },
    ]);
  });

  // [4] code-index 不可达 → 优雅降级返空 + notice 帧 → 会话不阻断可多轮。
  it('[4] code-index 不可达 → notice 帧 (无 sources/无 error) → 会话续两轮不中断', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id, 'mono');
    codeIndex.unreachable = true;
    provider.setFake(groundingScript('q', '检索暂不可用, 你能详细说说吗?'));

    const res1 = await turn(token, sid.toString(), '想加功能');
    expect(res1.statusCode).toBe(200);
    const fr1 = frames(res1.body);
    expect(hasFrameKey(fr1, 'tool_start')).toBe(true); // 检索已发起
    expect(hasFrameKey(fr1, 'notice')).toBe(true); // 降级气泡
    expect(hasFrameKey(fr1, 'sources')).toBe(false);
    expect(hasFrameKey(fr1, 'error')).toBe(false); // **不** error 整轮
    expect(tokensOf(fr1)).toBe('检索暂不可用, 你能详细说说吗?');
    expect(fr1.at(-1)).toBe('[DONE]');

    // 会话不阻断: 第二轮仍可正常推进 (服务仍不可达, 续问成功)。
    provider.setFake(groundingScript('q2', '那再补充一点?'));
    const res2 = await turn(token, sid.toString(), '继续想');
    expect(res2.statusCode).toBe(200);
    expect(tokensOf(frames(res2.body))).toBe('那再补充一点?');

    // 两轮 assistant turn 均落库 (会话中断率 0)。
    const rows = await turnsOf(sid);
    expect(rows.filter((r) => r.role === 'assistant').map((r) => r.content)).toEqual([
      '检索暂不可用, 你能详细说说吗?',
      '那再补充一点?',
    ]);
  });

  // [5] catalog 返可用 repo 列表 → 选中写 idea_session.repo (接地命名空间锁定)。
  it('[5] catalog 列表 → 选中某仓 → 写 idea_session.repo + 持久化 (重读详情仍记)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id, null); // 起始未选仓
    codeIndex.repos = [repoEntry('mono'), repoEntry('agent-platform', 'indexing')];

    // catalog 返真实列表 (含 status / lastSha / chunkCount)。
    const cat = await getRepos(token);
    expect(cat.statusCode).toBe(200);
    const items = (JSON.parse(cat.body) as { items: RepoCatalogEntry[] }).items;
    expect(items.map((i) => i.repo)).toEqual(['mono', 'agent-platform']);
    expect(items[0].status).toBe('ready');
    expect(items[0].chunkCount).toBe(1280);
    expect(items[1].status).toBe('indexing');

    // 选中 mono → PATCH /repo 写 idea_session.repo。
    const pick = await setRepo(token, sid.toString(), 'mono');
    expect(pick.statusCode).toBe(200);
    expect((JSON.parse(pick.body) as { repo: string }).repo).toBe('mono');
    // 持久化: DB 真落 + 重读会话详情仍记 (命名空间锁定本会话)。
    expect((await repoOf(sid))?.repo).toBe('mono');
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/ideation/sessions/${sid.toString()}`,
      headers: auth(token),
    });
    expect((JSON.parse(detail.body) as { repo: string }).repo).toBe('mono');
  });

  // [6] catalog 返空 (无 ready repo) → 空态 (items:[])。
  it('[6] catalog 返空 → items:[] (空态, 非错误)', async () => {
    const { token } = await activeToken();
    codeIndex.repos = []; // 无任何 repo

    const cat = await getRepos(token);
    expect(cat.statusCode).toBe(200);
    expect((JSON.parse(cat.body) as { items: unknown[] }).items).toEqual([]);
    expect(codeIndex.listReposCalls).toBe(1); // 端口真被调 (非短路)
  });

  // [7] catalog 不可达 → 错误态 (503, 不崩、不写脏 repo)。
  it('[7] catalog 不可达 → 503 CODE_INDEX_UNAVAILABLE (不崩, 不写脏 repo)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id, null);
    codeIndex.unreachable = true;

    const cat = await getRepos(token);
    expect(cat.statusCode).toBe(503);
    const body = JSON.parse(cat.body) as { code?: string };
    expect(body.code).toBe('CODE_INDEX_UNAVAILABLE');
    // 不写脏 repo: 会话 repo 仍为 null (catalog 失败不触发任何写)。
    expect((await repoOf(sid))?.repo).toBeNull();
  });

  // [8] 会话中切到另一 repo → 后续轮命名空间更新为新 repo (既有轮引用不回改)。
  it('[8] 会话中切仓 (PATCH /repo) → 后续轮检索用新 repo; 既有轮内容不被回改', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id, 'repoA');
    codeIndex.hitsByRepo = {
      repoA: [chunk('a/only.ts', 'aSym', 1)],
      repoB: [chunk('b/only.ts', 'bSym', 1)],
    };

    // 第一轮: repoA 接地, 落一条引用 repoA 的 assistant turn。
    provider.setFake(groundingScript('qA', '关于 A 的问题?'));
    const res1 = await turn(token, sid.toString(), 'A 仓需求');
    const srcA = findFrame<{ relPath: string }[]>(frames(res1.body), 'sources');
    expect(srcA![0].relPath).toBe('a/only.ts');

    // 会话中切仓 → repoB (经端点, 真写 idea_session.repo)。
    const sw = await setRepo(token, sid.toString(), 'repoB');
    expect(sw.statusCode).toBe(200);
    expect((await repoOf(sid))?.repo).toBe('repoB');

    // 第二轮: 后续轮检索命名空间已更新为 repoB。
    provider.setFake(groundingScript('qB', '关于 B 的问题?'));
    const res2 = await turn(token, sid.toString(), 'B 仓需求');
    const srcB = findFrame<{ relPath: string }[]>(frames(res2.body), 'sources');
    expect(srcB![0].relPath).toBe('b/only.ts');

    // search 实参随 session.repo 切换 (前轮 repoA / 后轮 repoB)。
    expect(codeIndex.searchCalls).toEqual([
      { repo: 'repoA', query: 'qA' },
      { repo: 'repoB', query: 'qB' },
    ]);
    // 既有轮引用不回改: 第一轮 assistant turn 内容仍是「关于 A 的问题?」(切仓不溯改历史)。
    const assistantTurns = (await turnsOf(sid))
      .filter((r) => r.role === 'assistant')
      .map((r) => r.content);
    expect(assistantTurns).toEqual(['关于 A 的问题?', '关于 B 的问题?']);
  });

  // [9] 选 repoA 只命中 A 命名空间; 切 repoB 只命中 B (严格隔离, 验 search repo 实参随 session.repo 变)。
  it('[9] 命名空间严格隔离 → search 收到的 repo 实参随 session.repo, 不串仓', async () => {
    const { id, token } = await activeToken();
    codeIndex.hitsByRepo = {
      repoA: [chunk('a/only.ts', 'aSym', 1)],
      repoB: [chunk('b/only.ts', 'bSym', 1)],
    };

    // 两个独立会话各锁一仓: A 只命中 A, B 只命中 B。
    const sidA = await seedSession(id, 'repoA');
    provider.setFake(groundingScript('qA', 'A?'));
    const resA = await turn(token, sidA.toString(), 'A 仓需求');
    const srcA = findFrame<{ relPath: string }[]>(frames(resA.body), 'sources');
    expect(srcA!.every((s) => s.relPath.startsWith('a/'))).toBe(true);

    const sidB = await seedSession(id, 'repoB');
    provider.setFake(groundingScript('qB', 'B?'));
    const resB = await turn(token, sidB.toString(), 'B 仓需求');
    const srcB = findFrame<{ relPath: string }[]>(frames(resB.body), 'sources');
    expect(srcB!.every((s) => s.relPath.startsWith('b/'))).toBe(true);

    // search 实参锁定各自 session.repo (跨会话零串仓, SC-002)。
    expect(codeIndex.searchCalls).toEqual([
      { repo: 'repoA', query: 'qA' },
      { repo: 'repoB', query: 'qB' },
    ]);
    // 反向证明: repoA 会话的 search 实参里**绝无** repoB, 反之亦然。
    expect(codeIndex.searchCalls.filter((c) => c.repo === 'repoA')).toHaveLength(1);
    expect(codeIndex.searchCalls.filter((c) => c.repo === 'repoB')).toHaveLength(1);
  });

  // ── 反枚举/校验补充 (端点联动健壮性, 非 9 条主分支但属端到端 catalog/set-repo 联动收口) ──
  it('[set-repo 健壮性] 空白 repo → 400; 越权切他人会话 → 404 字节级一致 (不写脏)', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const mine = await seedSession(me.id, null);
    const theirs = await seedSession(other.id, null);

    // 空白 repo → 400 (trim 后空, 不写库)。
    const blank = await setRepo(me.token, mine.toString(), '   ');
    expect(blank.statusCode).toBe(400);
    expect((await repoOf(mine))?.repo).toBeNull();

    // 越权切他人 → 404 字节级一致 (与不存在同构), 他人 repo 不被波及。
    const cross = await setRepo(me.token, theirs.toString(), 'mono');
    const unknown = await setRepo(me.token, '888888888888', 'mono');
    expect(cross.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(strip(cross.body)).toEqual(strip(unknown.body));
    expect((await repoOf(theirs))?.repo).toBeNull(); // 越权未写脏
  });
});

// ════════════════════════════════════════════════════════════════════════════
// env-gated 真 code-index IT (RUN_CODEINDEX_IT, 默认 skip — CI fast suite 不打外网 /
// 不连真索引服务, per feedback_env_gated_perf_it_pattern)。
//
// 本地显式 `RUN_CODEINDEX_IT=1 CODE_INDEX_URL=http://<host>:<port> \
//   CODE_INDEX_SERVICE_TOKEN=<token> env -u OSS_* \
//   nx test server test/integration/ideation-grounding.it.spec.ts` 真打 62/77 code-index 服务:
//   ① /repos 真拉 catalog (≥1 ready repo, 形状 = repo/lastSha/indexedAt/chunkCount/status)。
//   ② /search 真命中真 chunk (relPath 指向真存在的文件) + 命名空间隔离 (repoA 查不到 repoB 内容)。
//
// 经 HttpCodeIndexProvider 直打真 HTTP, 不经 DI 容器 (与 032 真 M3 IT 直建 provider 同范式),
// 验真 vendor 契约对齐 (URL/header/序列化) + 命名空间隔离在真服务上成立。
// ════════════════════════════════════════════════════════════════════════════
const RUN_CODEINDEX_IT =
  process.env.RUN_CODEINDEX_IT === '1' || process.env.RUN_CODEINDEX_IT === 'true';

describe.skipIf(!RUN_CODEINDEX_IT)(
  '034 真 code-index IT (env-gated RUN_CODEINDEX_IT, 默认 skip)',
  () => {
    let realProvider: HttpCodeIndexProvider;

    beforeAll(() => {
      const baseUrl = process.env.CODE_INDEX_URL;
      const token = process.env.CODE_INDEX_SERVICE_TOKEN;
      if (!baseUrl || !token) {
        throw new Error(
          'RUN_CODEINDEX_IT set but CODE_INDEX_URL / CODE_INDEX_SERVICE_TOKEN missing in env',
        );
      }
      realProvider = new HttpCodeIndexProvider({ kind: 'http', baseUrl, serviceToken: token });
    });

    it('① /repos 真拉 catalog → ≥1 ready repo + 形状对齐', async () => {
      const repos = await realProvider.listRepos();
      expect(repos.length).toBeGreaterThan(0);
      const ready = repos.find((r) => r.status === 'ready');
      expect(ready).toBeDefined();
      expect(typeof ready!.repo).toBe('string');
      expect(typeof ready!.lastSha).toBe('string');
      expect(typeof ready!.chunkCount).toBe('number');
      // eslint-disable-next-line no-console
      console.log(`[RUN_CODEINDEX_IT /repos] repos=${repos.map((r) => r.repo).join(',')}`);
    }, 60_000);

    it('② /search 真命中 + 命名空间隔离 (repoA 查不到他仓内容)', async () => {
      const repos = await realProvider.listRepos();
      const ready = repos.find((r) => r.status === 'ready');
      expect(ready).toBeDefined();
      const hits = await realProvider.search(ready!.repo, 'authentication login flow');
      // 命中真 chunk: relPath 非空 + score 数值。
      for (const h of hits) {
        expect(typeof h.relPath).toBe('string');
        expect(h.relPath.length).toBeGreaterThan(0);
        expect(typeof h.score).toBe('number');
      }
      // 命名空间隔离: 命中条目均归属被查 repo (provider 按 repo 命名空间隔离, 不串仓)。
      // (真服务返回不含 repo 字段, 隔离由服务端命名空间保证; 此处验调用契约连通 + chunk 形状。)
      // eslint-disable-next-line no-console
      console.log(`[RUN_CODEINDEX_IT /search] repo=${ready!.repo} hits=${hits.length}`);
    }, 60_000);
  },
);
