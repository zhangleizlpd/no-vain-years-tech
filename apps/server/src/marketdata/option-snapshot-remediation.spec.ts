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
import { emptyStats } from './sync-run.recorder.js';
import { SyncOptionSnapshotUseCase } from './sync-option-snapshot.usecase.js';
import type { TradingCalendarPort } from './trading-calendar.port.js';

/**
 * 两级自动补救单测 (047 T022, Small —— mock port + mock prisma, 零容器)。
 *
 * 🚨 本文件盯的五条:
 * ① **一级成功不进二级**: 二级起手先复判, 达标即**零外呼** —— 盲写成「二级无条件重采」会每天
 *    白打一轮全链快照, 且给每天的数据都盖上「靠兜底续命」的痕
 * ② **二级成功不升 ERROR, 但 MUST 留痕 + 告警** (FR-052): 「一直靠兜底续命」被静默掉, 与
 *    「没有兜底」一样危险
 * ③ **留痕形态是可被 SQL 读到的行状态** (`source = premarket_backfill`), **不是只落 log** ——
 *    T025a 那条独立进程的探针不读 app 的 log
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

interface Harness {
  remediation: OptionSnapshotRemediation;
  useCase: SyncOptionSnapshotUseCase;
  /** vendor 侧每一次请求 (「零外呼」只有数请求次数才证得了)。 */
  queries: OptionSnapshotQuery[];
  /** 落库行 (source / oi_as_of 的 SQL 可查性就靠它)。 */
  persisted: Record<string, unknown>[];
  evaluate: ReturnType<typeof vi.fn>;
}

/**
 * @param verdicts `coverage.evaluate` 的**逐次**返回 (第一次 = 补救前判定, 第二次 = 重采后复判)
 * @param tradingDays 库内交易日历 (缺 `SESSION` 之前的行 → 二级无法定位待补日)
 */
