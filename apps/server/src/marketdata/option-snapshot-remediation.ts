import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../security/prisma.service.js';
import type { WorkingInstrument } from './dimension-executor.js';
import {
  OptionSnapshotCoverageCheck,
  type OptionCoverageReport,
} from './option-snapshot-coverage.check.js';
import { emptyStats, type SyncRunStats } from './sync-run.recorder.js';
import {
  SNAPSHOT_SOURCE_EOD,
  SNAPSHOT_SOURCE_PREMARKET_BACKFILL,
  SyncOptionSnapshotUseCase,
} from './sync-option-snapshot.usecase.js';
import { marketDateFor } from './trading-day-gate.js';
import { TRADING_CALENDAR_PORT, type TradingCalendarPort } from './trading-calendar.port.js';

/**
 * 快照缺口的**两级自动补救** (047 T022, FR-046 / FR-052, plan D-DATA-4/5)。
 *
 * | 级 | 时刻 (Asia/Shanghai) | 落库口径 | 失败后 |
 * | --- | --- | --- | --- |
 * | ① 当日重试 | 08:00 (夜间采集窗 06:30 之后) | 与正常路径**同**: `source=eod` · `oi_as_of` = 上一交易日 | 只 WARN, 挂着等 ② |
 * | ② 次日盘前兜底 | 18:00 (= ET 05:00/06:00, 落在盘前 04:00–09:30 内, 亦在 spec 的北京 16:00–21:30 窗内) | `source=premarket_backfill` · `session_date` = **被补的那天** · `oi_as_of` = `session_date` | **升 ERROR** |
 *
 * ## 🚨 二级起手先复判 —— 一级救回了就**零外呼**
 *
 * 「无条件重采一遍」每天白打一轮全链快照, 且会给**每一天**的数据都盖上 `premarket_backfill`
 * 的痕 —— 那条痕的意义正是「这天是靠兜底续命的」, 天天有等于没有。
 *
 * ## 🚨 降级留痕的形态是**行状态**, 不是 log (FR-052)
 *
 * `source = premarket_backfill` 本身就是可被一条 SQL 数出来的痕。只落 log 的话, T025a 那条
 * **独立于 app 进程**的探针 (app 挂了数据自然缺失 ⇒ log 也一起没了) 根本看不见它。
 *
 * ## 🚨 两级都失败**才**升 ERROR (FR-046)
 *
 * 一级就响会把每次 vendor 抖动都变成红。ERROR 的**触达**仍归 `ops/jobs/marketdata-snapshot-integrity.{sh,sql}`
 * 的独立 timer (Guardrail 16) —— 落进 `sync_run` 等次日日报读, 就违反了「ERROR 触达 MUST NOT
 * 并入次日日报」。
 *
 * ## 🚨 非交易日两级都不跑
 *
 * 周末 / 节假日当天本就没有 session, 照跑会把「今天没有交易日」读成整批缺失 (一次全量假红 +
 * 一轮白烧的 vendor 配额)。判据走管线既有的交易日闸 —— ⚠️ 这**不是** FR-045 禁的那种「拿日历
 * 给告警打补丁」: 那条禁的是「今天是大到期日所以放宽阈值」, 而这里判的是「今天到底有没有 session」。
 *
 * ⚠️ **062 起这道闸是三态的**: 只有**确认**的非交易日才短路; 「日历视野还没填到今天」
 * (`unknown`) 一律继续执行 —— 起手的覆盖率复判会决定是否真外呼, 不缺即零外呼返回
 * (`state_branch` 6)。改前那个「无记录 ⇒ 非交易日」的布尔正是二级兜底静默死掉的成因:
 * 它每天在北京 18:00 判「今天不是美股交易日」, 而那一刻今天那一行还没落库。
 *
 * ## 周末的时序 (看起来晚, 但仍然正确)
 *
 * 周五 session 的采集发生在北京周六 06:30 (ET 周五晚)。① 级北京周六 08:00 跑时 us 业务日仍是
 * **周五** ⇒ 照常重试; ② 级要等到北京周一 18:00 (ET 周一盘前) —— 那时「上一交易日」仍是周五,
 * 而周一盘前的 last close 也仍是周五收盘 ⇒ 补回的值正确。🚫 **MUST NOT 把 ② 级改成「补最近 N 天」**:
 * 只有**紧邻的上一个 session** 能从盘前快照原样补回, 再往前一天拿到的是错的收盘价。
 */

