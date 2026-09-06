import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { setupIsolatedStores } from '../_support/isolated-db';
import { AppModule } from '../../src/app/app.module';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { RECALL_CANDIDATE_CAP } from '../../src/optionsdesk/leg-recall.rules';
import { REALTIME_DEGRADE_LOG_TAG } from '../../src/optionsdesk/leg-retrieval.adapter';
import {
  LEG_RETRIEVAL_PORT,
  REALTIME_CHAIN_DEGRADE_KINDS,
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
  type MarketSessionState,
  type MarketStatePort,
} from '../../src/marketdata/market-state.port';

/**
 * 071 —— 港股实时窄召回接线的路径级 IT (FR-004 / FR-005 / FR-006 / FR-006a / FR-012)。
 *
 * ## 🚨 本文件存在的唯一理由: 「周一效应」不设断言就看不出修没修
 *
 * 实时路径的业务日基准此前写死 `exchangeCalendarDate('us', now)`。港股**周一盘中**请求会折算出
 * **美股的周日**, 而 `marketdata.trading_day` 的 hk 周末无行、`calendar_coverage.hk` 又覆盖该日
 * ⇒ `classifyTradingDay` 返 `non-trading` ⇒ 闸判休市 ⇒ 回落收盘档且**零降级标**。
 *
 * ⇒ 周二到周五坏成一条红字 (`source_unavailable`), **周一坏成一张看起来完全正常的收盘档表**。
 * 后者没有任何外部可观测信号 —— 所以它必须由一条专门的时刻夹具钉住。
 *
 * ## 时刻夹具怎么选的
 *
 * `2026-08-31T02:00:00Z` = **港股周一 10:00 (连续竞价中)** ∧ **美股周日 22:00 (ET)**。
 * 两个市场的日历日在这一刻**不同且港股是交易日、美股折算日不是** —— 这正是病灶的构造条件。
 * 🚫 MUST NOT 换成两地同日的时刻: 那样换不换基准都绿, 本文件退化成摆设。
 *
 * ## 分工
 *
 * 真 PG + 真 DI 容器 (理由同 064/068 IT 文件头): 第一段选码读的是**真库**的合约集与昨日 Δ 面,
 * 闸读的是真交易日历。PG 从 `test/_support/isolated-db.ts` 取, 🚫 禁自起 Testcontainers。
 */

/** 本批实时报价的我方采集时刻 (信封 `as_of`)。 */
const REALTIME_AS_OF = new Date('2026-08-31T02:00:11.000Z');

/** 计数 + 可编程读取口替身 —— 「零外呼」只有数请求次数才证得了 (体例同 068 IT)。 */
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

/**
 * 市场时段替身 —— **按市场应答**。
 * 🚨 068 那份写死返 `{market:'us'}`, 港股用例照抄会让闸恒判 `unknown` ⇒ 全体假绿成「反正没外呼」。
 */
class FakeMarketStatePort implements MarketStatePort {
  sessions: MarketSessionState[] = [{ market: 'hk', session: 'regular' }];

  getMarketSessions(): Promise<MarketSessionState[]> {
    return Promise.resolve(this.sessions);
  }
}

