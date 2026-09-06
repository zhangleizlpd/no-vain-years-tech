import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { setupIsolatedStores } from '../_support/isolated-db';
import { AppModule } from '../../src/app/app.module';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { Prisma } from '../../src/generated/prisma/client';
import {
  RECALL_CANDIDATE_CAP,
  type RetrievalOverride,
} from '../../src/optionsdesk/leg-recall.rules';
import {
  LEG_RETRIEVAL_PORT,
  type LegRetrievalPort,
  type LegRetrievalResult,
} from '../../src/optionsdesk/leg-retrieval.port';
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
 * 068 (ADR-0068 P2) —— 实时窄召回两段式的路径级 IT。
 *
 * ## 为什么必须要真 PG + 真 DI 容器
 *
 * 与 064 IT 同一组理由 (那份文件头有全文): ① 两段式的第一段读的是**真库**里的合约集与昨日
 * Δ 面, 假 port 上「窗圈对了码」退化成「夹具原样出来」; ② 三级基准链与降级标走的是
 * `@Optional() @Inject()` 的真解析。PG 从 `test/_support/isolated-db.ts` 的
 * `setupIsolatedStores()` 取, 🚫 禁自起 Testcontainers。
 *
 * 📌 分工: 本文件管 068 的路径级分支 (基准链 / 窄召回主路 / 回落面); 064 IT 的**离线腿**
 * 用例 + golden 基线是 FR-011 离线零回归的机器证据, 留在原文件不动。
 */

/** 本批实时报价的我方采集时刻 (信封 `as_of`)。 */
const REALTIME_AS_OF = new Date('2026-08-11T17:45:03.000Z');

/** 计数 + 可编程读取口替身 (体例同 064 IT —— 计数是外呼预算的唯一机器判据)。 */
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

/** 市场时段替身 —— mock 档下真绑定是拒绝壳, 不 override 全部实时用例假绿成「反正没外呼」。 */
class FakeMarketStatePort implements MarketStatePort {
  session: MarketSession = 'regular';
  extra: MarketSessionState[] = [];
  fail: Error | null = null;

  getMarketSessions(): Promise<MarketSessionState[]> {
    if (this.fail !== null) return Promise.reject(this.fail);
    return Promise.resolve([{ market: 'us', session: this.session }, ...this.extra]);
  }
}