/** 本片补救只服务美股期权 (三个维度 `market_scope={us}`)。 */
const US_MARKET_SCOPE = ['us'];

export type RemediationLevel = 'same_day_retry' | 'premarket_backfill';

export type RemediationStatus =
  /** 覆盖率达标 (含「无对象」) 或非交易日 ⇒ 本级零外呼。 */
  | 'not_needed'
  /** 本级补回。 */
  | 'recovered'
  /** 本级重采后仍缺 (① 级 → 等 ②; ② 级 → 已升 ERROR)。 */
  | 'still_missing'
  /** 前置缺失, 无法定位待补交易日 (日历缺行) —— 已升 ERROR。 */
  | 'blocked';

/**
 * 本级**凭什么**走到这个结局的日历判据 (062 T009, FR-013)。
 *
 * 🚨 三值而不是两值: 「确认非交易日」与「覆盖率达标」都落 `not_needed`, 少了这一格,
 * 一条按结局分组的查询再也分不出「今天本就没有 session」和「今天有 session 且不缺」——
 * 而二级兜底恰恰是靠**前者天天成立**才静默死了几个月 (`unknown` 被读成 `non-trading`)。
 */
export type RemediationCalendarBasis = 'confirmed' | 'unknown' | 'non-trading';

export interface RemediationOutcome {
  level: RemediationLevel;
  /**
   * 本级的日历判据来源。`unknown` = 视野还没填到该业务日, 本级是「不知道所以照跑」——
   * 与 `confirmed` 事后必须分得出 (FR-013)。
   */
  calendar: RemediationCalendarBasis;
  /** 被补救的交易日; `null` = 无法定位。 */
  sessionDate: string | null;
  status: RemediationStatus;
  /** 本级重采过的票 (canonical symbol)。 */
  attempted: string[];
  /** 重采后仍缺的票。 */
  stillMissing: string[];
}

/** `YYYY-MM-DD` → `@db.Date` 列的 UTC 零点 Date。 */
const toDateOnly = (s: string): Date => new Date(`${s}T00:00:00Z`);

@Injectable()
export class OptionSnapshotRemediation {
  private readonly logger = new Logger(OptionSnapshotRemediation.name);

  constructor(
    private readonly coverage: OptionSnapshotCoverageCheck,
    private readonly snapshot: SyncOptionSnapshotUseCase,
    private readonly prisma: PrismaService,
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
  ) {}

  /** ① 级: 每日 08:00 Asia/Shanghai —— 夜间快照窗 (06:30) 之后, 留足限频顺延重入队的时间。 */
  @Cron('0 0 8 * * *', { timeZone: 'Asia/Shanghai' })
  async handleSameDayRetryCron(): Promise<void> {
    await this.retrySameDay(new Date());
  }

  /** ② 级: 每日 18:00 Asia/Shanghai —— 见类注释的窗口论证 (@Cron 表达式静态, 故取固定时刻)。 */
  @Cron('0 0 18 * * *', { timeZone: 'Asia/Shanghai' })
  async handlePremarketBackfillCron(): Promise<void> {
    await this.backfillPremarket(new Date());
  }

  /**
   * ① 当日重试: 对**当前 us 业务日**复采覆盖率不达标的那几票, 落的仍是正常 `eod` 行。
   *
   * 复杂度: 2 次覆盖率判定 (各 O(n)) + O(缺票数) 次采集。
   */
  async retrySameDay(now: Date): Promise<RemediationOutcome> {
    const sessionDate = marketDateFor(US_MARKET_SCOPE, now);
    const calendar = await this.calendarBasis(sessionDate);
    if (calendar === 'non-trading') {
      return this.idle('same_day_retry', sessionDate, calendar, '确认非交易日, 本就没有 session');
    }
    const before = await this.coverage.evaluate(sessionDate);
    if (before.status !== 'degraded') {
      return this.idle('same_day_retry', sessionDate, calendar, `覆盖率 ${before.status}`);
    }

    const after = await this.recollect(before, {
      sessionDate,
      mode: SNAPSHOT_SOURCE_EOD,
      now,
    });
    const attempted = before.degraded.map((u) => u.symbol);
    if (after.status !== 'degraded') {
      this.logger.warn(
        `[option-snapshot-remediation] ① 当日重试补回 ${sessionDate}: ${attempted.join(', ')}`,
      );
      return {
        level: 'same_day_retry',
        calendar,
        sessionDate,
        status: 'recovered',
        attempted,
        stillMissing: [],
      };
    }
    // 🚫 这里**不**升 ERROR: 还有 ② 级兜底 (FR-046「两级都失败才升 ERROR」)。
    const stillMissing = after.degraded.map((u) => u.symbol);
    this.logger.warn(
      `[option-snapshot-remediation] ① 当日重试后仍缺 ${stillMissing.length} 票 (${sessionDate}: ` +
        `${stillMissing.join(', ')}), 待次日盘前 ② 级兜底`,
    );
    return {
      level: 'same_day_retry',
      calendar,
      sessionDate,
      status: 'still_missing',
      attempted,
      stillMissing,
    };
  }

