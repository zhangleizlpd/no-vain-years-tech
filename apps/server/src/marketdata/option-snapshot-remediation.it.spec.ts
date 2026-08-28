import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { marketdataSyncConfig } from '../config/marketdata.config';
import { OptionSnapshotCoverageCheck } from './option-snapshot-coverage.check';
import { OptionSnapshotRemediation } from './option-snapshot-remediation';
import { SyncRunRecorder } from './sync-run.recorder';
import {
  SNAPSHOT_SOURCE_EOD,
  SNAPSHOT_SOURCE_PREMARKET_BACKFILL,
  SyncOptionSnapshotUseCase,
} from './sync-option-snapshot.usecase';
import type {
  OptionSnapshotBatch,
  OptionSnapshotPort,
  OptionSnapshotQuery,
  OptionSnapshotRow,
} from './option-snapshot.port';
import type { TradingCalendarPort } from './trading-calendar.port';
import type { TradingDayStatus } from './trading-day.rules';
import { stubTradingCalendar } from '../../test/_support/trading-calendar-stub';

/**
 * 两级补救的**写库路径** IT（Testcontainers PG），054 T005 / FR-011。
 *
 * ## 为什么必须存在
 *
 * 054 T001 之后 dev 上**彻底跑不了**这条路（`kind=mock` 的采集口一调即抛）——「拆东墙补西墙」
 * 是 spec Edge Cases 点名要补的那条。而 `marketdata` 目录此前只有 1 个 IT，
 * `option-snapshot-remediation.spec.ts` / `sync-option-snapshot.usecase.spec.ts` 都是 Small 档
 * 单测，不起容器、不碰真表。本文件是那条 dev 验证面唯一的替代。
 *
 * ## 🚨 断言的是**落库行**，不是返回值
 *
 * `RemediationOutcome` 全绿而 `source` 列写错照样全绿 —— 那正是本 feature 起因的同构失败
 * （行数对得上、日志全绿，灌进来的却是假行情）。故每条用例都读回 `option_daily_snapshot`
 * 的真实列值。
 *
 * ## 🚨 采集口是**测试内的 stub**，不经 `MockMarketDataAdapter`
 *
 * 本文件验的是「拿到数据之后写成什么样」，与 mock/refusing 的绑定选择正交（那条归 T001 的
 * boot IT + T003 的零写库 IT）。stub 直接扮演 live vendor ⇒ 这里跑的就是 **live 语义**下的
 * 来源标识行为（state_branch 5：live 任意写路径行为与来源标识零变化）。
 *
 * 直接 `new` 而不走 `Test.createTestingModule`：本文件的被测面是三个**普通 class** 的协作 +
 * 真 PG，不含任何 DI lifecycle 组件；范式同兄弟文件 `marketdata.snapshot-integrity.it.spec.ts`
 * （它同样直接 `new OptionSnapshotCoverageCheck(prisma, marketdataSyncConfig())`）。
 */

/**
 * ET 20:00（2026-08-12 周三）= ① 级 cron 的**真实时刻**（北京 08-13 08:00）⇒ us 业务日恒为
 * `2026-08-12`，且那一场早已收盘。
 *
 * 🚨 **不能取 ET 16:00 整**（本文件原值）：`isSessionUnderway` 的时段是**闭区间**
 * `[09:30, 16:00]`，而 `sessionWatermark` 的判据是 `>= 收盘`⇒ 恰好 16:00 那一分钟两者不一致，
 * 归属判据会给出 `skip`。取值方向是**保守侧**（宁可少采一轮也不写），故那不是缺陷；但拿它当
 * fixture 会让本组验的东西从「正常路径」变成「边界那一分钟」。
 */
const NOW = new Date('2026-08-13T00:00:00Z');
const TODAY = '2026-08-12';
/** `TODAY` 的上一交易日 —— ② 级要补的 session，同时是 `eod` 路径 `oi_as_of` 的取值。 */
const PREV = '2026-08-11';
/** 覆盖率判定的分母来源日。 */
const BASELINE = '2026-08-10';

/** vendor 原样合约 code（含市场前缀，与 `option_contract.code` 同口径）。 */
const CONTRACT_OK = 'US.PEP260918P130000';
/** 盘口交叉（bid > ask）⇒ 落库前硬门拒绝，用来造**批内部分失败**。 */
const CONTRACT_CROSSED = 'US.PEP260918P125000';
/** 标的自身那行的 code（spot 来源，与期权行同批回来）。 */
const UNDERLYING_CODE = 'US.PEP';
/** 远月到期，恒满足「到期日 ≥ 被判的那天」。 */
const EXPIRY = '2026-09-18';

const day = (s: string): Date => new Date(`${s}T00:00:00Z`);

