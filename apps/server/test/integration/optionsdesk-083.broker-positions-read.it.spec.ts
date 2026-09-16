import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Logger, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import type { Prisma } from '../../src/generated/prisma/client';
import { MARKETDATA_WORKER_DISABLED } from '../../src/marketdata/marketdata-sync.queue';
import {
  TRADING_CALENDAR_PORT,
  type TradingDayStatus,
} from '../../src/marketdata/trading-calendar.port';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';

// 083 T005 —— 券商持仓列表读端 (上): 端点骨架 + 列表主体
// (FR-001 / FR-002 / FR-003 / FR-005 / FR-007 / FR-011 / FR-012 / FR-021; plan D1 / D2 / D3 / D6 / D8;
// state_branches 1, 8, 9, 16, 20, 21, 23)。
// 083 T006 —— 同一读端 (下): 同步时刻 + 陈旧 + 空态口径 (FR-008 / FR-009 / FR-010; plan D7;
// state_branches 2, 3, 5, 6, 7, 44)。同步记录的「成功 / 失败 / 只有补齐」必须是库里真有的行 ——
// 取值是一条带 `OR` 的真 SQL, mock 下它恒等于 mock 返回值。
//
// ## 为什么**必须**要真 PG + 真 HTTP
//
//   ① **账号隔离是查询条件** (Guardrail 2): 「账号 B 看不到 A 的持仓」只有在库里**真有** A 的行、
//      且 SQL 真按 `account_id` 过滤时才有反例可看; mock Prisma 下返回值就是 mock 本身, 去掉
//      `accountId` 条件照样绿。
//   ② **锚集 / 名称 / 连接标签是三张真表的读**: 锚表 (含 excluded) → 锚集与锚现价;
//      `marketdata.instrument` → 正股名 (跨 ctx 只读); `broker_connection.label` → 连接标签。
//   ③ **账号来自 JWT**: `req.user.accountId` 由 `JwtAuthGuard` 在真 Fastify lifecycle 里填
//      (plan Testing Invariants「NO LIFECYCLE MOCKING」)。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 `setupIsolatedDb()` 取 (共享 PG 模板克隆, 禁自起容器);
// 本端点不碰 Redis ⇒ `REDIS_CLIENT` stub。装配 = `narrowTestModule([OptionsdeskModule])` 真 DI,
// 请求经 `app.inject()` 带真 JWT。fixture 全为合成值 (`ZQX` / `ZQY` / `ZQR` / 港股 `088xx`)。

const US_STOCK = 'US.ZQX';
/** 2027-12-17 到期 ⇒ 相对任意跑测时刻都未到期。 */
const US_PUT_LIVE = 'US.ZQY271217P30000';
/** 2026-01-16 到期 ⇒ 已到期 (尚未被同步移除)。 */
const US_PUT_EXPIRED = 'US.ZQY260116P30000';

/**
 * 交易日历端口 test double (plan Testing Invariants 允许的唯一替身): 固定「今天」的三态与上一交易日,
 * 并计数 —— 陈旧判定与跑测墙钟解耦。
 */
class FakeTradingCalendar {
  todayStatus: TradingDayStatus = 'trading';
  previous: string | null = '2026-09-09';
  previousCalls: { market: string; date: string }[] = [];

  reset() {
    this.todayStatus = 'trading';
    this.previous = '2026-09-09';
    this.previousCalls = [];
  }
  async classify(): Promise<TradingDayStatus> {
    return this.todayStatus;
  }
  async previousTradingDay(market: string, date: string): Promise<string | null> {
    this.previousCalls.push({ market, date });
    return this.previous;
  }
  async lastClosedSession(): Promise<string | null> {
    return null;
  }
}

