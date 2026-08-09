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
 * 032 T008 澄清轮 SSE UC + controller IT (真 DI 容器 + Testcontainers PG/Redis + Fastify,
 * per plan「NO LIFECYCLE MOCKING」: 经 DI override LLM_PROVIDER 注入 FakeIdeationLlmProvider
 * 驱动两相剧本, 绝不 jest.mock)。
 *
 * 覆盖 T008 落库语义 (契约 doc §3/§4):
 *  ① 澄清轮 → user + assistant turn 落库 (SSE token drip + [DONE]) /
 *  ② 带 chips 轮 (过两闸 + 非第一问) → suggestion 帧 + idea_turn.suggestion 落库 /
 *  ③ 不过闸轮 (无 recommended) → 无 suggestion 帧 + assistant turn.suggestion=null /
 *  ④ 空白输入 → 拒 (400, user turn 不落) /
 *  ⑤ abort (中流停止) → 保留半成品 assistant turn /
 *  ⑥ provider 失败 (errorAfter=0) → 不落 assistant turn + error 帧 (user turn 在) /
 *  ⑦ 越权 / 非 open → 404 字节级一致 (反枚举)。
 *
 * provider 注入: SwappableFake 包一个可逐 test 替换内核的 fake, 经 DI override 一次,
 * 各 test 调 setFake({script}) 定制两相剧本 / errorAfter / delayMs。
 */

/** 单 DI override, 内核 fake 逐 test 可换; 记录最近一次 stream 的 messages 供人设断言。 */
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

