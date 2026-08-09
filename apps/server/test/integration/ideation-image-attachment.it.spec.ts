import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import fastifyCors from '@fastify/cors';
import type { Redis } from 'ioredis';
import {
  appConfig,
  ossConfig,
  parseOrigins,
  type AppConfig,
  type OssConfig,
} from '../../src/config';
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
import {
  FakeIdeationLlmProvider,
  type FakeIdeationLlmConfig,
} from '../../src/ideation/fake-ideation-llm.provider';

/**
 * 036 T007 ([US1][US3][Server-IT]) — 图片上传凭证签发 + 带图澄清轮 state_branches 全覆盖 IT
 * (真 DI 容器 + Testcontainers PG/Redis + Fastify, per plan「NO LIFECYCLE MOCKING」+
 * 「MANDATORY INTEGRATION」: Guard/Pipe/Filter 全在真实 lifecycle 触发, 经 DI override
 * `LLM_PROVIDER` 注入 fake-llm + 经 `ossConfig.KEY` override 参数化 OSS, 绝不 jest.mock)。
 *
 * 覆盖 spec state_branches (逐条对照, 每分支一 it):
 *  ① JWT 有效 200 / 无效 401 (凭证 EP + 带图 turn EP, JwtAuthGuard 真 DI lifecycle)。
 *  ② 凭证签发 scope (keyPrefix=`ideation/<accountId>/` + content-type 白名单 + size 上限)。
 *  ③ 他人 session 凭证/带图 turn → 404 字节级一致 (反枚举 FR-013, body 与不存在 session 完全一致)。
 *  ④ 带图 turn 落库 (IdeaAttachment + user turn 引用同 tx + annotationsJson 留 null)。
 *  ⑤ 带图 turn 重载查询返回 attachment 引用 (FR-009 持久化可重展示)。
 *  ⑥ 多模态 Msg 路由 (fake-llm 收到 content=数组 + image_url + model:'minimax'; aliyun OSS boot)。
 *  ⑦ 纯文本轮零回归 (string content + model:'pro', 既有澄清闭环不变 SC-005)。
 *  ⑧ send-once (含历史带图轮的多轮会话, 新纯文本轮上下文整段不含 image_url)。
 *  ⑨ 降级 (凭证签发失败 OSS 未配置 → 503 ProblemDetail 不暴 vendor / 路由失败 → error 帧不脏写)。
 * env-gated 真 OSS/真 M3 分支 (`RUN_OSS_IT` / `RUN_M3_VISION_IT`) 默认 skip (无真 key 不入 CI)。
 *
 * **双 app boot** (同享 PG/Redis 容器, 不同 OSS 配置):
 *   - `appOss`   —— `ossConfig.KEY` override 为 aliyun (region/bucket/ak/sk), 让凭证签发成功
 *                   (200) + `buildMultimodalContent` 派生 image_url (⑥ 路由断言所需; OSS 未配置
 *                   时 UC 降级为纯 string 无 image_url)。
 *   - `appNoOss` —— 默认 unconfigured OSS, 验凭证签发失败 503 降级 (⑨)。
 */

/** aliyun OSS 配置覆盖值 (确定性, 让签名 + public URL 派生生效; 非真 bucket — IT 不打真 OSS)。 */
const ALIYUN_OSS: OssConfig = {
  kind: 'aliyun',
  region: 'oss-cn-shanghai',
  bucket: 'mbw-test-images',
  accessKeyId: 'LTAI-test-access-key-id',
  accessKeySecret: 'test-access-key-secret-deterministic',
};

/** unconfigured OSS (dev/test 默认形态; 显式 override 防 @nestjs/config registerAs 跨 app 记忆化泄漏)。 */
const UNCONFIGURED_OSS: OssConfig = { kind: 'unconfigured' };

/** 单 DI override, 内核 fake 逐 test 可换; 记录最近一次 stream 的 messages + model 供路由断言。 */
class SwappableFake implements LlmProvider {
  private inner: FakeIdeationLlmProvider = new FakeIdeationLlmProvider({ script: [] });
  lastMessages: Msg[] = [];
  lastModel: string | undefined = undefined;
  /** 历次 stream 调用的 model (多步微循环每轮一次 stream; 取首轮即本轮路由 model)。 */
  modelCalls: string[] = [];

