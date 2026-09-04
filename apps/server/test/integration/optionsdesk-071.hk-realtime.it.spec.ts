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

  /** 港股交易日历: 上周四五 + 本周一有行, 周末**无行**; 覆盖声明含整段 ⇒ 周末 = 确认非交易日。 */
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

  async function seedChain(): Promise<void> {
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
    for (const leg of LEGS) {
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
  ): Promise<LegRetrievalResult | null> {
    return moduleRef.get<LegRetrievalPort>(LEG_RETRIEVAL_PORT).retrieveCandidates({
      symbol: SYMBOL,
      now: NOW,
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
});
