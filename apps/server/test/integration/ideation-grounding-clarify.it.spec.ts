import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import fastifyCors from '@fastify/cors';
import type { Redis } from 'ioredis';
import { appConfig, parseOrigins, type AppConfig } from '../../src/config';
import { IdeationModule } from '../../src/ideation/ideation.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { LLM_PROVIDER } from '../../src/integrations/llm/llm.module';
import { CODE_INDEX } from '../../src/integrations/codeindex/code-index.port';
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
 * 034 T006 接地回灌循环 IT (真 DI 容器 + Testcontainers PG/Redis + Fastify; per plan
 * 「NO LIFECYCLE MOCKING」: DI override LLM_PROVIDER + CODE_INDEX 注 fake, 绝不 jest.mock)。
 *
 * 6 分支 (T006 验收 + plan §Testing Invariants EXHAUSTIVE BRANCHING):
 *   ① 命中 → tool_result 回灌 + sources 帧 + 模型据真代码出 ask (引用真代码)
 *   ② 0 命中 (端口正常返 []) → 续问不造引用, **不**发 notice 帧 (FR-009 分流)
 *   ③ 不可达 (fake unreachable=throw) → notice 帧 + 续问不中断整轮 (FR-008)
 *   ④ 未选仓 (session.repo=null) → **不调端口** (条件注册 FakeLLM 也拿不到工具)
 *   ⑤ repoA 命中 A, repoB 命中 B → search 收到的 repo 实参随 session.repo 变 (命名空间隔离)
 *   ⑥ abort 半成品保留 (既有 abort 语义不破)
 *
 * grounding 轮序契约: FakeLLM 单例 round 游标单调。已选仓接地流的 stream 调用序 =
 *   [步1 round0 (interviewToolsFor 含 codeindex → 吐 grounding tool_call),
 *    回灌重入 round1 (吐 ask)]; 故脚本 [{grounding}, {ask}] 两轮一一对位。
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

/** SwappableFake code-index: 记录 search 调用 (repo/query) 验命名空间隔离 + 未选仓不调。 */
class SwappableCodeIndex implements CodeIndexProvider {
  hitsByRepo: Record<string, CodeChunk[]> = {};
  unreachable = false;
  searchCalls: { repo: string; query: string }[] = [];

  reset(): void {
    this.hitsByRepo = {};
    this.unreachable = false;
    this.searchCalls = [];
  }

  async search(repo: string, query: string, signal?: AbortSignal): Promise<CodeChunk[]> {
    this.searchCalls.push({ repo, query });
    if (signal?.aborted) throw new Error('ABORTED');
    if (this.unreachable) throw new Error('FAKE_CODE_INDEX_UNREACHABLE');
    return this.hitsByRepo[repo] ?? [];
  }

