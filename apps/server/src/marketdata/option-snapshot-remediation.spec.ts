import { Logger } from '@nestjs/common';
import { describe, it, expect, vi } from 'vitest';
import type { MarketdataSyncConfig } from '../config/marketdata.config.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../security/prisma.service.js';
import type { ExecutorInput, ExecutorSyncDimensionRow } from './dimension-executor.js';
import {
  OptionSnapshotCoverageCheck,
  type OptionCoverageReport,
  type UnderlyingCoverage,
} from './option-snapshot-coverage.check.js';
import { OptionSnapshotRemediation } from './option-snapshot-remediation.js';
import type {
  OptionSnapshotPort,
  OptionSnapshotQuery,
  OptionSnapshotRow,
} from './option-snapshot.port.js';
import { exchangeCalendarDate, sessionWatermark } from './session-clock.js';
import { resolveSnapshotAttribution } from './snapshot-session-attribution.rules.js';
import {
  emptyStats,
  type SyncRunOrigin,
  type SyncRunRecorder,
  type SyncRunStats,
  type SyncRunStatus,
} from './sync-run.recorder.js';
import { SyncOptionSnapshotUseCase } from './sync-option-snapshot.usecase.js';
import type { TradingCalendarPort } from './trading-calendar.port.js';
import { stubTradingCalendar } from '../../test/_support/trading-calendar-stub';

/**
 * 两级自动补救单测 (047 T022, Small —— mock port + mock prisma, 零容器)。
 *
 * 🚨 本文件盯的五条:
 * ① **一级成功不进二级**: 二级起手先复判, 达标即**零外呼** —— 盲写成「二级无条件重采」会每天
 *    白打一轮全链快照, 且给每天的数据都盖上「靠兜底续命」的痕
 * ② **二级成功不升 ERROR, 但 MUST 留痕 + 告警** (FR-052): 「一直靠兜底续命」被静默掉, 与
 *    「没有兜底」一样危险
 * ③ **留痕形态是可被 SQL 读到的行状态**, **不是只落 log** —— T025a 那条独立进程的探针不读 app
 *    的 log。⚠️ 载体**按市场分**: OI 隔日翻新的市场 (us) 靠行的 `source = premarket_backfill`;
 *    OI 当晚定稿的市场 (hk) 的行落 `source = eod` (换回唯一键去重), 痕改由
 *    `sync_run.triggered_by` 承载 —— 同样是落库行, 且不参与唯一键 (2026-08-31 收口)
 * ④ **补采行 `oi_as_of = session_date`**, 与正常路径的「上一交易日」**方向相反** (Guardrail 6):
 *    盘前 OI 已翻新, 正是被补那天的真值。抄成一样不会红, 但两条路径产出的 OI 差一天
 * ⑤ **两级都失败才升 ERROR** (FR-046), 且非交易日两级都不跑 —— 周末照跑会把「今天本来就没有
 *    session」读成整批缺失
 */

/** 库内 us 交易日历 (周末不在表内)。 */
const TRADING_DAYS = ['2026-06-11', '2026-06-12', '2026-06-15', '2026-06-16'];

/** 被补的交易日 = 周一 06-15; 其上一交易日 = 上周五 06-12。 */
const SESSION = '2026-06-15';
const PREV_SESSION = '2026-06-12';

/** 北京 08:00 周二 = ET 周一 20:00 ⇒ us 业务日仍是**周一** (当日重试的时刻)。 */
const SAME_DAY_RETRY_AT = new Date('2026-06-16T00:00:00Z');
/** 北京 18:00 周二 = ET 周二 06:00 (盘前窗内) ⇒ 待补的是上一交易日周一。 */
const PREMARKET_AT = new Date('2026-06-16T10:00:00Z');
/** 北京 18:00 周六 = ET 周六 06:00 ⇒ 非交易日。 */
const WEEKEND_AT = new Date('2026-06-20T10:00:00Z');

const PEP_CONTRACT_CODE = 'US.PEP260717P130000';

/** 港股 ① 级的时刻: 23:40 HKT 周一 = 15:40 UTC ⇒ 仍在**同一港股日历日**内 (#255)。 */
const HK_SAME_DAY_RETRY_AT = new Date('2026-06-15T15:40:00Z');

/** 港股 ② 级的时刻: 08:30 HKT 周二 = 00:30 UTC ⇒ 港股当地已跨日, 待补的是上一交易日周一。 */
const HK_PREMARKET_AT = new Date('2026-06-16T00:30:00Z');

const day = (s: string): Date => new Date(`${s}T00:00:00Z`);

/** 一票的覆盖率明细 (补救侧只消费 instrumentId + symbol)。 */
function shortfall(): UnderlyingCoverage {
  return {
    instrumentId: 1n,
    symbol: 'us:PEP',
    expected: 2,
    covered: 1,
    missingContractCodes: [PEP_CONTRACT_CODE],
    degraded: true,
  };
}

