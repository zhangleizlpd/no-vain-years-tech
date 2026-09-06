import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { setupIsolatedStores } from '../_support/isolated-db';
import { AppModule } from '../../src/app/app.module';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { Prisma } from '../../src/generated/prisma/client';
import { GetLegsUseCase, type LegTableView } from '../../src/optionsdesk/get-legs.usecase';
import {
  LEG_RETRIEVAL_PORT,
  type LegRetrievalPort,
} from '../../src/optionsdesk/leg-retrieval.port';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../../src/marketdata/trading-calendar.port';
import {
  MARCH_EXCLUSION_CATEGORIES,
  type MarchAuditEntry,
} from '../../src/optionsdesk/leg-fwd-chain.rules';
import {
  OPTION_SNAPSHOT_READ_PORT,
  type OptionSnapshotBatch,
  type OptionSnapshotPort,
  type OptionSnapshotQuery,
  type OptionSnapshotRow,
} from '../../src/marketdata/option-snapshot.port';
import {
  MARKET_STATE_PORT,
  type MarketSession,
  type MarketSessionState,
  type MarketStatePort,
} from '../../src/marketdata/market-state.port';

/**
 * 069 (ADR-0068 P3) —— 清链与行军选档的路径级 IT (T006 九臂)。
 *
 * ## 为什么必须要真 PG + 真 DI 容器
 *
 * 与 068 IT 同一组理由: 判决管道吃的是「窄召回真产物」(窗 / 护栏留痕 / 带标全在检索层长出来),
 * 假 port 上「判决对了」退化成「夹具原样出来」。PG 从 `setupIsolatedStores()` 取, 🚫 禁自起
 * Testcontainers。
 *
 * 📌 分工: 纯函数分支 (凸包深级联 / 行军十一臂 / tick 推断) 在三个 `*.rules.spec.ts` 已穷举;
 * 本文件管**接线面**: 判决挂在哪些请求上 (实时∧收租 only)、审计三路合流 (#1/#12/清链/行军)、
 * 排序零改动、离线/建仓缺省、config 面 (φ 档界 / θ 模式)。
 */

const REALTIME_AS_OF = new Date('2026-08-11T17:45:03.000Z');

class SpySnapshotReadPort implements OptionSnapshotPort {
  readonly calls: OptionSnapshotQuery[] = [];
  respond: (query: OptionSnapshotQuery) => OptionSnapshotBatch = () => ({
    asOf: REALTIME_AS_OF,
    rows: [],
  });
  fail: Error | null = null;

  getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch> {
    this.calls.push(query);
    if (this.fail !== null) return Promise.reject(this.fail);
    return Promise.resolve(this.respond(query));
  }
}

class FakeMarketStatePort implements MarketStatePort {
  session: MarketSession = 'regular';
  fail: Error | null = null;

  getMarketSessions(): Promise<MarketSessionState[]> {
    if (this.fail !== null) return Promise.reject(this.fail);
    return Promise.resolve([{ market: 'us', session: this.session }]);
  }
}

