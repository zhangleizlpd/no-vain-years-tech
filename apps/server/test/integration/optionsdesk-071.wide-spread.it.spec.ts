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
  type LegRetrievalResult,
} from '../../src/optionsdesk/leg-retrieval.port';
import {
  RECALL_CANDIDATE_CAP,
  type RetrievalOverride,
} from '../../src/optionsdesk/leg-recall.rules';
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
 * 071 (ADR-0068 P5) —— 宽价差机会支的路径级 IT (T009, spec `state_branches` 九臂)。
 *
 * ## 为什么必须要真 PG + 真 DI 容器
 *
 * 机会支住在召回层, 而「它有没有在**这条真读路径上**生效」取决于三件只有真装配才给得出的东西:
 * 成色上界 (要真行权价网格)、权利金下限 (要真 spot)、护栏处置 (要真 `priceKind`)。假 port 上
 * 「放行了」会退化成「夹具原样出来」。PG 从 `setupIsolatedStores()` 取, 🚫 禁自起 Testcontainers。
 *
 * 📌 分工: 谓词与维度合成的边界穷举在 `leg-recall.rules.spec.ts` (T002–T004) 已做; 本文件管
 * **接线面** —— 放行后腿真出现在候选与行里、标真传到 `LegView`、两档同判据、fwd 阶梯真吃它。
 */

const REALTIME_AS_OF = new Date('2026-08-11T17:45:03.000Z');

class SpySnapshotReadPort implements OptionSnapshotPort {
  readonly calls: OptionSnapshotQuery[] = [];
  respond: (query: OptionSnapshotQuery) => OptionSnapshotBatch = () => ({
    asOf: REALTIME_AS_OF,
    rows: [],
  });

  getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch> {
    this.calls.push(query);
    return Promise.resolve(this.respond(query));
  }
}

class FakeMarketStatePort implements MarketStatePort {
  session: MarketSession = 'regular';

  getMarketSessions(): Promise<MarketSessionState[]> {
    return Promise.resolve([{ market: 'us', session: this.session }]);
  }
}

