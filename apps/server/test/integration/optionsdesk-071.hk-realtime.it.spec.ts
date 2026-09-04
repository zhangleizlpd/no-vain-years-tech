import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { setupIsolatedStores } from '../_support/isolated-db';
import { AppModule } from '../../src/app/app.module';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { RECALL_CANDIDATE_CAP } from '../../src/optionsdesk/leg-recall.rules';
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

  /** 🚨 港股周一 10:00 (盘中) = 美股周日 22:00 (ET)。见文件头「时刻夹具怎么选的」。 */
  const NOW = new Date('2026-08-31T02:00:00.000Z');
  /** 港股当地日历日 —— 修好之后实时路径该用的那个。 */
  const HK_TODAY = '2026-08-31';
  /** 美股折算日 (周日) —— 病灶用的那个, 同时也是**离线路径至今仍在用**的那个 (Guardrail 1)。 */
  const US_TODAY = '2026-08-30';
  /** 昨日 Δ 面所在的交易日 = 上周五。 */
  const PREV_SESSION = '2026-08-28';

  const SYMBOL = 'hk:TCX';
  const UNDERLYING_CODE = 'HK.TCX';
  const EOD_SPOT = '100.0000';

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
    marketState.sessions = [{ market: 'hk', session: 'regular' }];
    await prisma.optionDailySnapshot.deleteMany();
    await prisma.optionContract.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.anchorChange.deleteMany();
    await prisma.anchor.deleteMany();
    await prisma.$executeRawUnsafe('TRUNCATE marketdata.trading_day RESTART IDENTITY CASCADE');
    await prisma.calendarCoverage.deleteMany();
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

  async function seedChain(extra: readonly SeedLeg[] = []): Promise<void> {
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
    for (const leg of [...LEGS, ...extra]) {
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
        },
        select: { id: true },
      });
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
        // 基准新鲜 (相对 NOW 只差 30s) ⇒ 三级基准链第一级命中, 不补发。
        intradayPrice: '104.25',
        intradayAt: new Date(NOW.getTime() - 30_000),
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

  // ── 臂③ 离线路径零变化 (FR-006; Guardrail 1 —— `:608` 本片禁改) ─────────────

  it('🚨 臂③ 离线路径的业务日基准**仍是美股折算日** —— `:608` 没被顺手一起改', async () => {
    await seedChain();

    const offline = await retrieve(false);

    expect(offline).not.toBeNull();
    // 🚨 反直觉但**刻意**: 离线那处换基准会改用户可见的腿集合 (plan §D1c), 归后续片。
    //    这一条把「只改了实时那一处」钉成机器判据 —— 顺手改了不会红, 只会让离线腿集合悄悄变。
    expect(offline?.chain.marketDate).toBe(US_TODAY);
    // 离线路径**零对外呼**。
    expect(readPort.calls).toHaveLength(0);
    expect(offline?.chain.priceKind).toBe('eod_close');
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
});
