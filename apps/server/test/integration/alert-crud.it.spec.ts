import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AuthModule } from '../../src/auth/auth.module';
import { AlertModule } from '../../src/alert/alert.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';

// 021 T007 全 boot IT — 覆盖 spec frontmatter state_branches 配置侧全条 (评估引擎条目归 PR-2 T013):
//  ① 批量建 (2 标的 × 2 条件, 每标的各一条, D5 原子) → EP1 个股可见 / EP2 平铺可见 /
//  ② 校验拒 400 (同类型重复 / 0 条件 / note 23 字 / 价格阈值 0 / 涨跌幅 101) + 整批零落库 /
//  ③ EP4 toggle 停用 → enabled=false 持久化 / ④ 他人资源: PATCH 未知 vs 他人 404 字节级一致 +
//  delete-batch 他人 id 静默跳过 (反枚举) / ⑤ 未认证 vs 非 ACTIVE → 401 字节级一致 /
//  ⑥ 消息三端点水位线闭环 (EP6 倒序+unread / EP7 计数 / EP8 置已读归零 / 新 trigger 再未读 /
//  keyset 分页) — trigger 行直插 prisma (引擎是 PR-2, 本 IT 验消息读侧) /
//  ⑦ 限流 429 (读桶 121 / 写桶 31 边界, 桶间互不污染)。
// beforeEach redis flushall 隔离限流桶 (读/写桶 per-account key)。
describe('021 alert CRUD + messages (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'alert-t007-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'alert-t007-hmac-secret-min-32-bytes-zyxwv';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule, AlertModule],
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
    await redis.flushall(); // 隔离限流桶
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613913${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }

  interface ConditionView {
    type: string;
    threshold: string;
  }
  interface AlertView {
    id: string;
    market: string;
    code: string;
    conditions: ConditionView[];
    frequency: string;
    note: string | null;
    enabled: boolean;
    createdAt: string;
  }
  interface MessageView {
    id: string;
    market: string;
    code: string;
    instrumentName: string;
    tradeDate: string;
    conditions: Array<ConditionView & { actual: string }>;
    note: string | null;
    triggeredAt: string;
    unread: boolean;
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const authJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });

  const listInstrument = (token: string, market: string, code: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/alert/instruments/${market}/${code}/alerts`,
      headers: auth(token),
    });
  const listAll = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/alert/alerts', headers: auth(token) });
  const createBatch = (token: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/alert/alerts', headers: authJson(token), payload });
  const patchAlert = (token: string, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/alert/alerts/${id}`,
      headers: authJson(token),
      payload,
    });
  const deleteBatch = (token: string, ids: string[]) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/alert/alerts/delete-batch',
      headers: authJson(token),
      payload: { ids },
    });
  const listMessages = (token: string, query = '') =>
    app.inject({ method: 'GET', url: `/api/v1/alert/messages${query}`, headers: auth(token) });
  const unreadCount = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/alert/messages/unread-count', headers: auth(token) });
  const markRead = (token: string) =>
    app.inject({ method: 'POST', url: '/api/v1/alert/messages/mark-read', headers: auth(token) });

  const alertsOf = (res: { json: () => unknown }) => (res.json() as { alerts: AlertView[] }).alerts;
  const messagesOf = (res: { json: () => unknown }) =>
    res.json() as { messages: MessageView[]; nextCursor: string | null };

  /** 标准合法草稿 (2 条件 AND)。 */
  const validBody = (codes: string[], extra: Record<string, unknown> = {}) => ({
    instruments: codes.map((code) => ({ market: 'cn', code })),
    conditions: [
      { type: 'PRICE_FALL_TO', threshold: 13 },
      { type: 'DAILY_LOSS_OVER', threshold: 5 },
    ],
    frequency: 'DAILY',
    note: '低吸观察',
    ...extra,
  });

  /** 触发流水直插 (引擎 PR-2 未落, 消息读侧用种子行验; alertId null 避开唯一键)。 */
  const seedTrigger = (
    accountId: bigint,
    opts: { tradeDate: string; triggeredAt: Date; code?: string },
  ) =>
    prisma.alertTrigger.create({
      data: {
        alertId: null,
        accountId,
        market: 'cn',
        code: opts.code ?? '603305',
        instrumentName: '旭升集团',
        tradeDate: new Date(opts.tradeDate),
        conditionsSnapshot: [{ type: 'PRICE_FALL_TO', threshold: '13.0000', actual: '12.8000' }],
        frequencySnapshot: 'DAILY',
        noteSnapshot: null,
        triggeredAt: opts.triggeredAt,
      },
    });

  /** ProblemDetail 字节级一致比较 (剥动态 traceId/instance)。 */
  const strip = (raw: string) => {
    const { traceId, instance, ...rest } = JSON.parse(raw) as Record<string, unknown>;
    void traceId;
    void instance;
    return rest;
  };

  // ── ① 批量建 → EP1/EP2 可见 ──────────────────────────────────────────────
  it('① 批量建 2 标的 × 2 条件 → 201 每标的各一条; EP1 个股各见 1; EP2 平铺 2 条', async () => {
    const { id, token } = await activeToken();
    const created = await createBatch(token, validBody(['603305', '600519']));
    expect(created.statusCode).toBe(201);
    const alerts = alertsOf(created);
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.code).sort()).toEqual(['600519', '603305']);
    for (const a of alerts) {
      expect(a).toMatchObject({
        market: 'cn',
        frequency: 'DAILY',
        note: '低吸观察',
        enabled: true,
      });
      expect(a.conditions).toHaveLength(2);
      // threshold Decimal → string '13.0000' (015 体例)
      expect(a.conditions.find((c) => c.type === 'PRICE_FALL_TO')!.threshold).toBe('13.0000');
      expect(a.conditions.find((c) => c.type === 'DAILY_LOSS_OVER')!.threshold).toBe('5.0000');
    }

    // EP1: 个股各见自己那条
    const ep1 = alertsOf(await listInstrument(token, 'cn', '603305'));
    expect(ep1).toHaveLength(1);
    expect(ep1[0]!.code).toBe('603305');

    // EP2: 全账号平铺 (分组归 client)
    const ep2 = alertsOf(await listAll(token));
    expect(ep2).toHaveLength(2);

    // DB: 2 alert + 4 condition 落库
    expect(await prisma.alert.count({ where: { accountId: id } })).toBe(2);
  });

  // ── ② 校验拒 400 + 整批零落库 (D5 原子) ──────────────────────────────────
  it('② 同类型重复 / 0 条件 / note 23 字 / 价格阈值 0 / 涨跌幅 101 → 400 且零落库', async () => {
    const { id, token } = await activeToken();

    const dupType = await createBatch(
      token,
      validBody(['603305'], {
        conditions: [
          { type: 'PRICE_FALL_TO', threshold: 13 },
          { type: 'PRICE_FALL_TO', threshold: 12 },
        ],
      }),
    );
    const empty = await createBatch(token, validBody(['603305'], { conditions: [] }));
    const longNote = await createBatch(token, validBody(['603305'], { note: '注'.repeat(23) }));
    const zeroPrice = await createBatch(
      token,
      validBody(['603305'], { conditions: [{ type: 'PRICE_FALL_TO', threshold: 0 }] }),
    );
    const percentOut = await createBatch(
      token,
      validBody(['603305'], { conditions: [{ type: 'DAILY_GAIN_OVER', threshold: 101 }] }),
    );

    for (const res of [dupType, empty, longNote, zeroPrice, percentOut]) {
      expect(res.statusCode).toBe(400);
      expect((res.json() as { code: string }).code).toBe('FORM_VALIDATION');
    }
    // 任一校验失败整批拒 → 零落库
    expect(await prisma.alert.count({ where: { accountId: id } })).toBe(0);
  });

  // ── ③ EP4 toggle 停用 ────────────────────────────────────────────────────
  it('③ PATCH enabled=false → 停用持久化, 条件不动', async () => {
    const { token } = await activeToken();
    const created = alertsOf(await createBatch(token, validBody(['603305'])));
    const id = created[0]!.id;

    const patched = await patchAlert(token, id, { enabled: false });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as AlertView).enabled).toBe(false);

    const refetched = alertsOf(await listInstrument(token, 'cn', '603305'));
    expect(refetched[0]).toMatchObject({ id, enabled: false });
    expect(refetched[0]!.conditions).toHaveLength(2); // 条件未被 toggle 误动
  });

  // ── ④ 他人资源 404 反枚举 + delete-batch 静默跳过 ────────────────────────
  it('④ PATCH 未知 id vs 他人 alert → 404 字节级一致; delete-batch 仅删本账号命中', async () => {
    const { token } = await activeToken();
    const other = await activeToken();
    const mine = alertsOf(await createBatch(token, validBody(['603305'])));
    const theirs = alertsOf(await createBatch(other.token, validBody(['600519'])));

    const unknown = await patchAlert(token, '888888888888', { enabled: false });
    const cross = await patchAlert(token, theirs[0]!.id, { enabled: false });
    expect(unknown.statusCode).toBe(404);
    expect(cross.statusCode).toBe(404);
    expect(strip(unknown.body)).toEqual(strip(cross.body));

    // delete-batch: 本账号 1 条 + 他人 1 条 + 未知 id → 实删仅 1, 他人行原样
    const res = await deleteBatch(token, [mine[0]!.id, theirs[0]!.id, '888888888888']);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { deleted: number }).deleted).toBe(1);
    expect(alertsOf(await listAll(token))).toHaveLength(0);
    expect(alertsOf(await listAll(other.token))).toHaveLength(1); // 他人未被波及
  });

  // ── ⑤ 未认证 / 非 ACTIVE → 401 字节级一致 ───────────────────────────────
  it('⑤ 未认证 vs 非 ACTIVE → 均 401 字节级一致 (反枚举)', async () => {
    const frozen = await prisma.account.create({ data: { phone: nextPhone(), status: 'FROZEN' } });
    const frozenToken = jwt.signAccessToken({ accountId: frozen.id });

    const noAuth = await app.inject({ method: 'GET', url: '/api/v1/alert/alerts' });
    const nonActive = await listAll(frozenToken);
    expect(noAuth.statusCode).toBe(401);
    expect(nonActive.statusCode).toBe(401);
    const stripTrace = (raw: string) => {
      const { traceId, ...rest } = JSON.parse(raw) as Record<string, unknown>;
      void traceId;
      return rest;
    };
    expect(stripTrace(noAuth.body)).toEqual(stripTrace(nonActive.body));
  });

  // ── ⑥ 消息三端点水位线闭环 ───────────────────────────────────────────────
  it('⑥ 倒序+unread → mark-read 归零 → 新 trigger 再未读 → keyset 分页', async () => {
    const { id, token } = await activeToken();
    await seedTrigger(id, {
      tradeDate: '2026-06-04',
      triggeredAt: new Date('2026-06-04T15:05:00Z'),
    });
    await seedTrigger(id, {
      tradeDate: '2026-06-05',
      triggeredAt: new Date('2026-06-05T15:05:00Z'),
    });

    // EP7 全未读 (无水位线行); EP6 倒序 + unread + 快照投影
    expect((await unreadCount(token)).json()).toEqual({ unread: 2 });
    const page = messagesOf(await listMessages(token));
    expect(page.messages).toHaveLength(2);
    expect(page.messages.map((m) => m.tradeDate)).toEqual(['2026-06-05', '2026-06-04']); // 倒序
    expect(page.messages.every((m) => m.unread)).toBe(true);
    expect(page.messages[0]!.conditions).toEqual([
      { type: 'PRICE_FALL_TO', threshold: '13.0000', actual: '12.8000' },
    ]);
    expect(page.messages[0]!.instrumentName).toBe('旭升集团');
    expect(page.nextCursor).toBeNull();

    // EP8 置已读 → EP7 归零, EP6 unread 全 false
    expect((await markRead(token)).json()).toEqual({ unread: 0 });
    expect((await unreadCount(token)).json()).toEqual({ unread: 0 });
    const afterRead = messagesOf(await listMessages(token));
    expect(afterRead.messages.every((m) => !m.unread)).toBe(true);

    // 新 trigger (水位线之后) → 再未读
    await seedTrigger(id, {
      tradeDate: '2026-06-06',
      triggeredAt: new Date(Date.now() + 5_000), // 严格 > mark-read 水位线
      code: '600519',
    });
    expect((await unreadCount(token)).json()).toEqual({ unread: 1 });

    // keyset 分页: 3 条 limit=2 → nextCursor → 末页 1 条 + null
    const first = messagesOf(await listMessages(token, '?limit=2'));
    expect(first.messages).toHaveLength(2);
    expect(first.nextCursor).toBe(first.messages[1]!.id);
    const second = messagesOf(await listMessages(token, `?limit=2&cursor=${first.nextCursor}`));
    expect(second.messages).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    // 他人消息不可见 (accountId scope)
    const other = await activeToken();
    expect(messagesOf(await listMessages(other.token)).messages).toHaveLength(0);
    expect((await unreadCount(other.token)).json()).toEqual({ unread: 0 });
  });

  // ── ⑦ 限流 429 (读 121 / 写 31 边界) ─────────────────────────────────────
  it('⑦ 读桶: GET 第 121 次 → 429 (alert-read-account 120/60s)', async () => {
    const { token } = await activeToken();
    let last;
    for (let i = 0; i < 121; i += 1) last = await listInstrument(token, 'cn', '603305');
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  }, 15_000);

  // 31 个串行写请求满载时可超 vitest 默认 5s → 显式放宽防 flake (013 同款)。
  it('⑦ 写桶: POST 第 31 次 → 429 (alert-write-account 30/60s, 校验 400 亦计桶)', async () => {
    const { token } = await activeToken();
    let last;
    for (let i = 0; i < 31; i += 1) {
      last = await createBatch(token, validBody(['603305'], { conditions: [] })); // 400 但计桶
    }
    expect(last!.statusCode).toBe(429);

    // 写桶满 ≠ 读桶受限 (桶隔离)
    expect((await listAll(token)).statusCode).toBe(200);
  }, 15_000);
});
