import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { Prisma } from '../../src/generated/prisma/client';
import { MARKETDATA_WORKER_DISABLED } from '../../src/marketdata/marketdata-sync.queue';
import {
  TRADING_CALENDAR_PORT,
  type TradingDayStatus,
} from '../../src/marketdata/trading-calendar.port';
import { FX_RATE_PORT, type FxRate, type FxRatePort } from '../../src/optionsdesk/fx-rate.port';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';

// 085 T006 —— 持仓列表读端接入展示币种 (FR-001 / FR-002 / FR-003 / FR-004 / FR-006 / FR-007 /
// FR-008 / FR-009 / FR-011 / FR-012 / FR-013; plan D1 / D2 / D5;
// state_branches 1, 2, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 19, 20)。
//
// ## 为什么**必须**要真 PG + 真 HTTP (照 083 同端点 IT 的三条理由, 本片再加一条)
//
//   ① **账号隔离是查询条件**: `displayCurrency` MUST NOT 进任何 `where` (Guardrail 4)。「两种币种
//      请求拿到逐条相同的行」只有在库里真有行、SQL 真按 `account_id` + `market` 过滤时才有反例可看。
//   ② **锚集 / 名称 / 连接标签是三张真表的读** —— 折算接在这三张表取数之后, mock Prisma 下
//      「折算接错位置」不可观测。
//   ③ **账号来自 JWT**: `req.user.accountId` 由 `JwtAuthGuard` 在真 Fastify lifecycle 里填。
//   ④ **本片特有 —— 可选 query 的校验是 Fastify + ValidationPipe 的事**: 臂 ⑫ (非法币种 ⇒ 400,
//      不静默落默认) 只有经真 HTTP 才测得到, 直调 use case 根本走不到校验。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 `setupIsolatedDb()` 取 (共享 PG 模板克隆, 禁自起容器);
// 本端点不碰 Redis ⇒ `REDIS_CLIENT` stub。装配 = `narrowTestModule([OptionsdeskModule])` 真 DI。
//
// 🚨 **FX port 是唯一允许的 test double** (plan Testing Invariants): 它是外部 vendor I/O。
// 🚫 mock `PrismaService`。交易日历端口沿 083 同端点 IT 的既有替身 (陈旧判定与跑测墙钟解耦),
// 本片不断言陈旧。
//
// 夹具汇率**全部是合成值** (per `testing.md` §7 合成数据条款), 与 `display-currency.rules.spec.ts`
// 同一组, 且**三角蓄意不闭合** (`0.9500 × 7.5000 ≠ 7.0000`) —— 任何链式交叉实现都会给出不同的数字。

const HK_STOCK_A = 'HK.08801';
const HK_STOCK_B = 'HK.08802';
const HK_STOCK_C = 'HK.08803';
const US_STOCK = 'US.ZQX';
/** 2027-12-17 到期 ⇒ 相对任意跑测时刻都未到期。 */
const US_PUT_LIVE = 'US.ZQY271217P30000';

const CAPTURED_AT = new Date('2026-09-17T01:30:00.000Z');

const RATES: readonly FxRate[] = [
  { pair: 'USDCNY', rate: new Prisma.Decimal('7.0000'), capturedAt: CAPTURED_AT },
  { pair: 'HKDCNY', rate: new Prisma.Decimal('0.9500'), capturedAt: CAPTURED_AT },
  { pair: 'USDHKD', rate: new Prisma.Decimal('7.5000'), capturedAt: CAPTURED_AT },
];

/**
 * FX 取数口替身。三种形态覆盖 branch 8 / 15 / 19:
 * - 正常返回三对 ⇒ 折算路径
 * - `failure` 置位 ⇒ 全源失败 (真 FallbackChain 全败时同样是 rejected promise, 形态一致)
 * - `delayMs` 置位 ⇒ 取数**进行中**: 端点应当等它, 而不是先返未折算数字或判为已失败
 */
class FakeFxRatePort implements FxRatePort {
  rates: readonly FxRate[] = RATES;
  failure: Error | null = null;
  delayMs = 0;
  calls = 0;