  /**
   * ② 次日盘前兜底: 在美股盘前窗口重采**上一个交易日**的缺口, 落 `premarket_backfill` 行。
   *
   * 复杂度同 {@link retrySameDay}。
   */
  async backfillPremarket(now: Date): Promise<RemediationOutcome> {
    const today = marketDateFor(US_MARKET_SCOPE, now);
    const calendar = await this.calendarBasis(today);
    if (calendar === 'non-trading') {
      // 非交易日无盘前窗口 (OI 也不会翻新) ⇒ 不补; 下一个交易日的盘前仍能补回同一个 session。
      return this.idle('premarket_backfill', null, calendar, '确认非交易日, 无盘前窗口');
    }
    const sessionDate = await this.resolvePreviousTradingDay(today);
    if (sessionDate === null) {
      // 🚫 不猜日子: 猜错就是一批 `session_date` 标错的脏行, 比不补更难发现且要人工回删。
      this.logger.error(
        `[option-snapshot-remediation] 交易日历缺 us 在 ${today} 之前的行, 无法定位待补交易日 ` +
          `⇒ ② 级兜底跳过 (请补交易日历)`,
      );
      return {
        level: 'premarket_backfill',
        calendar,
        sessionDate: null,
        status: 'blocked',
        attempted: [],
        stillMissing: [],
      };
    }

    const before = await this.coverage.evaluate(sessionDate);
    // 🚨 ① 级已补回 ⇒ 零外呼、不留降级痕 (见类注释)。
    if (before.status !== 'degraded') {
      return this.idle('premarket_backfill', sessionDate, calendar, `覆盖率 ${before.status}`);
    }

    const after = await this.recollect(before, {
      sessionDate,
      mode: SNAPSHOT_SOURCE_PREMARKET_BACKFILL,
      now,
    });
    const attempted = before.degraded.map((u) => u.symbol);
    if (after.status !== 'degraded') {
      // 降级 MUST 留痕 + 告警 (FR-052), 但**不是** ERROR —— 缺口已补上。留痕的权威形态是
      // 落库行的 `source`, 本条 log 只是让它当场可见。
      this.logger.warn(
        `[option-snapshot-remediation] ② 次日盘前兜底补回 ${sessionDate} (source=` +
          `${SNAPSHOT_SOURCE_PREMARKET_BACKFILL}, 本日数据来自兜底补采): ${attempted.join(', ')}`,
      );
      return {
        level: 'premarket_backfill',
        calendar,
        sessionDate,
        status: 'recovered',
        attempted,
        stillMissing: [],
      };
    }
    // 两级都失败 ⇒ ERROR。文案复用覆盖率核对的同一个结构化格式 (同判据两处措辞必漂移),
    // 逐票明细 + sessionDate 都在里面。
    this.coverage.alertIfDegraded(after, '两级补救均失败: ① 当日重试 + ② 次日盘前兜底');
    return {
      level: 'premarket_backfill',
      calendar,
      sessionDate,
      status: 'still_missing',
      attempted,
      stillMissing: after.degraded.map((u) => u.symbol),
    };
  }