/** 一行「干净」的期权快照（四条硬门全过：bid ≤ ask、PUT 的 Δ ≤ 0、|Δ| 合理、虚值无内在价值约束）。 */
const optionRow = (
  code: string,
  overrides: Partial<OptionSnapshotRow> = {},
): OptionSnapshotRow => ({
  code,
  isOption: true,
  underlyingCode: UNDERLYING_CODE,
  bid: '2.00',
  ask: '2.10',
  bidSize: '10',
  askSize: '12',
  last: '2.05',
  prevClose: '2.01',
  iv: '0.25000000',
  delta: '-0.45000000',
  gamma: '0.01000000',
  vega: '0.12000000',
  theta: '-0.03000000',
  rho: '-0.02000000',
  openInterest: '1234',
  netOpenInterest: '56',
  volume: '789',
  turnover: '161000.00',
  vendorUpdateTime: new Date('2026-08-12T19:59:00Z'),
  greeksComplete: true,
  ...overrides,
});

/** 标的自身那行（`isOption: false`），`last` 即 spot —— 135 > 130 ⇒ 两张 PUT 均为虚值。 */
const underlyingRow = (): OptionSnapshotRow => ({
  ...optionRow(UNDERLYING_CODE),
  isOption: false,
  underlyingCode: null,
  last: '135.00',
  greeksComplete: null,
});

/** 测试内 stub 采集口 —— 扮演 live vendor，返确定性数据并记账。 */
class StubOptionSnapshotPort implements OptionSnapshotPort {
  readonly calls: OptionSnapshotQuery[] = [];
  /** 这些 code 返回**盘口交叉**的行（bid > ask）⇒ 被硬门拒。 */
  crossed = new Set<string>();

  async getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch> {
    this.calls.push(query);
    return {
      asOf: new Date('2026-08-12T20:00:00Z'),
      rows: [
        underlyingRow(),
        ...query.contractCodes.map((code) =>
          this.crossed.has(code) ? optionRow(code, { bid: '9.00', ask: '2.10' }) : optionRow(code),
        ),
      ],
    };
  }
}

/** 交易日闸 stub —— 本文件的被测面不是日历，恒判交易日。 */
const alwaysTradingCalendar: TradingCalendarPort = {
  async classify(): Promise<TradingDayStatus> {
    return 'trading';
  },
  // 062 T010: 本文件不验陈旧度基准。
  async lastClosedSession(): Promise<string | null> {
    return null;
  },
};