describe('069 清链与行军选档 (Testcontainers PG + Redis, 真 DI 容器)', () => {
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let readPort: SpySnapshotReadPort;
  let marketState: FakeMarketStatePort;
  let usecase: GetLegsUseCase;

  /** 请求时刻 = 2026-08-11 ET 12:00 (盘中)。 */
  const NOW = new Date('2026-08-11T16:00:00.000Z');
  const TODAY = '2026-08-11';
  const PREV_SESSION = '2026-08-10';
  const SYMBOL = 'us:MCH';
  const EOD_SPOT = '100.0000';
  const REALTIME_SPOT = '104.25';
  const UNDERLYING_CODE = 'US.MCH';

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-069-chain-march-jwt-secret-32b';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-069-chain-march-hmac-32b';
    delete process.env.MARKETDATA_PROVIDER;

    readPort = new SpySnapshotReadPort();
    marketState = new FakeMarketStatePort();
    moduleRef = await Test.createTestingModule({ imports: [AppModule, OptionsdeskModule] })
      .overrideProvider(OPTION_SNAPSHOT_READ_PORT)
      .useValue(readPort)
      .overrideProvider(MARKET_STATE_PORT)
      .useValue(marketState)
      .compile();
    prisma = moduleRef.get(PrismaService);
    usecase = moduleRef.get(GetLegsUseCase);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await moduleRef?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    readPort.calls.length = 0;
    readPort.respond = () => ({ asOf: REALTIME_AS_OF, rows: [] });
    readPort.fail = null;
    marketState.session = 'regular';
    marketState.fail = null;
    await prisma.earningsEvent.deleteMany();
    await prisma.optionDailySnapshot.deleteMany();
    await prisma.optionContract.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.anchorChange.deleteMany();
    await prisma.anchor.deleteMany();
  });

  // ── 造数 ──────────────────────────────────────────────────────────────────

  interface SeedLeg {
    readonly code: string;
    readonly dte: number;
    readonly strike: string;
    readonly bid: string;
    readonly ask: string;
    readonly delta: string;
  }

  /**
   * 三个 K 各自成梯 (昨日 Δ 全落 rent 带 [0.03, 0.62] ⇒ 三个 K 全进窗):
   * K=92 三档 (45/90/180d) —— 行军主路梯; K=96 两档 (60/120d) —— 停点梯; K=88 单档 (60d)。
   */
  const LEGS: readonly SeedLeg[] = [
    { code: 'M-92-45', dte: 45, strike: '92', bid: '2.70', ask: '2.90', delta: '-0.20' },
    { code: 'M-92-90', dte: 90, strike: '92', bid: '4.50', ask: '4.70', delta: '-0.25' },
    { code: 'M-92-180', dte: 180, strike: '92', bid: '7.50', ask: '7.70', delta: '-0.30' },
    { code: 'M-96-60', dte: 60, strike: '96', bid: '3.00', ask: '3.20', delta: '-0.40' },
    { code: 'M-96-120', dte: 120, strike: '96', bid: '5.00', ask: '5.20', delta: '-0.45' },
    { code: 'M-88-60', dte: 60, strike: '88', bid: '1.55', ask: '1.75', delta: '-0.15' },
  ];

  async function seedChain(
    opts: { snapshots?: boolean; earningsDay?: string } = {},
  ): Promise<void> {
    const instrument = await prisma.instrument.create({
      data: {
        market: 'us',
        code: 'MCH',
        name: 'MCH Inc.',
        type: 'stock',
        currency: 'USD',
        status: 'active',
        needSync: true,
      },
      select: { id: true },
    });
    for (const leg of LEGS) {
      const expiry = new Date(dateOf(TODAY).getTime() + leg.dte * 86_400_000);
      const contract = await prisma.optionContract.create({
        data: {
          market: 'us',
          code: leg.code,
          root: 'MCH',
          underlyingInstrumentId: instrument.id,
          expiryDate: expiry,
          strikePrice: leg.strike,
          optionType: 'PUT',
          isStandard: true,
          expirationCycle: 'MONTH',
        },
        select: { id: true },
      });
      if (opts.snapshots === false) continue;
      await prisma.optionDailySnapshot.create({
        data: {
          contractId: contract.id,
          sessionDate: dateOf(PREV_SESSION),
          source: 'eod',
          quoteAsOf: new Date(`${PREV_SESSION}T20:31:07Z`),
          oiAsOf: dateOf('2026-08-07'),
          bid: leg.bid,
          ask: leg.ask,
          bidSize: '25',
          askSize: '26',
          delta: leg.delta,
          iv: '21',
          openInterest: '900',
          netOpenInterest: '111',
          volume: '40',
          underlyingSpot: EOD_SPOT,
          greeksComplete: true,
        },
      });
    }
    if (opts.earningsDay !== undefined) {
      await prisma.earningsEvent.create({
        data: {
          instrumentId: instrument.id,
          earningsDate: dateOf(opts.earningsDay),
          pubType: 'AFTER',
        },
      });
    }
    await prisma.anchor.create({
      data: {
        ticker: SYMBOL,
        market: 'us',
        v: '150',
        asof: dateOf('2026-06-30'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
        intradayPrice: EOD_SPOT,
        intradayAt: new Date(NOW.getTime() - 10_000),
      },
    });
  }

  function optionRow(
    code: string,
    over: Partial<Omit<OptionSnapshotRow, 'code' | 'isOption'>> = {},
  ): OptionSnapshotRow {
    return {
      code,
      isOption: true,
      underlyingCode: UNDERLYING_CODE,
      bid: '2.40',
      ask: '2.50',
      bidSize: '11',
      askSize: '12',
      last: '2.45',
      prevClose: '2.20',
      iv: '22.5',
      delta: '-0.20',
      gamma: null,
      vega: null,
      theta: null,
      rho: null,
      openInterest: null,
      netOpenInterest: null,
      volume: '15',
      turnover: null,
      vendorUpdateTime: new Date('2026-08-11T15:59:58.000Z'),
      greeksComplete: true,
      // 076: 本文件不判股数 —— null = vendor 没给 ⇒「无从比对」那一档 (FR-008)。
      contractSize: null,
      ...over,
    };
  }

  function underlyingRow(last: string): OptionSnapshotRow {
    return {
      code: UNDERLYING_CODE,
      isOption: false,
      underlyingCode: null,
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      last,
      prevClose: '99.10',
      iv: null,
      delta: null,
      gamma: null,
      vega: null,
      theta: null,
      rho: null,
      openInterest: null,
      netOpenInterest: null,
      volume: null,
      turnover: null,
      vendorUpdateTime: new Date('2026-08-11T15:59:55.000Z'),
      greeksComplete: null,
      contractSize: null,
    };
  }

  /**
   * 主路实时批 —— 报价与昨日收盘同值 (判别面在梯形状, 不在实时/收盘差), Δ 原样。
   * K=92: fwd 链 [0.250, 0.170, 0.155] 全 ≥ φ(good)=0.15 且形状合规 ⇒ 推荐链尾 180d;
   * K=96: fwd 链 [0.196, 0.138] ⇒ 138 < φ 在 120d 停 ⇒ 推荐 60d;
   * K=88: 单档, fwd = 年化 0.107 < φ ⇒ 无合格档。
   */
  const MAIN_QUOTES: Readonly<
    Record<string, Partial<Omit<OptionSnapshotRow, 'code' | 'isOption'>>>
  > = Object.fromEntries(
    LEGS.map((leg) => [leg.code, { bid: leg.bid, ask: leg.ask, delta: leg.delta }]),
  );

  function realtimeBatch(
    rowsByCode: Readonly<
      Record<string, Partial<Omit<OptionSnapshotRow, 'code' | 'isOption'>>>
    > = MAIN_QUOTES,
    spot: string = REALTIME_SPOT,
  ): (q: OptionSnapshotQuery) => OptionSnapshotBatch {
    return (query) => ({
      asOf: REALTIME_AS_OF,
      rows: [
        underlyingRow(spot),
        ...query.contractCodes.map((code) => optionRow(code, rowsByCode[code] ?? {})),
      ],
    });
  }

  const rent = (realtime = true): Promise<LegTableView> =>
    usecase.execute(SYMBOL, 'rent', NOW, null, null, realtime);

  const marchOf = (view: LegTableView, strike: string) =>
    view.march?.find((m) => m.strike.equals(new Prisma.Decimal(strike)));

  /** 与主实例同一批真 DI 依赖、仅 config 换 θ 模式的第二实例 (config 面判别用)。 */
  const thetaUsecase = (): GetLegsUseCase =>
    new GetLegsUseCase(
      prisma,
      moduleRef.get<LegRetrievalPort>(LEG_RETRIEVAL_PORT),
      moduleRef.get<TradingCalendarPort>(TRADING_CALENDAR_PORT),
      { marchPhiTier: 'good', marchMode: 'theta' },
    );

  // ── 九臂 ──────────────────────────────────────────────────────────────────

  it('① 主路: 收租实时响应含 per-K 判决 + 逐档审计, 每个非推荐档恰一条原因 (FR-009 / FR-014)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    const view = await rent();
    expect(view.state).toBe('available');
    expect(view.priceKind).toBe('realtime');
    expect(view.march).not.toBeNull();
    expect(view.march!.map((m) => m.strike.toString())).toEqual(['88', '92', '96']);

    const k92 = marchOf(view, '92')!;
    expect(k92.verdict).toBe('recommended');
    expect(k92.recommendedDteDays).toBe(180);
    expect(k92.summary.ladderCount).toBe(3);
    expect(k92.summary.netChainCount).toBe(3);

    const k96 = marchOf(view, '96')!;
    expect(k96.verdict).toBe('recommended');
    expect(k96.recommendedDteDays).toBe(60);
    const k96Stop = k96.audits.find((a) => a.dteDays === 120)!;
    expect(k96Stop.category).toBe('fwd_below_phi');
    expect(k96Stop.evidence.fwd).not.toBeNull();
    expect(k96Stop.evidence.phi).not.toBeNull();

    const k88 = marchOf(view, '88')!;
    expect(k88.verdict).toBe('no_qualified');
    expect(k88.audits.map((a) => a.category)).toEqual(['fwd_below_phi']);

    // FR-014 零无原因排除: 每 K 的每个候选档要么是推荐档、要么恰有一条审计 (类目在 13 类内)。
    for (const strikeView of view.march!) {
      const dtes = view.legs
        .filter((leg) => leg.strike.equals(strikeView.strike))
        .map((leg) => leg.dteDays);
      for (const dte of dtes) {
        const entries = strikeView.audits.filter((a) => a.dteDays === dte);
        expect(entries).toHaveLength(dte === strikeView.recommendedDteDays ? 0 : 1);
      }
      for (const entry of strikeView.audits) {
        expect(MARCH_EXCLUSION_CATEGORIES).toContain(entry.category);
      }
    }
  });

  it('② 排序零改动: φ / θ 两种判决态下同请求行序逐行相同 (FR-018 机器判据)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    const phiView = await rent();
    const thetaView = await thetaUsecase().execute(SYMBOL, 'rent', NOW, null, null, true);
    // 判决确实不同 (判别性前置: 不是「两跑本来就一样」)
    expect(marchOf(phiView, '92')!.recommendedDteDays).toBe(180);
    expect(marchOf(thetaView, '92')!.recommendedDteDays).toBe(45);
    // 行序与行内容逐行相同 —— 判决是行上叠加标注, 不重排不改值 (march 字段之外全等)。
    const rows = (view: LegTableView) => JSON.stringify(view.legs);
    expect(rows(thetaView)).toBe(rows(phiView));
    expect(thetaView.legs.map((l) => l.code)).toEqual(phiView.legs.map((l) => l.code));
  });

  it('③ 建仓视角响应新字段恒缺省 (FR-019)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    const build = await usecase.execute(SYMBOL, 'build', NOW, null, null, true);
    expect(build.march).toBeNull();
    const all = await usecase.execute(SYMBOL, 'all', NOW, null, null, true);
    expect(all.march).toBeNull();
  });

  it('④ 离线 (收盘档) 响应判决点亮 —— 069 FR-017「恒缺省」自 070 门控放宽起作废 (070 FR-001)', async () => {
    // 070 语义演进臂: 本臂原断言「离线/回落恒 null」, 070 把门控放宽为「收租 ∧ us」后离线随之
    // 点亮 —— 离线面的完整断言在 optionsdesk-070.offline-ladder.it.spec.ts, 这里只钉档位与点亮。
    await seedChain();

    const offline = await rent(false);
    expect(offline.priceKind).toBe('eod_close');
    expect(offline.march).not.toBeNull();
    // 实时请求但闸判 closed ⇒ 整体回落收盘档 ⇒ 随离线口径一并点亮 (070 plan §D1 裁决)。
    marketState.session = 'other';
    const fallback = await rent(true);
    expect(fallback.priceKind).toBe('eod_close');
    expect(fallback.march).not.toBeNull();
  });

  it('⑤ bootstrap 宽窗候选照常清链行军 (state_branch 16)', async () => {
    await seedChain({ snapshots: false });
    readPort.respond = realtimeBatch(
      Object.fromEntries(
        LEGS.map((leg) => [
          leg.code,
          { bid: leg.bid, ask: leg.ask, delta: leg.delta, openInterest: '900' },
        ]),
      ),
    );

    const view = await rent();
    expect(view.state).toBe('available');
    expect(view.priceKind).toBe('realtime');
    expect(view.march).not.toBeNull();
    expect(marchOf(view, '92')!.verdict).toBe('recommended');
    expect(marchOf(view, '92')!.recommendedDteDays).toBe(180);
  });

  it('⑥ 全梯报价剔空 ⇒ 判整梯无可成交 + 审计逐档 #1 (clarify Q2; state_branch 9/17)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch({
      ...MAIN_QUOTES,
      // K=96 两档全交叉 (ask < bid) ⇒ 护栏整条剔除, 该 K 净链为空。
      'M-96-60': { bid: '3.00', ask: '2.90', delta: '-0.40' },
      'M-96-120': { bid: '5.00', ask: '4.90', delta: '-0.45' },
    });

    const view = await rent();
    const k96 = marchOf(view, '96')!;
    expect(k96.verdict).toBe('untradable');
    expect(k96.recommendedDteDays).toBeNull();
    expect(k96.summary.netChainCount).toBe(0);
    expect(k96.summary.removedCount).toBe(2);
    expect(k96.audits.map((a) => [a.dteDays, a.category])).toEqual([
      [60, 'crossed_quote'],
      [120, 'crossed_quote'],
    ]);
    for (const entry of k96.audits) {
      expect(entry.evidence.bid).not.toBeNull();
      expect(entry.evidence.ask).not.toBeNull();
    }
    // 成因判别 (Q2): 同为 untradable, 剔空 K 的审计全是 #1, 与 OI 不过闸 (#10/#11) 可区分。
    expect(k96.audits.some((a) => a.category === 'ladder_oi_all_below_min')).toBe(false);
  });

  it('⑦ 带外横档 #12 进审计不进净链 (state_branch「带外」)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch({
      ...MAIN_QUOTES,
      // K=88 实时 Δ 落带外 (0.70 > 0.62) ⇒ bandStatus out: 表内可见、非候选。
      'M-88-60': { bid: '1.55', ask: '1.75', delta: '-0.70' },
    });

    const view = await rent();
    const outRow = view.legs.find((leg) => leg.code === 'M-88-60');
    expect(outRow?.bandStatus).toBe('out');
    const k88 = marchOf(view, '88')!;
    expect(k88.summary.ladderCount).toBe(0);
    expect(k88.audits.map((a) => a.category)).toEqual(['band_out']);
    expect(k88.audits[0].evidence.absDelta?.toNumber()).toBeCloseTo(0.7, 6);
    // 净链空 (唯一档是带外非候选) ⇒ 判整梯无可成交 —— 但成因经 #12 可解释。
    expect(k88.verdict).toBe('untradable');
  });

  it('⑧ 财报段档照常进链零特判 —— 审计类目里无财报类 (FR-012)', async () => {
    // 财报日落在 K=92 的 90d→180d 段内 ⇒ 该段 fwd 天然含事件溢价, 机制自动伺服。
    await seedChain({ earningsDay: '2026-11-19' });
    readPort.respond = realtimeBatch();

    const view = await rent();
    const k92 = marchOf(view, '92')!;
    expect(k92.verdict).toBe('recommended');
    expect(k92.recommendedDteDays).toBe(180);
    // 13 类封闭枚举内零财报类目 (类型层已封死, 这里留运行时留痕)。
    const categories = view.march!.flatMap((m) => m.audits.map((a: MarchAuditEntry) => a.category));
    for (const category of categories) expect(MARCH_EXCLUSION_CATEGORIES).toContain(category);
  });

  it('⑨ config 切 θ 模式 ⇒ 判决 ≡ 年化 argmax; 默认配置 ⇒ φ 模式 (US2-AS6 / clarify Q3)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    // 默认 (φ): K=92 推荐链尾 180d (前向每天 ≥ φ 的最长档)。
    const phiView = await rent();
    expect(marchOf(phiView, '92')!.recommendedDteDays).toBe(180);

    // θ: 判决 ≡ 年化 argmax —— K=92 年化 [45d: 0.250, 90d: 0.210, 180d: 0.183] ⇒ 45d。
    const thetaView = await thetaUsecase().execute(SYMBOL, 'rent', NOW, null, null, true);
    const k92 = marchOf(thetaView, '92')!;
    expect(k92.verdict).toBe('recommended');
    const annualizedOf = new Map(
      thetaView.legs
        .filter((leg) => leg.strike.equals(new Prisma.Decimal('92')))
        .map((leg) => [leg.dteDays, leg.annualizedRate]),
    );
    const argmax = [...annualizedOf.entries()].reduce((best, next) =>
      next[1]!.greaterThan(best[1]!) ? next : best,
    );
    expect(k92.recommendedDteDays).toBe(argmax[0]);
    expect(k92.recommendedDteDays).toBe(45);
  });
});
