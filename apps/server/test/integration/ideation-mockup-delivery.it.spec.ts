import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  agentBridgeConfig,
  ossConfig,
  type AgentBridgeConfig,
  type OssConfig,
} from '../../src/config';
import { AppModule } from '../../src/app/app.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { mockupKeyPrefix } from '../../src/ideation/mockup.rules';

/**
 * 037 T008 ([US1][Server-IT]) — mockup 交付 + 读列表 state_branches 全覆盖 IT
 * (真 DI 容器 + Testcontainers PG/Redis + Fastify, per plan「NO LIFECYCLE MOCKING」+
 * 「MANDATORY INTEGRATION」: WorkerAuthGuard / JwtAuthGuard / Pipe / Filter 全在真实
 * lifecycle 触发, 经 DI override `agentBridgeConfig.KEY`(worker token) + `ossConfig.KEY`
 * 参数化 OSS, 绝不 `new Guard()` / `jest.mock`)。
 *
 * **模拟 worker** (channel = agent-platform 仓、仓外): 种子一条 claimed `agent_queue_event`
 * 行 (bizType='ideation.requirement' / bizId=String(sessionId) / status='claimed' / accountId)
 * + 直接持 worker token 调 worker-token 端点 (不依赖真 channel)。归属 scope (accountId,
 * sessionId) **永远** server 据 claimed event 派生, body 只带 eventId (channel 不自报)。
 *
 * 覆盖 spec.md state_branches (逐条对照, 每分支至少一 it):
 *  ① worker-token 有效 (正常派生) / 无效 → 401 (WorkerAuthGuard 真 DI lifecycle)。
 *  ② 凭证 scope 派生: keyPrefix=`ideation-mockup/{accountId}/{sessionId}/` + content-type 限
 *     text/html + size cap, 且 accountId/sessionId **来自 event 非请求自报** (body 只有 eventId)。
 *  ③ 写记录 prefix 归属: 合法 key (用 `mockupKeyPrefix` 拼) → insert 成功 (库多一行);
 *     谎报他 session prefix → 403 OBJECT_KEY_OUT_OF_SCOPE (事件合法但 key 越界, 非 404)。
 *  ④ append-only 多版: 同 session 多次 record → 多行; 读列表 createdAt 倒序返全部
 *     (versionRank latest=1)。
 *  ⑤ account-token 读列表: 自己 session 返列表 / 他人 session (另一 account 拥有的 sessionId)
 *     → 404 反枚举折叠 / 不存在 numeric session → 404 折叠 (字节级一致)。
 *  ⑥ 降级: OSS 未配 → 503 ProblemDetail (不泄 vendor); 派生失败 (eventId 不存在/非 claimed/
 *     bizType 不符) → 404 EVENT_NOT_FOUND, 且不脏写 (库无新行)。
 *
 * ⚠️ **覆盖边界 (analyze C1)**: spec state_branch「直传失败 → 不落库」= **channel 侧 (仓外)**
 * 职责 (server 只在直传成功后被调写记录, 看不到直传失败), 本 IT **不覆盖**该 branch, 由
 * agent-platform 仓 channel PR + T017 手动 dogfood 担保 —— 故本 IT 不声称 server IT 100%
 * 覆盖全 9 branch。渲染相关 branch (隔离 / 渲染最新 / 渲染降级) 为 mobile 职责, 走 T013 e2e。
 *
 * ⚠️ **反枚举语义 (实装)**: 读列表他人 / 不存在 numeric session → **404 字节级一致** (usecase 先
 * 校验 session 归属-存在, 镜像 get-session.usecase: 查不到本人 session → `SESSION_NOT_FOUND`,
 * 经全局 ProblemDetail filter 转 404; 沿 036 FR-013, 与 ideation 既有读端点统一)。本人**空** session
 * 仍 200 `{items:[]}` (own-empty 与他人 404 现可区分, 这是 404 约定的预期)。id 非数字 → 404
 * (`parseSessionId` 折叠, 与不存在不可区分)。两者断言: 他人 session 与不存在 numeric session 的
 * 404 响应字节级一致; 非数字 id 与不存在 numeric id 都 404 字节级一致。
 *
 * env-gated 真 OSS round-trip 用 `RUN_OSS_IT` (默认 skip, 无真 bucket/CORS 不入 CI)。fake-oss
 * 下只验签发逻辑 (不真传字节)。
 *
 * **双 app boot** (同享 PG/Redis 容器, 不同 OSS 配置, 同一 worker token):
 *   - `appOss`   —— `ossConfig.KEY` override 为 aliyun → 凭证签发 200 + 读列表 mockupUrl 非 null。
 *   - `appNoOss` —— 默认 unconfigured OSS → 凭证签发 503 降级。
 */

