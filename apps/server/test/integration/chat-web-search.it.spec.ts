import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { msgText } from '../_support/msg-text';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import fastifyCors from '@fastify/cors';
import { appConfig, parseOrigins, type AppConfig } from '../../src/config';
import type { Redis } from 'ioredis';
import { AppModule } from '../../src/app/app.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmStreamEvent,
  type LlmStreamOptions,
  type ToolDef,
} from '../../src/integrations/llm/llm-provider.port';
import {
  FakeLlmProvider,
  type FakeLlmProviderConfig,
} from '../../src/integrations/llm/fake-llm.provider';
import {
  SEARCH_PROVIDER,
  type SearchProvider,
  type SearchResult,
  type SearchOptions,
} from '../../src/chat/search-provider.port';
import {
  FakeSearchProvider,
  type FakeSearchProviderConfig,
} from '../../src/chat/fake-search.provider';
import { SendMessageUseCase } from '../../src/chat/send-message.usecase';
import type { Msg } from '../../src/chat/chat-context.rules';

/**
 * 030 T020 (A1 amend) 统一联网 ReAct loop state_branches IT — 真 DI 容器 (全 boot `AppModule`
 * 含 ChatModule) + Testcontainers PG/Redis + Fastify, per plan「NO LIFECYCLE MOCKING」:
 * LLM_PROVIDER / SEARCH_PROVIDER 经 **DI override** 注 Fake (绝不 jest.mock / new XxxProvider())。
 * 全 boot AppModule (非裸 ChatModule), 因 ChatModule → AccountModule 依赖全局 ThrottlerModule
 * (与 chat-streaming.it / llm-tool-stream.it 同款)。
 *
 * **A1 amend (T019/T020)**: 去 `webSearch` per-message gate → ChatGPT 式统一联网。所有会话/模型
 * 默认走 ReAct loop (恒挂 web_search 工具 + 恒 prepend system 含联网 steering + 日期; 模型
 * `tool_choice:'auto'` 自决检索)。`metadata.webSearch` → `metadata.searched` (实际是否发生
 * tool_call)。删原 OFF/无联网回归分支, 加「MiniMax 同走 loop (不再按模型 gate)」。
 *
 * 覆盖 spec state_branches server 可验分支 (A1 改造后):
 *  ① 默认发送 → 恒注入 system (platformBase + steering + 当日日期) + 恒挂 web_search 工具;
 *     模型纯文本不检索 → search 0 次, metadata.searched=false (等价旧单轮收敛) /
 *  ② MiniMax 会话同样走 loop → 不再按模型 gate (scripted tool_call → 真检索) /
 *  ③ 模型自决不检索 (寒暄/常识, 无 tool_call → text) → 零成本路径, searched=false /
 *  ④ 多轮去重编号 (scripted 2 轮重叠 URL → metadata.sources 编号唯一) /
 *  ⑤ 超时/error 降级 → degraded=true + degraded 帧 + user msg 不丢 + AI msg 仍落 /
 *  ⑥ 零结果不标 degraded (searched=true, sources=[], degraded=false) /
 *  ⑦ max-3-轮兜底 (持续吐 tool_call → 第 4 次 stream 不附 tools 收敛) /
 *  ⑧ 流中 abort → 中断整链 + 半成品 status=stopped + 已有 sources 保留 /
 *  ⑨ 越权 404 字节级一致 (反枚举) /
 *  ⑩ 未认证 401 /
 *  ⑪ flash 可联网 / ⑫ pro 可联网 /
 *  ⑬ sources 落 metadata (NumberedSource 形状) + SSE sources 帧 /
 *  ⑭ 冷启动 GET messages 回填 metadata.searched/sources/degraded /
 *  ⑮ 降级后再 stream 不再附 tools (loop 收敛不二次检索)。
 */

/** 单 DI override fake llm, 内核逐 test 换 (记录最后收到的 messages + 每次 stream 的 tools)。 */
class SwappableFakeLlm implements LlmProvider {
  private inner: FakeLlmProvider = new FakeLlmProvider({ tokens: [] });
  lastMessages: Msg[] = [];
  /** 每次 stream 调用收到的 tools (验降级/收敛轮是否附 tools)。 */
  toolsPerCall: (ToolDef[] | undefined)[] = [];

  set(config: FakeLlmProviderConfig): void {
    this.inner = new FakeLlmProvider(config);
    this.lastMessages = [];
    this.toolsPerCall = [];
  }

  stream(messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    this.lastMessages = messages;
    this.toolsPerCall.push(opts.tools);
    return this.inner.stream(messages, opts);
  }
}