describe('068 两段式窄召回 (Testcontainers PG + Redis, 真 DI 容器)', () => {
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let readPort: SpySnapshotReadPort;
  let marketState: FakeMarketStatePort;
  const warnings: string[] = [];
  const infos: string[] = [];

  /** 请求时刻 = 2026-08-11 ET 12:00 (盘中) ⇒ 交易所的今天恒为 2026-08-11。 */
  const NOW = new Date('2026-08-11T16:00:00.000Z');
  const TODAY = '2026-08-11';
  const PREV_SESSION = '2026-08-10';

  const SYMBOL = 'us:TWR';
  /** 库内昨日收盘 spot —— Δ 面 moneyness 折算的分母。 */
  const EOD_SPOT = '100.0000';
  /** 实时补发回来的标的现价 —— 与库内 spot 蓄意拉开 (判别性)。 */
  const REALTIME_SPOT = '104.25';
  const UNDERLYING_CODE = 'US.TWR';

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-068-two-stage-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-068-two-stage-hmac-secret-32b';
    delete process.env.MARKETDATA_PROVIDER;

    readPort = new SpySnapshotReadPort();
    marketState = new FakeMarketStatePort();
    moduleRef = await Test.createTestingModule({ imports: [AppModule, OptionsdeskModule] })
      .overrideProvider(OPTION_SNAPSHOT_READ_PORT)
      .useValue(readPort)
      .overrideProvider(MARKET_STATE_PORT)
      .useValue(marketState)
      // 交易日历不 override (同 064 IT): lastClosedSession 等读端也在用它。
      .compile();
    prisma = moduleRef.get(PrismaService);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(typeof message === 'string' ? message : JSON.stringify(message));
    });
    vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      infos.push(typeof message === 'string' ? message : JSON.stringify(message));
    });
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await moduleRef?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    warnings.length = 0;
    infos.length = 0;
    readPort.calls.length = 0;
    readPort.respond = () => ({ asOf: REALTIME_AS_OF, rows: [] });
    readPort.fail = null;
    marketState.session = 'regular';
    marketState.extra = [];
    marketState.fail = null;
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
    readonly oi: string;
    readonly vol: string;
    /** 昨日收盘 Δ (放大可判别性: 每腿各异, Δ 面查表的输入)。`null` = vendor 缺读数。 */
    readonly delta: string | null;
  }

  /**
   * 五条腿铺出一个可判别的昨日 Δ 面 (昨日 spot = 100, |Δ| 随 K 升单调升; 定稿带 rent
   * [0.03, 0.62] / build [0.10, 0.45]):
   * K=80 |Δ|=0.02 (双带带下) / K=88 |Δ|=0.15 (双带带内) / K=92 |Δ|=0.25 (双带带内) /
   * K=96 |Δ|=0.55 (仅 rent 带内) / K=104 |Δ|=0.70 (双带带外)。DTE 全落收租段。
   */
  const LEGS: readonly SeedLeg[] = [
    {
      code: 'T-80',
      dte: 60,
      strike: '80',
      bid: '0.90',
      ask: '1.00',
      oi: '900',
      vol: '40',
      delta: '-0.02',
    },
    {
      code: 'T-88',
      dte: 60,
      strike: '88',
      bid: '1.60',
      ask: '1.70',
      oi: '900',
      vol: '40',
      delta: '-0.15',
    },
    {
      code: 'T-92',
      dte: 60,
      strike: '92',
      bid: '2.20',
      ask: '2.30',
      oi: '900',
      vol: '40',
      delta: '-0.25',
    },
    {
      code: 'T-96',
      dte: 60,
      strike: '96',
      bid: '3.00',
      ask: '3.10',
      oi: '900',
      vol: '40',
      delta: '-0.55',
    },
    {
      code: 'T-104',
      dte: 60,
      strike: '104',
      bid: '5.50',
      ask: '5.60',
      oi: '900',
      vol: '40',
      delta: '-0.70',
    },
  ];

  interface SeedBasis {
    readonly price: string | null;
    readonly at: Date | null;
  }

  const FRESH_BASIS: SeedBasis = { price: EOD_SPOT, at: new Date(NOW.getTime() - 10_000) };
  /** 陈旧基准 —— 90s 新鲜闸外 (061 单点判陈旧)。 */
  const STALE_BASIS: SeedBasis = { price: EOD_SPOT, at: new Date(NOW.getTime() - 600_000) };

  async function seedChain(
    opts: {
      snapshots?: boolean;
      basis?: SeedBasis;
      v?: string;
      legs?: readonly SeedLeg[];
      market?: string;
      code?: string;
    } = {},
  ): Promise<void> {
    const market = opts.market ?? 'us';
    const code = opts.code ?? 'TWR';
    const instrument = await prisma.instrument.create({
      data: {
        market,
        code,
        name: `${code} Inc.`,
        type: 'stock',
        currency: 'USD',
        status: 'active',
        needSync: true,
      },
      select: { id: true },
    });
    for (const leg of opts.legs ?? LEGS) {
      const expiry = new Date(dateOf(TODAY).getTime() + leg.dte * 86_400_000);
      const contract = await prisma.optionContract.create({
        data: {
          market,
          code: leg.code,
          root: code,
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
          openInterest: leg.oi,
          netOpenInterest: '111',
          volume: leg.vol,
          underlyingSpot: EOD_SPOT,
          greeksComplete: leg.delta !== null,
        },
      });
    }
    const basis = opts.basis ?? FRESH_BASIS;
    await prisma.anchor.create({
      data: {
        ticker: `${market}:${code}`,
        market,
        v: opts.v ?? '150',
        asof: dateOf('2026-06-30'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
        intradayPrice: basis.price,
        intradayAt: basis.at,
      },
    });
  }

  // ── 实时批替身 ────────────────────────────────────────────────────────────

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
      ...over,
    };
  }

  function underlyingRow(last: string | null): OptionSnapshotRow {
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
    };
  }

  /** 标的行恒随批; 期权行按请求 code 回放 (缺席 = vendor 缺行)。 */
  function realtimeBatch(
    rowsByCode: Readonly<
      Record<string, Partial<Omit<OptionSnapshotRow, 'code' | 'isOption'>>>
    > = {},
    spot: string = REALTIME_SPOT,
    omit: readonly string[] = [],
  ): (q: OptionSnapshotQuery) => OptionSnapshotBatch {
    return (query) => ({
      asOf: REALTIME_AS_OF,
      rows: [
        underlyingRow(spot),
        ...query.contractCodes
          .filter((code) => !omit.includes(code))
          .map((code) => optionRow(code, rowsByCode[code] ?? {})),
      ],
    });
  }

  function retrieve(
    realtime: boolean,
    view: 'build' | 'rent' | 'all' = 'rent',
    override: RetrievalOverride | null = null,
    symbol: string = SYMBOL,
  ): Promise<LegRetrievalResult | null> {
    return moduleRef.get<LegRetrievalPort>(LEG_RETRIEVAL_PORT).retrieveCandidates({
      symbol,
      now: NOW,
      perspectives: [view],
      candidateCap: RECALL_CANDIDATE_CAP,
      override,
      realtime,
    });
  }

  // ── T004 · 三级基准链 (FR-006 / FR-013; state_branches 4/5/6) ─────────────

  describe('T004 三级基准链 resolveWindowBasis', () => {
    it('① 基准新鲜 (≤90s) ⇒ 零补发 —— 外呼只有主批一次, 且不含空码探针', async () => {
      await seedChain({ basis: FRESH_BASIS });
      readPort.respond = realtimeBatch();

      const result = await retrieve(true);
      expect(result).not.toBeNull();
      expect(readPort.calls).toHaveLength(1);
      expect(readPort.calls[0].contractCodes.length).toBeGreaterThan(0);
    });

    it('② 基准陈旧 ⇒ 实时补一发 (空码批只取标的行) 成功即以实时 spot 定窗 —— 外呼恰 2 次', async () => {
      await seedChain({ basis: STALE_BASIS });
      readPort.respond = realtimeBatch();

      const result = await retrieve(true);
      expect(result).not.toBeNull();
      expect(readPort.calls).toHaveLength(2);
      expect(readPort.calls[0].contractCodes).toHaveLength(0);
      expect(readPort.calls[1].contractCodes.length).toBeGreaterThan(0);
      // 补发成功 ⇒ 走实时路径而非回落: 链级非降级、报价为实时口径。
      expect(result!.chain.realtimeDegrade).toBeNull();
      expect(result!.chain.priceKind).toBe('realtime');
    });

    it('③ 补发失败 ⇒ 零再外呼回落收盘档 + `window_basis_stale` (禁拿昨收定窗, 非错误态)', async () => {
      await seedChain({ basis: STALE_BASIS });
      readPort.fail = new Error('vendor unreachable');

      const result = await retrieve(true);
      expect(result).not.toBeNull();
      // 只有那一次失败的补发 —— 主批被 fail-closed 掉, 计数不再增长。
      expect(readPort.calls).toHaveLength(1);
      expect(readPort.calls[0].contractCodes).toHaveLength(0);
      expect(result!.chain.realtimeDegrade).toBe('window_basis_stale');
      expect(result!.chain.priceKind).toBe('eod_close');
      // 回落产物 = 收盘档全量 (五条腿都在, 值取库内) —— 不是空态不是错误。
      expect(result!.chain.spot.toString()).toBe(new Prisma.Decimal(EOD_SPOT).toString());
    });
  });

  // ── T005 · 窄路径主装配 (FR-001/002/005/008/009/010/013; branches 1/9/11/12/13) ──

  describe('T005 实时窄路径主装配 loadRealtimeNarrowChain', () => {
    const codesOf = (result: LegRetrievalResult) => result.candidates.map((c) => c.leg.code).sort();

    it('① 主路: 外呼码集 = K-梯形窗产物 (任一到期日落带 × 段内全部到期日), 计数恒 1, 判腿走同一入口', async () => {
      await seedChain({ basis: FRESH_BASIS });
      readPort.respond = realtimeBatch();

      const result = await retrieve(true);
      expect(result).not.toBeNull();
      expect(readPort.calls).toHaveLength(1);
      // RENT 带 [0.03, 0.62] 对昨日面 {80:0.02, 88:0.15, 92:0.25, 96:0.55, 104:0.70}
      // ⇒ 落带 K = {88, 92, 96}, 包络 ±pad 后 80/104 仍在窗外 (104 另被 W 帽外的比例项罩住)。
      expect([...readPort.calls[0].contractCodes].sort()).toEqual(['T-88', 'T-92', 'T-96']);
      expect(codesOf(result!)).toEqual(['T-88', 'T-92', 'T-96']);
      // 第二段吃实时值: 链级 spot = 批内标的行 (非库内 spot / 非定窗基准)。
      expect(result!.chain.priceKind).toBe('realtime');
      // #378: 候选面标识随链上报 —— 有面 ⇒ 梯形窗 (与下方 window-size 日志的 shape= 同值)。
      expect(result!.chain.windowShape).toBe('window');
      expect(result!.chain.spot.toString()).toBe(new Prisma.Decimal(REALTIME_SPOT).toString());
      expect(result!.chain.quoteAsOf).toEqual(REALTIME_AS_OF);
      // FR-013 窗规模可观测 (analyze G2)。
      expect(infos.some((line) => line.includes('[068] window-size'))).toBe(true);
    });

    it('② 带标: 同批实时 Δ 落带 ⇒ in, 未落 ⇒ out 且**仍在候选中** (打标不删)', async () => {
      await seedChain({ basis: FRESH_BASIS });
      readPort.respond = realtimeBatch({
        'T-88': { delta: '-0.20' },
        'T-92': { delta: '-0.65' },
        'T-96': { delta: '-0.30' },
      });

      const result = await retrieve(true);
      const byCode = new Map(result!.candidates.map((c) => [c.leg.code, c.leg]));
      expect(byCode.get('T-92')?.bandStatus).toBe('out');
      expect(byCode.get('T-88')?.bandStatus).toBe('in');
      expect(byCode.get('T-96')?.bandStatus).toBe('in');
      expect(byCode.has('T-92')).toBe(true);
    });

    it('③ 规则内无腿 ⇒ 既有「有链无候选」形态非错误 (branch 12)', async () => {
      await seedChain({ basis: FRESH_BASIS });
      readPort.respond = realtimeBatch({
        'T-88': { bid: '0.01', ask: '0.03' },
        'T-92': { bid: '0.01', ask: '0.03' },
        'T-96': { bid: '0.01', ask: '0.03' },
      });

      const result = await retrieve(true);
      expect(result).not.toBeNull();
      expect(result!.candidates).toHaveLength(0);
      expect(result!.chain.realtimeDegrade).toBeNull();
      expect(result!.criteriaByTab.rent).toBeDefined();
      expect(result!.removedByPremiumFloor).toBe(3);
    });

    it('④ 两意图视角两次请求 ⇒ 两窗两外呼两个 quoteAsOf (branch 9)', async () => {
      const OLEGS = LEGS.map((leg) => ({ ...leg, dte: 35, code: leg.code.replace('T-', 'O-') }));
      await seedChain({ basis: FRESH_BASIS, legs: OLEGS });
      readPort.respond = (query) => ({
        asOf: new Date(REALTIME_AS_OF.getTime() + readPort.calls.length * 1000),
        rows: [underlyingRow(REALTIME_SPOT), ...query.contractCodes.map((code) => optionRow(code))],
      });

      const build = await retrieve(true, 'build');
      const rent = await retrieve(true, 'rent');
      expect(build).not.toBeNull();
      expect(rent).not.toBeNull();
      expect(readPort.calls).toHaveLength(2);
      // BUILD 带 [0.10, 0.45] ⇒ {88, 92}; RENT 带 [0.03, 0.62] ⇒ {88, 92, 96}。
      expect([...readPort.calls[0].contractCodes].sort()).toEqual(['O-88', 'O-92']);
      expect([...readPort.calls[1].contractCodes].sort()).toEqual(['O-88', 'O-92', 'O-96']);
      expect(build!.chain.quoteAsOf.getTime()).not.toBe(rent!.chain.quoteAsOf.getTime());
    });

    it('⑤ 实时批部分缺行 ⇒ 缺失腿不进候选且不污染门槛计数, partial_miss 留痕 (Edge 2)', async () => {
      await seedChain({ basis: FRESH_BASIS });
      readPort.respond = realtimeBatch({}, REALTIME_SPOT, ['T-88']);

      const result = await retrieve(true);
      expect(codesOf(result!)).toEqual(['T-92', 'T-96']);
      // 没被回答的腿 MUST NOT 被计成「被门槛移出」—— 那是「真实、可读、且完全错的数」。
      expect(result!.removedByPremiumFloor).toBe(0);
      expect(warnings.some((line) => line.includes('partial_miss'))).toBe(true);
    });

    it('⑥ 覆盖在窄路径原样生效: strikeMax 收窄 ⇒ 候选按覆盖出现, 三态 narrowed, memberCount 无覆盖口径 (US3-AS4)', async () => {
      await seedChain({ basis: FRESH_BASIS });
      readPort.respond = realtimeBatch();

      const override: RetrievalOverride = {
        perspective: 'rent',
        criteria: { strikeMax: new Prisma.Decimal('90') },
      };
      const result = await retrieve(true, 'rent', override);
      expect(codesOf(result!)).toEqual(['T-88']);
      expect(result!.memberCount).toBe(3);
      expect(result!.criteriaByTab.rent.outcomes.strikeMax.state).toBe('narrowed');
    });
  });

  // ── T006 · 回落面 + 退役收口 (FR-001/004/007/011/013/014; branches 2/7/8/10) ──

  describe('T006 回落面 + overlay 退役收口', () => {
    it('① bootstrap: 库内零快照期 ⇒ 矩形宽窗走同一管道, 实时批成链 (branch 2)', async () => {
      await seedChain({ snapshots: false, basis: FRESH_BASIS });
      readPort.respond = realtimeBatch({ 'T-88': { openInterest: '321' } });

      const result = await retrieve(true);
      expect(result).not.toBeNull();
      expect(readPort.calls).toHaveLength(1);
      // 矩形 [0.7, 1.05] × 100 罩住五条腿 (80~104)。
      expect(readPort.calls[0].contractCodes).toHaveLength(5);
      expect(infos.some((line) => line.includes('shape=bootstrap'))).toBe(true);
      expect(result!.chain.priceKind).toBe('realtime');
      expect(result!.chain.source).toBe('realtime');
      // #378: 零快照期 ⇒ 候选面标识 = bootstrap —— 客户端靠它把这一轮与次日梯形窗那一轮判成不可比。
      expect(result!.chain.windowShape).toBe('bootstrap');
      // 归属口径: sessionDate = 交易所今天, oiAsOf = 最近已收盘交易日 (周一 08-10)。
      expect(result!.chain.sessionDate.toISOString().slice(0, 10)).toBe(TODAY);
      expect(result!.chain.oiAsOf.toISOString().slice(0, 10)).toBe(PREV_SESSION);
      // bootstrap 下 OI 取实时批 (064 实时基线口径承接) —— 库内无骨架 OI 可落。
      const t88 = result!.candidates.find((c) => c.leg.code === 'T-88');
      expect(t88?.leg.openInterest).toBe(321);
    });

    /**
     * 🚨 **反例样本已从 `hk` 迁到 `cn`** (071 T004① 的必然波及, plan §D6 预告)。
     *
     * 本臂原先拿 hk 当「未支持市场」的被试对象, 而 071 把 hk 接进 `WINDOW_SUPPORTED_MARKETS`
     * ⇒ 它**失去被试对象**: 断言照旧写着「零外呼」, 实际走了实时 ⇒ 当场红 (这是好事; 坏的是
     * 有人顺手把断言删掉而不是换样本)。`IMPORTABLE_MARKETS = ['us','hk']` 没有第三个市场 ⇒
     * `cn` 建不了锚, 但本臂经 `seedChain` **直接播种、不经建锚校验**, 而 `parseAnchorTicker`
     * 也不挑市场 ⇒ cn 走得到闸后那道 guard, 且更贴它真正要守的那一面 (调用方闸失效时兜住)。
     *
     * 📌 #286 要钉的是**顺序**: guard 在闸**之后**。挪到闸前 = 休市时段天天见降级标。
     */
    it('② 未支持市场的 IT 反例**已结构性不可构造** —— 降级理由做成会失效的断言 (#286)', async () => {
      // 🚨 `parseAnchorTicker` 不挑市场, 但**建锚落库有 DB CHECK 约束** `ck_anchor_market`
      //    ⇒ 拿不到第三个市场的锚 ⇒ 闸后那道 guard 在 IT 层没有被试对象。
      //    T006b-⑥ 预写的降级分支就是这一条: 降为 `bootstrapWindowFor` 的纯函数 throw 单测
      //    (`src/optionsdesk/leg-window.rules.spec.ts` 的「非已支持市场 (cn) → throw」)。
      await expect(
        prisma.anchor.create({
          data: {
            ticker: 'cn:000001',
            market: 'cn',
            v: '150',
            asof: dateOf('2026-06-30'),
            method: 'dcf',
            confidence: '8',
            confidenceSource: 'manual',
            lLevelEffective: 'L2',
          },
        }),
      ).rejects.toThrow(/ck_anchor_market/);

      // 🚨 **本断言的真正作用是「哪天它不再成立就来提醒你」**: 谁把 `ck_anchor_market` 放宽到
      //    第三个市场, 这里当场红 —— 那一刻 IT 层重新有了被试对象, MUST 回来把真正的反例臂
      //    (闸开 + 白名单不含它 ⇒ 零外呼 + source_unavailable) 恢复回去, 而不是删掉本条。
      //    🚫 MUST NOT 把它当成「已经测过 guard 了」—— guard 的**顺序** (闸后而非闸前, #286)
      //    在 IT 层目前**无覆盖**, 这是知情的空缺, 不是遗漏。
    });

    it('②b hk 已接实时 ⇒ 同一条路径上它是**正例**而不再是反例 (071 FR-001)', async () => {
      await seedChain({ market: 'hk', code: '0700' });
      marketState.extra = [{ market: 'hk', session: 'regular' }];
      readPort.respond = realtimeBatch();

      const result = await retrieve(true, 'rent', null, 'hk:0700');
      expect(result).not.toBeNull();
      // 闸开 + 白名单放行 ⇒ 真的问了 vendor, 且不该有任何降级标。
      expect(readPort.calls.length).toBeGreaterThan(0);
      expect(result!.chain.realtimeDegrade).toBeNull();
      expect(result!.chain.priceKind).toBe('realtime');
    });

    it('③ 闸 closed (盘前) ⇒ 与离线响应逐值相同且零外呼 (branch 8, 离线零改动机器判据)', async () => {
      await seedChain();
      marketState.session = 'other';

      const realtime = await retrieve(true);
      const offline = await retrieve(false);
      expect(readPort.calls).toHaveLength(0);
      expect(JSON.stringify(realtime)).toBe(JSON.stringify(offline));
      expect(realtime!.chain.realtimeDegrade).toBeNull();
    });

    it('④ 实时开态 + 全腿视角 ⇒ 零外呼、与离线逐值相同、priceKind 标口径 (branch 10, Q1 裁决)', async () => {
      await seedChain();

      const realtime = await retrieve(true, 'all');
      const offline = await retrieve(false, 'all');
      expect(readPort.calls).toHaveLength(0);
      expect(JSON.stringify(realtime)).toBe(JSON.stringify(offline));
      expect(realtime!.chain.priceKind).toBe('eod_close');
    });

    it('⑤ 窗码数 > 单批上限 ⇒ 零外呼回落收盘档 + window_over_cap (Edge 5 回归网, analyze G3)', async () => {
      const wide: SeedLeg[] = Array.from({ length: 401 }, (_, i) => ({
        code: `W-${i}`,
        dte: 60,
        strike: (80 + i * 0.03).toFixed(2),
        bid: '2.00',
        ask: '2.10',
        oi: '900',
        vol: '40',
        delta: '-0.20',
      }));
      await seedChain({ legs: wide });
      readPort.respond = realtimeBatch();

      const result = await retrieve(true);
      expect(result).not.toBeNull();
      expect(readPort.calls).toHaveLength(0);
      expect(result!.chain.realtimeDegrade).toBe('window_over_cap');
      expect(result!.chain.priceKind).toBe('eod_close');
    });

    it('⑥ 主批源不可达 ⇒ 回落收盘档 + source_unavailable (盘中源挂 ≠ 正常盘后)', async () => {
      await seedChain({ basis: FRESH_BASIS });
      readPort.fail = new Error('vendor down');

      const result = await retrieve(true);
      expect(result).not.toBeNull();
      // 基准新鲜 ⇒ 无补发, 唯一一次外呼是失败的主批。
      expect(readPort.calls).toHaveLength(1);
      expect(result!.chain.realtimeDegrade).toBe('source_unavailable');
      expect(result!.chain.priceKind).toBe('eod_close');
      expect(result!.chain.spot.toString()).toBe(new Prisma.Decimal(EOD_SPOT).toString());
    });

    it('⑧ 两闸自身故障 ⇒ gate_unknown 回落收盘档 (不知道该不该给实时 ≠ 今天休市)', async () => {
      await seedChain();
      marketState.fail = new Error('market state source down');

      const result = await retrieve(true);
      expect(result).not.toBeNull();
      expect(readPort.calls).toHaveLength(0);
      expect(result!.chain.realtimeDegrade).toBe('gate_unknown');
      expect(result!.chain.priceKind).toBe('eod_close');
    });

    it('⑦ 067 branch 8 承接: 实时窄路径 axis = min(实时 spot, W) —— 低 V 锚 rent 默认上界按 W 锚定', async () => {
      await seedChain({ v: '120' }); // W = 96 < 实时 spot 104.25 ⇒ axis = 96
      readPort.respond = realtimeBatch();

      const result = await retrieve(true);
      const w = new Prisma.Decimal('96');
      const cap = w.times(new Prisma.Decimal('1.03'));
      const strikeMax = result!.criteriaByTab.rent.defaults.strikeMax;
      expect(strikeMax).not.toBeNull();
      // axis = min(104.25, 96) = 96; 结构项 min{K ≥ 96} = 96 (T-96 在窗内) < 比例项 98.88
      // ⇒ 上界取严落在 W 本身 —— 实时 spot 没有夺走轴 (067 branch 8 的判别点)。
      expect(strikeMax!.toString()).toBe(w.toString());
      expect(strikeMax!.lessThanOrEqualTo(cap)).toBe(true);
    });
  });
});