function report(
  status: 'no_subject' | 'ok' | 'degraded',
  sessionDate = SESSION,
): OptionCoverageReport {
  const degraded = status === 'degraded' ? [shortfall()] : [];
  return {
    market: 'us',
    sessionDate,
    baselineDate: PREV_SESSION,
    threshold: 1,
    status,
    expected: 2,
    covered: status === 'degraded' ? 1 : 2,
    underlyings: degraded,
    degraded,
  };
}

/** 港股档的覆盖率明细 —— `symbol` 决定 `toWorkingInstrument` 反解出来的 market。 */
function hkReport(status: 'ok' | 'degraded'): OptionCoverageReport {
  const degraded =
    status === 'degraded'
      ? [
          {
            instrumentId: 7n,
            symbol: 'hk:00700',
            expected: 2,
            covered: 1,
            missingContractCodes: ['HK.TCH260929P630000'],
            degraded: true,
          },
        ]
      : [];
  return {
    market: 'hk',
    sessionDate: SESSION,
    baselineDate: PREV_SESSION,
    threshold: 1,
    status,
    expected: 2,
    covered: status === 'degraded' ? 1 : 2,
    underlyings: degraded,
    degraded,
  };
}

/** 补救轮自己开的那一行 `SyncRun` —— 开 (start) 与收 (finish) 合成一条便于断言。 */
interface RecordedRun {
  syncType: string;
  origin: SyncRunOrigin;
  status?: SyncRunStatus;
  stats?: SyncRunStats;
}

interface Harness {
  remediation: OptionSnapshotRemediation;
  useCase: SyncOptionSnapshotUseCase;
  /** vendor 侧每一次请求 (「零外呼」只有数请求次数才证得了)。 */
  queries: OptionSnapshotQuery[];
  /** 落库行 (source / oi_as_of 的 SQL 可查性就靠它)。 */
  persisted: Record<string, unknown>[];
  evaluate: ReturnType<typeof vi.fn>;
  /** 日历闸**问的是哪个市场** (#255) —— 不记下来就断言不了「按 hk 问」。 */
  classifyCalls: [string, string][];
  /**
   * 补救轮落的 `SyncRun` 行。**「零外呼」的对偶断言在这里**: 不缺就不该开行, 缺了才开一行
   * 并把 findings 收进去 (#261 续 —— 此前补救轮在库里完全不存在)。
   */
  runs: RecordedRun[];
}

/**
 * @param verdicts `coverage.evaluate` 的**逐次**返回 (第一次 = 补救前判定, 第二次 = 重采后复判)
 * @param tradingDays 库内交易日历 (缺 `SESSION` 之前的行 → 二级无法定位待补日)
 * @param underlyingLast 标的 spot。默认 `128.40` 让 K=130 的 PUT 是浅实值 ⇒ 硬门放行;
 *        调低到深实值区间即可让 `ask_below_intrinsic` 整批拒掉 (见 {@link underlyingRow})
 */
