import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { msgText } from '../_support/msg-text';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import fastifyCors from '@fastify/cors';
import { appConfig, parseOrigins, type AppConfig } from '../../src/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
} from '../../src/integrations/llm/llm-provider.port';
import {
  FakeLlmProvider,
  type FakeLlmProviderConfig,
} from '../../src/integrations/llm/fake-llm.provider';
import { DeepseekProvider } from '../../src/integrations/llm/deepseek.provider';
import { SendMessageUseCase } from '../../src/chat/send-message.usecase';
import type { Msg } from '../../src/chat/chat-context.rules';

// 仅供下方 env-gated 真 vendor 块读 apps/server/.env 的真 key 用（vitest cwd = apps/server）。
// 共享 PG fixture 转正后主体不再需要它，但那个块仍要 —— 2026-08-02 P4.1 曾连同删掉，
// 因该块恒 skip（T-4）+ test/ 不 typecheck 也不 lint（T-2），断了两天没人发现。
const SERVER_DIR = process.cwd();

/**
 * 027 T007 流式发消息 UC + SSE controller IT (真 DI 容器 + Testcontainers PG/Redis +
 * Fastify, per plan「NO LIFECYCLE MOCKING」: 经 DI override LLM_PROVIDER 注入
 * FakeLlmProvider, 绝不 jest.mock / new XxxGuard())。
 *
 * 覆盖 T007 落库语义 (Clarify):
 *  ① 发消息 → user + AI msg 落库 completed (SSE drip token + [DONE]) /
 *  ② 多轮 → buildContext 把历史喂进 provider 收到的 messages /
 *  ③ 停止 (abort 中流) → 落已生成半成品 AI msg status=stopped (UC 层, 真 DI + 真 PG) /
 *  ④ provider 失败 → 不落 AI msg 但 user msg 在 + error 帧 /
 *  ⑤ 空输入 → 拒 (400, user msg 不落) /
 *  ⑥ 他人/不存在/非数字 conversationId → 404 字节级一致 (反枚举) /
 *  ⑦ 未认证 → 401。
 *
 * provider 注入: 用 SwappableFakeProvider 包一个可逐 test 替换内核的 fake, 经 DI
 * override 一次, 各 test 调 setFake({...}) 定制 token 序列 / errorAfter / delay。
 */

/** 单 DI override, 内核 fake 逐 test 可换 (并记录最后收到的 messages 供多轮断言)。 */
class SwappableFakeProvider implements LlmProvider {
  private inner: FakeLlmProvider = new FakeLlmProvider({ tokens: [] });
  lastMessages: Msg[] = [];

  setFake(config: FakeLlmProviderConfig): void {
    this.inner = new FakeLlmProvider(config);
  }

  stream(messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    this.lastMessages = messages;
    return this.inner.stream(messages, opts);
  }
}