describe('083 T005 / T006 券商持仓列表读端 (共享 PG + 收窄 boot + 真 HTTP)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let jwt: JwtTokenService;
  const calendar = new FakeTradingCalendar();
  const prevWorkerDisabled = process.env[MARKETDATA_WORKER_DISABLED];

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-083-t005-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-083-t005-hmac-secret-min-32-bytes';
    // 本地 shell 常泄漏 MARKETDATA_PROVIDER=live 与 OSS_* 部署凭据 (同 046 详情读端 IT)。
    process.env.MARKETDATA_PROVIDER = 'mock';
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OSS_')) delete process.env[key];
    }
    // 不起 marketdata 队列 worker (同 046 详情读端 IT: bullmq 5.x 关停竞态假红)。
    process.env[MARKETDATA_WORKER_DISABLED] = '1';

    moduleRef = await Test.createTestingModule({ imports: narrowTestModule([OptionsdeskModule]) })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ call: () => undefined, quit: () => undefined, on: () => undefined })
      // T006: 陈旧判定的「今天三态 / 上一交易日」由 test double 固定 (mock 档默认绑的 adapter 随墙钟漂)。
      .overrideProvider(TRADING_CALENDAR_PORT)
      .useValue(calendar)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtTokenService);
  }, 180_000);

  afterAll(async () => {
    if (prevWorkerDisabled === undefined) delete process.env[MARKETDATA_WORKER_DISABLED];
    else process.env[MARKETDATA_WORKER_DISABLED] = prevWorkerDisabled;
    await app?.close();
    await db?.drop();
  });

  let accountA: bigint;
  let accountB: bigint;

  beforeEach(async () => {
    await prisma.brokerSyncRun.deleteMany({});
    await prisma.brokerPosition.deleteMany({});
    await prisma.brokerConnection.deleteMany({});
    await prisma.anchor.deleteMany({});
    await prisma.optionContract.deleteMany({});
    await prisma.instrument.deleteMany({});
    await prisma.account.deleteMany({});

    accountA = (
      await prisma.account.create({ data: { phone: '+8613800083001', status: 'ACTIVE' } })
    ).id;
    accountB = (
      await prisma.account.create({ data: { phone: '+8613800083002', status: 'ACTIVE' } })
    ).id;

    const anchor = (ticker: string, over: Partial<Prisma.AnchorCreateInput> = {}) =>
      prisma.anchor.create({
        data: {
          ticker,
          market: ticker.split(':')[0]!,
          v: '50',
          asof: new Date('2026-06-30T00:00:00Z'),
          method: 'dcf',
          confidence: '8',
          confidenceSource: 'manual',
          lLevelEffective: 'L2',
          ...over,
        },
      });
    await anchor('us:ZQX');
    // 只有期权持仓的组: 组头现价取锚现价 (无盘中价 ⇒ 收盘价)。excluded 仍在锚集 (plan D2)。
    await anchor('us:ZQY', {
      lastClose: '31.5',
      lastCloseDate: new Date('2026-09-01T00:00:00Z'),
      excluded: true,
    });
    await anchor('hk:08801');
    await prisma.instrument.create({
      data: {
        market: 'us',
        code: 'ZQX',
        name: '示例甲',
        type: 'stock',
        currency: 'USD',
        status: 'active',
      },
    });
  });

  const tokenOf = (accountId: bigint) => jwt.signAccessToken({ accountId });

  const connect = (accountId: bigint, label: string, brokerCode = 'futu') =>
    prisma.brokerConnection
      .create({ data: { accountId, brokerCode, label, phoneLast4: '0000' } })
      .then((c) => c.id);

  const seedPosition = (
    accountId: bigint,
    connectionId: bigint,
    code: string,
    over: Partial<Prisma.BrokerPositionUncheckedCreateInput> = {},
  ) =>
    prisma.brokerPosition.create({
      data: {
        accountId,
        connectionId,
        market: code.startsWith('HK.') ? 'hk' : 'us',
        code,
        underlyingTicker: null,
        qty: '1',
        marketValue: '100',
        currentPrice: '10',
        averageCost: '9',
        currency: code.startsWith('HK.') ? 'HKD' : 'USD',
        firstSeenAt: new Date('2026-08-01T15:00:00Z'),
        openedAt: new Date('2026-08-01T15:00:00Z'),
        openedAtSource: 'derived',
        syncedAt: new Date('2026-09-01T15:00:00Z'),
        raw: { code },
        ...over,
      },
    });

  const list = async (accountId: bigint, market = 'us') => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/optionsdesk/broker-positions?market=${market}`,
      headers: { authorization: `Bearer ${tokenOf(accountId)}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  const allRows = (body: { groups: { rows: Record<string, unknown>[] }[] }) =>
    body.groups.flatMap((g) => g.rows);

  it('① 账号无连接 ⇒ hasConnection=false、brokerCount=0、groups=[] (branch 1)', async () => {
    const body = await list(accountA);
    expect(body).toMatchObject({
      hasConnection: false,
      brokerCount: 0,
      syncedAt: null,
      syncedAtLocal: null,
      stale: false,
      unresolvedCount: 0,
      groups: [],
    });
  });

  it('② 非锚持仓不返回、未解析持仓计入 unresolvedCount、他市场持仓不进本市场 (branch 8, 9)', async () => {
    const conn = await connect(accountA, '主账户');
    await seedPosition(accountA, conn, US_STOCK, { underlyingTicker: 'us:ZQX' });
    await seedPosition(accountA, conn, 'US.ZQR', { underlyingTicker: 'us:ZQR' });
    await seedPosition(accountA, conn, 'US.ZQRW', { underlyingTicker: null });
    await seedPosition(accountA, conn, 'US.ZQRV', { underlyingTicker: null });
    await seedPosition(accountA, conn, 'HK.08801', { underlyingTicker: 'hk:08801' });

    const us = await list(accountA);
    expect(us.hasConnection).toBe(true);
    expect(us.unresolvedCount).toBe(2);
    expect(us.groups.map((g: { underlyingTicker: string }) => g.underlyingTicker)).toEqual([
      'us:ZQX',
    ]);
    expect(allRows(us).map((r) => r.code)).toEqual([US_STOCK]);

    const hk = await list(accountA, 'hk');
    expect(hk.unresolvedCount).toBe(0);
    expect(allRows(hk).map((r) => r.code)).toEqual(['HK.08801']);
  });

  it('③ 1 个连接 ⇒ brokerCount=1; 2 个连接 ⇒ brokerCount=2、同合约两行各带自己的 connectionLabel、数量不合并 (branch 20, 21)', async () => {
    const first = await connect(accountA, '主账户');
    await seedPosition(accountA, first, US_PUT_LIVE, { underlyingTicker: 'us:ZQY', qty: '-2' });
    expect((await list(accountA)).brokerCount).toBe(1);

    const second = await connect(accountA, '备用账户');
    await seedPosition(accountA, second, US_PUT_LIVE, { underlyingTicker: 'us:ZQY', qty: '-1' });
    const body = await list(accountA);
    expect(body.brokerCount).toBe(2);
    const rows = allRows(body);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.connectionLabel, r.qty]).sort()).toEqual([
      ['主账户', '-2'],
      ['备用账户', '-1'],
    ]);
  });

  it('④ 已过期期权行 expired=true, 未到期 expired=false, 正股恒 false (branch 23)', async () => {
    const conn = await connect(accountA, '主账户');
    await seedPosition(accountA, conn, US_PUT_EXPIRED, { underlyingTicker: 'us:ZQY' });
    await seedPosition(accountA, conn, US_PUT_LIVE, { underlyingTicker: 'us:ZQY' });
    await seedPosition(accountA, conn, US_STOCK, { underlyingTicker: 'us:ZQX' });

    const byCode = new Map(allRows(await list(accountA)).map((r) => [r.code, r]));
    expect(byCode.get(US_PUT_EXPIRED)).toMatchObject({
      kind: 'option',
      expired: true,
      option: { expiry: '2026-01-16', right: 'P', strike: '30' },
    });
    expect(byCode.get(US_PUT_LIVE)).toMatchObject({ kind: 'option', expired: false });
    expect(byCode.get(US_STOCK)).toMatchObject({ kind: 'stock', expired: false, option: null });
  });

  it('⑤ 🚨 账号 B 请求 ⇒ 看不到账号 A 的任何持仓 (SC-006 列表面)', async () => {
    const connA = await connect(accountA, '主账户');
    await seedPosition(accountA, connA, US_STOCK, { underlyingTicker: 'us:ZQX' });
    await seedPosition(accountA, connA, 'US.ZQRW', { underlyingTicker: null });
    await connect(accountB, '另一人的账户');

    const bodyB = await list(accountB);
    expect(bodyB).toMatchObject({ hasConnection: true, brokerCount: 1, unresolvedCount: 0 });
    expect(bodyB.groups).toEqual([]);
    // 管道自证: 同一时刻 A 自己看得到 ⇒ 上面的空不是「种数没落库」。
    const bodyA = await list(accountA);
    expect(allRows(bodyA).map((r) => r.code)).toEqual([US_STOCK]);
    expect(bodyA.unresolvedCount).toBe(1);
  });

  it('⑥ 删掉锚 ⇒ 该正股持仓不再返回 (Edge「删除锚」)', async () => {
    const conn = await connect(accountA, '主账户');
    await seedPosition(accountA, conn, US_STOCK, { underlyingTicker: 'us:ZQX' });
    expect(allRows(await list(accountA))).toHaveLength(1);

    await prisma.anchor.deleteMany({ where: { ticker: 'us:ZQX' } });
    const body = await list(accountA);
    expect(body.groups).toEqual([]);
    expect(body.unresolvedCount).toBe(0);
  });

  it('⑦ 持仓盈亏取 raw.unrealized_pl、比例取 raw.pl_ratio_avg_cost; N/A / 缺失 ⇒ null (US1-AS4)', async () => {
    const conn = await connect(accountA, '主账户');
    await seedPosition(accountA, conn, US_STOCK, {
      underlyingTicker: 'us:ZQX',
      // 摊薄口径字段给不同的值: 取错字段立刻看得出。
      raw: {
        code: US_STOCK,
        unrealized_pl: 12.5,
        pl_ratio_avg_cost: '4.25',
        pl_val: 99,
        pl_ratio: 77,
      },
    });
    await seedPosition(accountA, conn, US_PUT_LIVE, {
      underlyingTicker: 'us:ZQY',
      raw: { code: US_PUT_LIVE, unrealized_pl: 'N/A' },
    });

    const byCode = new Map(allRows(await list(accountA)).map((r) => [r.code, r]));
    expect(byCode.get(US_STOCK)).toMatchObject({ unrealizedPl: '12.5', unrealizedPlRatio: '4.25' });
    expect(byCode.get(US_PUT_LIVE)).toMatchObject({ unrealizedPl: null, unrealizedPlRatio: null });
  });

  it('⑧ 行带 market; connectionLabel = 连接行 label 而非 brokerCode; 名称取 instrument, 取不到回落 raw.stock_name (Edge「同一券商有两个连接」)', async () => {
    const conn = await connect(accountA, '主账户', 'futu');
    await seedPosition(accountA, conn, US_STOCK, {
      underlyingTicker: 'us:ZQX',
      raw: { code: US_STOCK, stock_name: '券商给的名字' },
    });
    await seedPosition(accountA, conn, US_PUT_LIVE, {
      underlyingTicker: 'us:ZQY',
      raw: { code: US_PUT_LIVE, stock_name: '期权合约名' },
    });
    await seedPosition(accountA, conn, 'HK.08801', {
      underlyingTicker: 'hk:08801',
      raw: { code: 'HK.08801', stock_name: '示例港股' },
    });

    const us = await list(accountA);
    const byCode = new Map(allRows(us).map((r) => [r.code, r]));
    expect(byCode.get(US_STOCK)).toMatchObject({
      id: expect.stringMatching(/^\d+$/),
      market: 'us',
      brokerCode: 'futu',
      connectionLabel: '主账户',
      name: '示例甲',
    });
    // 期权行返回正股名; 正股既无 instrument 也无正股行 ⇒ 回落正股代码 (🚫 期权合约自己的 stock_name)。
    expect(byCode.get(US_PUT_LIVE)).toMatchObject({
      market: 'us',
      connectionLabel: '主账户',
      name: 'ZQY',
    });
    const zqx = us.groups.find(
      (g: { underlyingTicker: string }) => g.underlyingTicker === 'us:ZQX',
    );
    expect(zqx.underlyingName).toBe('示例甲');

    const hk = await list(accountA, 'hk');
    expect(allRows(hk)[0]).toMatchObject({ market: 'hk', name: '示例港股' });
    expect(hk.groups[0].underlyingName).toBe('示例港股');
  });

  it('⑨ 组内只有期权 ⇒ 组头现价 = 锚现价; 有正股 ⇒ 正股行现价 (branch 16)', async () => {
    const conn = await connect(accountA, '主账户');
    await seedPosition(accountA, conn, US_PUT_LIVE, {
      underlyingTicker: 'us:ZQY',
      marketValue: '-300',
      currentPrice: '1.5',
    });
    await seedPosition(accountA, conn, US_STOCK, {
      underlyingTicker: 'us:ZQX',
      marketValue: '100',
      currentPrice: '10',
    });

    const body = await list(accountA);
    // 跨组按 |组市值| 降序: ZQY(300) 在前。
    expect(body.groups.map((g: { underlyingTicker: string }) => g.underlyingTicker)).toEqual([
      'us:ZQY',
      'us:ZQX',
    ]);
    expect(body.groups[0]).toMatchObject({
      underlyingPrice: '31.5',
      groupMarketValue: '-300',
      groupUnrealizedPl: null,
    });
    expect(body.groups[1]).toMatchObject({ underlyingPrice: '10', groupMarketValue: '100' });
  });

  it('非法 market ⇒ 400; 无 token ⇒ 401', async () => {
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/optionsdesk/broker-positions?market=cn',
      headers: { authorization: `Bearer ${tokenOf(accountA)}` },
    });
    expect(bad.statusCode).toBe(400);
    const anon = await app.inject({
      method: 'GET',
      url: '/api/v1/optionsdesk/broker-positions?market=us',
    });
    expect(anon.statusCode).toBe(401);
  });

  describe('T006 同步时刻 + 陈旧 + 空态口径', () => {
    let tradingDay = 0;

    beforeEach(() => {
      calendar.reset();
      tradingDay = 0;
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    /** 固定请求时刻 (只 fake `Date`; token 在 `list` 内签发, 与 fake 时钟同源)。 */
    const at = (iso: string) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(iso));
    };

    const seedRun = (
      accountId: bigint,
      connectionId: bigint,
      over: Partial<Prisma.BrokerSyncRunUncheckedCreateInput> &
        Pick<Prisma.BrokerSyncRunUncheckedCreateInput, 'kind' | 'status' | 'target'>,
    ) =>
      prisma.brokerSyncRun.create({
        data: {
          accountId,
          connectionId,
          market: null,
          // 对账部分唯一索引按 (连接, 市场, 交易日): 每条给不同交易日, 与本读端无关的冲突不进来。
          tradingDate:
            over.kind === 'reconcile' ? new Date(Date.UTC(2026, 6, 1 + tradingDay++)) : null,
          ...over,
        },
      });

    const reconciled = (accountId: bigint, conn: bigint, finishedAt: string, market = 'us') =>
      seedRun(accountId, conn, {
        kind: 'reconcile',
        status: 'succeeded',
        market,
        target: '*',
        finishedAt: new Date(finishedAt),
      });

    it('① 有连接无成功记录 ⇒ syncedAt=null、stale=false; 他人的成功记录不算 (branch 2)', async () => {
      const conn = await connect(accountA, '主账户');
      await seedRun(accountA, conn, {
        kind: 'reconcile',
        status: 'running',
        market: 'us',
        target: '*',
      });
      await seedRun(accountA, conn, {
        kind: 'reconcile',
        status: 'failed',
        market: 'us',
        target: '*',
        finishedAt: new Date('2026-09-09T13:15:00Z'),
      });
      const connB = await connect(accountB, '另一人的账户');
      await reconciled(accountB, connB, '2026-09-09T13:15:00Z');

      expect(await list(accountA)).toMatchObject({
        hasConnection: true,
        syncedAt: null,
        syncedAtLocal: null,
        stale: false,
      });
      // 管道自证: B 自己的成功记录确实取得到。
      expect((await list(accountB)).syncedAt).toBe('2026-09-09T13:15:00.000Z');
    });

    it('② 有成功对账、锚标的持仓为 0 但有 2 条未归类 ⇒ groups=[]、syncedAt 非空、unresolvedCount=2 (branch 3)', async () => {
      const conn = await connect(accountA, '主账户');
      await reconciled(accountA, conn, '2026-09-09T13:15:00Z');
      await seedPosition(accountA, conn, 'US.ZQRW', { underlyingTicker: null });
      await seedPosition(accountA, conn, 'US.ZQRV', { underlyingTicker: null });

      const body = await list(accountA);
      expect(body.groups).toEqual([]);
      expect(body.syncedAt).toBe('2026-09-09T13:15:00.000Z');
      expect(body.unresolvedCount).toBe(2);
    });

    it('③ 🚨 先一条成功对账、再一条失败对账 ⇒ syncedAt = 成功那条 finishedAt, 持仓照常返回 (branch 5)', async () => {
      const conn = await connect(accountA, '主账户');
      await reconciled(accountA, conn, '2026-09-09T13:15:00Z');
      await seedRun(accountA, conn, {
        kind: 'reconcile',
        status: 'failed',
        market: 'us',
        target: '*',
        finishedAt: new Date('2026-09-10T13:40:00Z'),
      });
      await seedPosition(accountA, conn, US_STOCK, { underlyingTicker: 'us:ZQX' });

      const body = await list(accountA);
      expect(body.syncedAt).toBe('2026-09-09T13:15:00.000Z');
      expect(allRows(body).map((r) => r.code)).toEqual([US_STOCK]);
    });

    it("④ 🚨 只有一条 target='us:ZQX' 的成功补齐 (market 为空) ⇒ 美股 syncedAt 有值、港股为 null; 再有 target='*' 补齐 ⇒ 港股也有值 (V5)", async () => {
      const conn = await connect(accountA, '主账户');
      await seedRun(accountA, conn, {
        kind: 'backfill',
        status: 'succeeded',
        target: 'us:ZQX',
        finishedAt: new Date('2026-09-09T13:15:00Z'),
      });

      expect((await list(accountA)).syncedAt).toBe('2026-09-09T13:15:00.000Z');
      expect((await list(accountA, 'hk')).syncedAt).toBeNull();

      await seedRun(accountA, conn, {
        kind: 'backfill',
        status: 'succeeded',
        target: '*',
        finishedAt: new Date('2026-09-09T02:00:00Z'),
      });
      expect((await list(accountA, 'hk')).syncedAt).toBe('2026-09-09T02:00:00.000Z');
      // 更早的 '*' 不覆盖美股更晚的单票补齐 (取最大值)。
      expect((await list(accountA)).syncedAt).toBe('2026-09-09T13:15:00.000Z');
    });

    // 美股对账时点 09:10 ET; 2026-09-10 为 EDT (UTC-4) ⇒ 时点 = 13:10Z。

    it('⑤ 固定 now: 今天时点 + 60 分钟且今天未成功 ⇒ stale=true; + 59 分钟、昨天已成功 ⇒ false (branch 6, 7)', async () => {
      const conn = await connect(accountA, '主账户');
      await reconciled(accountA, conn, '2026-09-09T13:15:00Z');

      at('2026-09-10T14:10:00Z');
      expect((await list(accountA)).stale).toBe(true);
      // 判定时点在今天 ⇒ 不需要上一交易日, 不调端口。
      expect(calendar.previousCalls).toEqual([]);

      at('2026-09-10T14:09:00Z');
      expect((await list(accountA)).stale).toBe(false);
      expect(calendar.previousCalls).toEqual([{ market: 'us', date: '2026-09-10' }]);
    });

    it('⑥ 🚨 最近成功在前天、今天时点 + 10 分钟 (宽限内) ⇒ stale=true (Edge「昨天对账没有成功」)', async () => {
      const conn = await connect(accountA, '主账户');
      await reconciled(accountA, conn, '2026-09-08T13:15:00Z');

      at('2026-09-10T13:20:00Z');
      expect((await list(accountA)).stale).toBe(true);
    });

    it('⑦ 日历 previousTradingDay 返回 null ⇒ stale=false 且一条不含账号的 warn (branch 44)', async () => {
      const conn = await connect(accountA, '主账户');
      // 按「前一个日历日 09-09」猜会得出陈旧的输入: 最近成功在 09-08。
      await reconciled(accountA, conn, '2026-09-08T13:15:00Z');
      calendar.previous = null;
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      at('2026-09-10T13:20:00Z');
      expect((await list(accountA)).stale).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls[0])).not.toContain(accountA.toString());
    });

    it('⑧ syncedAtLocal 为交易所当地时间串 (美东 / 香港)', async () => {
      const conn = await connect(accountA, '主账户');
      await reconciled(accountA, conn, '2026-09-09T13:15:30Z', 'us');
      await reconciled(accountA, conn, '2026-09-09T01:05:00Z', 'hk');

      expect((await list(accountA)).syncedAtLocal).toBe('2026-09-09 09:15:30');
      expect((await list(accountA, 'hk')).syncedAtLocal).toBe('2026-09-09 09:05:00');
    });

    // 084 T007 (FR-012 / FR-013): 上面 ①–⑧ 的夹具**全是**对账 / 补齐 —— 给
    // `lastSucceededSyncAt` 加一支 `push` 的 OR **不会让它们任何一条红**, 不新增下面两条臂,
    // FR-012 就是零覆盖。
    const pushed = (accountId: bigint, conn: bigint, finishedAt: string, market = 'us') =>
      seedRun(accountId, conn, {
        kind: 'push',
        status: 'succeeded',
        market,
        target: '*',
        finishedAt: new Date(finishedAt),
      });

    it('⑨ 🚨 只有一条推送刷新成功记录 (无对账、无补齐) ⇒ syncedAt 取它 (branch 8)', async () => {
      const conn = await connect(accountA, '主账户');
      await pushed(accountA, conn, '2026-09-10T13:42:00Z');

      expect((await list(accountA)).syncedAt).toBe('2026-09-10T13:42:00.000Z');
      // 管道自证: 同一条记录不进港股 ⇒ 上面那条不是「没按市场筛」蒙对的。
      expect((await list(accountA, 'hk')).syncedAt).toBeNull();
    });

    it('⑩ 🚨 对账停在前天 (单独看会判陈旧) + 今天一条推送刷新 ⇒ syncedAt 取推送且未标陈旧', async () => {
      const conn = await connect(accountA, '主账户');
      await reconciled(accountA, conn, '2026-09-08T13:15:00Z');
      await pushed(accountA, conn, '2026-09-10T13:42:00Z');

      at('2026-09-10T14:10:00Z');
      const body = await list(accountA);
      // 只认对账与补齐的实现在这里两条断言同时红 (syncedAt 取成 09-08, 且 stale=true)。
      expect(body.syncedAt).toBe('2026-09-10T13:42:00.000Z');
      expect(body.stale).toBe(false);
    });
  });
});