describe('032 ideation clarify-turn SSE (Testcontainers PG + Redis + Fastify)', () => {
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
    process.env.AUTH_JWT_SECRET = 'ideation-t008-jwt-secret-min-32-bytes-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'ideation-t008-hmac-secret-min-32-bytes-zy';

    provider = new SwappableFake();
    moduleRef = await Test.createTestingModule({ imports: narrowTestModule([IdeationModule]) })
      .overrideProvider(LLM_PROVIDER)
      .useValue(provider)
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
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613919${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const sendJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });

  async function seedSession(
    accountId: bigint,
    opts: { status?: string; userTurns?: number } = {},
  ): Promise<bigint> {
    const s = await prisma.ideaSession.create({
      data: { accountId, title: '种子会话', status: opts.status ?? 'open' },
      select: { id: true },
    });
    // 预置已有 user turn (推进 turnIndex, 让 chips 闸不被第一问拦)。
    for (let i = 0; i < (opts.userTurns ?? 0); i++) {
      await prisma.ideaTurn.create({
        data: { sessionId: s.id, role: 'user', content: `历史 ${i}` },
      });
      await prisma.ideaTurn.create({
        data: { sessionId: s.id, role: 'assistant', content: `回复 ${i}` },
      });
    }
    return s.id;
  }

  const turn = (token: string, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/ideation/sessions/${id}/turns`,
      headers: sendJson(token),
      payload,
    });

  /** SSE body → 帧 payload (去 data: 前缀, 丢空帧)。 */
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

  const turnsOf = (sessionId: bigint) =>
    prisma.ideaTurn.findMany({
      where: { sessionId },
      orderBy: { id: 'asc' },
      select: { role: true, content: true, suggestion: true },
    });

  // ── ① 澄清轮 → user + assistant turn 落库 (token drip + [DONE]) ──────────────
  it('① 澄清轮 → SSE token drip + [DONE]; user + assistant turn 落库', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    // 第一问 (turnIndex=0): 纯文本问题 (无 options)。
    provider.setFake({ script: [{ ask: { question: '你想达成什么?' } }] });

    const res = await turn(token, sid.toString(), { content: '想给行情页加点东西' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const fr = frames(res.body);
    expect(fr.at(-1)).toBe('[DONE]');
    const tokens = fr
      .filter((f) => f !== '[DONE]')
      .map((f) => (JSON.parse(f) as { token?: string }).token)
      .filter((t): t is string => typeof t === 'string');
    expect(tokens.join('')).toBe('你想达成什么?');

    const rows = await turnsOf(sid);
    expect(rows).toEqual([
      { role: 'user', content: '想给行情页加点东西', suggestion: null },
      { role: 'assistant', content: '你想达成什么?', suggestion: null },
    ]);
  });

  // ── ② 带 chips 轮 (过两闸 + 非第一问) → suggestion 帧 + 落库 ───────────────────
  it('② 过两闸 + 非第一问 → suggestion 帧 + idea_turn.suggestion 落库', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id, { userTurns: 1 }); // turnIndex 推到 1 (非第一问)
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

    const res = await turn(token, sid.toString(), { content: '关于输出方式' });
    expect(res.statusCode).toBe(200);

    const fr = frames(res.body);
    const sugFrame = fr
      .map((f) => (f === '[DONE]' ? null : (JSON.parse(f) as { suggestion?: unknown })))
      .find((p) => p !== null && p.suggestion !== undefined);
    expect(sugFrame).toBeDefined();
    const sug = (sugFrame as { suggestion: Record<string, unknown> }).suggestion;
    // 推荐项排首 (recommended=true；「（推荐）」由前端渲染装饰、落库 label 干净) + 末位逃生 + allow_freetext 恒 true。
    expect((sug.options as { recommended?: boolean }[])[0].recommended).toBe(true);
    expect((sug.options as { label: string }[]).at(-1)?.label).toBe('都不是/自己填');
    expect(sug.allow_freetext).toBe(true);

    const rows = await turnsOf(sid);
    const assistant = rows.at(-1)!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.suggestion).not.toBeNull();
    expect((assistant.suggestion as { question: string }).question).toBe(
      '输出流走 SSE 还是一次性?',
    );
  });

  // ── ③ 不过闸轮 (无 recommended) → 无 suggestion 帧 + suggestion=null ──────────
  it('③ 不过闸 (可枚举但无可辩护推荐) → 无 suggestion 帧 + assistant.suggestion=null', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id, { userTurns: 1 });
    provider.setFake({
      script: [
        {
          ask: {
            question: '用什么语气?',
            options: [{ label: '正式' }, { label: '轻松' }], // 无 recommended → 闸二挂
          },
        },
      ],
    });

    const res = await turn(token, sid.toString(), { content: '关于语气' });
    expect(res.statusCode).toBe(200);

    const fr = frames(res.body);
    const hasSug = fr.some(
      (f) => f !== '[DONE]' && (JSON.parse(f) as { suggestion?: unknown }).suggestion !== undefined,
    );
    expect(hasSug).toBe(false);

    const rows = await turnsOf(sid);
    expect(rows.at(-1)!.suggestion).toBeNull();
  });

  // ── ④ 空白输入 → 拒 (400, user turn 不落) ───────────────────────────────────
  it('④ 空白输入 → 400 (user turn 不落)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    provider.setFake({ script: [{ ask: { question: 'Q' } }] });

    const res = await turn(token, sid.toString(), { content: '   ' });
    expect(res.statusCode).toBe(400);
    const rows = await turnsOf(sid);
    expect(rows).toEqual([]); // 无 turn 落
  });

  // ── ⑤ abort (中流停止) → 保留半成品 assistant turn ──────────────────────────
  it('⑤ abort 中流 → 保留半成品 assistant turn', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    // delayMs 留时窗 → 客户端断连触发 abort。
    provider.setFake({ script: [{ ask: { question: '这是一个长问题' } }], delayMs: 200 });

    const ac = new AbortController();
    const pending = app.inject({
      method: 'POST',
      url: `/api/v1/ideation/sessions/${sid.toString()}/turns`,
      headers: sendJson(token),
      payload: { content: '触发 abort' },
      // fastify inject 支持 signal 中断
      signal: ac.signal,
    } as never);
    setTimeout(() => ac.abort(), 50);
    await pending.catch(() => undefined); // inject abort 抛, 吞掉

    // 给 UC 落库一点时间
    await new Promise((r) => setTimeout(r, 300));

    const rows = await turnsOf(sid);
    // user turn 必在; assistant 半成品 turn 应被保留 (abort 语义, FR-008)。
    expect(rows[0]).toEqual({ role: 'user', content: '触发 abort', suggestion: null });
    expect(rows.some((r) => r.role === 'assistant')).toBe(true);
  });

  // ── ⑥ provider 失败 (errorAfter=0) → 不落 assistant turn + error 帧 ──────────
  it('⑥ provider 失败 → 不落 assistant turn + error 帧 (user turn 在)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    provider.setFake({ script: [{ ask: { question: 'Q' } }], errorAfter: 0 });

    const res = await turn(token, sid.toString(), { content: '触发失败' });
    expect(res.statusCode).toBe(200); // 流已开 (error 帧)
    const fr = frames(res.body);
    const errFrame = fr
      .map((f) => (f === '[DONE]' ? null : (JSON.parse(f) as { error?: unknown })))
      .find((p) => p !== null && p.error !== undefined);
    expect(errFrame).toBeDefined();

    const rows = await turnsOf(sid);
    expect(rows).toEqual([{ role: 'user', content: '触发失败', suggestion: null }]); // 无 assistant
  });

  // ── ⑦ 越权 / 非 open → 404 字节级一致 (反枚举) ──────────────────────────────
  it('⑦ 他人 session → 404; 非 open → 404; 字节级一致', async () => {
    const owner = await activeToken();
    const other = await activeToken();
    const sid = await seedSession(owner.id);
    const convergedSid = await seedSession(owner.id, { status: 'converged' });
    provider.setFake({ script: [{ ask: { question: 'Q' } }] });

    const otherRes = await turn(other.token, sid.toString(), { content: 'x' });
    const nonOpenRes = await turn(owner.token, convergedSid.toString(), { content: 'x' });
    const unknownRes = await turn(owner.token, '99999999', { content: 'x' });

    expect(otherRes.statusCode).toBe(404);
    expect(nonOpenRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    // 字节级一致 (剥 traceId/instance)。
    expect(strip(otherRes.body)).toEqual(strip(unknownRes.body));
    expect(strip(nonOpenRes.body)).toEqual(strip(unknownRes.body));
  });

  // ── ⑧ 纯文本兜底: 模型未调 ask 工具只吐文本 → 当引导回复落库 (completed, 非 error) ──
  it('⑧ 模型纯文本回复 (未调 ask 工具) → 文本兜底落 assistant turn, 不报 IDEATION_NO_QUESTION', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    // 招呼/模糊输入时模型只吐纯文本引导 (interview-persona 形态 A), 不调 ask 工具。
    provider.setFake({ script: [{ text: ['你好', '!先', '说说', '你的', '想法'] }] });

    const res = await turn(token, sid.toString(), { content: '你好' });
    expect(res.statusCode).toBe(200);
    const fr = frames(res.body);
    expect(fr.at(-1)).toBe('[DONE]');
    // 文本被 drip 成 token 帧; 无 error 帧。
    const tokens = fr
      .filter((f) => f !== '[DONE]')
      .map((f) => (JSON.parse(f) as { token?: string }).token)
      .filter((t): t is string => typeof t === 'string');
    expect(tokens.join('')).toBe('你好!先说说你的想法');
    const hasErr = fr.some(
      (f) => f !== '[DONE]' && (JSON.parse(f) as { error?: unknown }).error !== undefined,
    );
    expect(hasErr).toBe(false);
    // assistant turn 落库 = 文本回复 (suggestion=null), 非空缺。
    const rows = await turnsOf(sid);
    expect(rows).toEqual([
      { role: 'user', content: '你好', suggestion: null },
      { role: 'assistant', content: '你好!先说说你的想法', suggestion: null },
    ]);
  });

  // ── ⑨ 访谈人设 system prompt 置于 messages 首 (默认源回落) ───────────────────
  it('⑨ 访谈人设 system prompt 置于 messages 首', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    provider.setFake({ script: [{ ask: { question: '你想达成什么?' } }] });

    await turn(token, sid.toString(), { content: '想给行情页加点东西' });
    expect(provider.lastMessages[0]?.role).toBe('system');
    expect(provider.lastMessages[0]?.content).toContain('需求澄清访谈助手');
    // user turn 紧随 system 之后。
    expect(provider.lastMessages[1]).toMatchObject({ role: 'user', content: '想给行情页加点东西' });
  });
});