describe('071 宽价差机会支 (Testcontainers PG + Redis, 真 DI 容器)', () => {
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let readPort: SpySnapshotReadPort;
  let marketState: FakeMarketStatePort;
  let usecase: GetLegsUseCase;

  /** 请求时刻 = 2026-08-11 ET 12:00 (盘中) ⇒ 交易所的今天恒为 2026-08-11。 */
  const NOW = new Date('2026-08-11T16:00:00.000Z');
  const TODAY = '2026-08-11';
  const PREV_SESSION = '2026-08-10';
  const SYMBOL = 'us:WSP';
  const UNDERLYING_CODE = 'US.WSP';
  /**
   * 库内昨日收盘 spot。V=150 ⇒ W=120 ⇒ axis = min(100,120) = 100;
   * 链上无 `K ≥ 100` 的档 ⇒ 成色上界退化为比例项 `100 × 1.03 = 103` ⇒ 全部种子腿都过成色。
   * 权利金下限 = max(0.20, 100 × 0.0018) = 0.20。
   */
  const EOD_SPOT = '100.0000';

  const dateOf = (isoDay: string): Date => new Date(`${isoDay}T00:00:00Z`);

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-071-wide-spread-jwt-secret-min-32b';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-071-wide-spread-hmac-32bytes';
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
    marketState.session = 'regular';
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
    readonly ask: string | null;
    /** 昨日收盘 |Δ| —— 实时窄召回第一段 (K-梯形窗) 的查表输入; 全部落 rent 带 [0.03, 0.62]。 */
    readonly delta: string;
  }

  /**
   * 六条腿把机会支的判别面一次铺齐（`年化 = bid/(K−bid) × 365/DTE`，全部落收租段）:
   *
   * | 腿        | 相对价差 | bid 年化 | 期望                                     |
   * | --------- | -------- | -------- | ---------------------------------------- |
   * | W-NARROW  | 0.065    | 21.0%    | 主支就过 ⇒ 候选**无标**（判别性关键臂）   |
   * | W-OPP     | 1.00     | 19.6%    | 主支不过 + 机会支成立 ⇒ 放行**带标**      |
   * | W-THIN    | 1.60     | 7.0%     | 两支都不过 ⇒ 出局（既有语义逐字不变）     |
   * | W-NOASK   | 不可算   | 21.0%    | fail-closed ⇒ 出局（机会支 MUST NOT 接管）|
   * | W-CROSS   | 负       | 21.0%    | 护栏前置 ⇒ 机会支结构上够不到             |
   * | W-DUAL    | 1.00     | 30.1%    | DTE 40 落两段重叠区 ⇒ 收租放行 / 建仓出局 |
   *
   * 🚨 `W-NARROW` 的年化同样达档 —— 它在场是为了钉死「标不是『年化 ≥ 档』的同义词」:
   * 把标的判据误写成只看年化, 这条腿会跟着带标而**表照样渲染得出来**。
   */
  const LEGS: readonly SeedLeg[] = [
    { code: 'W-NARROW', dte: 60, strike: '90', bid: '3.00', ask: '3.20', delta: '-0.20' },
    { code: 'W-OPP', dte: 60, strike: '96', bid: '3.00', ask: '9.00', delta: '-0.25' },
    { code: 'W-THIN', dte: 60, strike: '88', bid: '1.00', ask: '9.00', delta: '-0.15' },
    { code: 'W-NOASK', dte: 60, strike: '86', bid: '3.00', ask: null, delta: '-0.12' },
    { code: 'W-CROSS', dte: 60, strike: '84', bid: '3.00', ask: '2.50', delta: '-0.10' },
    { code: 'W-DUAL', dte: 40, strike: '94', bid: '3.00', ask: '9.00', delta: '-0.30' },
  ];

  async function seedChain(): Promise<void> {
    const instrument = await prisma.instrument.create({
      data: {
        market: 'us',
        code: 'WSP',
        name: 'WSP Inc.',
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
          root: 'WSP',
          underlyingInstrumentId: instrument.id,
          expiryDate: expiry,
          strikePrice: leg.strike,
          optionType: 'PUT',
          isStandard: true,
          expirationCycle: 'MONTH',
        },
        select: { id: true },
      });
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

  /** 实时批把**库内同一批报价原样回放** ⇒ 两档输入值相同 ⇒ 差异只可能来自判据本身 (FR-009)。 */
  function realtimeBatch(): (q: OptionSnapshotQuery) => OptionSnapshotBatch {
    const byCode = new Map(LEGS.map((l) => [l.code, l]));
    const underlying: OptionSnapshotRow = {
      code: UNDERLYING_CODE,
      isOption: false,
      underlyingCode: null,
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      last: EOD_SPOT,
      prevClose: EOD_SPOT,
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
    return (query) => ({
      asOf: REALTIME_AS_OF,
      rows: [
        underlying,
        ...query.contractCodes.flatMap((code): OptionSnapshotRow[] => {
          const leg = byCode.get(code);
          if (leg === undefined) return [];
          return [
            {
              code,
              isOption: true,
              underlyingCode: UNDERLYING_CODE,
              bid: leg.bid,
              ask: leg.ask,
              bidSize: '11',
              askSize: '12',
              last: leg.bid,
              prevClose: leg.bid,
              iv: '22.5',
              delta: leg.delta,
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
            },
          ];
        }),
      ],
    });
  }

  const retrieve = (
    realtime: boolean,
    view: 'all' | 'build' | 'rent' = 'rent',
    override: RetrievalOverride | null = null,
  ): Promise<LegRetrievalResult | null> =>
    moduleRef.get<LegRetrievalPort>(LEG_RETRIEVAL_PORT).retrieveCandidates({
      symbol: SYMBOL,
      now: NOW,
      perspectives: [view],
      candidateCap: RECALL_CANDIDATE_CAP,
      override,
      realtime,
    });

  /** `code → 机会标` —— 九臂共用的判别面。 */
  const marksOf = (result: LegRetrievalResult | null): Record<string, boolean> => {
    expect(result).not.toBeNull();
    return Object.fromEntries(
      (result as LegRetrievalResult).candidates.map((c) => [c.leg.code, c.wideSpreadOpportunity]),
    );
  };

  const view = (perspective: 'all' | 'build' | 'rent', realtime = false): Promise<LegTableView> =>
    usecase.execute(SYMBOL, perspective, NOW, null, null, realtime);

  // ── 九臂 ──────────────────────────────────────────────────────────────────

  it('① 收租离线: 达档的宽价差腿放行带标, 不达档 / 不可算 / 窄价差三类各归各位 (state_branches 1/2/3)', async () => {
    await seedChain();
    const marks = marksOf(await retrieve(false));

    // 放行的两条 —— 它们在 071 之前压根不在收租候选里。
    expect(marks['W-OPP']).toBe(true);
    expect(marks['W-DUAL']).toBe(true);
    // 🚨 年化同样达档但主支就过 ⇒ **无标**: 标不是「年化 ≥ 档」的同义词。
    expect(marks['W-NARROW']).toBe(false);
    // 不达档 / 相对价差不可算 ⇒ 逐字沿既有语义出局。
    expect(marks).not.toHaveProperty('W-THIN');
    expect(marks).not.toHaveProperty('W-NOASK');
  });

  it('② 护栏前置: 交叉报价腿离线保留成行但**不带标** —— 机会支结构上够不到它 (state_branches 5)', async () => {
    await seedChain();
    const result = await retrieve(false);
    const marks = marksOf(result);

    // 070 收盘口径 = 剔降为标 ⇒ 它在候选里, 且进护栏留痕列表。
    expect(marks['W-CROSS']).toBe(false);
    expect((result as LegRetrievalResult).removedByCrossedQuote.map((l) => l.code)).toEqual([
      'W-CROSS',
    ]);
  });

  it('③ 机会支收租限定: 同一条腿在建仓视角仍被点差闸挡下 (FR-003; state_branches 4)', async () => {
    await seedChain();
    const build = marksOf(await retrieve(false, 'build'));

    // W-DUAL 的 DTE 40 同时落建仓段 [1,49] 与收租段 ⇒ 视角是唯一变量。
    expect(build).not.toHaveProperty('W-DUAL');
    // 建仓段内的窄价差腿照常在 —— 排除的原因是点差不是期限。
    expect(Object.values(build).every((marked) => marked === false)).toBe(true);
  });

  it('④ 全腿视角不设点差上界 ⇒ 机会支恒不触发, 腿照常可达且无标 (state_branches 4)', async () => {
    await seedChain();
    const all = marksOf(await retrieve(false, 'all'));

    expect(all).toHaveProperty('W-OPP');
    expect(all).toHaveProperty('W-THIN');
    expect(Object.values(all).every((marked) => marked === false)).toBe(true);
  });

  it('⑤ 用户把点差上界**收窄** ⇒ 机会支让位, 用户的值绝对生效 (state_branches 8)', async () => {
    await seedChain();
    const narrowed: RetrievalOverride = {
      perspective: 'rent',
      criteria: { relativeSpreadMax: new Prisma.Decimal('0.05') },
    };
    const marks = marksOf(await retrieve(false, 'rent', narrowed));

    // 🚨 「我只要窄市场」是一句明确的话 —— 机会支照样放行, 这个控件就对一类腿失效了。
    expect(marks).not.toHaveProperty('W-OPP');
    expect(marks).not.toHaveProperty('W-NARROW'); // rel 0.065 > 0.05, 主支也挡下它
  });

  it('⑤ᵇ 显式填一个等于默认值的上界 ⇒ 机会支仍在 —— 判据是「不比默认严」不是「有没有覆盖」', async () => {
    await seedChain();
    const explicitDefault: RetrievalOverride = {
      perspective: 'rent',
      criteria: { relativeSpreadMax: new Prisma.Decimal('0.35') },
    };
    const marks = marksOf(await retrieve(false, 'rent', explicitDefault));

    expect(marks['W-OPP']).toBe(true);
    expect(marks['W-NARROW']).toBe(false);
  });

  it('⑥ 用户把点差上界放到「不限」⇒ 标不消失 (FR-006; state_branches 8)', async () => {
    await seedChain();
    const widened: RetrievalOverride = {
      perspective: 'rent',
      criteria: { relativeSpreadMax: null },
    };
    const marks = marksOf(await retrieve(false, 'rent', widened));

    // 🚨 此时主支恒过 ⇒ 标若按「本次实际被挡下」判会当场消失, 而那还是同一条腿。
    expect(marks['W-OPP']).toBe(true);
    expect(marks['W-THIN']).toBe(false);
  });

  it('⑦ 两档一律: 实时窄召回第二段与离线档判据逐腿一致 (FR-009; state_branches 6)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    const offline = marksOf(await retrieve(false));
    const realtimeResult = await retrieve(true);
    const realtime = marksOf(realtimeResult);

    // 窄召回只圈规则内的码 ⇒ 比对两档的**交集**; 交叉腿的成员差异归 070 的口径分派, 不是本片。
    const shared = Object.keys(realtime).filter((code) => code in offline && code !== 'W-CROSS');
    expect(shared.length).toBeGreaterThan(0);
    for (const code of shared) {
      expect(realtime[code], `${code} 两档机会标不一致`).toBe(offline[code]);
    }
    expect(realtime['W-OPP']).toBe(true);
    // 前置确认这一臂真走了窄召回 (否则「两档一致」会因为两边都是收盘档而假绿)。
    expect(readPort.calls.length).toBeGreaterThan(0);
  });

  it('⑧ 标一路上浮到行视图, 且带标腿照常参与 fwd 阶梯并可当选推荐停点 (FR-005/FR-008; state_branches 7/9)', async () => {
    await seedChain();
    const rent = await view('rent');

    const opp = rent.legs.find((l) => l.code === 'W-OPP');
    expect(opp?.wideSpreadOpportunity).toBe(true);
    expect(rent.legs.find((l) => l.code === 'W-NARROW')?.wideSpreadOpportunity).toBe(false);

    // K=96 上只有这一条腿 ⇒ 净链单档, fwd = 自身年化 19.6% ≥ φ(good)=0.15、OI 900 ≥ 50
    // ⇒ 判决 recommended 且停点就是这条带标腿。
    const k96 = rent.march?.find((m) => m.strike.equals(new Prisma.Decimal('96')));
    expect(k96?.verdict).toBe('recommended');
    expect(k96?.recommendedDteDays).toBe(60);
  });

  it('⑨ 建仓与全腿两视角的行集合零回归 —— 爆炸半径钉在收租点差这一格 (US3)', async () => {
    await seedChain();
    const build = await view('build');
    const all = await view('all');

    // 建仓: 只有 DTE 40 那条落段内, 而它宽价差 ⇒ 被点差闸挡下 ⇒ 建仓无行。
    expect(build.legs.map((l) => l.code)).toEqual([]);
    expect(build.gateCounts.excludedFromIntentTabs).toBe(1);
    // 全腿: 六条腿全部可达 (不设期限段、不设点差上界), 且一条标都不打。
    expect(all.legs.map((l) => l.code).sort()).toEqual(
      ['W-CROSS', 'W-DUAL', 'W-NARROW', 'W-NOASK', 'W-OPP', 'W-THIN'].sort(),
    );
    expect(all.legs.every((l) => l.wideSpreadOpportunity === false)).toBe(true);
  });
});