describe('027 chat streaming send-message (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let provider: SwappableFakeProvider;
  let sendMessage: SendMessageUseCase;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'chat-t007-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'chat-t007-hmac-secret-min-32-bytes-zyxwv';
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-placeholder-key';

    provider = new SwappableFakeProvider();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(provider)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    // 镜像 main.ts 注册 @fastify/cors (CORS 在 AppModule 之外注册, 故 IT 须显式注册才能
    // 验 SSE hijack 路径不丢跨域头 — 见测 ⑨)。须在 routes mount (app.init) 前注册。
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
    await redis.flushall(); // 隔离限流桶
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613916${String(++seq).padStart(6, '0')}`;
  async function activeAccount(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  async function newConversation(accountId: bigint, title = '新对话'): Promise<bigint> {
    const c = await prisma.conversation.create({
      data: { accountId, title, model: 'deepseek-chat' },
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

  const messagesOf = (conversationId: bigint) =>
    prisma.message.findMany({
      where: { conversationId },
      orderBy: { id: 'asc' },
      select: { role: true, content: true, status: true },
    });

  // ── ① 发消息 → user + AI msg 落库 completed (SSE drip + DONE) ───────────────
  it('① 发消息 → SSE drip token + [DONE]; user + AI msg 落库 completed', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    provider.setFake({ tokens: ['你好', ',', '我是 AI'] });

    const res = await send(token, cid.toString(), { content: '帮我分析贵州茅台' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const fr = frames(res.body);
    // token 帧 + DONE 哨兵
    expect(fr.at(-1)).toBe('[DONE]');
    const tokens = fr
      .filter((f) => f !== '[DONE]')
      .map((f) => (JSON.parse(f) as { token: string }).token);
    expect(tokens).toEqual(['你好', ',', '我是 AI']);

    // 落库: user msg (completed) + AI msg (拼接后 content, completed)
    const msgs = await messagesOf(cid);
    expect(msgs).toEqual([
      { role: 'user', content: '帮我分析贵州茅台', status: 'completed' },
      { role: 'assistant', content: '你好,我是 AI', status: 'completed' },
    ]);
  });

  it('① 首条消息 → 派生标题覆盖默认「新对话」', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    provider.setFake({ tokens: ['ok'] });

    await send(token, cid.toString(), { content: '帮我分析贵州茅台的基本面情况' });
    const conv = await prisma.conversation.findUnique({
      where: { id: cid },
      select: { title: true },
    });
    expect(conv?.title).not.toBe('新对话');
    expect(conv?.title).toBe('帮我分析贵州茅台的基本面情况'.slice(0, 20));
  });

  it('① 自定义 title 不被首条派生覆盖', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id, '我的研究会话');
    provider.setFake({ tokens: ['ok'] });
    await send(token, cid.toString(), { content: '帮我分析贵州茅台' });
    const conv = await prisma.conversation.findUnique({
      where: { id: cid },
      select: { title: true },
    });
    expect(conv?.title).toBe('我的研究会话');
  });

  // ── ② 多轮 → 历史经 buildContext 喂进 provider ──────────────────────────────
  it('② 多轮追问 → provider 收到含历史的 messages (buildContext)', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    // 第一轮
    provider.setFake({ tokens: ['第一答'] });
    await send(token, cid.toString(), { content: '第一问' });
    // 第二轮
    provider.setFake({ tokens: ['第二答'] });
    await send(token, cid.toString(), { content: '第二问' });

    // 第二轮 provider 收到的 messages: 031 基线更新 — 现首条恒为平台基座 system
    // (每条发送都 prepend, 主动演进 027 非联网零注入), 其后含历史 第一问/第一答/第二问。
    const [first, ...rest] = provider.lastMessages;
    expect(first.role).toBe('system');
    expect(msgText(first.content).startsWith('你是「不负光阴」App 的 AI 助手')).toBe(true);
    expect(rest).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
    ]);
    // 落库四条
    const msgs = await messagesOf(cid);
    expect(msgs.map((m) => m.content)).toEqual(['第一问', '第一答', '第二问', '第二答']);
  });

  // ── ③ 停止 (abort 中流) → 落半成品 AI msg status=stopped (UC 层真 DI + 真 PG) ──
  it('③ 停止 (中流 abort) → 落已生成半成品 AI msg status=stopped (FR-008)', async () => {
    const { id } = await activeAccount();
    const cid = await newConversation(id);
    // delay 让停止有时窗; abortAt=2 在第 2 个 token 后停。
    provider.setFake({ tokens: ['半', '成', '品', '不该出现'], delayMs: 30 });

    const controller = new AbortController();
    const seen: string[] = [];
    const exec = sendMessage.execute(
      { accountId: id, conversationId: cid, content: '慢慢回答', signal: controller.signal },
      (t) => {
        seen.push(t);
        if (seen.length === 2) controller.abort(); // 收到 2 个 token 后客户端停止
      },
    );
    const outcome = await exec;
    expect(outcome.kind).toBe('stopped');

    const msgs = await messagesOf(cid);
    expect(msgs[0]).toMatchObject({ role: 'user', content: '慢慢回答', status: 'completed' });
    const ai = msgs[1]!;
    expect(ai.role).toBe('assistant');
    expect(ai.status).toBe('stopped');
    // 半成品: 只含 abort 前已吐的 token (不含全序列)。
    expect(ai.content.length).toBeGreaterThan(0);
    expect(ai.content).not.toContain('不该出现');
  });

  // ── ④ provider 失败 → 不落 AI msg 但 user msg 在 + error 帧 ───────────────────
  it('④ provider 失败 → AI msg 不落 (FR-009); user msg 在; SSE error 帧', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    provider.setFake({ tokens: ['部分'], errorAfter: 1 }); // 吐 1 token 后抛

    const res = await send(token, cid.toString(), { content: '会失败的问题' });
    expect(res.statusCode).toBe(200);
    const fr = frames(res.body);
    // 最后一帧是 error 帧 (非 DONE)
    const last = JSON.parse(fr.at(-1)!) as { error?: string };
    expect(last.error).toBeTruthy();
    expect(fr).not.toContain('[DONE]');

    // 落库: user msg 在, AI msg 不落 (无 assistant 行)
    const msgs = await messagesOf(cid);
    expect(msgs).toEqual([{ role: 'user', content: '会失败的问题', status: 'completed' }]);
  });

  it('④b provider 首 token 前即失败 → 无 token 帧, 仅 error 帧, AI msg 不落', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    provider.setFake({ tokens: ['x'], errorAfter: 0 }); // 首 token 前抛

    const res = await send(token, cid.toString(), { content: '立即失败' });
    expect(res.statusCode).toBe(200);
    const fr = frames(res.body);
    const last = JSON.parse(fr.at(-1)!) as { error?: string };
    expect(last.error).toBeTruthy();
    const msgs = await messagesOf(cid);
    expect(msgs).toEqual([{ role: 'user', content: '立即失败', status: 'completed' }]);
  });

  // ── ⑤ 空输入 → 拒 (user msg 不落) ────────────────────────────────────────────
  it('⑤ 空白 content → 拒 (400), user msg 不落', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    provider.setFake({ tokens: ['不该被调用'] });

    const res = await send(token, cid.toString(), { content: '   ' });
    // class-validator @IsNotEmpty 拦掉纯空白前需先 trim? whitespace 非空 → 入 UC trim 拒 400
    expect(res.statusCode).toBe(400);
    const msgs = await messagesOf(cid);
    expect(msgs).toEqual([]);
  });

  // ── ⑥ 他人/不存在/非数字 conversationId → 404 字节级一致 ─────────────────────
  it('⑥ 他人 / 不存在 / 非数字 conversationId → 404 字节级一致 (反枚举)', async () => {
    const { token } = await activeAccount();
    const other = await activeAccount();
    const theirs = await newConversation(other.id);
    provider.setFake({ tokens: ['x'] });

    const cross = await send(token, theirs.toString(), { content: 'hi' });
    const unknown = await send(token, '888888888888', { content: 'hi' });
    const nonNumeric = await send(token, 'abc', { content: 'hi' });

    expect(cross.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(nonNumeric.statusCode).toBe(404);
    expect(strip(cross.body)).toEqual(strip(unknown.body));
    expect(strip(cross.body)).toEqual(strip(nonNumeric.body));

    // 越权: 他人会话未被写入 user msg
    expect(await messagesOf(theirs)).toEqual([]);
  });

  // ── ⑦ 未认证 → 401 ───────────────────────────────────────────────────────────
  it('⑦ 未认证 → 401', async () => {
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

  // ── ⑨ SSE 响应携带 CORS 头 (reply.hijack 不丢 @fastify/cors 头) ──────────────────
  //
  // 回归: 仓内首个 SSE 端点用 reply.hijack()+裸 writeHead, 绕过 @fastify/cors 的 onSend
  // hook → 流式响应曾缺 Access-Control-Allow-Origin。浏览器 web 端 preflight (OPTIONS) 过,
  // 但实际流被 CORS 拦读 (net::ERR_FAILED); native fetch 不走 CORS 故真机不暴露。controller
  // 在 hijack 前把 cors 已按 allowlist 算好的 access-control-* / vary 头并入 writeHead。
  // 本测注册了 @fastify/cors (镜像 main.ts), 带 Origin 发 SSE 请求, 断言响应头回显 Origin。
  // 缺此头即回归 (web 端流式不可用)。
  it('⑨ SSE 响应携带 Access-Control-Allow-Origin (hijack 不丢跨域头, web 端可读流)', async () => {
    const { id, token } = await activeAccount();
    const cid = await newConversation(id);
    provider.setFake({ tokens: ['你好'] });
    const origin = 'http://localhost:8081';

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${cid}/messages`,
      headers: { ...sendJson(token), origin },
      payload: { content: '你好' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // 默认 corsAllowedOrigins='*' + credentials:true → @fastify/cors 回显具体 Origin (非裸 '*')。
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(String(res.headers['vary'])).toContain('Origin');
  });

  // ── ⑧ 断连 → 服务端流完成则完整落库 completed (state_branch #6) ────────────────
  //
  // state_branch #6「流式中网络断开/用户切屏离开 -> 客户端停止渲染;服务端流完成则
  // 完整落库,未完成则按 error 分支」与 #5 停止 (中流 abort → stopped) 是**两条不同
  // 分支**: #5 = abort 在上游流完成**前**命中 → 半成品 stopped; #6 = 上游流已**正常
  // 跑完所有 token** (服务端流完成) → 即便此后客户端断连, 也应完整落库 completed,
  // 不降级为 stopped。判据是 UC 的终态分流 `signal.aborted ? 'stopped' : 'completed'`
  // (send-message.usecase L110): 流跑完时未 abort → completed。
  //
  // controller 侧用 `finished` 哨兵保证「end() 后触发的 close」不误 abort (L147-152):
  // 正常结束 (含服务端流完成后客户端断连) 不视作 stop。这里在 UC 层精确验「流完整
  // 跑完 → completed」, 并叠一条「流完成后才 abort 不改终态」覆盖断连竞态的良性侧。
  it('⑧ 断连/切屏: 服务端流完成 → 完整落库 completed (state_branch #6, 区别于 #5 stopped)', async () => {
    const { id } = await activeAccount();
    const cid = await newConversation(id);
    // 全序列 + 每 token delay, 但本测**不** abort → 流跑完所有 token。
    provider.setFake({ tokens: ['完', '整', '回', '复'], delayMs: 10 });

    const controller = new AbortController();
    const seen: string[] = [];
    const outcome = await sendMessage.execute(
      { accountId: id, conversationId: cid, content: '正常问完整答', signal: controller.signal },
      (t) => seen.push(t),
    );

    // 服务端流完成 (所有 token 吐出, 无 abort) → completed。
    expect(outcome.kind).toBe('completed');
    expect(seen).toEqual(['完', '整', '回', '复']);

    const msgs = await messagesOf(cid);
    expect(msgs).toEqual([
      { role: 'user', content: '正常问完整答', status: 'completed' },
      { role: 'assistant', content: '完整回复', status: 'completed' },
    ]);
    // 客户端在流完成**之后**才断连 (切屏离开): 此时 abort 已无意义, 已落 completed
    // 不被翻成 stopped (落库是流后的独立短写, 已发生)。再 abort 验落库结果稳定。
    controller.abort();
    const after = await messagesOf(cid);
    expect(after[1]).toMatchObject({ role: 'assistant', status: 'completed' });
  });

  // ── ⑧b 断连且服务端流未完成 → error 分支 (state_branch #6 后半「未完成则按 error」) ─
  //
  // #6 后半: 「未完成则按 error 分支」—— 客户端断连时上游流尚未跑完且 provider 报错
  // (如断连后上游超时/失败), 走 error 分支: AI msg 不落 (FR-009), user msg 在。复用
  // ④ 的 provider-fail 语义 (errorAfter 在中途抛), 验「未完成 → error」终态。
  it('⑧b 断连且流未完成 (provider 失败) → error 分支, AI msg 不落, user msg 在 (state_branch #6 后半)', async () => {
    const { id } = await activeAccount();
    const cid = await newConversation(id);
    provider.setFake({ tokens: ['未完成'], errorAfter: 1 }); // 吐 1 token 后未完成即失败

    const controller = new AbortController();
    const outcome = await sendMessage.execute(
      { accountId: id, conversationId: cid, content: '断连未完成', signal: controller.signal },
      () => {},
    );

    expect(outcome.kind).toBe('error');
    const msgs = await messagesOf(cid);
    expect(msgs).toEqual([{ role: 'user', content: '断连未完成', status: 'completed' }]);
  });
});