function makeHarness(verdicts: OptionCoverageReport[], tradingDays = TRADING_DAYS): Harness {
  const queries: OptionSnapshotQuery[] = [];
  const persisted: Record<string, unknown>[] = [];

  const port: OptionSnapshotPort = {
    getSnapshots: vi.fn(async (q: OptionSnapshotQuery) => {
      queries.push({ ...q, contractCodes: [...q.contractCodes] });
      const rows: OptionSnapshotRow[] = q.contractCodes.map((code) => quoteRow(code));
      rows.push(underlyingRow());
      return { asOf: new Date('2026-06-16T10:02:11Z'), rows };
    }),
  };

  const prisma = {
    optionContract: {
      findMany: vi.fn(async () => [
        {
          id: 11n,
          code: PEP_CONTRACT_CODE,
          optionType: 'PUT',
          strikePrice: new Prisma.Decimal('130'),
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
      findFirst: vi.fn(async (args: { where: { date: { lt: Date } } }) => {
        const before = args.where.date.lt.toISOString().slice(0, 10);
        const prev = tradingDays.filter((d) => d < before).at(-1);
        return prev === undefined ? null : { date: day(prev) };
      }),
    },
  } as unknown as PrismaService;

  const calendar: TradingCalendarPort = {
    isTradingDay: async (_market: string, date: string) => tradingDays.includes(date),
  };

  const coverage = new OptionSnapshotCoverageCheck(prisma, {
    optionCoverageThreshold: 1,
  } as unknown as MarketdataSyncConfig);
  // 🚨 只把**读库那半段**换成剧本: `alertIfDegraded` 走真实现 —— 「升不升 ERROR」是本文件的
  // 被测面, 换成 spy 就只能断言「调了那个方法」而不是「真的响了」。
  const evaluate = vi.fn(async () => verdicts.shift() ?? report('ok'));
  vi.spyOn(coverage, 'evaluate').mockImplementation(evaluate);

  const useCase = new SyncOptionSnapshotUseCase(port, prisma);
  return {
    remediation: new OptionSnapshotRemediation(coverage, useCase, prisma, calendar),
    useCase,
    queries,
    persisted,
    evaluate,
  };
}

function quoteRow(code: string): OptionSnapshotRow {
  return {
    code,
    isOption: true,
    underlyingCode: 'US.PEP',
    bid: '2.30',
    ask: '2.40',
    bidSize: '45',
    askSize: '60',
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
function underlyingRow(): OptionSnapshotRow {
  return {
    ...quoteRow('US.PEP'),
    isOption: false,
    underlyingCode: null,
    bid: null,
    ask: null,
    last: '128.40',
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

      const outcome = await h.remediation.retrySameDay(SAME_DAY_RETRY_AT);

      expect(outcome).toMatchObject({ status: 'not_needed', sessionDate: SESSION });
      expect(h.queries).toHaveLength(0);
      expect(h.persisted).toHaveLength(0);
    });

    it('缺失 → 只重采**缺的那几票**并补回 ⇒ 不升 ERROR, 且落的是正常 eod 行', async () => {
      const h = makeHarness([report('degraded'), report('ok')]);
      const err = spyLog('error');

      const outcome = await h.remediation.retrySameDay(SAME_DAY_RETRY_AT);

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

      const outcome = await h.remediation.retrySameDay(SAME_DAY_RETRY_AT);

      expect(outcome.status).toBe('still_missing');
      // FR-046: 两级都失败**才**升 ERROR —— 一级就响会把每次 vendor 抖动都变成红。
      expect(err).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      err.mockRestore();
      warn.mockRestore();
    });
  });

  describe('② 次日盘前兜底', () => {
    it('🚨 一级已补回 → 二级复判达标 ⇒ **零外呼**, 不留降级痕', async () => {
      const h = makeHarness([report('ok')]);

      const outcome = await h.remediation.backfillPremarket(PREMARKET_AT);

      expect(outcome).toMatchObject({ status: 'not_needed', sessionDate: SESSION });
      expect(h.queries).toHaveLength(0);
      expect(h.persisted).toHaveLength(0);
    });

    it('🚨 二级补回 → 不升 ERROR, 但**留痕 (SQL 可查的行状态) + 告警**', async () => {
      const h = makeHarness([report('degraded'), report('ok')]);
      const err = spyLog('error');
      const warn = spyLog('warn');

      const outcome = await h.remediation.backfillPremarket(PREMARKET_AT);

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

    it('🚨 两级都失败 → 升 ERROR 且**指明哪一票哪一天**', async () => {
      const h = makeHarness([report('degraded'), report('degraded')]);
      const err = spyLog('error');

      const outcome = await h.remediation.backfillPremarket(PREMARKET_AT);

      expect(outcome).toMatchObject({ status: 'still_missing', stillMissing: ['us:PEP'] });
      const logged = err.mock.calls.map((c: unknown[]) => String(c[0])).join(' | ');
      expect(logged).toContain('us:PEP');
      expect(logged).toContain(SESSION);
      err.mockRestore();
    });

    it('日历缺「上一交易日」行 → blocked + ERROR, **不猜日子** (猜错=脏 session_date)', async () => {
      const h = makeHarness([report('degraded')], ['2026-06-16']);
      const err = spyLog('error');

      const outcome = await h.remediation.backfillPremarket(PREMARKET_AT);

      expect(outcome).toMatchObject({ status: 'blocked', sessionDate: null });
      expect(h.queries).toHaveLength(0);
      expect(err).toHaveBeenCalled();
      err.mockRestore();
    });
  });

  describe('🚨 非交易日两级都不跑 (假阳性守卫)', () => {
    it('周六 → 零判定、零外呼 (当日本就没有 session, 照跑会读成整批缺失)', async () => {
      const h = makeHarness([report('degraded'), report('degraded')]);

      const same = await h.remediation.retrySameDay(WEEKEND_AT);
      const premarket = await h.remediation.backfillPremarket(WEEKEND_AT);

      expect(same.status).toBe('not_needed');
      expect(premarket.status).toBe('not_needed');
      expect(h.evaluate).not.toHaveBeenCalled();
      expect(h.queries).toHaveLength(0);
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
      await h.remediation.backfillPremarket(PREMARKET_AT);

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