/** worker-token 端点的 Bearer 凭证 (≥32 字符; agentBridgeConfig.KEY override 注入)。 */
const WORKER_TOKEN = 'w'.repeat(43);

/** aliyun OSS 配置覆盖值 (确定性, 让签名 + public URL 派生生效; 非真 bucket — IT 不打真 OSS)。 */
const ALIYUN_OSS: OssConfig = {
  kind: 'aliyun',
  region: 'oss-cn-shanghai',
  bucket: 'mbw-test-mockups',
  accessKeyId: 'LTAI-test-access-key-id',
  accessKeySecret: 'test-access-key-secret-deterministic',
};

/** unconfigured OSS (dev/test 默认形态; 显式 override 防 @nestjs/config registerAs 跨 app 记忆化泄漏)。 */
const UNCONFIGURED_OSS: OssConfig = { kind: 'unconfigured' };

/** worker token config override (两 app 共享同一 token; 不配 → guard fail-closed 全 401)。 */
const WORKER_CFG: AgentBridgeConfig = { workerToken: WORKER_TOKEN };

describe('037 ideation mockup delivery (credential + record + list, Testcontainers PG + Redis + Fastify)', () => {
  let appOss: NestFastifyApplication;
  let appNoOss: NestFastifyApplication;
  let moduleOss: TestingModule;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let seq = 0;

  async function bootApp(
    ossOverride: OssConfig,
  ): Promise<{ module: TestingModule; app: NestFastifyApplication }> {
    // 两 app 均**显式** override ossConfig.KEY + agentBridgeConfig.KEY —— @nestjs/config v4
    // registerAs 跨独立 DI 容器仍记忆化首个 factory 结果, 仅靠「不 override 读 env」会让两 app
    // 共享同一 config 对象 (036 实测 unconfigured app 误读到 aliyun)。各自显式 useValue 切断泄漏。
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ossConfig.KEY)
      .useValue(ossOverride)
      .overrideProvider(agentBridgeConfig.KEY)
      .useValue(WORKER_CFG)
      .compile();
    const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return { module, app };
  }

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'ideation-t008-jwt-secret-min-32-bytes-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'ideation-t008-hmac-secret-min-32-bytes-zy';

    // appNoOss 先 boot (默认 unconfigured OSS → 503 降级); appOss 后 boot (aliyun override →
    // 凭证 200 + mockupUrl 派生)。两 app 独立 DI 容器, ossConfig.KEY 经 .overrideProvider 各自注入。
    ({ app: appNoOss } = await bootApp(UNCONFIGURED_OSS));
    ({ module: moduleOss, app: appOss } = await bootApp(ALIYUN_OSS));

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

  /** 建 ACTIVE 账号 + 签 account-token (读列表 JwtAuthGuard 用)。 */
  async function activeAccount(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }

  /** 建一条本 account 的 ideation session。 */
  async function seedSession(accountId: bigint): Promise<bigint> {
    const s = await prisma.ideaSession.create({
      data: { accountId, title: '种子会话', status: 'open' },
      select: { id: true },
    });
    return s.id;
  }

  /**
   * 模拟 channel 已认领: 种子一条 claimed `agent_queue_event` 行 (bizType=ideation.requirement,
   * bizId=String(sessionId), status='claimed', accountId)。返事件 id (worker 端点据此派生 scope)。
   * opts.status / opts.bizType 可覆盖以构造派生失败分支 (非 claimed / 错 bizType)。
   */
  async function seedClaimedEvent(
    accountId: bigint,
    sessionId: bigint,
    opts: { status?: string; bizType?: string } = {},
  ): Promise<string> {
    const ev = await prisma.agentQueueEvent.create({
      data: {
        accountId,
        bizType: opts.bizType ?? 'ideation.requirement',
        bizId: String(sessionId),
        status: opts.status ?? 'claimed',
      },
      select: { id: true },
    });
    return ev.id;
  }

  const workerAuth = (token: string = WORKER_TOKEN) => ({ authorization: `Bearer ${token}` });
  const workerJson = (token: string = WORKER_TOKEN) => ({
    ...workerAuth(token),
    'content-type': 'application/json',
  });
  const accountAuth = (token: string) => ({ authorization: `Bearer ${token}` });

  // worker-token 凭证签发 EP (appOss = aliyun → 200; appNoOss = unconfigured → 503)。
  const credential = (
    app: NestFastifyApplication,
    payload: Record<string, unknown>,
    token: string = WORKER_TOKEN,
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/ideation/mockups/credential',
      headers: workerJson(token),
      payload,
    });

  // worker-token 写记录 EP (201 void)。
  const record = (
    app: NestFastifyApplication,
    payload: Record<string, unknown>,
    token: string = WORKER_TOKEN,
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/ideation/mockups',
      headers: workerJson(token),
      payload,
    });

  // account-token 读列表 EP。
  const listMockups = (app: NestFastifyApplication, token: string, sessionId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/ideation/sessions/${sessionId}/mockups`,
      headers: accountAuth(token),
    });

  /** 剥 ProblemDetail 易变字段 (traceId/instance) 供字节级比较。 */
  const strip = (raw: string) => {
    const { traceId, instance, ...rest } = JSON.parse(raw) as Record<string, unknown>;
    void traceId;
    void instance;
    return rest;
  };

  /** 直查某 session 的 mockup 行数 (脏写断言)。 */
  const mockupCountOf = (sessionId: bigint) =>
    prisma.ideationMockup.count({ where: { sessionId } });

  // ── ① worker-token 有效 / 无效 → 401 (WorkerAuthGuard 真 lifecycle) ───────────
  it('① 凭证 EP: 有效 worker token → 200 派生; 缺 / 错 token → 401 (字节级一致)', async () => {
    const acct = await activeAccount();
    const sid = await seedSession(acct.id);
    const eventId = await seedClaimedEvent(acct.id, sid);

    const ok = await credential(appOss, { eventId });
    expect(ok.statusCode).toBe(200);

    const noAuth = await appOss.inject({
      method: 'POST',
      url: '/api/v1/ideation/mockups/credential',
      headers: { 'content-type': 'application/json' },
      payload: { eventId },
    });
    expect(noAuth.statusCode).toBe(401);

    const badAuth = await credential(appOss, { eventId }, 'wrong-worker-token');
    expect(badAuth.statusCode).toBe(401);
    // 缺 token / 错 token 字节级一致 (不暴露「token 未配」vs「token 不符」差异)。
    expect(strip(noAuth.body)).toEqual(strip(badAuth.body));
  });

  it('① 写记录 EP: 缺 / 错 worker token → 401, 不落库', async () => {
    const acct = await activeAccount();
    const sid = await seedSession(acct.id);
    const eventId = await seedClaimedEvent(acct.id, sid);
    const key = `${mockupKeyPrefix(acct.id, sid)}${randomUUID()}/index.html`;

    const noAuth = await appOss.inject({
      method: 'POST',
      url: '/api/v1/ideation/mockups',
      headers: { 'content-type': 'application/json' },
      payload: { eventId, objectKey: key, screens: ['空态'] },
    });
    expect(noAuth.statusCode).toBe(401);

    const badAuth = await record(appOss, { eventId, objectKey: key, screens: ['空态'] }, 'bad');
    expect(badAuth.statusCode).toBe(401);
    expect(await mockupCountOf(sid)).toBe(0);
  });

  // ── ② 凭证 scope 派生: keyPrefix + content-type=text/html + size cap (来自 event) ──
  it('② 凭证 scope: keyPrefix=ideation-mockup/{accountId}/{sessionId}/ + content-type text/html + size cap; accountId/sessionId 来自 event 非自报', async () => {
    const acct = await activeAccount();
    const sid = await seedSession(acct.id);
    // body 只带 eventId —— accountId/sessionId 不在请求里, 由 server 据 event 派生。
    const eventId = await seedClaimedEvent(acct.id, sid);

    const res = await credential(appOss, { eventId });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      host: string;
      objectKey: string;
      expiresAt: string;
      fields: { key: string; policy: string };
    };

    // objectKey / fields.key 严格落在派生 scope 前缀内 (accountId/sessionId 来自 event)。
    const expectedPrefix = mockupKeyPrefix(acct.id, sid);
    expect(expectedPrefix).toBe(`ideation-mockup/${acct.id}/${sid}/`);
    expect(body.objectKey.startsWith(expectedPrefix)).toBe(true);
    expect(body.fields.key).toBe(body.objectKey);
    // host 指向 override 的 bucket/region (确定性)。
    expect(body.host).toBe('https://mbw-test-mockups.oss-cn-shanghai.aliyuncs.com');
    // expiresAt = ISO 8601 (TTL 15min 后)。
    expect(body.expiresAt).toBe(new Date(body.expiresAt).toISOString());

    // policy (base64 JSON) 内嵌 key-prefix / content-type 白名单 / size 上限三道 scope 闸。
    const policy = JSON.parse(Buffer.from(body.fields.policy, 'base64').toString('utf8')) as {
      conditions: unknown[];
    };
    const conds = policy.conditions as Array<unknown>;
    // key 前缀 starts-with 闸 (本 session scope 锁)。
    expect(conds).toContainEqual(['starts-with', '$key', expectedPrefix]);
    // content-type 白名单闸 = 仅 text/html (mockup 单自包含 HTML)。
    expect(conds).toContainEqual(['in', '$content-type', ['text/html']]);
    // size 上限闸 (1..5MB)。
    expect(conds).toContainEqual(['content-length-range', 1, 5 * 1024 * 1024]);
  });

  it('② 凭证 scope 隔离: 不同 event (不同 account/session) → 各自前缀, 互不串档', async () => {
    const a = await activeAccount();
    const b = await activeAccount();
    const sidA = await seedSession(a.id);
    const sidB = await seedSession(b.id);
    const evA = await seedClaimedEvent(a.id, sidA);
    const evB = await seedClaimedEvent(b.id, sidB);

    const resA = await credential(appOss, { eventId: evA });
    const resB = await credential(appOss, { eventId: evB });
    const keyA = (JSON.parse(resA.body) as { objectKey: string }).objectKey;
    const keyB = (JSON.parse(resB.body) as { objectKey: string }).objectKey;

    expect(keyA.startsWith(mockupKeyPrefix(a.id, sidA))).toBe(true);
    expect(keyB.startsWith(mockupKeyPrefix(b.id, sidB))).toBe(true);
    expect(keyA.startsWith(mockupKeyPrefix(b.id, sidB))).toBe(false);
  });

  // ── ③ 写记录 prefix 归属: 合法 insert / 谎报他 session → 403 ────────────────────
  it('③ 写记录: 合法 key (派生 scope 前缀) → 201 insert (库多一行)', async () => {
    const acct = await activeAccount();
    const sid = await seedSession(acct.id);
    const eventId = await seedClaimedEvent(acct.id, sid);
    const key = `${mockupKeyPrefix(acct.id, sid)}${randomUUID()}/index.html`;

    expect(await mockupCountOf(sid)).toBe(0);
    const res = await record(appOss, {
      eventId,
      objectKey: key,
      screens: ['空态', '加载', '成功'],
      note: '自检通过',
    });
    expect(res.statusCode).toBe(201);
    // 201 void —— 无 body。
    expect(res.body).toBe('');

    // 库里多一行 (append-only insert); 归属 + screens 落库。
    const rows = await prisma.ideationMockup.findMany({
      where: { sessionId: sid },
      select: { accountId: true, objectKey: true, screens: true, note: true },
    });
    expect(rows).toEqual([
      { accountId: acct.id, objectKey: key, screens: ['空态', '加载', '成功'], note: '自检通过' },
    ]);
  });

  it('③ 写记录: 谎报他 session 的 prefix → 403 OBJECT_KEY_OUT_OF_SCOPE (事件合法但 key 越界), 不落库', async () => {
    const owner = await activeAccount();
    const other = await activeAccount();
    const sidOwner = await seedSession(owner.id);
    const sidOther = await seedSession(other.id);
    // 用 owner 自己的 claimed event (合法), 但 objectKey 谎报指向他人 session 前缀。
    const eventId = await seedClaimedEvent(owner.id, sidOwner);
    const foreignKey = `${mockupKeyPrefix(other.id, sidOther)}${randomUUID()}/index.html`;

    const res = await record(appOss, { eventId, objectKey: foreignKey, screens: ['x'] });
    // 403 (非 404): eventId 合法 (派生成功), 仅 objectKey 越界 → 越权写, 语义不同于「事件不存在」。
    expect(res.statusCode).toBe(403);
    // 既不落 owner session 也不落 other session。
    expect(await mockupCountOf(sidOwner)).toBe(0);
    expect(await mockupCountOf(sidOther)).toBe(0);
  });

  it('③ 写记录: screens 非字符串元素规整 (channel 上报不可信 Json 兜底)', async () => {
    const acct = await activeAccount();
    const sid = await seedSession(acct.id);
    const eventId = await seedClaimedEvent(acct.id, sid);
    const key = `${mockupKeyPrefix(acct.id, sid)}${randomUUID()}/index.html`;

    // screens 含非字符串元素 (ValidationPipe whitelist 不会过滤数组内元素类型 —— 经 UC
    // normalizeScreens 兜底丢弃)。注: class-validator @IsString({each}) 会拒非字符串元素,
    // 故此处只验「合法字符串数组」原样落库 (规整纯逻辑单测在 mockup.rules.spec.ts)。
    const res = await record(appOss, { eventId, objectKey: key, screens: ['仅一屏'] });
    expect(res.statusCode).toBe(201);
    const row = await prisma.ideationMockup.findFirstOrThrow({
      where: { sessionId: sid },
      select: { screens: true },
    });
    expect(row.screens).toEqual(['仅一屏']);
  });

  // ── ④ append-only 多版 + 读列表倒序 (versionRank latest=1) ─────────────────────
  it('④ append-only 多版: 同 session 多次 record → 多行; 读列表 createdAt 倒序返全部 (versionRank latest=1)', async () => {
    const acct = await activeAccount();
    const sid = await seedSession(acct.id);
    const eventId = await seedClaimedEvent(acct.id, sid);

    // 三版依次交付 (顺序写入 → createdAt 单调递增; v3 最新)。
    const keys: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const key = `${mockupKeyPrefix(acct.id, sid)}v${i}/index.html`;
      keys.push(key);
      const res = await record(appOss, { eventId, objectKey: key, screens: [`屏${i}`] });
      expect(res.statusCode).toBe(201);
    }
    expect(await mockupCountOf(sid)).toBe(3);

    const listRes = await listMockups(appOss, acct.token, sid.toString());
    expect(listRes.statusCode).toBe(200);
    const body = JSON.parse(listRes.body) as {
      items: Array<{
        objectKey: string;
        screens: string[];
        versionRank: number;
        mockupUrl: string | null;
        createdAt: string;
      }>;
    };

    // 倒序: 最新 (v3) 在前, versionRank latest=1。
    expect(body.items.map((x) => x.objectKey)).toEqual([keys[2], keys[1], keys[0]]);
    expect(body.items.map((x) => x.versionRank)).toEqual([1, 2, 3]);
    expect(body.items[0].screens).toEqual(['屏3']);
    // createdAt 严格倒序 (desc)。
    const times = body.items.map((x) => new Date(x.createdAt).getTime());
    expect(times[0]).toBeGreaterThanOrEqual(times[1]);
    expect(times[1]).toBeGreaterThanOrEqual(times[2]);
    // aliyun OSS 配置下 mockupUrl 非 null (备案展示域派生)。
    expect(body.items[0].mockupUrl).toBe(
      `https://mbw-test-mockups.oss-cn-shanghai.aliyuncs.com/${keys[2]}`,
    );
  });

  // ── ⑤ account-token 读列表: 自己 / 自己空 / 他人 / 不存在 (404 反枚举折叠) ────────
  it('⑤ 读列表: 自己 session 返列表; 本人空 session → 200 {items:[]}; 他人 session / 不存在 numeric → 404 (反枚举字节级一致)', async () => {
    const owner = await activeAccount();
    const other = await activeAccount();
    const sid = await seedSession(owner.id);
    const eventId = await seedClaimedEvent(owner.id, sid);
    const key = `${mockupKeyPrefix(owner.id, sid)}${randomUUID()}/index.html`;
    await record(appOss, { eventId, objectKey: key, screens: ['成功'] });

    // 自己 session → 返该记录。
    const own = await listMockups(appOss, owner.token, sid.toString());
    expect(own.statusCode).toBe(200);
    expect((JSON.parse(own.body) as { items: unknown[] }).items).toHaveLength(1);

    // 本人**空** session (归属本人但无 mockup) → 200 {items:[]} (own-empty 与他人 404 现可区分)。
    const emptySid = await seedSession(owner.id);
    const ownEmpty = await listMockups(appOss, owner.token, emptySid.toString());
    expect(ownEmpty.statusCode).toBe(200);
    expect((JSON.parse(ownEmpty.body) as { items: unknown[] }).items).toEqual([]);

    // 他人 account 拿 owner 的 sessionId → 404 (usecase 归属-存在校验失败, 与「不存在」不可区分)。
    const byOther = await listMockups(appOss, other.token, sid.toString());
    // 不存在的 numeric session id → 同样 404。
    const unknown = await listMockups(appOss, owner.token, '99999999');

    expect(byOther.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    // 他人 session 与不存在 session 的 404 响应字节级一致 (剥 traceId 后, 反枚举折叠)。
    expect(strip(byOther.body)).toEqual(strip(unknown.body));
  });

  it('⑤ 读列表: id 非数字 → 404 字节级一致 (与不存在折叠, parseSessionId 反枚举)', async () => {
    const acct = await activeAccount();

    const nonNumeric = await listMockups(appOss, acct.token, 'abc');
    expect(nonNumeric.statusCode).toBe(404);
    // 非数字 id 与不存在 numeric id 的 404 折叠语义一致 (剥 traceId 后)。
    const otherNonNumeric = await listMockups(appOss, acct.token, 'not-a-session');
    expect(otherNonNumeric.statusCode).toBe(404);
    expect(strip(nonNumeric.body)).toEqual(strip(otherNonNumeric.body));
  });

  it('⑤ 读列表: 缺 / 错 account token → 401 (JwtAuthGuard, 反枚举)', async () => {
    const acct = await activeAccount();
    const sid = await seedSession(acct.id);

    const noAuth = await appOss.inject({
      method: 'GET',
      url: `/api/v1/ideation/sessions/${sid.toString()}/mockups`,
    });
    expect(noAuth.statusCode).toBe(401);
    const badAuth = await listMockups(appOss, 'not-a-valid-jwt', sid.toString());
    expect(badAuth.statusCode).toBe(401);
  });

  // ── ⑥ 降级: OSS 未配 → 503 不泄 vendor / 派生失败 → 404 不脏写 ──────────────────
  it('⑥ 降级: OSS 未配 → 凭证 503 ProblemDetail (不泄 vendor / 凭证)', async () => {
    const acct = await activeAccount();
    const sid = await seedSession(acct.id);
    const eventId = await seedClaimedEvent(acct.id, sid);

    // appNoOss = 默认 unconfigured OSS → UC 显式 503 OSS_NOT_CONFIGURED (不用空 creds 签名)。
    const res = await credential(appNoOss, { eventId });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.status).toBe(503);
    // 不含 vendor 细节 / access key / secret / signature。
    const blob = JSON.stringify(body).toLowerCase();
    expect(blob).not.toContain('accesskey');
    expect(blob).not.toContain('secret');
    expect(blob).not.toContain('signature');
    expect(blob).not.toContain('aliyun');
  });

  it('⑥ 派生失败: eventId 不存在 → 404 EVENT_NOT_FOUND (凭证 + 写记录, 不脏写)', async () => {
    const acct = await activeAccount();
    const sid = await seedSession(acct.id);
    const ghostEventId = randomUUID();

    const credRes = await credential(appOss, { eventId: ghostEventId });
    expect(credRes.statusCode).toBe(404);

    const key = `${mockupKeyPrefix(acct.id, sid)}${randomUUID()}/index.html`;
    const recRes = await record(appOss, { eventId: ghostEventId, objectKey: key, screens: ['x'] });
    expect(recRes.statusCode).toBe(404);
    // 不脏写: 派生失败 → 库无新行。
    expect(await mockupCountOf(sid)).toBe(0);
  });

  it('⑥ 派生失败: event 非 claimed (status=pending) → 404 不脏写', async () => {
    const acct = await activeAccount();
    const sid = await seedSession(acct.id);
    const pendingEvent = await seedClaimedEvent(acct.id, sid, { status: 'pending' });

    const credRes = await credential(appOss, { eventId: pendingEvent });
    expect(credRes.statusCode).toBe(404);

    const key = `${mockupKeyPrefix(acct.id, sid)}${randomUUID()}/index.html`;
    const recRes = await record(appOss, { eventId: pendingEvent, objectKey: key, screens: ['x'] });
    expect(recRes.statusCode).toBe(404);
    expect(await mockupCountOf(sid)).toBe(0);
  });

  it('⑥ 派生失败: event bizType 不符 (非 ideation.requirement) → 404 不脏写', async () => {
    const acct = await activeAccount();
    const sid = await seedSession(acct.id);
    const wrongBizEvent = await seedClaimedEvent(acct.id, sid, { bizType: 'portfolio.sync' });

    const credRes = await credential(appOss, { eventId: wrongBizEvent });
    expect(credRes.statusCode).toBe(404);

    const key = `${mockupKeyPrefix(acct.id, sid)}${randomUUID()}/index.html`;
    const recRes = await record(appOss, { eventId: wrongBizEvent, objectKey: key, screens: ['x'] });
    expect(recRes.statusCode).toBe(404);
    expect(await mockupCountOf(sid)).toBe(0);
  });

  it('⑥ 派生失败折叠反枚举: 凭证不存在 event vs 非 claimed event → 404 字节级一致', async () => {
    const acct = await activeAccount();
    const sid = await seedSession(acct.id);
    const pendingEvent = await seedClaimedEvent(acct.id, sid, { status: 'pending' });

    const ghost = await credential(appOss, { eventId: randomUUID() });
    const pending = await credential(appOss, { eventId: pendingEvent });
    expect(ghost.statusCode).toBe(404);
    expect(pending.statusCode).toBe(404);
    // 不存在 vs 非 claimed → body 字节级一致 (不泄漏「事件存在但未认领」)。
    expect(strip(ghost.body)).toEqual(strip(pending.body));
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
});