// ── env-gated 真 DeepSeek IT (RUN_LLM_IT) ──────────────────────────────────────
//
// 默认 skip (CI 不打外网 + 占位 key)。本地显式 `RUN_LLM_IT=1 env -u OSS_* nx test
// server test/integration/chat-streaming.it.spec.ts` 真连 DeepSeek 验 provider 接线:
//   真 DeepseekProvider 发一条 → 收到非空流式 token + 落库 completed + 观察 TTFT。
//
// ⚠️ key 来源: vitest.config test.env 注入占位 `DEEPSEEK_API_KEY=test-...`, 故真 IT
// **不能** 用 DI / process.env 的 key (会被占位覆盖)。这里直接读 apps/server/.env 的
// 真 DEEPSEEK_API_KEY 手工建 DeepseekProvider (绕 DI 与占位), 验真 provider 实现本身。
// (DI 接线已由 chat.module useFactory + boot IT 间接覆盖; 本块只验真 vendor 连通。)
const RUN_LLM_IT = process.env.RUN_LLM_IT === '1' || process.env.RUN_LLM_IT === 'true';

describe.skipIf(!RUN_LLM_IT)(
  '027 真 DeepSeek provider IT (env-gated RUN_LLM_IT, 默认 skip)',
  () => {
    let prisma: PrismaService;
    let realProvider: DeepseekProvider;
    let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

    beforeAll(async () => {
      // 真 key 从 .env 读 (绕 vitest test.env 占位); .env 不在 git 但本地存在。
      const envText = readFileSync(resolve(SERVER_DIR, '.env'), 'utf8');
      const apiKey = envText
        .split('\n')
        .find((l) => l.startsWith('DEEPSEEK_API_KEY='))
        ?.slice('DEEPSEEK_API_KEY='.length)
        .trim();
      if (!apiKey || apiKey === 'test-deepseek-placeholder-key') {
        throw new Error('RUN_LLM_IT set but real DEEPSEEK_API_KEY missing in apps/server/.env');
      }
      realProvider = new DeepseekProvider({
        apiKey,
        baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
        model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      });

      stores = await setupIsolatedStores();
      process.env.DATABASE_URL = stores.databaseUrl;
      process.env.REDIS_URL = stores.redisUrl;
      prisma = new PrismaService(stores.databaseUrl);
      await prisma.$connect();
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await stores.drop();
    });

    it('真发一条 → 收到非空流式 token + 落库 completed (验 provider 接线 + TTFT 观察)', async () => {
      const acc = await prisma.account.create({
        data: { phone: '+8613900000001', status: 'ACTIVE' },
      });
      const conv = await prisma.conversation.create({
        data: { accountId: acc.id, title: '真连通', model: 'deepseek-chat' },
        select: { id: true },
      });

      const controller = new AbortController();
      const t0 = Date.now();
      let ttft = -1;
      let acc2 = '';
      let tokenCount = 0;
      for await (const event of realProvider.stream(
        [{ role: 'user', content: '用一句话介绍贵州茅台' }],
        { signal: controller.signal, model: 'flash' },
      )) {
        if (event.kind !== 'token') continue;
        if (ttft < 0) ttft = Date.now() - t0;
        acc2 += event.text;
        tokenCount += 1;
      }

      // 验真 provider 接线: 收到非空流式 token。
      expect(tokenCount).toBeGreaterThan(0);
      expect(acc2.length).toBeGreaterThan(0);
      // TTFT 留观察 (SC-001 p95 ≤ 3s; PoC 已实测 ~518ms)。不硬断言 (真网抖动)。
      // eslint-disable-next-line no-console
      console.log(`[RUN_LLM_IT] TTFT=${ttft}ms tokens=${tokenCount} len=${acc2.length}`);

      // 落库 completed (验流正常结束语义, 镜像 SendMessageUseCase ⑦ 终态)。
      const ai = await prisma.message.create({
        data: { conversationId: conv.id, role: 'assistant', content: acc2, status: 'completed' },
        select: { status: true, content: true },
      });
      expect(ai.status).toBe('completed');
      expect(ai.content.length).toBeGreaterThan(0);
    }, 30_000);
  },
);