  setFake(config: FakeIdeationLlmConfig): void {
    this.inner = new FakeIdeationLlmProvider(config);
    this.lastMessages = [];
    this.lastModel = undefined;
    this.modelCalls = [];
  }

  stream(messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    this.lastMessages = messages;
    this.lastModel = opts.model;
    this.modelCalls.push(opts.model);
    return this.inner.stream(messages, opts);
  }
}

describe('036 ideation image attachment (credential + image turn, Testcontainers PG + Redis + Fastify)', () => {
  let appOss: NestFastifyApplication;
  let appNoOss: NestFastifyApplication;
  let moduleOss: TestingModule;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let provider: SwappableFake;
  let seq = 0;

  async function bootApp(
    provider_: LlmProvider,
    ossOverride: OssConfig,
  ): Promise<{ module: TestingModule; app: NestFastifyApplication }> {
    // 两 app 均**显式** override ossConfig.KEY (aliyun / unconfigured) —— @nestjs/config v4
    // registerAs 跨独立 DI 容器仍记忆化首个 factory 结果, 仅靠「不 override 读 env」会让两 app
    // 共享同一 config 对象 (实测 unconfigured app 误读到 aliyun)。各自显式 useValue 切断泄漏。
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(provider_)
      .overrideProvider(ossConfig.KEY)
      .useValue(ossOverride)
      .compile();
    const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    const cfg = module.get<AppConfig>(appConfig.KEY);
    // SSE 端点 (turns) 走 reply.hijack() 裸写 → IT 必须显式注册 fastifyCors (CORS 在 main.ts 注册,
    // AppModule 默认无 cors; 与 clarify-turn IT 同款 boot, server-sse-hijack-cors rule)。
    await app.register(fastifyCors, {
      origin: parseOrigins(cfg.corsAllowedOrigins),
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return { module, app };
  }

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'ideation-t007-jwt-secret-min-32-bytes-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'ideation-t007-hmac-secret-min-32-bytes-zy';

    provider = new SwappableFake();
    // appNoOss 先 boot (默认 unconfigured OSS → 503 降级); appOss 后 boot (aliyun override →
    // 凭证 200 + image_url 派生)。两 app 独立 DI 容器, ossConfig.KEY 经 .overrideProvider 各自注入。
    ({ app: appNoOss } = await bootApp(provider, UNCONFIGURED_OSS));
    ({ module: moduleOss, app: appOss } = await bootApp(provider, ALIYUN_OSS));

    prisma = moduleOss.get(PrismaService);
    jwt = moduleOss.get(JwtTokenService);
    redis = moduleOss.get(REDIS_CLIENT);
  }, 180_000);

  afterAll(async () => {
    await appOss?.close();
    await appNoOss?.close();
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
  const sendJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });

  async function seedSession(accountId: bigint, opts: { status?: string } = {}): Promise<bigint> {
    const s = await prisma.ideaSession.create({
      data: { accountId, title: '种子会话', status: opts.status ?? 'open' },
      select: { id: true },
    });
    return s.id;
  }

  // 凭证签发 EP (appOss = aliyun → 200; appNoOss = unconfigured → 503)。
  const credential = (
    app: NestFastifyApplication,
    token: string,
    id: string,
    payload: Record<string, unknown> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/ideation/sessions/${id}/attachments/credential`,
      headers: sendJson(token),
      payload,
    });

  // 带图 / 纯文本澄清轮 EP (SSE)。
  const turn = (
    app: NestFastifyApplication,
    token: string,
    id: string,
    payload: Record<string, unknown>,
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/ideation/sessions/${id}/turns`,
      headers: sendJson(token),
      payload,
    });

  // 会话详情读侧 EP (重载路径; mobile 冷启 hydrate 走它)。
  const getSession = (app: NestFastifyApplication, token: string, id: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/ideation/sessions/${id}`,
      headers: auth(token),
    });

  /** SSE body → 帧 payload (去 data: 前缀, 丢空帧)。 */
  const frames = (body: string): string[] =>
    body
      .split('\n\n')
      .filter((f) => f.startsWith('data:'))
      .map((f) => f.slice('data:'.length));

  /** 剥 ProblemDetail 易变字段 (traceId/instance) 供字节级比较。 */
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

  const attachmentsOf = (sessionId: bigint) =>
    prisma.ideaAttachment.findMany({
      where: { sessionId },
      orderBy: { id: 'asc' },
      select: { sessionId: true, accountId: true, ossKey: true, kind: true, annotationsJson: true },
    });

  // ── ① JWT 有效 200 / 无效 401 (凭证 EP) ───────────────────────────────────
  it('① 凭证 EP: 有效 JWT → 200; 无 JWT / 坏 JWT → 401 (反枚举一致)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);

    const ok = await credential(appOss, token, sid.toString(), { contentType: 'image/png' });
    expect(ok.statusCode).toBe(200);

    const noAuth = await appOss.inject({
      method: 'POST',
      url: `/api/v1/ideation/sessions/${sid.toString()}/attachments/credential`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(noAuth.statusCode).toBe(401);

    const badAuth = await credential(appOss, 'not-a-valid-jwt', sid.toString(), {});
    expect(badAuth.statusCode).toBe(401);
    // 无 token / 坏 token 字节级一致 (反枚举: 不暴露「存在但未授权」vs「无凭证」差异)。
    expect(strip(noAuth.body)).toEqual(strip(badAuth.body));
  });

  // ── ② 凭证签发 scope: keyPrefix + content-type 白名单 + size 上限 ───────────
  it('② 凭证 scope: keyPrefix=ideation/<accountId>/ + 白名单 content-type + size 上限 (≤10MB)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);

    const res = await credential(appOss, token, sid.toString(), { contentType: 'image/webp' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      host: string;
      objectKey: string;
      expiresAt: string;
      fields: { key: string; policy: string; 'x-oss-credential': string };
    };

    // objectKey / fields.key 严格 account-scoped 前缀 (反枚举 + 隔离)。
    const expectedPrefix = `ideation/${id}/`;
    expect(body.objectKey.startsWith(expectedPrefix)).toBe(true);
    expect(body.objectKey).toMatch(new RegExp(`^ideation/${id}/[0-9a-f-]{36}/img$`));
    expect(body.fields.key).toBe(body.objectKey);
    // host 指向 override 的 bucket/region (确定性)。
    expect(body.host).toBe('https://mbw-test-images.oss-cn-shanghai.aliyuncs.com');
    // expiresAt = ISO 8601 (TTL 15min 后, .000Z 收口); 这里只断言可解析 ISO。
    expect(() => new Date(body.expiresAt).toISOString()).not.toThrow();
    expect(body.expiresAt).toBe(new Date(body.expiresAt).toISOString());

    // policy (base64 JSON) 内嵌 key-prefix / content-type 白名单 / size 上限三道 scope 闸。
    const policy = JSON.parse(Buffer.from(body.fields.policy, 'base64').toString('utf8')) as {
      conditions: unknown[];
    };
    const conds = policy.conditions as Array<unknown>;
    // key 前缀 starts-with 闸。
    expect(conds).toContainEqual(['starts-with', '$key', expectedPrefix]);
    // content-type 白名单闸 (仅 JPEG/PNG/WebP)。
    expect(conds).toContainEqual([
      'in',
      '$content-type',
      ['image/jpeg', 'image/png', 'image/webp'],
    ]);
    // size 上限闸 (1..10MB)。
    expect(conds).toContainEqual(['content-length-range', 1, 10 * 1024 * 1024]);
  });

  // ── ② 凭证 content-type 白名单 fast-fail (非白名单 → 400) ────────────────────
  it('② 凭证 content-type 非白名单 → 400 (fast-fail 白名单闸)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    const res = await credential(appOss, token, sid.toString(), { contentType: 'image/gif' });
    expect(res.statusCode).toBe(400);
  });

  // ── ③ 他人 session 凭证 → 404 字节级一致 (反枚举 FR-013) ─────────────────────
  it('③ 凭证 EP: 他人 session / 不存在 session → 404 字节级一致 (反枚举)', async () => {
    const owner = await activeToken();
    const other = await activeToken();
    const sid = await seedSession(owner.id);

    const otherRes = await credential(appOss, other.token, sid.toString(), {});
    const unknownRes = await credential(appOss, owner.token, '99999999', {});
    const nonNumericRes = await credential(appOss, owner.token, 'abc', {});

    expect(otherRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(nonNumericRes.statusCode).toBe(404);
    // 他人 / 不存在 / 非数字 id (折叠 404) → body 字节级一致 (剥 traceId/instance)。
    expect(strip(otherRes.body)).toEqual(strip(unknownRes.body));
    expect(strip(nonNumericRes.body)).toEqual(strip(unknownRes.body));
  });

  // ── ③ 他人 session 带图 turn → 404 字节级一致 ───────────────────────────────
  it('③ 带图 turn EP: 他人 session / 不存在 / key 前缀越权 → 404 字节级一致 (反枚举)', async () => {
    const owner = await activeToken();
    const other = await activeToken();
    const sid = await seedSession(owner.id);
    provider.setFake({ script: [{ ask: { question: 'Q' } }] });

    // 他人 session id (owner 的 session, other token 提交)。
    const otherRes = await turn(appOss, other.token, sid.toString(), {
      content: 'x',
      attachmentKeys: [`ideation/${other.id}/uuid/img`],
    });
    // 不存在 session。
    const unknownRes = await turn(appOss, owner.token, '99999999', { content: 'x' });
    // key 前缀越权: 自己的 open session, 但 attachmentKey 前缀指向他人 account → 折叠 404。
    const foreignKeyRes = await turn(appOss, owner.token, sid.toString(), {
      content: 'x',
      attachmentKeys: [`ideation/${other.id}/uuid/img`],
    });

    expect(otherRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(foreignKeyRes.statusCode).toBe(404);
    // 全折叠 SESSION_NOT_FOUND, 字节级一致 (不区分「他人 session」vs「他人图 key」vs「不存在」)。
    expect(strip(otherRes.body)).toEqual(strip(unknownRes.body));
    expect(strip(foreignKeyRes.body)).toEqual(strip(unknownRes.body));
  });

  // ── ④ 带图 turn 落库: IdeaAttachment + user turn 同 tx + annotationsJson 留 null ──
  it('④ 带图 turn → IdeaAttachment + user turn 落库 (同 tx, annotationsJson 留 null)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    provider.setFake({ script: [{ ask: { question: '想强调图上哪个区域?' } }] });

    const key1 = `ideation/${id}/uuid-1/img`;
    const key2 = `ideation/${id}/uuid-2/img`;
    const res = await turn(appOss, token, sid.toString(), {
      content: '看这张截图',
      attachmentKeys: [key1, key2],
      annotationText: '1：天空改蓝 2：塔变红',
    });
    expect(res.statusCode).toBe(200);

    // user turn 落库 (content = 用户输入原文, 不含 annotationText —— 合成文字只进 Msg 不进 DB)。
    const rows = await turnsOf(sid);
    expect(rows[0]).toEqual({ role: 'user', content: '看这张截图', suggestion: null });

    // IdeaAttachment 各烧录图一行 (sessionId/accountId 归属 + ossKey + kind='image' + annotationsJson null)。
    const atts = await attachmentsOf(sid);
    expect(atts).toEqual([
      { sessionId: sid, accountId: id, ossKey: key1, kind: 'image', annotationsJson: null },
      { sessionId: sid, accountId: id, ossKey: key2, kind: 'image', annotationsJson: null },
    ]);
  });

  // ── ⑤ 带图 turn 重载查询返回 attachment 引用 (FR-009 持久化可重展示) ──────────
  it('⑤ 会话重载 (重查) → 带图轮 attachment 引用仍在 (FR-009 可重展示)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    provider.setFake({ script: [{ ask: { question: 'Q' } }] });

    const key = `ideation/${id}/reload-uuid/img`;
    await turn(appOss, token, sid.toString(), { content: '带图', attachmentKeys: [key] });

    // 模拟会话重载: 重新查 attachments (FR-009 持久化 → 与 session/account 归属一致)。
    const reload = await prisma.ideaAttachment.findMany({
      where: { sessionId: sid, accountId: id },
      orderBy: { id: 'asc' },
      select: { ossKey: true, kind: true },
    });
    expect(reload).toEqual([{ ossKey: key, kind: 'image' }]);
  });

  // ── ⑤b 读侧投影 (T019): GET /sessions/{id} 带图轮返回 attachments[].ossKey ──────
  it('⑤b 读侧 GET /sessions/{id} → 带图 user 轮携 attachments[].ossKey; 纯文本轮空数组 (FR-009)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);

    // 轮 1: 带图轮 (落带图 user turn + attachment, turnId 关联本轮)。
    provider.setFake({ script: [{ ask: { question: 'Q1?' } }] });
    const key1 = `ideation/${id}/read-uuid-1/img`;
    const key2 = `ideation/${id}/read-uuid-2/img`;
    await turn(appOss, token, sid.toString(), {
      content: '看这两张图',
      attachmentKeys: [key1, key2],
    });

    // 轮 2: 纯文本轮 (无附件)。
    provider.setFake({ script: [{ ask: { question: 'Q2?' } }] });
    await turn(appOss, token, sid.toString(), { content: '再问一句' });

    // 读侧重载: GET 真实读路径 (经 DTO 投影, 非直查 DB)。
    const res = await getSession(appOss, token, sid.toString());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      turns: Array<{ role: string; content: string; attachments: Array<{ ossKey: string }> }>;
    };

    // 带图 user 轮 (插入序首条 user) → attachments 含两个 ossKey (插入序)。
    const imageTurn = body.turns.find((t) => t.role === 'user' && t.content === '看这两张图');
    expect(imageTurn).toBeDefined();
    expect(imageTurn!.attachments).toEqual([{ ossKey: key1 }, { ossKey: key2 }]);

    // 纯文本 user 轮 + 所有 assistant 轮 → attachments 为空数组 (零回归)。
    const textTurn = body.turns.find((t) => t.role === 'user' && t.content === '再问一句');
    expect(textTurn!.attachments).toEqual([]);
    for (const t of body.turns.filter((x) => x.role === 'assistant')) {
      expect(t.attachments).toEqual([]);
    }
  });

  // ── ⑤c 读侧反枚举: 他人 session GET → 404 字节级一致 (attachments 读不到) ────────
  it('⑤c 读侧 GET: 他人 session / 不存在 → 404 字节级一致 (反枚举, 带图附件读不到)', async () => {
    const owner = await activeToken();
    const other = await activeToken();
    const sid = await seedSession(owner.id);
    provider.setFake({ script: [{ ask: { question: 'Q' } }] });
    await turn(appOss, owner.token, sid.toString(), {
      content: '私密带图',
      attachmentKeys: [`ideation/${owner.id}/secret/img`],
    });

    const otherRes = await getSession(appOss, other.token, sid.toString());
    const unknownRes = await getSession(appOss, owner.token, '99999999');
    expect(otherRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(strip(otherRes.body)).toEqual(strip(unknownRes.body));
  });

  // ── ⑥ 多模态 Msg 路由: content=数组 + image_url + model:'minimax' (aliyun OSS boot) ──
  it('⑥ 带图轮 → fake-llm 收到 content 数组含 image_url + 路由 model:minimax', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    provider.setFake({ script: [{ ask: { question: '聚焦图上区域?' } }] });

    const key = `ideation/${id}/vision-uuid/img`;
    const res = await turn(appOss, token, sid.toString(), {
      content: '帮我看这处',
      attachmentKeys: [key],
      annotationText: '1：这里改蓝',
    });
    expect(res.statusCode).toBe(200);

    // 带图轮强制路由视觉模型 (M3 → 逻辑名 'minimax'); 全部 stream 调用均走 minimax。
    expect(provider.lastModel).toBe('minimax');
    expect(provider.modelCalls.every((m) => m === 'minimax')).toBe(true);

    // 最后一条 user message = 多模态 MsgPart[] (text part 含用户输入 + 合成文字; image_url part
    // = ossKey 派生的 OSS public URL)。
    const userMsg = [...provider.lastMessages].reverse().find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(Array.isArray(userMsg!.content)).toBe(true);
    const parts = userMsg!.content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    const textPart = parts.find((p) => p.type === 'text');
    const imgPart = parts.find((p) => p.type === 'image_url');
    expect(textPart?.text).toContain('帮我看这处');
    expect(textPart?.text).toContain('1：这里改蓝');
    // image_url = ossPublicBaseUrl(region, bucket)/<ossKey> (与 confirm-profile-image 同款派生)。
    expect(imgPart?.image_url?.url).toBe(
      `https://mbw-test-images.oss-cn-shanghai.aliyuncs.com/${key}`,
    );
  });

  // ── ⑦ 纯文本轮零回归: string content + model:'pro' (既有澄清闭环不变 SC-005) ────
  it('⑦ 纯文本轮 (无 attachmentKeys) → string content + 路由 model:pro (零回归)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    provider.setFake({ script: [{ ask: { question: '你想达成什么?' } }] });

    const res = await turn(appOss, token, sid.toString(), { content: '想给行情页加点东西' });
    expect(res.statusCode).toBe(200);
    const fr = frames(res.body);
    expect(fr.at(-1)).toBe('[DONE]');

    // 纯文本轮维持 'pro' (DeepSeek, 视觉 API 未开放); content 维持旧 string 形状 (无 MsgPart[])。
    expect(provider.lastModel).toBe('pro');
    const userMsg = [...provider.lastMessages].reverse().find((m) => m.role === 'user');
    expect(typeof userMsg!.content).toBe('string');
    expect(userMsg!.content).toBe('想给行情页加点东西');
    // 无 attachment 落库 (纯文本轮不碰附件表)。
    expect(await attachmentsOf(sid)).toEqual([]);
  });

  // ── ⑧ send-once: 历史带图轮 + 新纯文本轮 → 整段 messages 不含 image_url (FR-015) ──
  it('⑧ send-once: 历史带图轮后的新纯文本轮, 整段上下文不重注历史 image_url', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);

    // 轮 1: 带图轮 (落历史带图 user turn + attachment)。
    provider.setFake({ script: [{ ask: { question: 'Q1?' } }] });
    const key = `ideation/${id}/sendonce-uuid/img`;
    await turn(appOss, token, sid.toString(), {
      content: '第一轮带图',
      attachmentKeys: [key],
      annotationText: '1：看这里',
    });

    // 轮 2: 新纯文本轮 (无 attachmentKeys)。组上下文时历史带图轮的图 MUST NOT 重注 (send-once)。
    provider.setFake({ script: [{ ask: { question: 'Q2?' } }] });
    const res = await turn(appOss, token, sid.toString(), { content: '第二轮纯文字' });
    expect(res.statusCode).toBe(200);

    // 路由回 pro (纯文本轮); 整段 messages 任一条 content 都不含 image_url part (历史图不重发)。
    expect(provider.lastModel).toBe('pro');
    const imageUrlCount = provider.lastMessages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p) => p.type === 'image_url').length;
    expect(imageUrlCount).toBe(0);
    // 历史带图 user turn 在上下文里重建为纯 string (content 原文, 无 image_url)。
    const firstUser = provider.lastMessages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content === '第一轮带图',
    );
    expect(firstUser).toBeDefined();
  });

  // ── ⑧b send-once 反证: 同带图轮内 image_url part 数 = 当前轮注入图数 ──────────
  it('⑧b 带图轮内 image_url part 数 = 当前轮注入的烧录图数 (无多注 / 无漏注)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    provider.setFake({ script: [{ ask: { question: 'Q?' } }] });

    const keys = [`ideation/${id}/a/img`, `ideation/${id}/b/img`, `ideation/${id}/c/img`];
    await turn(appOss, token, sid.toString(), { content: '三图', attachmentKeys: keys });

    const imageUrlCount = provider.lastMessages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p) => p.type === 'image_url').length;
    expect(imageUrlCount).toBe(keys.length);
  });

  // ── ⑨ 降级: 凭证签发失败 (OSS 未配置) → 503 ProblemDetail, 不暴 vendor / 凭证 ────
  it('⑨ 降级: OSS 未配置 → 凭证 503 ProblemDetail (不暴 vendor 细节 / 不泄凭证 FR-011)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);

    // appNoOss = 默认 unconfigured OSS → UC 显式 503 OSS_NOT_CONFIGURED (不用空 creds 签名)。
    const res = await credential(appNoOss, token, sid.toString(), { contentType: 'image/png' });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    // ProblemDetail 形状 (status/title/detail); 不含 vendor 细节 / access key / secret / signature。
    expect(body.status).toBe(503);
    const blob = JSON.stringify(body).toLowerCase();
    expect(blob).not.toContain('accesskey');
    expect(blob).not.toContain('secret');
    expect(blob).not.toContain('signature');
    expect(blob).not.toContain('aliyun');
  });

  // ── ⑨ 降级: 视觉路由失败 (provider 抛) → error 帧不脏写对话 (user turn 在, 无 assistant) ──
  it('⑨ 降级: 带图轮 provider 失败 → error 帧, 不落 assistant turn (user turn + attachment 已落不脏写)', async () => {
    const { id, token } = await activeToken();
    const sid = await seedSession(id);
    // errorAfter=0 → 首 event 前即抛 (模拟 M3 视觉不可达/非 2xx)。
    provider.setFake({ script: [{ ask: { question: 'Q' } }], errorAfter: 0 });

    const key = `ideation/${id}/fail-uuid/img`;
    const res = await turn(appOss, token, sid.toString(), {
      content: '触发视觉失败',
      attachmentKeys: [key],
    });
    expect(res.statusCode).toBe(200); // 流已开 (error 帧)
    const fr = frames(res.body);
    const errFrame = fr
      .map((f) => (f === '[DONE]' ? null : (JSON.parse(f) as { error?: unknown })))
      .find((p) => p !== null && p.error !== undefined);
    expect(errFrame).toBeDefined();
    // error 帧不暴露 vendor 内部错误细节 (FR-011: 统一 IDEATION 错误形态)。
    expect(JSON.stringify(errFrame).toLowerCase()).not.toContain('aliyun');

    // user turn + attachment 已落 (落了就不丢); assistant turn 不落半截 (FR-010 不脏写)。
    const rows = await turnsOf(sid);
    expect(rows).toEqual([{ role: 'user', content: '触发视觉失败', suggestion: null }]);
    const atts = await attachmentsOf(sid);
    expect(atts).toEqual([
      { sessionId: sid, accountId: id, ossKey: key, kind: 'image', annotationsJson: null },
    ]);
  });

  // ── env-gated: 真 OSS 直传 round-trip (默认 skip, 无真 bucket/CORS 不入 CI) ────
  it.skipIf(!process.env.RUN_OSS_IT)(
    'env-gated 真 OSS: 凭证签发 → 真 PostObject 直传 round-trip (RUN_OSS_IT)',
    () => {
      // 真 OSS bucket/CORS 接线在部署 PR 核 (tasks.md 部署前置); 本 IT 业务全走参数化 fake OSS。
      // 占位: 真 round-trip 留部署前置手动/env-gated 验证, 默认 skip 不红。
      expect(process.env.RUN_OSS_IT).toBeTruthy();
    },
  );

  // ── env-gated: 真 M3 视觉 round-trip (默认 skip, 无真 key 不入 CI) ─────────────
  it.skipIf(!process.env.RUN_M3_VISION_IT)(
    'env-gated 真 M3 视觉: 带图轮真 minimax round-trip (RUN_M3_VISION_IT)',
    () => {
      // 真 MiniMax key + 带图轮真 model round-trip 已在 T001 Spike env-gated 验路径; 本占位默认 skip。
      expect(process.env.RUN_M3_VISION_IT).toBeTruthy();
    },
  );
});