describe('OptionSnapshotRemediation 写库路径 (Testcontainers PG, stub 采集口)', () => {
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let prisma: PrismaService;
  let port: StubOptionSnapshotPort;
  let remediation: OptionSnapshotRemediation;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.optionDailySnapshot.deleteMany();
    await prisma.optionContract.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.tradingDay.deleteMany();

    port = new StubOptionSnapshotPort();
    remediation = new OptionSnapshotRemediation(
      new OptionSnapshotCoverageCheck(prisma, marketdataSyncConfig()),
      new SyncOptionSnapshotUseCase(port, prisma, stubTradingCalendar()),
      prisma,
      alwaysTradingCalendar,
      new SyncRunRecorder(prisma),
    );
    // `oi_as_of` 的权威来源 —— 缺行会退到「最近工作日」近似值并抬 ERROR，那会让下面的
    // `oi_as_of` 断言变成在验兜底逻辑而不是验正常路径。
    // 🚨 #187 起 `TODAY` 那一行也必须在：① 级的归属日改由 `resolveSnapshotAttribution` 从
    //    `trading_day` 取「最近一个已收盘 session」⇒ 少了它，① 级会正确地判定「今天那一场还
    //    没进日历」并去补 `PREV`。那是本片**刻意**的新行为（日历滞后时与夜间轮对齐），不是
    //    缺陷；这里补上行，是因为本组要验的是**日历完整**时的正常路径。
    await prisma.tradingDay.createMany({
      data: [
        { market: 'us', date: day(PREV) },
        { market: 'us', date: day(TODAY) },
      ],
    });
  });

  /**
   * 造一票 + `codes` 张远月合约 + 一行 `baselineOn` 当天的快照（= 覆盖率判定的分母来源）。
   * 被判的那天没有行 ⇒ `evaluate` 判 degraded ⇒ 补救进采集分支。
   */
  async function seedGap(baselineOn: string, codes: string[]): Promise<void> {
    const instrument = await prisma.instrument.create({
      data: {
        market: 'us',
        code: 'PEP',
        name: 'PepsiCo',
        type: 'stock',
        currency: 'USD',
        status: 'active',
        needSync: true,
      },
    });
    for (const [i, code] of codes.entries()) {
      const contract = await prisma.optionContract.create({
        data: {
          market: 'us',
          code,
          root: 'PEP',
          underlyingInstrumentId: instrument.id,
          expiryDate: day(EXPIRY),
          strikePrice: 130 - i * 5,
          optionType: 'PUT',
          isStandard: true,
        },
      });
      await prisma.optionDailySnapshot.create({
        data: {
          contractId: contract.id,
          sessionDate: day(baselineOn),
          source: SNAPSHOT_SOURCE_EOD,
          quoteAsOf: day(baselineOn),
          oiAsOf: day(baselineOn),
          greeksComplete: true,
        },
      });
    }
  }

  /** 读回某一 session 的落库行（本文件全部断言的对象）。 */
  const rowsOn = (sessionDate: string) =>
    prisma.optionDailySnapshot.findMany({
      where: { sessionDate: day(sessionDate) },
      select: {
        source: true,
        oiAsOf: true,
        quoteAsOf: true,
        underlyingSpot: true,
        contract: { select: { code: true } },
      },
      orderBy: { contractId: 'asc' },
    });

  it('① 当日重试: 落库行 source = eod, oi_as_of = 上一交易日 (state_branch 5)', async () => {
    await seedGap(PREV, [CONTRACT_OK]);

    await remediation.retrySameDay('us', NOW);

    // 🚨 断言落库行, 不是 RemediationOutcome —— 返回值全绿而 source 写错照样全绿。
    const rows = await rowsOn(TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe(SNAPSHOT_SOURCE_EOD);
    expect(rows[0].contract.code).toBe(CONTRACT_OK);
    // 三个时点列各自取值 (Guardrail 6): oi_as_of 是**上一交易日**, 不是 session_date。
    // 全填 session_date 永远不会红, 但活跃度排名与 UI 的 asOf 全错一天。
    expect(rows[0].oiAsOf.toISOString().slice(0, 10)).toBe(PREV);
    expect(rows[0].quoteAsOf.toISOString()).toBe('2026-08-12T20:00:00.000Z');
    // spot 取标的自身那行的 last, 不是期权行的 (它俩同批回来, 取混了不会红)。
    expect(rows[0].underlyingSpot?.toString()).toBe('135');
    // 只重采缺的那票, 且确实打了端口。
    expect(port.calls).toEqual([{ underlyingSymbol: 'us:PEP', contractCodes: [CONTRACT_OK] }]);
  });

  it('② 盘前兜底: 落库行 source = premarket_backfill, 落在**被补的那天**', async () => {
    await seedGap(BASELINE, [CONTRACT_OK]);

    await remediation.backfillPremarket('us', NOW);

    // 补的是 PREV 那个 session, 不是 TODAY。
    expect(await rowsOn(TODAY)).toHaveLength(0);
    const rows = await rowsOn(PREV);
    expect(rows).toHaveLength(1);
    // 🚨 降级留痕的权威形态是**行状态**而非 log (FR-052): 只落 log 的话, 独立于 app 进程的
    // 探针根本看不见它。
    expect(rows[0].source).toBe(SNAPSHOT_SOURCE_PREMARKET_BACKFILL);
    // ② 级路径 oi_as_of = session_date 本身 (盘前窗 OI 已是被补那天的), 与 ① 级不同。
    expect(rows[0].oiAsOf.toISOString().slice(0, 10)).toBe(PREV);
  });

  it('批内部分失败: 硬门拒一行, **已落的另一行仍带正确来源标识** (state_branch 8)', async () => {
    await seedGap(PREV, [CONTRACT_OK, CONTRACT_CROSSED]);
    port.crossed.add(CONTRACT_CROSSED); // bid 9.00 > ask 2.10 ⇒ 盘口交叉, 落库前被拒

    await remediation.retrySameDay('us', NOW);

    const rows = await rowsOn(TODAY);
    // 一条脏行 MUST NOT 带走同批其余行 (整批回滚会丢掉当日唯一一次采集机会)。
    expect(rows).toHaveLength(1);
    expect(rows[0].contract.code).toBe(CONTRACT_OK);
    expect(rows[0].source).toBe(SNAPSHOT_SOURCE_EOD);
    // 两张合约同批请求过 —— 「只落了一行」是硬门拒的结果, 不是压根没请求。
    expect(port.calls[0].contractCodes).toEqual([CONTRACT_OK, CONTRACT_CROSSED]);
  });

  it('幂等: 同一 session 重跑第二遍不改写已落行 (唯一键挡掉)', async () => {
    await seedGap(PREV, [CONTRACT_OK]);
    await remediation.retrySameDay('us', NOW);
    const first = await rowsOn(TODAY);

    await remediation.retrySameDay('us', NOW);

    // 第二遍覆盖率已达标 ⇒ 零外呼 (端口调用数不增), 行也不该多出或被改写。
    expect(port.calls).toHaveLength(1);
    expect(await rowsOn(TODAY)).toEqual(first);
  });
});