describe('071 港股实时窄召回接线 (Testcontainers PG + Redis, 真 DI 容器)', () => {
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let readPort: SpySnapshotReadPort;
  let marketState: FakeMarketStatePort;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  /** 🚨 港股周一 10:00 (盘中) = 美股周日 22:00 (ET)。见文件头「时刻夹具怎么选的」。 */
  const NOW = new Date('2026-08-31T02:00:00.000Z');
  /** 港股当地日历日 —— 修好之后实时路径该用的那个。 */
  const HK_TODAY = '2026-08-31';
  /**
   * 美股折算日 (周日) —— 病灶用的那个。
   * 📌 071 当时它还兼任「离线路径仍在用的那个」(Guardrail 1 的绊线锚点); 离线基准补齐后**两条
   * 路径都不再用它**, 它在本文件里的角色收窄为**反例锚**: 臂③/③b 断言 `not.toBe(US_TODAY)`,
   * 钉住「基准没有退回美股」。🚫 MUST NOT 因为「没人用了」把它删掉 —— 删了那两条断言就只剩
   * 「等于港股日」这一半, 而拿任何一个恒定值都能过。
   */
  const US_TODAY = '2026-08-30';
  /** 昨日 Δ 面所在的交易日 = 上周五。 */
  const PREV_SESSION = '2026-08-28';

  const SYMBOL = 'hk:TCX';
  const UNDERLYING_CODE = 'HK.TCX';
  const EOD_SPOT = '100.0000';
  /**
   * 076 本夹具链上每张合约的正股股数。取 `500` 而非 `100` 是刻意的 —— 港股每张合约的股数逐标的
   * 不同, 用 100 会让「股数没被带出来」与「带出来了」在断言上长得一样。
   */
  const HK_CONTRACT_SIZE = 500;

  const day = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-071-hk-realtime-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-071-hk-realtime-hmac-secret-32b';
    delete process.env.MARKETDATA_PROVIDER;

    readPort = new SpySnapshotReadPort();
    marketState = new FakeMarketStatePort();
    moduleRef = await Test.createTestingModule({ imports: [AppModule, OptionsdeskModule] })
      .overrideProvider(OPTION_SNAPSHOT_READ_PORT)
      .useValue(readPort)
      .overrideProvider(MARKET_STATE_PORT)
      .useValue(marketState)
      // 🚨 交易日历**不 override** —— 病灶正是「闸拿错日期去问日历」, override 掉就测不到了。
      .compile();
    prisma = moduleRef.get(PrismaService);
    // 🚨 留住 warn 的引用 —— T006b-③ 要断言「不抬告警」, 那只能对着调用记录问。
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await moduleRef?.close();
    await stores.drop();
  });

  /**
   * 清空本文件播的全部表。
   *
   * 🚨 抽成函数是因为 T006b 的 ①/③ 两臂要在**同一个 `it()` 内**重播一次夹具 (它们的判据是
   * 「同一批合约, 换一个前提, 结局不同」的差分) —— 表清单抄第二份必漂移, 而漏掉一张的表现是
   * `Unique constraint failed`, 那种红**看起来像被测代码坏了**
   * (2026-09-04 实撞: 第一版漏了 `trading_day` / `calendar_coverage` 两张)。
   */
  async function resetSeededTables(): Promise<void> {
    await prisma.optionDailySnapshot.deleteMany();
    await prisma.optionContract.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.anchorChange.deleteMany();
    await prisma.anchor.deleteMany();
    await prisma.$executeRawUnsafe('TRUNCATE marketdata.trading_day RESTART IDENTITY CASCADE');
    await prisma.calendarCoverage.deleteMany();
  }

  beforeEach(async () => {
    readPort.calls.length = 0;
    readPort.respond = () => ({ asOf: REALTIME_AS_OF, rows: [] });
    warnSpy.mockClear();
    marketState.sessions = [{ market: 'hk', session: 'regular' }];
    await resetSeededTables();
  });

  // ── 造数 ──────────────────────────────────────────────────────────────────

  interface SeedLeg {
    readonly code: string;
    /** 到期日 (绝对日期, 不用 DTE 偏移 —— 本文件的全部价值在「哪一天」上, 偏移会把它算糊)。 */
    readonly expiry: string;
    readonly strike: string;
    readonly delta: string | null;
  }

  /**
   * 昨日 spot = 100, |Δ| 随 K 升单调升 (定稿带 rent [0.03,0.62] / build [0.10,0.45])。
   * 🚨 `DTE0` 那条**到期日恰是港股今天** —— 它是 FR-006a 等价性臂的被试对象:
   *    比较符从 `>` 改成 `>=` 时它会混进候选, 而候选集照样出得来、不报错。
   */
  const LEGS: readonly SeedLeg[] = [
    { code: 'X-DTE0', expiry: HK_TODAY, strike: '92', delta: '-0.30' },
    { code: 'X-88', expiry: '2026-10-29', strike: '88', delta: '-0.15' },
    { code: 'X-92', expiry: '2026-10-29', strike: '92', delta: '-0.25' },
    { code: 'X-96', expiry: '2026-10-29', strike: '96', delta: '-0.55' },
  ];

  /**
   * T006a-② 的**近月**腿 —— DTE 24 (`2026-08-31` → `2026-09-24`) ⇒ 只落建仓段 `[1,49]`,
   * 收租段 `[30,365]` 够不着; 而 {@link LEGS} 的远月腿 DTE 59 反之。两意图的窗因此**不相交**,
   * 「两视角各按自己的落带圈码」才有一条不会被巧合满足的判据。
   * 🚨 蓄意不进 {@link LEGS}: 那会改掉既有五臂的夹具面 (放行路径新增前先扫既有夹具的纪律)。
   */
  const NEAR_LEGS: readonly SeedLeg[] = [
    { code: 'N-90', expiry: '2026-09-24', strike: '90', delta: '-0.18' },
    { code: 'N-94', expiry: '2026-09-24', strike: '94', delta: '-0.32' },
  ];

  /**
   * T006b-① 的**深虚**腿 —— 两条都远在梯形窗之外, 用来把 bootstrap 兜底窗的**两侧**同时钉住。
   * 定窗基准 spot = `104.25` (锚的盘中价), 港股 bootstrap 下界比例 `0.6` / 上界 `1.05`:
   *
   * | 腿 | `K/spot` | `0.6×spot = 62.55` | `0.7×spot = 72.98` (美股那档) |
   * | --- | --- | --- | --- |
   * | `D-70` | 0.671 | **在窗内** | 在窗**外** |
   * | `D-60` | 0.576 | 在窗外 | 在窗外 |
   *
   * ⇒ `D-70` 被问到 = 港股取的确实是 `0.6` 那一项 (退回 `0.7` 当场红);
   *   `D-60` 不被问到 = 「宁宽」也仍然有边, 不是把下界一路放空。
   * 🚨 两条的昨日 `|Δ|` 都低于收租带下界 `0.03` ⇒ 有昨日面时它们**本就不在梯形窗内**,
   *    这正是本臂差分的另一半 (同一份合约, 有面 ⇒ 不问; 无面 ⇒ 问)。
   */
  const DEEP_OTM_LEGS: readonly SeedLeg[] = [
    { code: 'D-70', expiry: '2026-10-29', strike: '70', delta: '-0.02' },
    { code: 'D-60', expiry: '2026-10-29', strike: '60', delta: '-0.01' },
  ];

  /**
   * 港股交易日历: 上周四五 + 本周一有行, 周末**无行**; 覆盖声明含整段 ⇒ 周末 = 确认非交易日。
   *
   * 🚨 **本 IT 里这两张表并不驱动实时闸的日历那一半** —— `TRADING_CALENDAR_PORT` 在
   * `MARKETDATA_PROVIDER=mock` 档绑的是 `MockMarketDataAdapter`（`marketdata.module.ts` 的
   * `useFactory`: `cfg.kind === 'mock' ? mock : new DbTradingCalendarAdapter(prisma)`），它的
   * `classify` 是**星期判据**（周一~周五 = `trading`），从不查 `trading_day`。
   * EVIDENCE: 2026-09-04 —— T006a-⑥ 初版删掉 `trading_day` 的 `2026-08-31` 行（`deleteMany`
   * 实返 `count=1`）后闸**仍判开市**、`priceKind` 仍是 `'realtime'`；改用「把时刻挪到周六」
   * 才驱动得动那一闸。
   * ⇒ 要驱动日历闸只能换**时刻**（星期几），🚫 改这两张表是无效 arrange，且它会**长得像通过**。
   * 📌 播种保留不动: 周末无行这件事与 mock 的星期判据同向，周一效应臂（臂①/④）两种口径下
   * 答案一致；且换成 live 档时它就是真判据。
   */
  async function seedCalendar(): Promise<void> {
    for (const date of ['2026-08-27', PREV_SESSION, HK_TODAY]) {
      await prisma.tradingDay.create({ data: { market: 'hk', date: day(date) } });
    }
    await prisma.calendarCoverage.create({
      data: {
        market: 'hk',
        coveredFrom: day('2026-08-01'),
        coveredTo: day('2026-09-30'),
      },
    });
  }

  /**
   * T006b 用的三个开关。默认值**逐项等于 T005 / T006a 立这个函数时的行为** —— 既有臂一个字
   * 不用改, 新臂只挑自己要偏离的那一项。
   */
  interface SeedOptions {
    /** `false` ⇒ 只建合约、**不写昨日快照** = 「新锚首日无昨日预测面」(T006b-①)。 */
    readonly snapshots?: boolean;
    /** 锚的盘中基准时刻; `null` ⇒ 连同价一起不写 = 三级基准链第一级必落空 (T006b-④)。 */
    readonly intradayAt?: Date | null;
    /**
     * `false` ⇒ 建锚**与标的**、但一条期权合约都不建 = 「没有任何挂牌期权的港股锚」(T006b-③)。
     * 🚨 标的行仍要建 —— 生产里那只锚的标的是在册的, 缺的只是期权合约。连标的一起省掉的话
     *    `null` 其实来自「查不到 instrument」那条更早的分支, 臂就测到别的东西上去了。
     */
    readonly contracts?: boolean;
  }

  async function seedChain(
    extra: readonly SeedLeg[] = [],
    options: SeedOptions = {},
  ): Promise<void> {
    const withSnapshots = options.snapshots ?? true;
    const withContracts = options.contracts ?? true;
    const intradayAt =
      options.intradayAt === undefined ? new Date(NOW.getTime() - 30_000) : options.intradayAt;
    await seedCalendar();
    const instrument = await prisma.instrument.create({
      data: {
        market: 'hk',
        code: 'TCX',
        name: 'TCX Ltd.',
        type: 'stock',
        currency: 'HKD',
        status: 'active',
        needSync: true,
      },
      select: { id: true },
    });
    for (const leg of withContracts ? [...LEGS, ...extra] : []) {
      const contract = await prisma.optionContract.create({
        data: {
          market: 'hk',
          code: leg.code,
          root: 'TCX',
          underlyingInstrumentId: instrument.id,
          expiryDate: day(leg.expiry),
          strikePrice: leg.strike,
          optionType: 'PUT',
          isStandard: true,
          expirationCycle: 'MONTH',
          // 076: 一张合约的正股股数。取 500 是港股实测分布里最常见的一档 (7/22 只锚)
          // —— EVIDENCE: `specs/076-option-contract-size/spec.md`「取证」§1。
          contractSize: HK_CONTRACT_SIZE,
        },
        select: { id: true },
      });
      if (!withSnapshots) continue;
      await prisma.optionDailySnapshot.create({
        data: {
          contractId: contract.id,
          sessionDate: day(PREV_SESSION),
          source: 'eod',
          quoteAsOf: new Date(`${PREV_SESSION}T15:00:31Z`),
          oiAsOf: day(PREV_SESSION),
          bid: '1.60',
          ask: '1.70',
          bidSize: '25',
          askSize: '26',
          delta: leg.delta,
          iv: '21',
          openInterest: '900',
          netOpenInterest: '111',
          volume: '40',
          underlyingSpot: EOD_SPOT,
          greeksComplete: leg.delta !== null,
        },
      });
    }
    await seedAnchor(intradayAt);
  }

  /** 建锚。`intradayAt === null` ⇒ 盘中价与时刻都不写 ⇒ 三级基准链第一级必落空。 */
  async function seedAnchor(intradayAt: Date | null): Promise<void> {
    await prisma.anchor.create({
      data: {
        ticker: SYMBOL,
        market: 'hk',
        v: '150',
        asof: day('2026-06-30'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
        // 默认基准新鲜 (相对 NOW 只差 30s) ⇒ 三级基准链第一级命中, 不补发。
        intradayPrice: intradayAt === null ? null : '104.25',
        intradayAt,
      },
    });
  }

  function optionRow(code: string): OptionSnapshotRow {
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
      openInterest: '900',
      netOpenInterest: '111',
      volume: '40',
      turnover: null,
      vendorUpdateTime: null,
      greeksComplete: false,
    };
  }

  /** 标的行 —— 实时 spot 的载体 (期权行不带 spot, 见 `OptionSnapshotRow`)。 */
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
      vendorUpdateTime: REALTIME_AS_OF,
      greeksComplete: null,
    };
  }

  /** 标的行恒随批; 期权行按请求 code 回放。 */
  const realtimeBatch =
    () =>
    (q: OptionSnapshotQuery): OptionSnapshotBatch => ({
      asOf: REALTIME_AS_OF,
      rows: [underlyingRow('104.25'), ...q.contractCodes.map((code) => optionRow(code))],
    });

  function retrieve(
    realtime: boolean,
    view: 'build' | 'rent' | 'all' = 'rent',
    now: Date = NOW,
  ): Promise<LegRetrievalResult | null> {
    return moduleRef.get<LegRetrievalPort>(LEG_RETRIEVAL_PORT).retrieveCandidates({
      symbol: SYMBOL,
      now,
      perspectives: [view],
      candidateCap: RECALL_CANDIDATE_CAP,
      override: null,
      realtime,
    });
  }

  // ── 臂① 周一效应 (FR-004; state_branch 「港股盘中走实时窄召回」) ─────────────

  it('🚨 臂① 港股周一盘中 ⇒ 闸判**开市**并走实时 (改前折算出美股周日, 静默给收盘档)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    const result = await retrieve(true);

    expect(result).not.toBeNull();
    // 🚨 这一条就是病灶本身: 基准写死 'us' 时 marketDate = 2026-08-30 (周日)。
    expect(result?.chain.marketDate).toBe(HK_TODAY);
    // 闸开 ⇒ 真的问了 vendor。改前是**零外呼**且不报错 —— 「静默收盘档」没有别的可观测信号。
    expect(readPort.calls.length).toBeGreaterThan(0);
    expect(result?.chain.priceKind).toBe('realtime');
  });

  // ── 臂④ 链级日期口径 (FR-004; 与臂① 同因不同果, 分开断言) ───────────────────

  it('🚨 臂④ 链级 marketDate 等于**港股**当地日历日, 不是美股折算日', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    const result = await retrieve(true);

    expect(result?.chain.marketDate).toBe(HK_TODAY);
    expect(result?.chain.marketDate).not.toBe(US_TODAY);
    // 港股周一 10:00 与美股周日 22:00 是同一刻 —— 两个日期都真, 但只有一个是**这条链的**日期。
    expect(HK_TODAY).not.toBe(US_TODAY);
  });

  // ── 臂② 等价性 (FR-006a) —— 拦「顺手把 `>` 改成 `>=`」 ──────────────────────

  it('🚨 臂② 当天到期的腿**不进**候选 (比较符仍是严格 `>`; 改 `>=` 只多一批范围外计数)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    const result = await retrieve(true);

    const codes = result?.candidates.map((c) => c.leg.code) ?? [];
    // `X-DTE0` 的到期日恰是港股今天 ⇒ DTE=0 ⇒ MUST NOT 出现。
    expect(codes).not.toContain('X-DTE0');
    // 🚨 而且**外呼那一批里也不该有它** —— 圈码是召回第一段, 出窗的码根本不问 vendor。
    for (const call of readPort.calls) {
      expect(call.contractCodes).not.toContain('X-DTE0');
    }
  });

  // ── 臂③ 离线路径的业务日基准同样取该锚市场 ─────────────────────────────────

  it('🚨 臂③ 离线路径的业务日基准 = **该锚市场的今天**, 与实时那处同一条纪律', async () => {
    await seedChain();

    const offline = await retrieve(false);

    expect(offline).not.toBeNull();
    // 🚨 **本臂已于「离线基准修复」翻面, 翻它是蓄意的**: 原文钉的是「离线**仍是**美股折算日」
    //    (`expect(...).toBe(US_TODAY)`), 那是 071 Guardrail 1 刻意设的绊线 —— 当时实时与离线
    //    分两片走, 绊线保证「顺手把离线也改了」当场红。离线这半现已补齐 ⇒ 绊线的使命结束,
    //    翻面而不是删除: 留着这一条继续钉住「基准取 `parsed.market`」这个正向判据。
    //    🚫 MUST NOT 因为「它以前是 US_TODAY」就把它改回去 —— 那是把修复本身回退掉。
    expect(offline?.chain.marketDate).toBe(HK_TODAY);
    expect(offline?.chain.marketDate).not.toBe(US_TODAY);
    // 离线路径**零对外呼**。
    expect(readPort.calls).toHaveLength(0);
    expect(offline?.chain.priceKind).toBe('eod_close');
  });

  it('🚨 臂③b 离线腿集合在**同一个港股交易日内恒定** —— 不再随 ET 午夜跳变', async () => {
    await seedChain();

    // 同一个港股交易日 (2026-08-31) 的两个时点, 跨过 ET 午夜 (= 北京 12:00, EDT):
    //   · 港股上午 10:00 HKT = `NOW` (02:00Z) ⇒ 美股折算日还是 08-30
    //   · 港股下午 14:00 HKT (06:00Z)        ⇒ 美股折算日追平到 08-31
    // 改前这两个时点的 `marketDate` 不同 ⇒ `expiryDate > marketDate` 这道过滤对**当天到期腿**
    // (`X-DTE0`, 到期日 = `HK_TODAY`) 给出相反答案 ⇒ 全腿视角的成员集在北京 12:00 无业务事件地
    // 变一次。EVIDENCE: 我方 2026-09-06 按 `Intl` 复算这两个时点 —— 02:00Z 得 us=2026-08-30、
    // 06:00Z 得 us=2026-08-31, 而 hk 两次都是 2026-08-31。
    const hkAfternoon = new Date('2026-08-31T06:00:00.000Z');
    // 🚨 视角取 `all`: 它的 `dteBand` 恒 `null`, 是唯一看得见当天到期腿的视角 —— 收租/建仓的
    //    召回段下界 (`RENT_RECALL_DTE.min = 30` / `BUILD_RECALL_DTE.min = 1`) 已单点排除 DTE=0,
    //    拿它们做判据的话本臂对基准**恒绿**, 即使基准是错的。
    const morning = await retrieve(false, 'all');
    const afternoon = await retrieve(false, 'all', hkAfternoon);

    const codesOf = (r: LegRetrievalResult | null) =>
      (r?.candidates.map((c) => c.leg.code) ?? []).slice().sort();

    expect(morning?.chain.marketDate).toBe(HK_TODAY);
    expect(afternoon?.chain.marketDate).toBe(HK_TODAY);
    // 成员集逐值相同 —— 这一条才是本臂的靶心 (只比 `marketDate` 的话, 拿一个恒定但**错**的
    // 基准也能过)。
    expect(codesOf(morning)).toEqual(codesOf(afternoon));
    // 且当天到期的腿两个时点都**不在**集合里 (`>` 这条 policy 本片不动, 两市同构地全天隐藏)。
    expect(codesOf(morning)).not.toContain('X-DTE0');
    expect(codesOf(afternoon)).not.toContain('X-DTE0');
  });

  // ── 软下架的码不进实时批 (#342; 毒批防线) ──────────────────────────────────

  it('🚨 已软下架的码 MUST NOT 进实时报价批 —— 一颗死码就让整批一票否决, 表现为整体回落收盘档', async () => {
    await seedChain();
    // X-92 被 vendor 撤下 (链发现对账已置戳)。它的昨日快照仍在库里 ⇒ 不设谓词时它照常成行。
    // EVIDENCE: 2026-09-04 prod 快照轮实撞 hk:09988 批 3/4 (399 合约) 因单个死码
    // `ALB260904C103000` 整批 502 —— vendor 的批量报价口不逐码降级, 整批拒。
    await prisma.optionContract.updateMany({
      where: { code: 'X-92' },
      data: { withdrawnAt: new Date(`${PREV_SESSION}T16:20:00Z`) },
    });
    readPort.respond = realtimeBatch();

    const result = await retrieve(true);

    expect(result?.chain.priceKind).toBe('realtime');
    // 🚨 判据落在**请求出参**上, 不是结果集: 死码只要进了 codes, 真 vendor 那边整批就废了 ——
    // 而 stub 会老老实实回放它, 结果集看不出任何异常 (正是线上那次没被任何断言拦住的原因)。
    const requested = readPort.calls.flatMap((c) => c.contractCodes);
    expect(requested).not.toContain('X-92');
    // 同窗其余腿照常问 —— 摘掉死码 MUST NOT 顺手把工作集缩没 (窄召回的窗本就只圈落带内的码,
    // 这里剩 X-96; 断言它仍在, 免得「一条都没问」也让上面那条 not.toContain 通过)。
    expect(requested).toContain('X-96');
    expect(result?.candidates.map((c) => c.leg.code) ?? []).not.toContain('X-92');
  });

  // ══ T006a 正常态 + 意图分叉 + 时段态 (FR-007 / FR-008 / FR-016; SC-001 / SC-005) ══════════
  //
  // 🚨 七臂全部 **fixture 播种**, 🚫 不依赖任何真锚的当下形态 (FR-016) —— 全库仅一只港股锚能
  //    真正跑通收租路径, 拿它当被试对象等于让断言随行情漂。
  // 🚨 时段三臂 (④⑤⑥) 的判据**同为「零外呼 + 收盘档 + 零降级标」, 但关闸的机制三样**:
  //    ④ 供应方报非常规 · ⑤ 同 ④ 但本地日历仍说是交易日 (半日市下午由供应方挡, 闸不读半日标)
  //    · ⑥ 供应方仍报 regular 而日历说非交易日 (两闸取交集的存在理由)。
  //    只断言结局不区分机制的话, 删掉任意一闸都还有两臂是绿的。

  // ── T006a-① 正常实时态 (state_branch 1; SC-001) ────────────────────────────

  it('🚨 T006a-① 盘中 ∧ 基准新鲜 ⇒ 实时窄召回: 时点 = 本批采集时刻 (SC-001) ∧ 零降级标', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    const result = await retrieve(true);

    expect(result?.chain.priceKind).toBe('realtime');
    // 🚨 SC-001「数据时点与请求时刻的间隔不超过一次请求往返」的机器判据 = 时点**与本批同源**,
    //    而不是「离 NOW 足够近」—— 后者要挑一个毫秒阈值, 而任何阈值都是编的。
    expect(result?.chain.quoteAsOf.toISOString()).toBe(REALTIME_AS_OF.toISOString());
    // 秒级**时刻**而非交易日: 收盘档那一路的 quoteAsOf 落在 PREV_SESSION 当天。
    expect(result?.chain.quoteAsOf.getTime()).toBeGreaterThan(day(HK_TODAY).getTime());
    // 🚨 正常实时档 MUST NOT 带降级标 —— 它与 priceKind 答的是两个问题, 不许互相推导。
    expect(result?.chain.realtimeDegrade).toBeNull();
    // 腿行的报价取自**本次**外呼返回的值 (夹具里实时 bid 2.40 ≠ 库内收盘 bid 1.60)。
    expect(result?.candidates.length ?? 0).toBeGreaterThan(0);
    for (const c of result?.candidates ?? []) {
      expect(c.leg.priceKind).toBe('realtime');
      expect(c.leg.bid?.toString()).toBe('2.4');
    }
  });

  // ── 076 实时窄路径带出合约股数 (076 FR-011; state_branch 8) ─────────────────

  it('🚨 076 实时窄路径的 answered 行**自动携带**合约股数 —— 骨架行展开, 零额外改写点', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    const result = await retrieve(true);

    // 前置: 确实走的是实时那条路 (回落收盘档时本臂验的就不是窄路径了)。
    expect(result?.chain.priceKind).toBe('realtime');
    expect(result?.candidates.length ?? 0).toBeGreaterThan(0);
    // 🚨 钉的是**结构论断** (plan §D5): `answered` 行由骨架行 `{ ...leg, … }` 展开, 于是合约主
    //    数据这一类字段无需在实时分支再列一遍。本臂红 = 这个结构假设不成立 (有人把展开换成了
    //    逐字段列举), 那时该改的是那一处, 不是骨架。
    for (const c of result?.candidates ?? []) {
      expect([c.leg.code, c.leg.contractSize]).toEqual([c.leg.code, HK_CONTRACT_SIZE]);
      // 判别性: 实时分支确实改写过这一行 (bid 取本批 2.40 ≠ 库内收盘 1.60), 股数却原样穿过。
      expect(c.leg.priceKind).toBe('realtime');
    }
  });

  // ── T006a-② 意图分叉 (US1-AS2; state_branch 1) ─────────────────────────────

  it('🚨 T006a-② 建仓视角同样走实时, 且两视角的窗**不是同一个** (各按自己的预测落带圈码)', async () => {
    await seedChain(NEAR_LEGS);
    readPort.respond = realtimeBatch();

    const rent = await retrieve(true, 'rent');
    const rentCodes = readPort.calls.flatMap((c) => c.contractCodes);
    readPort.calls.length = 0;
    const build = await retrieve(true, 'build');
    const buildCodes = readPort.calls.flatMap((c) => c.contractCodes);

    expect(rent?.chain.priceKind).toBe('realtime');
    expect(build?.chain.priceKind).toBe('realtime');
    // 🚨 判据落在**外呼出参**上而不是候选集: 窗是第一段的产物, 候选集是第二段判腿之后的东西 ——
    //    只比候选集的话, 差异会被第二段的门槛混进来, 分不清「窗不同」还是「判腿不同」。
    expect(rentCodes.length).toBeGreaterThan(0);
    expect(buildCodes.length).toBeGreaterThan(0);
    expect(new Set(buildCodes)).not.toEqual(new Set(rentCodes));
    // 本夹具下两窗**不相交**: 近月 DTE 24 只落建仓段, 远月 DTE 59 只落收租段。
    expect(rentCodes).not.toContain('N-90');
    expect(rentCodes).not.toContain('N-94');
    expect(buildCodes).not.toContain('X-88');
    expect(buildCodes).not.toContain('X-96');
  });

  // ── T006a-③ 报价覆盖对拍 (SC-005; state_branch 1) ──────────────────────────

  it('🚨 T006a-③ 报价覆盖对拍 (SC-005): 供应方返 M 条 ⇒ 带实时报价的腿恰好 M 条, 不多不少', async () => {
    await seedChain();

    // 第一趟: 全量回放 ⇒ 拿到「窗内 N 条全被应答」时的基线。
    readPort.respond = realtimeBatch();
    const full = await retrieve(true);
    const requested = readPort.calls.flatMap((c) => c.contractCodes);
    const fullCodes = (full?.candidates ?? []).map((c) => c.leg.code);

    // 第二趟: 同一夹具, 供应方**少返一条** (停牌 / 刚摘牌的形态) ⇒ M = N − 1。
    readPort.calls.length = 0;
    const dropped = requested[0];
    readPort.respond = (q) => ({
      asOf: REALTIME_AS_OF,
      rows: [
        underlyingRow('104.25'),
        ...q.contractCodes.filter((code) => code !== dropped).map((code) => optionRow(code)),
      ],
    });
    const partial = await retrieve(true);
    const partialCodes = (partial?.candidates ?? []).map((c) => c.leg.code);

    // 分母必须 > 1, 否则「少返一条」退化成「一条都没返」, 下面两条断言恒真。
    expect(requested.length).toBeGreaterThan(1);
    // 🚨 不少: 全应答时窗内每条都成行 —— 没有腿因为我们的取数方式凭空丢掉。
    expect(fullCodes).toHaveLength(requested.length);
    // 🚨 不多: 少返一条就正好少一行, 且少的**就是那一条** —— 没有凭空造出来的行。
    expect(partialCodes).toHaveLength(requested.length - 1);
    expect(partialCodes).not.toContain(dropped);
    expect(new Set(partialCodes)).toEqual(new Set(fullCodes.filter((c) => c !== dropped)));
    // 窄路径下缺行是**整条落下**而非落成收盘值 —— 混合口径是 064 蓄意杜绝的形态。
    for (const c of partial?.candidates ?? []) expect(c.leg.priceKind).toBe('realtime');
    // 逐行缺失是**行级**降级, 链级仍是实时 (值域蓄意排除 partial_miss)。
    expect(partial?.chain.priceKind).toBe('realtime');
    expect(partial?.chain.realtimeDegrade).toBeNull();
  });

  // ── T006a-④ 午休 (state_branch 2; FR-008) ──────────────────────────────────

  it('🚨 T006a-④ 港股午休 ⇒ 中性收盘档 + 零对外呼 + **零降级标** (天天发生的常态不是告警)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();
    // 供应方报非常规时段 (归一后的三态之一) —— 本 ctx 只见归一值, 不认 vendor 原始串。
    marketState.sessions = [{ market: 'hk', session: 'other' }];

    const result = await retrieve(true);

    expect(result?.chain.priceKind).toBe('eod_close');
    expect(readPort.calls).toHaveLength(0);
    // 🚨 这一条是本臂的全部价值: 午休每个交易日都发生, 标成降级 = 造一条永远为真的告警,
    //    于是真出事那天它也不再有人看。
    expect(result?.chain.realtimeDegrade).toBeNull();
  });

  // ── T006a-⑤ 半日市下午 (state_branch 5) ────────────────────────────────────

  it('🚨 T006a-⑤ 半日市下午 ⇒ 由**供应方状态**判非开市; 本地日历仍说今天是交易日, 闸不读半日标', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();
    marketState.sessions = [{ market: 'hk', session: 'other' }];

    const closed = await retrieve(true);

    expect(closed?.chain.priceKind).toBe('eod_close');
    expect(readPort.calls).toHaveLength(0);
    expect(closed?.chain.realtimeDegrade).toBeNull();

    // 🚨 差分才是判据: **同一份库状态**下把供应方状态翻回常规就走实时 ⇒ 关闸的确实是供应方
    //    那一闸, 而不是日历或别的什么。半日市在本地日历里仍是一条普通的交易日行 (plan §D3:
    //    实时闸只读日历的 trading / non-trading 二分, 从不读 session_kind)。
    readPort.calls.length = 0;
    marketState.sessions = [{ market: 'hk', session: 'regular' }];
    const open = await retrieve(true);
    expect(open?.chain.priceKind).toBe('realtime');
    expect(readPort.calls.length).toBeGreaterThan(0);
  });

  // ── T006a-⑥ 非交易日 (state_branch 4) ──────────────────────────────────────

  it('🚨 T006a-⑥ 日历判非交易日 ⇒ 零外呼, **即便供应方仍报常规时段** (两闸取交集的存在理由)', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();
    // 🚨 供应方**不**翻转 —— 节假日 / 周末里 vendor 报的时段状态未必跟着变, 少了日历闸就照样
    //    外呼。本臂驱动的是**日历**那一闸, 与 ④⑤ 的机制正交。
    marketState.sessions = [{ market: 'hk', session: 'regular' }];

    // 港股当地的**周六** 10:00 (= 同刻 UTC 02:00)。
    const saturday = new Date('2026-08-29T02:00:00.000Z');
    const result = await retrieve(true, 'rent', saturday);

    expect(result).not.toBeNull();
    expect(result?.chain.priceKind).toBe('eod_close');
    expect(readPort.calls).toHaveLength(0);
    // 非交易日是常态不是故障 ⇒ 恒零降级标 (与 gate_unknown / source_unavailable 那两条路分得开)。
    expect(result?.chain.realtimeDegrade).toBeNull();

    // 🚨 差分: 同一份库状态 + 同一个供应方状态, 只把时刻挪回**周一**就走实时
    //    ⇒ 关闸的确实是日历那一闸。
    readPort.calls.length = 0;
    const monday = await retrieve(true, 'rent', NOW);
    expect(monday?.chain.priceKind).toBe('realtime');
    expect(readPort.calls.length).toBeGreaterThan(0);
  });

  // ── T006a-⑦ 全腿视角 (state_branch 13) ─────────────────────────────────────

  it('🚨 T006a-⑦ 全腿视角 ⇒ 回落收盘档全量 + 零对外呼, 即使调用方开了实时', async () => {
    await seedChain();
    readPort.respond = realtimeBatch();

    const result = await retrieve(true, 'all');

    // 窄召回只服务单意图视角 (068 Q1 裁决), 其余形态 fail-closed 到收盘档。
    expect(result?.chain.priceKind).toBe('eod_close');
    expect(readPort.calls).toHaveLength(0);
    // 🚨 这不是降级 —— 全腿视角本就按收盘档全量呈现, 标降级等于告诉用户「出问题了」。
    expect(result?.chain.realtimeDegrade).toBeNull();
    // 「全量」= 收盘档那一路的成员判定照常出候选, 不是空表。
    expect(result?.candidates.length ?? 0).toBeGreaterThan(0);
  });

  // ══ T006b 空态 / 降级态 / 守卫 (FR-009 / FR-010 / FR-011 / FR-016) ═══════════════════════
  //
  // 🚨 本组的四个结局**两两可区分**是全部价值所在: 「规则内无腿」「没有挂牌期权」「实时不可用」
  //    「源不可用」在用户那里是四件事, 而它们都长成「这张表没给我实时价」。合并任意两个都不会红。

  // ── T006b-① 新锚首日无昨日面 ⇒ bootstrap 兜底窗 (state_branch 8; FR-002 落值的端到端判据) ──

  it('🚨 T006b-① 无昨日 Δ 面 ⇒ 走 bootstrap 矩形窗, 且窗**两侧**都按港股取值 (下界 0.6)', async () => {
    // 建合约但**不写昨日快照** = 盘中新建锚当天的形态 (建锚冷启动在连续竞价时段蓄意不写快照)。
    await seedChain(DEEP_OTM_LEGS, { snapshots: false });
    readPort.respond = realtimeBatch();

    const boot = await retrieve(true);
    const bootCodes = readPort.calls.flatMap((c) => c.contractCodes);

    expect(boot?.chain.priceKind).toBe('realtime');
    // 🚨 `D-70` (K/spot = 0.671) 只有港股那档下界 0.6 圈得进; 退回美股的 0.7 (= 72.98) 当场红。
    expect(bootCodes).toContain('D-70');
    // 🚨 「宁宽」不等于无边: `D-60` (0.576) 仍在窗外 —— 少了这条, 把下界改成 0 也能通过上一条。
    expect(bootCodes).not.toContain('D-60');
    // 兜底窗是**矩形**: 段内、界内的常规腿一条不落。
    expect(bootCodes).toEqual(expect.arrayContaining(['X-88', 'X-92', 'X-96']));

    // 🚨 差分: 同一批合约, 只要昨日面在, `D-70` 就**不该**被问 —— 它的昨日 |Δ| = 0.02 低于收租
    //    带下界 0.03, 梯形窗圈不到它。⇒ 上面那条确实是在验 bootstrap 那一支, 不是「反正都会问」。
    await resetSeededTables();
    await seedChain(DEEP_OTM_LEGS);
    readPort.calls.length = 0;
    const surfaced = await retrieve(true);
    const surfacedCodes = readPort.calls.flatMap((c) => c.contractCodes);
    expect(surfaced?.chain.priceKind).toBe('realtime');
    expect(surfacedCodes).not.toContain('D-70');
    expect(surfacedCodes).not.toContain('D-60');

    // 📌 EC3「兜底窗圈出的码数超单批上限」**不在本臂造夹具** —— T003 §3 已按 10 个 session ×
    //    22 只标的证明本样本期不可达 (最大 234 vs 上限 399, 余量 165), 结论转论证。
    //    🚫 那不等于「它不会发生」: 挂牌阶梯变密或下界再降都会改变它, 届时这里要补显式处置臂。
  });

  // ── T006b-② 窗内无腿 ⇒ 「规则内无腿」空态 (state_branch 9) ──────────────────

  it('🚨 T006b-② 窗内有码但无腿过判据 ⇒ 诚实空态 (非降级非错误), 且**答得出为什么空**', async () => {
    await seedChain();
    // 窗照常圈到码、供应方也照常应答, 但每条腿的买价都低于权利金门槛
    // (门槛 = max(spot×0.0018, 0.20) = 0.20 > 0.01) ⇒ 判腿这一段把它们全挡下。
    readPort.respond = (q) => ({
      asOf: REALTIME_AS_OF,
      rows: [
        underlyingRow('104.25'),
        ...q.contractCodes.map((code) => ({ ...optionRow(code), bid: '0.01', ask: '0.02' })),
      ],
    });

    const result = await retrieve(true);

    expect(result).not.toBeNull();
    // 🚨 空态**不是**降级也不是错误: 实时口径拿到了、只是规则内没有腿。
    expect(result?.chain.priceKind).toBe('realtime');
    expect(result?.chain.realtimeDegrade).toBeNull();
    expect(result?.candidates).toHaveLength(0);
    // 🚨 「为什么空」必须答得出来 —— 出参带着被哪一道门槛挡下、挡了几条; 一张没有理由的空表
    //    与「今天没采到数据」在用户那里长得一模一样。
    expect(result?.removedByPremiumFloor ?? 0).toBeGreaterThan(0);
    // arrange 守卫: 确实问过 vendor (否则空态是「压根没去问」造成的, 那是另一条分支)。
    expect(readPort.calls.flatMap((c) => c.contractCodes).length).toBeGreaterThan(0);
  });

  // ── T006b-③ 无挂牌期权的港股锚 (Edge Case 1) ───────────────────────────────

  it('🚨 T006b-③ 锚没有任何挂牌期权 ⇒ 既有终态、不抬告警, 且与「有期权但今天没采到」可区分', async () => {
    await seedChain([], { contracts: false });
    readPort.respond = realtimeBatch();

    const noChain = await retrieve(true);

    // 既有终态 = 无链可给 (本 port 的表达就是 `null`), 🚫 不是空候选集也不是降级态。
    expect(noChain).toBeNull();
    expect(readPort.calls).toHaveLength(0);
    // 🚨 不抬告警: 「这只票没有期权」是常态, 打降级留痕等于把一个正常形态报成故障。
    //    tag 取生产侧常量而不是抄一份字面量 —— 抄的那份改了不会红。
    const degradeWarns = warnSpy.mock.calls.filter((args: readonly unknown[]) =>
      String(args[0]).includes(REALTIME_DEGRADE_LOG_TAG),
    );
    expect(degradeWarns).toHaveLength(0);

    // 🚨 与「有期权但今天没采到」可区分: 后者**有链**(走 bootstrap 兜底窗), 不是 null。
    await resetSeededTables();
    await seedChain([], { snapshots: false });
    const notCollected = await retrieve(true);
    expect(notCollected).not.toBeNull();
    expect(notCollected?.chain.priceKind).toBe('realtime');
  });

  // ── T006b-④ 基准既不新鲜也补不到 ⇒ 「实时不可用」(state_branch 6) ───────────

  it('🚨 T006b-④ 定窗基准落空 ⇒ `window_basis_stale` 而**不是** `source_unavailable`', async () => {
    // 一级: 锚不带盘中价 ⇒ 新鲜度闸必不命中; 二级: 补发那一批里没有标的行 ⇒ 补不到。
    await seedChain([], { intradayAt: null });
    readPort.respond = () => ({ asOf: REALTIME_AS_OF, rows: [] });

    const result = await retrieve(true);

    expect(result?.chain.priceKind).toBe('eod_close');
    expect(result?.chain.realtimeDegrade).toBe('window_basis_stale');
    // 🚨 与源故障可区分 —— 两者对用户是两件事: 「我们的基准太旧」vs「供应方挂了」。
    expect(result?.chain.realtimeDegrade).not.toBe('source_unavailable');
    // 🚫 MUST NOT 拿昨收定窗: 落空就落空, 不许拿一根陈旧的轴硬算一个窗出来。
    const requestedCodes = readPort.calls.flatMap((c) => c.contractCodes);
    expect(requestedCodes).toHaveLength(0);
  });

  // ── T006b-⑤ 供应方取数失败 ⇒ 「源不可用」(state_branch 7) ───────────────────

  it('🚨 T006b-⑤ 供应方取数抛错 ⇒ 整体回落收盘档并标 `source_unavailable`', async () => {
    await seedChain();
    readPort.respond = () => {
      throw new Error('vendor 报价口不可达 (夹具)');
    };

    const result = await retrieve(true);

    expect(result?.chain.priceKind).toBe('eod_close');
    expect(result?.chain.realtimeDegrade).toBe('source_unavailable');
    expect(result?.chain.realtimeDegrade).not.toBe('window_basis_stale');
    // 真去问过 (与 ④ 的「零外呼」正好相反) —— 这一对差分把两条路彻底分开。
    expect(readPort.calls.length).toBeGreaterThan(0);
  });

  // ── T006b-⑦ 降级值域不扩张 (FR-010 机器判据) ───────────────────────────────

  it('🚨 T006b-⑦ 链级降级值域恒为四值 —— 「市场未支持」MUST NOT 升格成第五个状态', async () => {
    // 🚨 蓄意写成字面量而不是从常量派生: 本条是**绊线**, 谁加第五个值它就第一个红, 逼他先回去
    //    读 FR-010 (扩值域要连带动契约值域、四条穷举文案与前端的穷举映射)。
    expect([...REALTIME_CHAIN_DEGRADE_KINDS]).toEqual([
      'window_over_cap',
      'window_basis_stale',
      'source_unavailable',
      'gate_unknown',
    ]);
  });
});