  /** 重采不达标的那几票 → 复判。返回**重采后**的报告。 */
  private async recollect(
    before: OptionCoverageReport,
    spec: {
      sessionDate: string;
      mode: typeof SNAPSHOT_SOURCE_EOD | typeof SNAPSHOT_SOURCE_PREMARKET_BACKFILL;
      /** 本次补救的绝对时刻 (异常监控 ② 的 DTE 基准, T024a) —— ② 级下它与 `sessionDate` 差一天。 */
      now: Date;
    },
  ): Promise<OptionCoverageReport> {
    const stats: SyncRunStats = emptyStats();
    // 🚨 只重采**缺的那几票**, 不整轮重跑: 整轮会让已达标的票平白多一批 vendor 请求, 且在
    // ② 级把 `premarket_backfill` 的痕盖到本来正常的票上。
    await this.snapshot.collect(
      before.degraded.map(toWorkingInstrument),
      { ...spec, marketScope: US_MARKET_SCOPE },
      stats,
    );
    if (stats.failed > 0) {
      this.logger.warn(
        `[option-snapshot-remediation] 重采期间 ${stats.failed} 票失败: ` +
          `${JSON.stringify(stats.failedTargets)}`,
      );
    }
    return this.coverage.evaluate(spec.sessionDate);
  }

  /**
   * `session_date` 的上一交易日 (权威来源 `marketdata.trading_day`, 同
   * `SyncOptionSnapshotUseCase.resolveOiSessionDate` 的取值口径)。
   *
   * ⚠️ 这里**没有**兜底近似值, 与那边不对称: 那边缺行只影响一个可回查订正的标签 (不落库 =
   * 永久缺口), 这里缺行会决定**整批行的 `session_date`** —— 猜错写下去要人工回删。
   */
  private async resolvePreviousTradingDay(date: string): Promise<string | null> {
    const prev = await this.prisma.tradingDay.findFirst({
      where: { market: { in: US_MARKET_SCOPE }, date: { lt: toDateOnly(date) } },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    return prev === null ? null : prev.date.toISOString().slice(0, 10);
  }

  /**
   * 「今天到底有没有 session」的**三态**分派 (062 T009, `state_branch` 6)。
   *
   * 🚨 `unknown` 走**继续执行**侧: 本级起手就有一次覆盖率复判, 不缺即零外呼返回 ——
   * 「不知道」的代价只是一次本地查询, 而判错成非交易日的代价是**永久缺口**
   * (期权收盘数据无跨日补救, 二级放弃掉的那一场再也补不回来)。
   * 🚫 **MUST NOT 写成 `!== 'trading'`** —— 那就是 062 修掉的病原样犯回去。
   */
  private async calendarBasis(date: string): Promise<RemediationCalendarBasis> {
    const status = await this.calendar.classify(US_MARKET_SCOPE[0], date);
    if (status === 'non-trading') return 'non-trading';
    if (status === 'trading') return 'confirmed';
    this.logger.warn(
      `[option-snapshot-remediation] 交易日历视野未覆盖 us 的 ${date} ⇒ 本级按「未知」继续执行 ` +
        `(起手的覆盖率复判决定是否真外呼; 请补前瞻视野)`,
    );
    return 'unknown';
  }

  /**
   * 本级零外呼的出口。**必须留痕** —— 这条路径以前是一句静默 `return`, 而二级盘前兜底正是
   * 沿它每天判「无事可做」并返回, 一连几个月没有任何信号 (SC-004 实测执行率 0%)。
   * `log` 而非 `warn`: 它在正常日子里每天都成立, 用 `warn` 会训练出「这条可以忽略」。
   */
  private idle(
    level: RemediationLevel,
    sessionDate: string | null,
    calendar: RemediationCalendarBasis,
    reason: string,
  ): RemediationOutcome {
    this.logger.log(
      `[option-snapshot-remediation] ${level} 本级零外呼: ${reason} ` +
        `(calendar=${calendar}, session=${sessionDate ?? '-'})`,
    );
    return { level, calendar, sessionDate, status: 'not_needed', attempted: [], stillMissing: [] };
  }
}

/** 覆盖率明细 → 采集工作集项 (`symbol` 是 `${market}:${code}` 的拼接, 此处反解)。 */
function toWorkingInstrument(underlying: {
  instrumentId: bigint;
  symbol: string;
}): WorkingInstrument {
  const [market, code] = underlying.symbol.split(':');
  return { id: underlying.instrumentId, market, code };
}