  reset() {
    this.rates = RATES;
    this.failure = null;
    this.delayMs = 0;
    this.calls = 0;
  }

  async fetchRates(): Promise<readonly FxRate[]> {
    this.calls += 1;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failure !== null) throw this.failure;
    return this.rates;
  }
}

/** 交易日历替身 (同 083 同端点 IT): 固定「今天」的三态与上一交易日。 */
class FakeTradingCalendar {
  async classify(): Promise<TradingDayStatus> {
    return 'trading';
  }
  async previousTradingDay(): Promise<string | null> {
    return '2026-09-09';
  }
  async lastClosedSession(): Promise<string | null> {
    return null;
  }
}

describe('085 T006 持仓列表展示币种 (共享 PG + 收窄 boot + 真 HTTP)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let jwt: JwtTokenService;
  const fx = new FakeFxRatePort();
  const prevWorkerDisabled = process.env[MARKETDATA_WORKER_DISABLED];

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-085-t006-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-085-t006-hmac-secret-min-32-bytes';
    // 本地 shell 常泄漏 MARKETDATA_PROVIDER=live 与 OSS_* 部署凭据 (同 083 同端点 IT)。
    process.env.MARKETDATA_PROVIDER = 'mock';
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OSS_')) delete process.env[key];
    }
    // 不起 marketdata 队列 worker (bullmq 5.x 关停竞态假红)。
    process.env[MARKETDATA_WORKER_DISABLED] = '1';

    moduleRef = await Test.createTestingModule({ imports: narrowTestModule([OptionsdeskModule]) })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ call: () => undefined, quit: () => undefined, on: () => undefined })
      .overrideProvider(TRADING_CALENDAR_PORT)
      .useValue(new FakeTradingCalendar())
      // mock 档默认绑的是**调用即抛**的拒绝壳 (T004) ⇒ 不换掉它就只测得到降级那一支。
      .overrideProvider(FX_RATE_PORT)
      .useValue(fx)
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
  let connA: bigint;

  beforeEach(async () => {
    fx.reset();
    await prisma.brokerSyncRun.deleteMany({});
    await prisma.brokerPosition.deleteMany({});
    await prisma.brokerConnection.deleteMany({});
    await prisma.anchor.deleteMany({});
    await prisma.instrument.deleteMany({});
    await prisma.account.deleteMany({});

    accountA = (
      await prisma.account.create({ data: { phone: '+8613800085001', status: 'ACTIVE' } })
    ).id;
    connA = (
      await prisma.brokerConnection.create({
        data: { accountId: accountA, brokerCode: 'futu', label: '主账户', phoneLast4: '0000' },
      })
    ).id;

    for (const ticker of ['us:ZQX', 'us:ZQY', 'hk:08801', 'hk:08802', 'hk:08803']) {
      await prisma.anchor.create({
        data: {
          ticker,
          market: ticker.split(':')[0]!,
          v: '50',
          asof: new Date('2026-06-30T00:00:00Z'),
          method: 'dcf',
          confidence: '8',
          confidenceSource: 'manual',
          lLevelEffective: 'L2',
        },
      });
    }
  });

  const tokenOf = (accountId: bigint) => jwt.signAccessToken({ accountId });

  const seedPosition = (
    code: string,
    over: Partial<Prisma.BrokerPositionUncheckedCreateInput> = {},
  ) =>
    prisma.brokerPosition.create({
      data: {
        accountId: accountA,
        connectionId: connA,
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
        raw: { code, unrealized_pl: 20, pl_ratio_avg_cost: '5' },
        ...over,
      },
    });

  const get = (market: string, currency?: string, accountId = accountA) =>
    app.inject({
      method: 'GET',
      url:
        `/api/v1/optionsdesk/broker-positions?market=${market}` +
        (currency === undefined ? '' : `&displayCurrency=${currency}`),
      headers: { authorization: `Bearer ${tokenOf(accountId)}` },
    });

  const list = async (market: string, currency?: string) => {
    const res = await get(market, currency);
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  const allRows = (body: { groups: { rows: Record<string, unknown>[] }[] }) =>
    body.groups.flatMap((g) => g.rows);

  const byCode = (body: { groups: { rows: Record<string, unknown>[] }[] }) =>
    new Map(allRows(body).map((r) => [r.code as string, r]));

  const tickersOf = (body: { groups: { underlyingTicker: string }[] }) =>
    body.groups.map((g) => g.underlyingTicker);

  it('① SC-006 不带 displayCurrency 与带该市场原币种 ⇒ 两次响应逐字节相同 (us + hk; branch 1, 2)', async () => {
    await seedPosition(US_STOCK, { underlyingTicker: 'us:ZQX' });
    await seedPosition(US_PUT_LIVE, { underlyingTicker: 'us:ZQY', marketValue: '-300' });
    await seedPosition(HK_STOCK_A, { underlyingTicker: 'hk:08801' });
    await seedPosition(HK_STOCK_B, { underlyingTicker: 'hk:08802', marketValue: '5000' });

    const usDefault = await get('us');
    const usExplicit = await get('us', 'USD');
    expect(usDefault.statusCode).toBe(200);
    expect(usExplicit.payload).toBe(usDefault.payload);

    const hkDefault = await get('hk');
    const hkExplicit = await get('hk', 'HKD');
    expect(hkDefault.statusCode).toBe(200);
    expect(hkExplicit.payload).toBe(hkDefault.payload);

    // 缺省视图与「原币种」档都无需折算 ⇒ 一次 vendor 往返都不该发生。
    expect(fx.calls).toBe(0);
  });

  it('② us 页签缺省 ⇒ displayCurrency=USD、各行即原值、响应不含汇率信息 (branch 1, 14; FR-008)', async () => {
    await seedPosition(US_STOCK, { underlyingTicker: 'us:ZQX' });

    const body = await list('us');
    expect(body.displayCurrency).toBe('USD');
    expect(body.fxRate).toBeNull();
    expect(allRows(body)[0]).toMatchObject({
      marketValue: '100',
      unrealizedPl: '20',
      currentPrice: '10',
      averageCost: '9',
      currency: 'USD',
      displayCurrency: 'USD',
      converted: false,
      degraded: false,
      originalMarketValue: null,
      originalUnrealizedPl: null,
    });
    expect(body.groups[0].aggregateComplete).toBe(true);
    expect(fx.calls).toBe(0);
  });

  it('③ hk 页签缺省 ⇒ displayCurrency=HKD、各行即原值、响应不含汇率信息 (branch 2, 14)', async () => {
    await seedPosition(HK_STOCK_A, { underlyingTicker: 'hk:08801' });

    const body = await list('hk');
    expect(body.displayCurrency).toBe('HKD');
    expect(body.fxRate).toBeNull();
    expect(allRows(body)[0]).toMatchObject({
      marketValue: '100',
      currency: 'HKD',
      displayCurrency: 'HKD',
      converted: false,
      degraded: false,
    });
    expect(fx.calls).toBe(0);
  });

  it('④ displayCurrency=CNY ∧ 汇率可用 ⇒ 金额类折算、价格类仍原币种、响应含汇率值与 capturedAt (branch 7, 15; FR-003)', async () => {
    await seedPosition(HK_STOCK_A, { underlyingTicker: 'hk:08801' });

    const body = await list('hk', 'CNY');
    expect(body.displayCurrency).toBe('CNY');
    expect(body.fxRate).toEqual({
      from: 'HKD',
      to: 'CNY',
      rate: '0.95',
      capturedAt: '2026-09-17T01:30:00.000Z',
      available: true,
    });
    expect(allRows(body)[0]).toMatchObject({
      // 金额类: 100 × 0.95 / 20 × 0.95
      marketValue: '95',
      unrealizedPl: '19',
      // 价格类三项逐字不变 (FR-003) —— 折算它们会让「现价 × 数量 = 市值」在屏上对不上。
      currentPrice: '10',
      averageCost: '9',
      unrealizedPlRatio: '5',
      currency: 'HKD',
      displayCurrency: 'CNY',
      converted: true,
      degraded: false,
    });
    expect(body.groups[0].groupMarketValue).toBe('95');
    expect(body.groups[0].aggregateComplete).toBe(true);
  });

  it('⑤ FX 全源失败 ⇒ 端点仍 200、整屏降级为原币种并标注、不 500 (branch 8)', async () => {
    fx.failure = new Error('all fx rate sources failed (test double)');
    await seedPosition(HK_STOCK_A, { underlyingTicker: 'hk:08801' });

    const res = await get('hk', 'CNY');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.displayCurrency).toBe('CNY');
    expect(body.fxRate).toEqual({
      from: 'HKD',
      to: 'CNY',
      rate: null,
      capturedAt: null,
      available: false,
    });
    expect(allRows(body)[0]).toMatchObject({
      // 聚合与排序的入参置 null ⇒ 不混进 signedSum; 呈现值搬到 original*。
      marketValue: null,
      unrealizedPl: null,
      originalMarketValue: '100',
      originalUnrealizedPl: '20',
      currentPrice: '10',
      displayCurrency: 'HKD',
      converted: false,
      degraded: true,
    });
    expect(body.groups[0]).toMatchObject({
      groupMarketValue: null,
      groupUnrealizedPl: null,
      aggregateComplete: false,
    });
  });

  it('⑥ 某行 currency 为 null ⇒ 该行降级且不被默认成任何币种; 同组其它行照常折算 (branch 9; US3-AS2)', async () => {
    await seedPosition(HK_STOCK_A, { underlyingTicker: 'hk:08801' });
    await seedPosition('HK.08801B', {
      underlyingTicker: 'hk:08801',
      currency: null,
      marketValue: '4000',
    });

    const rows = byCode(await list('hk', 'CNY'));
    expect(rows.get('HK.08801B')).toMatchObject({
      marketValue: null,
      originalMarketValue: '4000',
      currency: null,
      // 🚨 null 而不是 'HKD'/'CNY' —— 猜一个币种的后果是屏上一切正常但数字是错的。
      displayCurrency: null,
      converted: false,
      degraded: true,
    });
    expect(rows.get(HK_STOCK_A)).toMatchObject({
      marketValue: '95',
      displayCurrency: 'CNY',
      converted: true,
      degraded: false,
    });
  });

  it('⑦ 组内含降级行 ⇒ 两个聚合值均标不完整且未混入求和; 可完整折算组的组市值恰等于折算值之和 (branch 11)', async () => {
    // 完整组: 100 + 200 ⇒ 折算后 95 + 190 = 285 (先聚合再折算会得到 300)。
    await seedPosition(HK_STOCK_A, { underlyingTicker: 'hk:08801' });
    await seedPosition('HK.08801B', { underlyingTicker: 'hk:08801', marketValue: '200' });
    // 混合组: 两行可折算 + 一行币种未知。
    await seedPosition(HK_STOCK_B, { underlyingTicker: 'hk:08802' });
    await seedPosition('HK.08802B', { underlyingTicker: 'hk:08802', marketValue: '200' });
    await seedPosition('HK.08802C', {
      underlyingTicker: 'hk:08802',
      currency: null,
      marketValue: '4000',
    });

    const body = await list('hk', 'CNY');
    const groups = new Map(
      body.groups.map((g: { underlyingTicker: string }) => [g.underlyingTicker, g]),
    );
    expect(groups.get('hk:08801')).toMatchObject({
      groupMarketValue: '285',
      groupUnrealizedPl: '38',
      aggregateComplete: true,
    });
    expect(groups.get('hk:08802')).toMatchObject({
      groupMarketValue: null,
      groupUnrealizedPl: null,
      aggregateComplete: false,
    });
  });

  it('⑧ 降级组沉底: 可完整折算但折算后市值小的组排在含降级行、原币种市值大的组之前 (branch 13)', async () => {
    // A 组折算后 95; B 组的原币种部分和 5000 —— 留原币种裸和的实现会把 B 排在前面。
    await seedPosition(HK_STOCK_A, { underlyingTicker: 'hk:08801' });
    await seedPosition(HK_STOCK_B, { underlyingTicker: 'hk:08802', marketValue: '5000' });
    await seedPosition('HK.08802B', {
      underlyingTicker: 'hk:08802',
      currency: null,
      marketValue: '9000',
    });

    const body = await list('hk', 'CNY');
    expect(tickersOf(body)).toEqual(['hk:08801', 'hk:08802']);
    // 比大小用的是折算后的值 ⇒ 组市值本身必须是折算值 (先聚合再折算会是 '100')。
    expect(body.groups[0].groupMarketValue).toBe('95');
    expect(body.groups[1].groupMarketValue).toBeNull();
  });

  it('⑨ 全部可完整折算 ⇒ 折算前后组顺序逐项相同 (branch 12; SC-002)', async () => {
    await seedPosition(HK_STOCK_A, { underlyingTicker: 'hk:08801' });
    await seedPosition(HK_STOCK_B, { underlyingTicker: 'hk:08802', marketValue: '5000' });
    await seedPosition(HK_STOCK_C, { underlyingTicker: 'hk:08803', marketValue: '300' });

    const native = tickersOf(await list('hk'));
    const converted = tickersOf(await list('hk', 'CNY'));
    expect(native).toEqual(['hk:08802', 'hk:08803', 'hk:08801']);
    expect(converted).toEqual(native);
  });

  it('⑩ 账号无任何持仓 ⇒ 200 + 空组 + 汇率信息字段形态合法 (branch 20)', async () => {
    const native = await list('hk');
    expect(native).toMatchObject({
      hasConnection: true,
      groups: [],
      displayCurrency: 'HKD',
      fxRate: null,
    });

    const cny = await list('hk', 'CNY');
    expect(cny.groups).toEqual([]);
    expect(cny.displayCurrency).toBe('CNY');
    expect(cny.fxRate).toEqual({
      from: 'HKD',
      to: 'CNY',
      rate: '0.95',
      capturedAt: '2026-09-17T01:30:00.000Z',
      available: true,
    });
  });

  it('⑪ 🚨 displayCurrency 不进任何 where: 同账号两种币种 ⇒ 返回的行集合与 id 逐条相同 (Guardrail 4)', async () => {
    await seedPosition(HK_STOCK_A, { underlyingTicker: 'hk:08801' });
    await seedPosition(HK_STOCK_B, { underlyingTicker: 'hk:08802', marketValue: '5000' });
    await seedPosition(HK_STOCK_C, { underlyingTicker: 'hk:08803', marketValue: '300' });

    const nativeRows = allRows(await list('hk'));
    const cnyRows = allRows(await list('hk', 'CNY'));
    expect(cnyRows.map((r) => r.id)).toEqual(nativeRows.map((r) => r.id));
    expect(cnyRows.map((r) => r.code)).toEqual(nativeRows.map((r) => r.code));
    // 仅呈现字段不同 —— 同一条行在两次请求里是同一行。
    expect(cnyRows[0].marketValue).not.toBe(nativeRows[0].marketValue);
  });

  it('⑫ 非法 displayCurrency ⇒ 400, 不静默落默认', async () => {
    await seedPosition(HK_STOCK_A, { underlyingTicker: 'hk:08801' });

    expect((await get('hk', 'JPY')).statusCode).toBe(400);
    expect((await get('hk', '')).statusCode).toBe(400);
    expect((await get('hk', 'cny')).statusCode).toBe(400);
    // 管道自证: 同一夹具下合法档确实 200 ⇒ 上面的 400 不是夹具坏了。
    expect((await get('hk', 'CNY')).statusCode).toBe(200);
  });

  it('⑬ 汇率取数进行中 ⇒ 等它, 不先返未折算数字也不判已失败; 已失败才 available=false (branch 19)', async () => {
    await seedPosition(HK_STOCK_A, { underlyingTicker: 'hk:08801' });

    fx.delayMs = 30;
    const pending = await list('hk', 'CNY');
    expect(pending.fxRate.available).toBe(true);
    expect(allRows(pending)[0]).toMatchObject({
      marketValue: '95',
      converted: true,
      degraded: false,
    });

    fx.delayMs = 0;
    fx.failure = new Error('all fx rate sources failed (test double)');
    const failed = await list('hk', 'CNY');
    expect(failed.fxRate.available).toBe(false);
    expect(allRows(failed)[0]).toMatchObject({ marketValue: null, degraded: true });
  });
});