function makeHarness(
  verdicts: OptionCoverageReport[],
  tradingDays = TRADING_DAYS,
  underlyingLast = '128.40',
  /** 既往轮被落库前硬门拒掉的合约码 (喂 `sync_run.findings`) —— 假修复闸的判别器输入。 */
  priorRejected: readonly string[] = [],
  /** 端点是否返闭市形态 (两侧盘口 `null`), 见 {@link quoteRow}。 */
  quoteless = false,
): Harness {
  const queries: OptionSnapshotQuery[] = [];
  const persisted: Record<string, unknown>[] = [];
  const runs: RecordedRun[] = [];

  const port: OptionSnapshotPort = {
    getSnapshots: vi.fn(async (q: OptionSnapshotQuery) => {
      queries.push({ ...q, contractCodes: [...q.contractCodes] });
      const rows: OptionSnapshotRow[] = q.contractCodes.map((code) => quoteRow(code, quoteless));
      rows.push(underlyingRow(underlyingLast));
      return { asOf: new Date('2026-06-16T10:02:11Z'), rows };
    }),
  };

  // 🚨 深拷 `findings`: 被测方法收尾之后仍持有同一个 stats 对象, 存引用等于让断言看后续状态。
  const recorder = {
    start: vi.fn(async (syncType: string, origin: SyncRunOrigin = {}) => {
      runs.push({ syncType, origin });
      return BigInt(runs.length);
    }),
    finish: vi.fn(async (id: bigint, status: SyncRunStatus, stats: SyncRunStats) => {
      const run = runs[Number(id) - 1];
      run.status = status;
      run.stats = { ...stats, findings: [...stats.findings] };
    }),
  } as unknown as SyncRunRecorder;

  const prisma = {
    optionContract: {
      findMany: vi.fn(async () => [
        {
          id: 11n,
          code: PEP_CONTRACT_CODE,
          optionType: 'PUT',
          strikePrice: new Prisma.Decimal('130'),
          // 🚨 缺这一格时门 ④ (无套利下界) **整条跳过** (#186 对非标合约的豁免), 于是
          //    「深实值腿被拒」那条用例怎么调 spot 都拒不掉 —— 静默地测了个寂寞。
          isStandard: true,
        },
      ]),
    },
    optionDailySnapshot: {
      createMany: vi.fn(async (args: { data: Record<string, unknown>[] }) => {
        persisted.push(...args.data);
        return { count: args.data.length };
      }),
    },
    tradingDay: {
      // 「早于 X 的最近一个交易日」—— use case 取 oi_as_of 与补救取待补日共用这一条查询。
      // #181 起还多一种问法「≤ 上界的最近一个交易日」(归属判据)，两者 MUST 分辨：
      // 混作一谈会让 session_date 整体偏一天，而**测试照样绿**。
      findFirst: vi.fn(async (args: { where: { date: { lt?: Date; lte?: Date } } }) => {
        if (args.where.date.lte !== undefined) {
          const upTo = args.where.date.lte.toISOString().slice(0, 10);
          const closed = tradingDays.filter((d) => d <= upTo).at(-1);
          return closed === undefined ? null : { date: day(closed) };
        }
        const before = (args.where.date.lt as Date).toISOString().slice(0, 10);
        const prev = tradingDays.filter((d) => d < before).at(-1);
        return prev === undefined ? null : { date: day(prev) };
      }),
      // #181 归属判据要今天的 session 形态；本片不测半日市，恒 `whole`。
      findUnique: vi.fn(async () => ({ sessionKind: 'whole' })),
    },
    // 既往轮的 findings —— ② 级据此分辨「没采到」与「采到了被硬门拒」(2026-08-31 A′)。
    syncRun: {
      findMany: vi.fn(async () =>
        priorRejected.length === 0
          ? []
          : [
              {
                findings: [
                  {
                    kind: 'reject',
                    symbol: 'us:PEP',
                    step: 'option_snapshot_guard',
                    rejected: priorRejected.length,
                    contracts: [...priorRejected],
                    violations: ['ask_below_intrinsic'],
                    violationSamples: [`${priorRejected[0]}: ask 低于无套利下界`],
                  },
                ],
              },
            ],
      ),
    },
  } as unknown as PrismaService;

  const classifyCalls: [string, string][] = [];
  const calendar: TradingCalendarPort = {
    classify: async (market: string, date: string) => {
      classifyCalls.push([market, date]);
      return tradingDays.includes(date) ? 'trading' : 'non-trading';
    },
    // 062 T010: 本文件不验陈旧度基准 (那条归 optionsdesk-062.calendar IT)。
    lastClosedSession: async () => null,
    previousTradingDay: async () => null,
  };

  const coverage = new OptionSnapshotCoverageCheck(prisma, {
    optionCoverageThreshold: 1,
  } as unknown as MarketdataSyncConfig);
  // 🚨 只把**读库那半段**换成剧本: `alertIfDegraded` 走真实现 —— 「升不升 ERROR」是本文件的
  // 被测面, 换成 spy 就只能断言「调了那个方法」而不是「真的响了」。
  const evaluate = vi.fn(async () => verdicts.shift() ?? report('ok'));
  vi.spyOn(coverage, 'evaluate').mockImplementation(evaluate);

  const useCase = new SyncOptionSnapshotUseCase(port, prisma, stubTradingCalendar());
  return {
    remediation: new OptionSnapshotRemediation(coverage, useCase, prisma, calendar, recorder),
    useCase,
    queries,
    persisted,
    evaluate,
    classifyCalls,
    runs,
  };
}

/**
 * @param quoteless 闭市形态: 做市商全撤单 ⇒ 端点两侧盘口都返 `null`。门 ① / ④ 于是**判不动**,
 *        而不是「判了且过了」—— 假修复闸盯的就是这个差别。
 */
function quoteRow(code: string, quoteless = false): OptionSnapshotRow {
  return {
    code,
    isOption: true,
    underlyingCode: 'US.PEP',
    bid: quoteless ? null : '2.30',
    ask: quoteless ? null : '2.40',
    bidSize: quoteless ? null : '45',
    askSize: quoteless ? null : '60',
    last: '2.35',
    prevClose: '2.28',
    iv: '21.4',
    delta: '-0.31',
    gamma: '0.041',
    vega: '0.092',
    theta: '-0.058',
    rho: '0.011',
    openInterest: '3120',
    netOpenInterest: '-410',
    volume: '1204',
    turnover: '283940',
    vendorUpdateTime: new Date('2026-06-15T20:00:00Z'),
    greeksComplete: true,
  };
}