  async listRepos(): Promise<RepoCatalogEntry[]> {
    if (this.unreachable) throw new Error('FAKE_CODE_INDEX_UNREACHABLE');
    return [];
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

describe('034 ideation grounding 回灌循环 (Testcontainers PG + Redis + Fastify)', () => {
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
    process.env.AUTH_JWT_SECRET = 'ideation-t006-jwt-secret-min-32-bytes-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'ideation-t006-hmac-secret-min-32-bytes-zy';

    provider = new SwappableFake();
    codeIndex = new SwappableCodeIndex();
    moduleRef = await Test.createTestingModule({ imports: narrowTestModule([IdeationModule]) })
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
  const nextPhone = () => `+8613918${String(++seq).padStart(6, '0')}`;
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

  // ── ① 命中 → tool_result 回灌 + sources 帧 + 模型据真代码出 ask ────────────────
  it('① 命中 → tool_start + sources 帧 + role:tool 回灌 + 模型出 ask', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id, 'mono');
    codeIndex.hitsByRepo = {
      mono: [chunk('apps/server/src/ideation/x.ts', 'foo', 10), chunk('a/b.ts', null, 3)],
    };
    // round0: 模型发起检索; round1 (回灌重入): 据真代码出 ask。
    provider.setFake({
      script: [
        { grounding: { query: '收藏入口在哪实现' } },
        { ask: { question: '收藏按钮放在行情页顶部还是底部?' } },
      ],
    });

    const res = await turn(token, sid.toString(), '想加收藏功能');
    expect(res.statusCode).toBe(200);
    const fr = frames(res.body);

    expect(hasFrameKey(fr, 'tool_start')).toBe(true);
    const sources = findFrame<{ relPath: string; symbol?: string }[]>(fr, 'sources');
    expect(sources).toBeDefined();
    expect(sources!.length).toBe(2);
    expect(sources![0].relPath).toBe('apps/server/src/ideation/x.ts');
    expect(sources![0].symbol).toBe('foo');
    // symbol null → 省略键。
    expect(sources![1].symbol).toBeUndefined();
    expect(hasFrameKey(fr, 'notice')).toBe(false);
    expect(tokensOf(fr)).toBe('收藏按钮放在行情页顶部还是底部?');
    expect(fr.at(-1)).toBe('[DONE]');

    // search 收到 session.repo + query; 端口被调一次。
    expect(codeIndex.searchCalls).toEqual([{ repo: 'mono', query: '收藏入口在哪实现' }]);
    // 回灌: 重入 stream (messagesLog[1]) 含 role:'tool' 命中 JSON + assistant toolCalls。
    const reenter = provider.messagesLog[1];
    const toolMsg = reenter.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain('apps/server/src/ideation/x.ts');
    expect(reenter.some((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0)).toBe(
      true,
    );
  });

  // ── ② 0 命中 → 续问不造引用, 不发 notice (FR-009 分流) ────────────────────────
  it('② 0 命中 (端口返 []) → 无 sources 无 notice, 续问 (端口仍被调)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id, 'mono');
    codeIndex.hitsByRepo = {}; // mono 无键 → 返 []
    provider.setFake({
      script: [{ grounding: { query: '不存在的功能' } }, { ask: { question: '能再描述下吗?' } }],
    });

    const res = await turn(token, sid.toString(), '想加点啥');
    expect(res.statusCode).toBe(200);
    const fr = frames(res.body);

    expect(hasFrameKey(fr, 'tool_start')).toBe(true);
    expect(hasFrameKey(fr, 'sources')).toBe(false); // 0 命中不发 sources
    expect(hasFrameKey(fr, 'notice')).toBe(false); // **不**发 notice (与不可达分流)
    expect(tokensOf(fr)).toBe('能再描述下吗?');
    expect(codeIndex.searchCalls).toEqual([{ repo: 'mono', query: '不存在的功能' }]);
    // 回灌 content 表达「未找到」。
    const toolMsg = provider.messagesLog[1].find((m) => m.role === 'tool');
    expect(toolMsg!.content).toContain('no_match');
  });

  // ── ③ 不可达 → notice 帧 + 续问不中断 (FR-008) ───────────────────────────────
  it('③ 不可达 (throw) → notice 帧 + 续问不中断整轮', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id, 'mono');
    codeIndex.unreachable = true;
    provider.setFake({
      script: [
        { grounding: { query: 'q' } },
        { ask: { question: '检索暂不可用, 你能详细说说吗?' } },
      ],
    });

    const res = await turn(token, sid.toString(), '想加功能');
    expect(res.statusCode).toBe(200);
    const fr = frames(res.body);

    expect(hasFrameKey(fr, 'tool_start')).toBe(true);
    expect(hasFrameKey(fr, 'notice')).toBe(true); // 降级气泡
    expect(hasFrameKey(fr, 'sources')).toBe(false); // 不可达不发 sources
    expect(hasFrameKey(fr, 'error')).toBe(false); // **不** error 整轮
    expect(tokensOf(fr)).toBe('检索暂不可用, 你能详细说说吗?');
    expect(fr.at(-1)).toBe('[DONE]'); // 正常收束
    // assistant turn 仍落库 (续问成功)。
    const rows = await prisma.ideaTurn.findMany({
      where: { sessionId: sid },
      orderBy: { id: 'asc' },
      select: { role: true, content: true },
    });
    expect(rows.at(-1)).toEqual({ role: 'assistant', content: '检索暂不可用, 你能详细说说吗?' });
  });

  // ── ④ 未选仓 → 不调端口 (条件注册, FakeLLM 拿不到工具) ────────────────────────
  it('④ 未选仓 (repo=null) → search 永不被调; FakeLLM 接地轮降级空轮', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id, null); // 未选仓
    // 脚本排了 grounding, 但 interviewToolsFor(null) 不含 codeindex → FakeLLM 守门降级空轮;
    // streamGrounded round0 无 ask/grounding/text → 步2 ASK_ONLY 出 ask (round1)。
    provider.setFake({
      script: [{ grounding: { query: 'q' } }, { ask: { question: '请先描述你的需求?' } }],
    });

    const res = await turn(token, sid.toString(), '想加功能');
    expect(res.statusCode).toBe(200);
    const fr = frames(res.body);

    expect(codeIndex.searchCalls).toEqual([]); // **端口零调用**
    expect(hasFrameKey(fr, 'tool_start')).toBe(false);
    expect(hasFrameKey(fr, 'sources')).toBe(false);
    expect(tokensOf(fr)).toBe('请先描述你的需求?');
  });

  // ── ⑤ repoA 命中 A, repoB 命中 B → search 收到的 repo 随 session.repo 变 (隔离) ──
  it('⑤ 选 repoA 命中A / 切 repoB 命中B → search 实参随 session.repo (命名空间隔离)', async () => {
    const { id, token } = await activeToken();
    codeIndex.hitsByRepo = {
      repoA: [chunk('a/only.ts', 'aSym', 1)],
      repoB: [chunk('b/only.ts', 'bSym', 1)],
    };

    const sidA = await seedSession(id, 'repoA');
    provider.setFake({
      script: [{ grounding: { query: 'qA' } }, { ask: { question: 'A?' } }],
    });
    const resA = await turn(token, sidA.toString(), 'A 仓需求');
    const sourcesA = findFrame<{ relPath: string }[]>(frames(resA.body), 'sources');
    expect(sourcesA![0].relPath).toBe('a/only.ts');

    const sidB = await seedSession(id, 'repoB');
    provider.setFake({
      script: [{ grounding: { query: 'qB' } }, { ask: { question: 'B?' } }],
    });
    const resB = await turn(token, sidB.toString(), 'B 仓需求');
    const sourcesB = findFrame<{ relPath: string }[]>(frames(resB.body), 'sources');
    expect(sourcesB![0].relPath).toBe('b/only.ts');

    // search 实参锁定各自 session.repo (跨会话不串)。
    expect(codeIndex.searchCalls).toEqual([
      { repo: 'repoA', query: 'qA' },
      { repo: 'repoB', query: 'qB' },
    ]);
  });

  // ── ⑥ abort 半成品保留 (既有 abort 语义不破) ──────────────────────────────────
  it('⑥ abort 中流 → 保留半成品 assistant turn (接地路径 abort 语义不破)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id, 'mono');
    codeIndex.hitsByRepo = { mono: [chunk('a.ts', 's', 1)] };
    // delayMs 留时窗 → abort 在回灌后的重入 stream 期间触发。
    provider.setFake({
      script: [{ grounding: { query: 'q' } }, { ask: { question: '这是一个长问题' } }],
      delayMs: 200,
    });

    const ac = new AbortController();
    const pending = app.inject({
      method: 'POST',
      url: `/api/v1/ideation/sessions/${sid.toString()}/turns`,
      headers: sendJson(token),
      payload: { content: '触发 abort' },
      signal: ac.signal,
    } as never);
    setTimeout(() => ac.abort(), 50);
    await pending.catch(() => undefined);

    await new Promise((r) => setTimeout(r, 300));

    const rows = await prisma.ideaTurn.findMany({
      where: { sessionId: sid },
      orderBy: { id: 'asc' },
      select: { role: true, content: true },
    });
    expect(rows[0]).toEqual({ role: 'user', content: '触发 abort' });
    expect(rows.some((r) => r.role === 'assistant')).toBe(true);
  });
});