/** 单 DI override fake search, 内核逐 test 换 (记录调用次数 + query)。 */
class SwappableFakeSearch implements SearchProvider {
  private inner: FakeSearchProvider = new FakeSearchProvider();
  calls = 0;
  queries: string[] = [];

  set(config: FakeSearchProviderConfig): void {
    this.inner = new FakeSearchProvider(config);
    this.calls = 0;
    this.queries = [];
  }

  search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    this.calls += 1;
    this.queries.push(query);
    return this.inner.search(query, opts);
  }
}

describe('030 chat web search 统一 ReAct loop (AppModule 全 boot DI + Testcontainers PG/Redis)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let llm: SwappableFakeLlm;
  let searcher: SwappableFakeSearch;
  let sendMessage: SendMessageUseCase;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'chat-t020-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'chat-t020-hmac-secret-min-32-bytes-zyx';
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-placeholder-key';

    llm = new SwappableFakeLlm();
    searcher = new SwappableFakeSearch();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(llm)
      .overrideProvider(SEARCH_PROVIDER)
      .useValue(searcher)
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
    sendMessage = moduleRef.get(SendMessageUseCase);
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
  async function activeAccount(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  async function newConversation(
    accountId: bigint,
    model = 'flash',
    title = '新对话',
  ): Promise<bigint> {
    const c = await prisma.conversation.create({
      data: { accountId, title, model },
      select: { id: true },
    });
    return c.id;
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const sendJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });

  const send = (token: string, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${id}/messages`,
      headers: sendJson(token),
      payload,
    });

  const getMessages = (token: string, id: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${id}/messages`,
      headers: auth(token),
    });

  /** 把 SSE body 切成帧 payload (去 `data:` 前缀, 丢空帧)。 */
  const frames = (body: string): string[] =>
    body
      .split('\n\n')
      .filter((f) => f.startsWith('data:'))
      .map((f) => f.slice('data:'.length));

  const strip = (raw: string) => {
    const { traceId, instance, ...rest } = JSON.parse(raw) as Record<string, unknown>;
    void traceId;
    void instance;
    return rest;
  };

  const messageRows = (conversationId: bigint) =>
    prisma.message.findMany({
      where: { conversationId },
      orderBy: { id: 'asc' },
      select: { role: true, content: true, status: true, metadata: true },
    });

  const src = (title: string, url: string, extra: Partial<SearchResult> = {}): SearchResult => ({
    title,
    url,
    snippet: `摘要 ${title}`,
    ...extra,
  });

  // ── ① 默认发送 → 恒注入 system + 恒挂 web_search 工具; 模型不检索 → searched=false ───
  it('① 默认发送 → system 注入 platformBase+steering+当日日期 + 每轮挂 web_search 工具 (A1 统一联网)', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    // 模型纯文本不检索 (无 tool_call) → 等价旧单轮收敛。
    llm.set({ script: [{ tokens: ['你好', '世界'] }] });
    searcher.set({}); // 重置共享计数 (验不触达 search)

    const res = await send(token, cid.toString(), { content: '你好' });
    expect(res.statusCode).toBe(200);
    const fr = frames(res.body);
    expect(fr.at(-1)).toBe('[DONE]');

    // 模型自决不检索 → search 0 次, 但 web_search 工具恒附 (统一联网, 非按入参/模型 gate)。
    expect(searcher.calls).toBe(0);
    expect(llm.toolsPerCall.every((t) => t !== undefined && t.length > 0)).toBe(true);

    // system 恒注入: 平台基座层在最前 (恒注入最高优先), 联网 steering + 当日日期随后。
    const first = llm.lastMessages[0]!;
    const sys = msgText(first.content);
    expect(first.role).toBe('system');
    expect(sys.startsWith('你是「不负光阴」App 的 AI 助手')).toBe(true);
    expect(sys).toContain('web_search');
    expect(sys).toContain('当前时间');
    expect(sys).toContain(String(new Date().getFullYear()));
    // 顺序: platformBase 先于联网 steering。
    expect(sys.indexOf('不负光阴')).toBeLessThan(sys.indexOf('web_search'));

    const msgs = await messageRows(cid);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    // 未检索 → metadata searched=false, degraded=false, sources=[] (恒写, 非 null)。
    expect(msgs[1]!.metadata).toMatchObject({ searched: false, degraded: false, sources: [] });
  });

  // ── ② MiniMax 会话同样走 loop → 不再按模型 gate ─────────────────────────────────
  it('② MiniMax 会话 (model=minimax) 同样走 loop → 不再按模型 gate, scripted tool_call 真检索', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id, 'minimax');
    llm.set({
      script: [{ toolCall: { name: 'web_search', args: { query: 'm3查' } } }, { tokens: ['答'] }],
    });
    searcher.set({ results: [[src('M', 'https://m3.com/r')]] });

    const res = await send(token, cid.toString(), { content: '实时问' });
    expect(res.statusCode).toBe(200);
    // 关键: minimax 会话也真发起检索 (send-message 不再按 conversation.model gate 联网)。
    expect(searcher.calls).toBe(1);
    const msgs = await messageRows(cid);
    const meta = msgs[1]!.metadata as { searched: boolean; sources: { url: string }[] };
    expect(meta.searched).toBe(true);
    expect(meta.sources.map((s) => s.url)).toEqual(['https://m3.com/r']);
  });

  // ── ③ 模型自决不检索 → text 收敛, 不调 search, searched=false (零成本路径) ──────────
  it('③ 模型自决不检索 (寒暄/常识, 无 tool_call → text) → 不调 search, searched=false sources=[]', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    llm.set({ script: [{ tokens: ['寒暄', '无需', '检索'] }] });
    searcher.set({}); // 重置共享计数 (验不触达 search)

    const res = await send(token, cid.toString(), { content: '你好呀' });
    expect(res.statusCode).toBe(200);
    expect(searcher.calls).toBe(0);

    const msgs = await messageRows(cid);
    const meta = msgs[1]!.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ searched: false, degraded: false, sources: [] });
  });

  // ── ④ 多轮去重编号 → 2 轮重叠 URL, metadata.sources 编号唯一稳定 ───────────────
  it('④ 多轮检索重叠 URL → 去重 + 全局唯一编号 (FR-006)', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    // 轮1 tool_call → search 返 a,b; 轮2 tool_call → search 返 b(重叠),c; 轮3 收敛 text。
    llm.set({
      script: [
        { toolCall: { name: 'web_search', args: { query: 'q1' } } },
        { toolCall: { name: 'web_search', args: { query: 'q2' } } },
        { tokens: ['综合', '作答'] },
      ],
    });
    searcher.set({
      results: [
        [src('A', 'https://x.com/a'), src('B', 'https://x.com/b')],
        [src('B2', 'https://x.com/b'), src('C', 'https://x.com/c')],
      ],
    });

    const res = await send(token, cid.toString(), { content: '查实时' });
    expect(res.statusCode).toBe(200);
    expect(searcher.calls).toBe(2);

    const msgs = await messageRows(cid);
    const meta = msgs[1]!.metadata as {
      searched: boolean;
      sources: { index: number; url: string }[];
    };
    expect(meta.searched).toBe(true);
    // 去重: a,b,c 三条 (b 仅一次); 编号 1,2,3 唯一稳定。
    expect(meta.sources.map((s) => s.url)).toEqual([
      'https://x.com/a',
      'https://x.com/b',
      'https://x.com/c',
    ]);
    expect(meta.sources.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  // ── ⑤ 超时/error 降级 → degraded=true + degraded 帧 + user/AI msg 都在 ─────────
  it('⑤ search throw → degraded=true (帧+metadata), user msg 不丢, AI msg 仍落', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    llm.set({
      script: [
        { toolCall: { name: 'web_search', args: { query: '会失败' } } },
        { tokens: ['基于', '已有', '知识'] }, // 降级后无 tools 收敛
      ],
    });
    searcher.set({ error: true });

    const res = await send(token, cid.toString(), { content: '查会失败的' });
    expect(res.statusCode).toBe(200);
    const fr = frames(res.body);
    // 含 degraded 帧
    expect(fr.some((f) => f.includes('"degraded":true'))).toBe(true);
    // 流正常收尾 [DONE] (降级非 error)
    expect(fr.at(-1)).toBe('[DONE]');

    const msgs = await messageRows(cid);
    expect(msgs[0]).toMatchObject({ role: 'user', content: '查会失败的', status: 'completed' });
    const ai = msgs[1]!;
    expect(ai.role).toBe('assistant');
    expect(ai.status).toBe('completed');
    const meta = ai.metadata as Record<string, unknown>;
    expect(meta.degraded).toBe(true);
    // 降级前已发生 tool_call → searched=true。
    expect(meta.searched).toBe(true);
  });

  // ── ⑥ 零结果不标 degraded (searched=true, sources=[], degraded=false) ──────────
  it('⑥ search 返空数组 → 不标 degraded (零结果是正常结果), 但 searched=true', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    llm.set({
      script: [
        { toolCall: { name: 'web_search', args: { query: '无果' } } },
        { tokens: ['没有', '找到'] },
      ],
    });
    searcher.set({ results: [[]] }); // 第一次检索返空

    await send(token, cid.toString(), { content: '查个查不到的' });
    expect(searcher.calls).toBe(1);

    const msgs = await messageRows(cid);
    const meta = msgs[1]!.metadata as Record<string, unknown>;
    // 搜了 (searched=true) 但零结果 → 不降级、sources 空 (三态可分)。
    expect(meta).toMatchObject({ searched: true, degraded: false, sources: [] });
  });

  // ── ⑦ max-3-轮兜底 → 持续吐 tool_call 也最多检索 3 轮, 第 4 次 stream 无 tools 收敛 ─
  it('⑦ 模型每轮都吐 tool_call → 最多 3 轮检索, 兜底无 tools 收敛 (FR-010)', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    // 4 轮全 tool_call (模型不收敛); 第 5 轮即便 fake 越界返空轮。
    llm.set({
      script: [
        { toolCall: { name: 'web_search', args: { query: 'r1' } } },
        { toolCall: { name: 'web_search', args: { query: 'r2' } } },
        { toolCall: { name: 'web_search', args: { query: 'r3' } } },
        { toolCall: { name: 'web_search', args: { query: 'r4' } } },
        { tokens: ['兜底', '作答'] },
      ],
    });
    searcher.set({
      results: [
        [src('1', 'https://m.com/1')],
        [src('2', 'https://m.com/2')],
        [src('3', 'https://m.com/3')],
        [src('4', 'https://m.com/4')],
      ],
    });

    const res = await send(token, cid.toString(), { content: '反复检索' });
    expect(res.statusCode).toBe(200);
    // 检索次数封顶 3 (max 3 轮)
    expect(searcher.calls).toBe(3);
    // 最后一次 stream (兜底收敛) 不附 tools
    expect(llm.toolsPerCall.at(-1)).toBeUndefined();
  });

  // ── ⑧ 流中 abort → 中断整链 + 半成品 stopped + 已有 sources 保留 ────────────────
  it('⑧ 中流 abort → 中断整链, AI msg status=stopped, 已检索 sources 保留 (FR-011)', async () => {
    const { id } = await activeAccount();
    const cid = await newConversation(id);
    // 轮1: tool_call → search 成功; 轮2: 慢 token, abort 在第 1 个 token 后。
    llm.set({
      script: [
        { toolCall: { name: 'web_search', args: { query: '查' } } },
        { tokens: ['半', '成', '品', '不该全出'] },
      ],
    });
    searcher.set({ results: [[src('S', 'https://stop.com/s')]] });

    const controller = new AbortController();
    const seen: string[] = [];
    const outcome = await sendMessage.execute(
      {
        accountId: id,
        conversationId: cid,
        content: '慢答',
        signal: controller.signal,
      },
      (t) => {
        seen.push(t);
        if (seen.length === 1) controller.abort();
      },
    );
    expect(outcome.kind).toBe('stopped');

    const msgs = await messageRows(cid);
    expect(msgs[0]).toMatchObject({ role: 'user', content: '慢答', status: 'completed' });
    const ai = msgs[1]!;
    expect(ai.status).toBe('stopped');
    // 已检索 sources 保留 + searched=true
    const meta = ai.metadata as {
      searched: boolean;
      sources: { url: string }[];
      degraded: boolean;
    };
    expect(meta.searched).toBe(true);
    expect(meta.sources.map((s) => s.url)).toEqual(['https://stop.com/s']);
    // abort 引起的 search 取消不算降级 (这里 search 在 abort 前已成功)
    expect(meta.degraded).toBe(false);
  });

  // ── ⑨ 越权 404 字节级一致 ─────────────────────────────────────────────────────
  it('⑨ 他人/不存在/非数字 conversationId → 404 字节级一致 (反枚举)', async () => {
    const { token } = await activeAccount();
    const other = await activeAccount();
    const theirs = await newConversation(other.id);
    llm.set({ script: [{ tokens: ['x'] }] });
    searcher.set({}); // 重置计数 (验前置 404 路径不触达 search)

    const cross = await send(token, theirs.toString(), { content: 'hi' });
    const unknown = await send(token, '888888888888', { content: 'hi' });
    const nonNumeric = await send(token, 'abc', { content: 'hi' });

    expect(cross.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(nonNumeric.statusCode).toBe(404);
    expect(strip(cross.body)).toEqual(strip(unknown.body));
    expect(strip(cross.body)).toEqual(strip(nonNumeric.body));
    // search 未被调用 (前置校验在 loop 前)
    expect(searcher.calls).toBe(0);
    expect(await messageRows(theirs)).toEqual([]);
  });

  // ── ⑩ 未认证 401 ──────────────────────────────────────────────────────────────
  it('⑩ 未认证 → 401', async () => {
    const { id } = await activeAccount();
    const cid = await newConversation(id);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${cid}/messages`,
      headers: { 'content-type': 'application/json' },
      payload: { content: 'hi' },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── ⑪/⑫ flash & pro 均可联网 ──────────────────────────────────────────────────
  for (const model of ['flash', 'pro'] as const) {
    it(`⑪/⑫ model=${model} 可联网 → 检索 + sources 落 metadata`, async () => {
      const { id, token } = await activeAccount();
      const cid = await newConversation(id, model);
      llm.set({
        script: [
          { toolCall: { name: 'web_search', args: { query: `${model}查` } } },
          { tokens: ['答'] },
        ],
      });
      searcher.set({ results: [[src('R', `https://${model}.com/r`)]] });

      const res = await send(token, cid.toString(), { content: '实时问' });
      expect(res.statusCode).toBe(200);
      expect(searcher.calls).toBe(1);
      const msgs = await messageRows(cid);
      const meta = msgs[1]!.metadata as { sources: { url: string }[] };
      expect(meta.sources.map((s) => s.url)).toEqual([`https://${model}.com/r`]);
    });
  }

  // ── ⑬ sources 落 metadata (NumberedSource 形状) ───────────────────────────────
  it('⑬ sources 落 metadata: {index,title,url,publishedAt?} 形状 + SSE sources 帧', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    llm.set({
      script: [{ toolCall: { name: 'web_search', args: { query: '查' } } }, { tokens: ['答'] }],
    });
    searcher.set({
      results: [[src('标题', 'https://meta.com/1', { publishedAt: 1_700_000_000_000 })]],
    });

    const res = await send(token, cid.toString(), { content: '查带时间的' });
    const fr = frames(res.body);
    // SSE sources 帧 (收尾前)
    const sourcesFrame = fr.find((f) => f.includes('"sources"') && f.includes('"index"'));
    expect(sourcesFrame).toBeTruthy();

    const msgs = await messageRows(cid);
    const meta = msgs[1]!.metadata as { sources: Record<string, unknown>[] };
    expect(meta.sources[0]).toEqual({
      index: 1,
      title: '标题',
      url: 'https://meta.com/1',
      publishedAt: 1_700_000_000_000,
    });
  });

  // ── ⑭ 冷启动 GET messages 回填 metadata ───────────────────────────────────────
  it('⑭ 冷启动 GET messages → 回填 assistant metadata.searched/sources/degraded (SC-003)', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    llm.set({
      script: [{ toolCall: { name: 'web_search', args: { query: '查' } } }, { tokens: ['答'] }],
    });
    searcher.set({ results: [[src('冷启动源', 'https://cold.com/1')]] });
    await send(token, cid.toString(), { content: '查实时' });

    // 冷启动: GET messages 回填
    const res = await getMessages(token, cid.toString());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      messages: { role: string; metadata?: { searched: boolean; sources: { url: string }[] } }[];
    };
    const assistant = body.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.metadata?.searched).toBe(true);
    expect(assistant.metadata?.sources.map((s) => s.url)).toEqual(['https://cold.com/1']);
    // user 消息无 metadata (null → 不返回字段或 null)
    const user = body.messages.find((m) => m.role === 'user')!;
    expect(user.metadata == null).toBe(true);
  });

  // ── ⑮ 降级后不再附 tools (收敛不二次检索) ─────────────────────────────────────
  it('⑮ 降级后兜底 stream 不再附 tools (停检索, FR-009)', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    llm.set({
      script: [
        { toolCall: { name: 'web_search', args: { query: '失败查' } } },
        { tokens: ['降级', '作答'] },
      ],
    });
    searcher.set({ error: true });

    await send(token, cid.toString(), { content: '会降级' });
    // 仅 1 次检索尝试 (失败后停)
    expect(searcher.calls).toBe(1);
    // 第 1 次 stream 附 tools, 兜底 stream 不附 tools
    expect(llm.toolsPerCall[0]).toBeDefined();
    expect(llm.toolsPerCall.at(-1)).toBeUndefined();
  });
});