/**
 * 标的自身那行 (spot 的来源, 与期权行同批返回)。
 *
 * 🚨 `last` 蓄意取 **128.40 < K 130** —— 落库前硬门用 spot 算内在价值, 抄成期权价 (2.35) 会让
 * 这批 PUT 变成深实值腿而被 `ask_below_intrinsic` 整批拒掉, 于是「补救到底落没落库」这件事根本
 * 走不到 (本文件第一版实撞)。
 */
function underlyingRow(last = '128.40'): OptionSnapshotRow {
  return {
    ...quoteRow('US.PEP'),
    isOption: false,
    underlyingCode: null,
    bid: null,
    ask: null,
    last,
    delta: null,
    greeksComplete: null,
  };
}

const spyLog = (level: 'error' | 'warn'): ReturnType<typeof vi.spyOn> =>
  vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);

describe('OptionSnapshotRemediation', () => {
  describe('① 当日重试', () => {
    it('覆盖率达标 → 零外呼、零落库 (正常日不该有任何补救动作)', async () => {
      const h = makeHarness([report('ok')]);

      const outcome = await h.remediation.retrySameDay('us', SAME_DAY_RETRY_AT);

      expect(outcome).toMatchObject({ status: 'not_needed', sessionDate: SESSION });
      expect(h.queries).toHaveLength(0);
      expect(h.persisted).toHaveLength(0);
    });

    it('缺失 → 只重采**缺的那几票**并补回 ⇒ 不升 ERROR, 且落的是正常 eod 行', async () => {
      const h = makeHarness([report('degraded'), report('ok')]);
      const err = spyLog('error');

      const outcome = await h.remediation.retrySameDay('us', SAME_DAY_RETRY_AT);

      expect(outcome).toMatchObject({ status: 'recovered', attempted: ['us:PEP'] });
      expect(h.queries.map((q) => q.underlyingSymbol)).toEqual(['us:PEP']);
      // 一级补的是**当日**这条正常路径: source 仍是 eod, oi_as_of 仍是上一交易日。
      expect(h.persisted[0]).toMatchObject({
        source: 'eod',
        sessionDate: day(SESSION),
        oiAsOf: day(PREV_SESSION),
      });
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('重采后仍缺 → **不**升 ERROR (还有二级), 只 WARN 挂着', async () => {
      const h = makeHarness([report('degraded'), report('degraded')]);
      const err = spyLog('error');
      const warn = spyLog('warn');

      const outcome = await h.remediation.retrySameDay('us', SAME_DAY_RETRY_AT);

      expect(outcome.status).toBe('still_missing');
      // FR-046: 两级都失败**才**升 ERROR —— 一级就响会把每次 vendor 抖动都变成红。
      expect(err).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      err.mockRestore();
      warn.mockRestore();
    });
  });

  /**
   * 补救轮的 `SyncRun` 留痕 (#261 续)。
   *
   * 🚨 修之前**三层全空**: ① 本方法不开 SyncRun 行 ⇒ `stats.findings` 落不了库 (唯一通道是
   * `recorder.finish`); ② 那条兜底 WARN 的条件是 `failed > 0`, 而硬门拒绝**蓄意不计 failed**
   * ⇒ 连 WARN 都不打; ③ `RemediationOutcome` 被 @Cron handler 直接 await 掉, 无人接收。
   * 2026-08-28 实证: 08:00 那轮 us ① 级把 1110 行按美股语义写进港股 (#255), 而 `sync_run` 里
   * **查无此轮** —— 唯一能证明它发生过的东西是那批行自己的 `quote_as_of`。
   */
  describe('SyncRun 留痕', () => {
    it('覆盖率达标 → **不开** SyncRun 行 (零外呼的对偶: 什么都没做就不该留一行)', async () => {
      const h = makeHarness([report('ok')]);

      await h.remediation.retrySameDay('us', SAME_DAY_RETRY_AT);

      expect(h.runs).toHaveLength(0);
    });

    it('① 级重采 → 开一行与夜链**同名**的 SyncRun, 靠 triggered_by 分辨', async () => {
      const h = makeHarness([report('degraded'), report('ok')]);

      await h.remediation.retrySameDay('us', SAME_DAY_RETRY_AT);

      expect(h.runs).toHaveLength(1);
      expect(h.runs[0]).toMatchObject({
        // 🚨 与 tick 轮同名 ⇒ 同一维度的历史串成一条线, 不被拆进两个互相看不见的 sync_type。
        syncType: 'sync:option_daily_snapshot',
        origin: { triggeredBy: 'same_day_retry', asOf: SESSION },
      });
    });

    it('② 级重采 → triggered_by = premarket_backfill (两级 MUST 分得开, 别按时刻反推)', async () => {
      const h = makeHarness([report('degraded'), report('ok')]);
      const warn = spyLog('warn');

      await h.remediation.backfillPremarket('us', PREMARKET_AT);
      warn.mockRestore();

      expect(h.runs.map((r) => r.origin.triggeredBy)).toEqual(['premarket_backfill']);
    });

    it('hk ① 级 → 记在**港股自己**的维度键下, 不挂到美股名下', async () => {
      const h = makeHarness([hkReport('degraded'), hkReport('ok')]);
      const warn = spyLog('warn');

      await h.remediation.retrySameDay('hk', HK_SAME_DAY_RETRY_AT);
      warn.mockRestore();

      expect(h.runs.map((r) => r.syncType)).toEqual(['sync:hk_option_daily_snapshot']);
    });

    it('🚨 硬门拒绝 → 带数字的 violationSamples 随本行进库 (此前只进容器 stdout, 部署即滚)', async () => {
      // spot 78.21 ⇒ K=130 的 PUT 内在价值 51.79, 而 fixture 的 ask=2.40 远在下界之下
      // ⇒ 整批撞 `ask_below_intrinsic`, 与 #261 那四张腾讯深实值 PUT 同形。
      const h = makeHarness([report('degraded'), report('degraded')], TRADING_DAYS, '78.21');
      const err = spyLog('error');
      const warn = spyLog('warn');

      await h.remediation.retrySameDay('us', SAME_DAY_RETRY_AT);
      // 先 restore 再断言 —— 断言失败时的输出不该被这两个 spy 吞掉。
      err.mockRestore();
      warn.mockRestore();

      expect(h.persisted).toHaveLength(0); // 拒了就不入库
      const entry = h.runs[0]?.stats?.findings.find((f) => f.kind === 'reject');
      expect(entry).toBeDefined();
      expect(entry).toMatchObject({ symbol: 'us:PEP', violations: ['ask_below_intrinsic'] });
      // 🚨 本条的**全部价值**: 那两个数字必须跟着这一行进库。判据钉在 fixture 决定的 ask 与
      //    内在价值上, **蓄意不钉容差** —— #261 的收敛方向之一就是改容差 (同 #264 单测)。
      const samples = (entry as { violationSamples: string[] }).violationSamples;
      expect(samples).toHaveLength(1);
      expect(samples[0]).toContain('2.4');
      expect(samples[0]).toContain('51.79');
      // 🚨 拒绝**不计 failed** ⇒ 本行终态仍是 `success`。这正是「看 status 判不出问题、
      //    必须看 findings」的由来 —— 也正是这一行不能不写的理由。
      expect(h.runs[0]?.status).toBe('success');
    });
  });

  describe('② 次日盘前兜底', () => {
    it('🚨 一级已补回 → 二级复判达标 ⇒ **零外呼**, 不留降级痕', async () => {
      const h = makeHarness([report('ok')]);

      const outcome = await h.remediation.backfillPremarket('us', PREMARKET_AT);

      expect(outcome).toMatchObject({ status: 'not_needed', sessionDate: SESSION });
      expect(h.queries).toHaveLength(0);
      expect(h.persisted).toHaveLength(0);
    });

    it('🚨 二级补回 → 不升 ERROR, 但**留痕 (SQL 可查的行状态) + 告警**', async () => {
      const h = makeHarness([report('degraded'), report('ok')]);
      const err = spyLog('error');
      const warn = spyLog('warn');

      const outcome = await h.remediation.backfillPremarket('us', PREMARKET_AT);

      expect(outcome).toMatchObject({ status: 'recovered', sessionDate: SESSION });
      // 留痕形态 = 行状态本身 (T025a 的独立进程读 SQL, 读不到 app 的 log)。
      expect(h.persisted[0]).toMatchObject({
        source: 'premarket_backfill',
        sessionDate: day(SESSION),
        // 🚨 Guardrail 6 反向: 盘前 OI 已翻新 ⇒ 正是**被补那天**的真值。
        oiAsOf: day(SESSION),
      });
      // 降级 MUST 告警 (FR-052「一直靠兜底续命」不许静默), 但**不是** ERROR。
      expect(err).not.toHaveBeenCalled();
      expect(String(warn.mock.calls.at(-1)?.[0])).toContain('premarket_backfill');
      err.mockRestore();
      warn.mockRestore();
    });

    it('🚨 假修复闸: 上一轮被硬门拒的腿, 这一轮只拿到「门没判成」的行 ⇒ 覆盖率达标也不算修复', async () => {
      // prod 2026-08-28 场实撞的形态: hk:00700 两条深实值 PUT 撞 `ask_below_intrinsic` 被拒 ⇒
      // 判该票未完整 ⇒ ② 级 08:30 盘前重采, 而港股 09:00 才竞价 ⇒ ask 全为 null ⇒ 门 ④ **根本
      // 没跑** ⇒ 零违规 ⇒ 行落库 ⇒ 覆盖率数字达标 ⇒ 判「补回了」, ERROR 被吞成 WARN。
      // 而那批行的 greeks 是 vendor 无盘口时退化用陈旧 `last` 反解的, 比缺着还坏。
      const h = makeHarness(
        [report('degraded'), report('ok')], // ← 复判说"达标"
        TRADING_DAYS,
        '128.40',
        [PEP_CONTRACT_CODE], // ← 上一轮该合约是**被拒**, 不是没采到
        true, // ← 闭市: 端点两侧盘口都返 null
      );
      const err = spyLog('error');
      const warn = spyLog('warn');

      const outcome = await h.remediation.backfillPremarket('us', PREMARKET_AT);
      warn.mockRestore();

      // 🚨 覆盖率说达标, 本级仍判未修复 —— 判别器是「上一轮被拒 ∧ 本轮没判成」的交集。
      expect(outcome.status).toBe('still_missing');
      expect(String(err.mock.calls.at(-1)?.[0])).toContain('假修复');
      expect(String(err.mock.calls.at(-1)?.[0])).toContain(PEP_CONTRACT_CODE);
      err.mockRestore();
    });

    it('🚨 假修复闸 MUST NOT 恒红: 上一轮**没采到**(非被拒) ⇒ 无盘口行照样算补回', async () => {
      // 这条是上一条的对偶, 也是这个闸唯一的失败模式: 港股闭市七成腿的门 ①/④ 本就判不动,
      // 若判据退化成「本轮有任何 unjudged 行就判失败」, hk 会**天天红**。
      // hk 2026-08-24/25/26 就是这个形态: eod 轮整场零行, 兜底写的 2200 行里七成无盘口 ——
      // 那时任何数据都好过没有, MUST 判 recovered。
      const h = makeHarness(
        [report('degraded'), report('ok')],
        TRADING_DAYS,
        '128.40',
        [], // ← 既往轮**没有** reject 记录 ⇒ 是「没采到」不是「被拒」
        true, // ← 同样闭市无盘口
      );
      const err = spyLog('error');
      const warn = spyLog('warn');

      const outcome = await h.remediation.backfillPremarket('us', PREMARKET_AT);
      warn.mockRestore();

      expect(outcome.status).toBe('recovered');
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('🚨 假修复闸 MUST NOT 误伤真修复: 上一轮被拒但这一轮**判过了且过了** ⇒ 算补回', async () => {
      // us ② 级跑在 ET 盘前窗内, 那时**有真报价** ⇒ 被拒的腿可能这一轮就合规了。
      const h = makeHarness(
        [report('degraded'), report('ok')],
        TRADING_DAYS,
        '128.40',
        [PEP_CONTRACT_CODE], // ← 上一轮被拒
        false, // ← 但这一轮有盘口 ⇒ 门 ④ 真判过且过了
      );
      const err = spyLog('error');
      const warn = spyLog('warn');

      const outcome = await h.remediation.backfillPremarket('us', PREMARKET_AT);
      warn.mockRestore();

      expect(outcome.status).toBe('recovered');
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('🚨 两级都失败 → 升 ERROR 且**指明哪一票哪一天**', async () => {
      const h = makeHarness([report('degraded'), report('degraded')]);
      const err = spyLog('error');

      const outcome = await h.remediation.backfillPremarket('us', PREMARKET_AT);

      expect(outcome).toMatchObject({ status: 'still_missing', stillMissing: ['us:PEP'] });
      const logged = err.mock.calls.map((c: unknown[]) => String(c[0])).join(' | ');
      expect(logged).toContain('us:PEP');
      expect(logged).toContain(SESSION);
      err.mockRestore();
    });

    it('日历缺「上一交易日」行 → blocked + ERROR, **不猜日子** (猜错=脏 session_date)', async () => {
      const h = makeHarness([report('degraded')], ['2026-06-16']);
      const err = spyLog('error');

      const outcome = await h.remediation.backfillPremarket('us', PREMARKET_AT);

      expect(outcome).toMatchObject({ status: 'blocked', sessionDate: null });
      expect(h.queries).toHaveLength(0);
      expect(err).toHaveBeenCalled();
      err.mockRestore();
    });
  });

  describe('🚨 非交易日两级都不跑 (假阳性守卫)', () => {
    it('周六 → 零判定、零外呼 (当日本就没有 session, 照跑会读成整批缺失)', async () => {
      const h = makeHarness([report('degraded'), report('degraded')]);

      const same = await h.remediation.retrySameDay('us', WEEKEND_AT);
      const premarket = await h.remediation.backfillPremarket('us', WEEKEND_AT);

      expect(same.status).toBe('not_needed');
      expect(premarket.status).toBe('not_needed');
      expect(h.evaluate).not.toHaveBeenCalled();
      expect(h.queries).toHaveLength(0);
    });
  });

  /**
   * 🚨 **两级喂给 `collect` 的归属声明必须与判据层在同一时点逐字相同** (#187, 原住
   * `anchor-cold-start.rules.spec.ts`)。这里跑的是**真的** `OptionSnapshotRemediation`, 不是
   * 它的算法副本 —— 两级各钉一件不同的事:
   *
   * · ① 级 —— 它**就是**判据层的产物, 本条钉的是「原样转发、不在调用点重算任何一格」;
   * · ② 级 —— 它的 `mode` 是**自己硬编码**的留痕载体 (见该方法注释: 判据层在日历 `unknown`
   *   那天会给 `eod`, 恰恰是最需要留痕的日子)。本条钉的是「手写的那两格在该时点与判据层等值」
   *   —— 哪天两侧的时点归属被改动, 它立刻红。
   */
  describe('两级的归属声明 vs 判据层 —— 等值回归', () => {
    /** 判据层在给定时刻应给出的 spec（日历事实取自本 harness 同一份 `TRADING_DAYS`）。 */
    function expectedSpec(now: Date) {
      const today = exchangeCalendarDate('us', now);
      const target = TRADING_DAYS.filter((d) => d <= sessionWatermark('us', now, 'whole')).at(-1);
      const decision = resolveSnapshotAttribution({
        market: 'us',
        now,
        lastClosedTradingDay: target ?? null,
        todayIsTradingDay: TRADING_DAYS.includes(today),
        tradingDayBeforeTarget:
          target === undefined ? null : (TRADING_DAYS.filter((d) => d < target).at(-1) ?? null),
        todayKind: 'whole',
      });
      if (decision.decision !== 'collect') throw new Error('unreachable');
      return decision;
    }

    it('① 当日重试 ⇒ spec 原样来自判据层 (eod / 最近一个已收盘 session)', async () => {
      const h = makeHarness([report('degraded'), report('ok')]);
      const collect = vi.spyOn(h.useCase, 'collect');

      await h.remediation.retrySameDay('us', SAME_DAY_RETRY_AT);

      const expected = expectedSpec(SAME_DAY_RETRY_AT);
      expect(collect).toHaveBeenCalledTimes(1);
      expect(collect.mock.calls[0][1]).toEqual(expected.spec);
      // ① 级的 oi_as_of 由 collect 自己取 session_date 的上一交易日 (Guardrail 6)。
      expect(expected.oiAsOf).toBe(PREV_SESSION);
      // `now` 是**同一个 Date 实例**穿过去的 —— 谁在调用点重新 new 一个, 这条立刻红。
      expect(collect.mock.calls[0][1].now).toBe(SAME_DAY_RETRY_AT);
    });

    it('② 盘前兜底 ⇒ 手写的 sessionDate / mode 与判据层在该时点等值 (premarket_backfill / 上一交易日)', async () => {
      const h = makeHarness([report('degraded'), report('ok')]);
      const collect = vi.spyOn(h.useCase, 'collect');

      await h.remediation.backfillPremarket('us', PREMARKET_AT);

      const expected = expectedSpec(PREMARKET_AT);
      expect(collect).toHaveBeenCalledTimes(1);
      // 📌 `unjudgedWatch` **不属于归属语义** —— 它是留痕参数 (点名盯哪几个合约的门没判成),
      //    与 `session_date` / `source` / `oi_as_of` 三个时点列无关。剔出后仍做**等值**回归
      //    (不是 `toMatchObject`), 这样归属三元组多一格 / 少一格照旧当场红。
      const { unjudgedWatch, ...attributionSpec } = collect.mock.calls[0][1];
      expect(attributionSpec).toEqual(expected.spec);
      expect(unjudgedWatch).toEqual([]);
      // ② 级的 oi_as_of **= session_date** (盘前 OI 已翻新), 与 ① 级差一天且 MUST NOT 抹平。
      expect(expected.oiAsOf).toBe(SESSION);
    });
  });

  // #255: 本片此前写死 `US_MARKET_SCOPE = ['us']`, 而覆盖率判据又不带市场谓词 ⇒ 港股票混进
  // 美股补救的分母, 被拿 `marketScope: ['us']` 重采并按美股归属语义写库。
  describe('🚨 按市场分派 (#255)', () => {
    it('hk ① 级: 归属按港股自己的清算行为算 ⇒ oi_as_of = session_date, 与 us 方向相反', async () => {
      const h = makeHarness([hkReport('degraded'), hkReport('ok')]);
      const warn = spyLog('warn');

      const outcome = await h.remediation.retrySameDay('hk', HK_SAME_DAY_RETRY_AT);
      warn.mockRestore();

      expect(outcome.market).toBe('hk');
      expect(outcome.status).toBe('recovered');
      // 🚨 本条测试的全部价值: 同一档 (① 级 / mode=eod) 下, hk 的 OI 在 D 日 21:30 已定稿 ⇒
      //    **不退到上一交易日**; 而 us 那条 (第 250 行) 在同一档下是 `day(PREV_SESSION)`。
      //    #255 就是把港股行按下面那个 us 口径写出去的 —— 值对、标签差一天、且不报错。
      expect(h.persisted[0]).toMatchObject({
        sessionDate: day(SESSION),
        source: 'eod',
        oiAsOf: day(SESSION),
      });
      // 覆盖率判据必须收到市场 —— 少这一格就是本 issue 的病根本身。
      expect(h.evaluate.mock.calls[0][0]).toBe('hk');
    });

    it('🚨 hk ② 级: OI 当晚定稿 ⇒ 落 source=`eod` 撞唯一键**只补真缺的**, 不再平行写整链', async () => {
      const h = makeHarness([hkReport('degraded'), hkReport('ok')]);
      const warn = spyLog('warn');

      const outcome = await h.remediation.backfillPremarket('hk', HK_PREMARKET_AT);
      warn.mockRestore();

      expect(outcome).toMatchObject({ market: 'hk', status: 'recovered', sessionDate: SESSION });
      // 🚨 本条的全部价值 (2026-08-31 收口): `source` 第三段与 `eod` 分开的**唯一**理由是承载
      //    OI vintage, 而 hk 的 OI 在 D 日 21:30 已定稿 ⇒ 两个 source 的 `oi_as_of` **逐值相同**
      //    ⇒ 分叉不承载任何信息, 却让唯一键 `(contract_id, session_date, source)` 不再碰撞 ⇒
      //    本级平行写**整条链**, 而读侧「按 quote_as_of 取新」恒选中这份**闭市采**的行。
      //    prod 实撞 (2026-08-28 场): hk:00700 为补 2 条被无套利守卫拒掉的腿重写了 1110 行,
      //    那批 greeks 是 vendor 无盘口时退化用陈旧 `last` 反解的 (IV 30.7 vs 同日 eod 行 40.4)。
      expect(h.persisted[0]).toMatchObject({
        source: 'eod',
        sessionDate: day(SESSION),
        oiAsOf: day(SESSION),
      });
      // 📌 FR-052 那条痕**不丢**, 只是换了载体: 行的 `source` 不再标它, `sync_run.triggered_by`
      //    标它 —— 同样是落库行 (独立探针一样数得到), 且不参与唯一键。
      expect(h.runs.map((r) => r.origin.triggeredBy)).toEqual(['premarket_backfill']);
      expect(h.runs.map((r) => r.syncType)).toEqual(['sync:hk_option_daily_snapshot']);
    });

    it('hk 非交易日 → 两级都零外呼 (日历闸按 hk 问, 不是按 us)', async () => {
      const h = makeHarness([], ['2026-06-11', '2026-06-12']); // 06-15 不在表内 ⇒ non-trading

      const outcome = await h.remediation.retrySameDay('hk', HK_SAME_DAY_RETRY_AT);

      expect(outcome).toMatchObject({
        market: 'hk',
        status: 'not_needed',
        calendar: 'non-trading',
      });
      // 🚨 判据钉在「问的是哪个市场」上: 拿 us 的日历回答 hk 开不开市, 在两地假期不同的日子
      //    (2026-10-01 / 10-19 = us 开、hk 休) 会直接放行, 而那正是最坏那个形态的入口。
      expect(h.classifyCalls[0]).toEqual(['hk', '2026-06-15']);
      expect(h.queries).toHaveLength(0);
      expect(h.persisted).toHaveLength(0);
    });
  });

  describe('🚨 补采行与正常行在**列上**可区分 (不依赖读 log)', () => {
    it('同一合约同一交易日的两行: source 与 oi_as_of 各不相同', async () => {
      const h = makeHarness([report('degraded'), report('ok')]);
      const dim = {
        dimensionKey: 'option_daily_snapshot',
        marketScope: ['us'],
      } as unknown as ExecutorSyncDimensionRow;
      const input: ExecutorInput = { mode: 'delta', asOf: SESSION, now: SAME_DAY_RETRY_AT };

      // 正常路径 (收盘后 eod) 与兜底路径 (次日盘前) 各落一行。
      await h.useCase.run([{ id: 1n, market: 'us', code: 'PEP' }], dim, emptyStats(), input);
      await h.remediation.backfillPremarket('us', PREMARKET_AT);

      const [eod, backfill] = h.persisted;
      expect(eod.contractId).toEqual(backfill.contractId);
      expect(eod.sessionDate).toEqual(backfill.sessionDate);
      // 幂等键第三段区分两行 ⇒ 两条都留得住, 且探针一条 SQL 就能数出「今天有几行靠兜底」。
      expect([eod.source, backfill.source]).toEqual(['eod', 'premarket_backfill']);
      expect([eod.oiAsOf, backfill.oiAsOf]).toEqual([day(PREV_SESSION), day(SESSION)]);
      // quote_as_of 是各自的实际采集时刻, 不因补采而回填成收盘时刻。
      expect(backfill.quoteAsOf).toEqual(new Date('2026-06-16T10:02:11Z'));
    });
  });
});
