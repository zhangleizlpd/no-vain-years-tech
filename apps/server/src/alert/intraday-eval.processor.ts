import { Inject, Injectable, Logger } from '@nestjs/common';
import type { JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { ALERT_QUEUE_REDIS } from './alert-queue-connection.js';
import { PrismaService } from '../security/prisma.service.js';
// 盘中时段表的**唯一落点**在 marketdata (060 T001 下沉合并; 本文件此前持有唯一副本, 只登记
// 了 cn)。ADR-0053 的细分边 `marketdata-rules` 放行 alert → `src/marketdata/*.rules.ts` 的
// 编译期复用, 故这里是 import 而不是各持一份。
import { isWithinTradingSession, marketNow } from '../marketdata/market-session.rules.js';
// 交易日三态判据同样落在 marketdata 的 `*.rules.ts` (062 T001), 走 ADR-0053 那条同一细分边。
// 🚫 判据本体 MUST NOT 复制到本 ctx: 两处各写一份必漂移, 而漂移的形态恰是「差一天」这类不报错的静默失真。
import { classifyTradingDay, type CalendarCoverageRange } from '../marketdata/trading-day.rules.js';
import {
  EvaluateIntradayAlertsUseCase,
  type IntradayEvalSummary,
} from './evaluate-intraday-alerts.usecase.js';

/** 盘中 tick repeatable 标识 + 频率 (021 `alert-eval` queue 第 3 tick, 全天注册, gate 在 job 内, plan D1)。 */
export const INTRADAY_TICK_SCHEDULER_ID = 'alert-eval-intraday';
export const INTRADAY_TICK_PATTERN = '*/5 * * * *';

/** job opts: 盘中求值幂等 (撞 trigger 唯一键) → attempts 1; tick 高频 → 完成保留略放宽。 */
export const INTRADAY_JOB_OPTS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { count: 60 },
  removeOnFail: { count: 100 },
};

/** 熔断阈值: 连续 3 次源全断 → open, 降级 EOD-only (Clarify Q, plan D4)。 */
export const CIRCUIT_THRESHOLD = 3;

/** 熔断态 Redis 键 (盘中态, 跨进程共享单一 worker 拓扑下亦安全; 自然随计数演进, 无 TTL 依赖)。 */
export const INTRADAY_FAILSTREAK_KEY = 'alert:intraday:failstreak';
export const INTRADAY_CIRCUIT_KEY = 'alert:intraday:circuit';

/**
 * 本盘中通路当前**只服务 A 股** —— 时段表与交易日闸都按它判。
 *
 * 🚨 显式常量而非隐含默认: 时段一旦被当成「全局的盘中」, 接美股时会静默走 A 股时窗
 * (北京 09:30–15:00), 而美股盘中 = 北京 21:30–04:00, **两者零重叠 ⇒ 一次都不触发、且不报错**。
 * 接第二个市场时改这里, 顺带定 tick 拓扑 (单 tick 判多市场 vs 各市场各 tick)。
 * ⚠️ **时段登记本身已不在本文件** —— 060 T001 起归 `marketdata/market-session.rules.ts`,
 * 那里 cn / us / hk 都已登记, 故「接第二个市场」现在只是改本常量与 tick 拓扑的事。
 */
export const INTRADAY_MARKET = 'cn';

/**
 * 本拍**为什么**过了交易日闸 (062 T007, FR-013)。
 *
 * 🚨 `confirmed` 与 `unknown` **必须可分辨**: 「今天跑是因为确认了是交易日」与「今天跑是因为
 * 还不知道」若在 bullmq `returnvalue` 里长得一样, 下次同类故障照样查不出 —— 等于没修。
 * 2026-08-18 那次 43/43 静默跳过之所以拖了几个月, 正是因为「跳过」与「跑了」之外没有第三种痕。
 */
export type IntradayCalendarBasis = 'confirmed' | 'unknown';

/** 一 tick 处置结果 (bullmq returnvalue 供排障 + IT 断言点)。 */
export type IntradayTickOutcome =
  | { status: 'skipped-session' }
  | { status: 'skipped-holiday' }
  | { status: 'source-failed'; calendar: IntradayCalendarBasis }
  | { status: 'evaluated'; calendar: IntradayCalendarBasis; summary: IntradayEvalSummary };

/**
 * 024 T008 — 盘中 tick 处理器 (US1/US3; `alert-eval` queue `intraday-cron` payload 由
 * `AlertEvalWorker` 路由至此, plan D1)。职责三段:
 *
 * 1. **交易时段 gate** (FR-002, SC-003): 起手判 `INTRADAY_MARKET` 的连续竞价时段 (纯时窗,
 *    按该市场当地时区) → 非时段直接 return,
 *    `0` 源调用; 在时段再 CROSS-CONTEXT-READ `trading_day` + `calendar_coverage` **两个事实**,
 *    喂 marketdata 的三态判据 (062 T007, FR-012): `non-trading` → return; `trading` / `unknown`
 *    **都求值**, 后者额外留痕。
 *    🚨 **两个闸是独立的**: 时段闸答「现在是不是连续竞价」, 日历闸答「今天是不是交易日」——
 *    量纲不同, 谁也替不了谁。
 * 2. **委托求值**: 交易日内调 `EvaluateIntradayAlertsUseCase` (源全断 → 抛)。
 * 3. **熔断** (FR-006, plan D4): 求值成功 → failstreak reset + circuit close (曾 open 则 warn 回升);
 *    抛错 → failstreak++; 累计 ≥ `CIRCUIT_THRESHOLD` → circuit open + warn 降级 EOD-only。
 *    open 态不另设跳闸 — 每 tick 仍探测一次源 (源调用即半开探针), 成功即自动回升 (SC-004 留痕)。
 *
 * 注: 调度幂等注册 (repeatable upsert) 在 `AlertEvalQueue.registerRepeatables` (同 queue, 单一注册面);
 * worker 启停门 (CLI sentinel) 沿用 `AlertEvalWorker` — 本处理器不自持 queue/worker。
 */
@Injectable()
export class IntradayEvalProcessor {
  private readonly logger = new Logger(IntradayEvalProcessor.name);

  constructor(
    @Inject(ALERT_QUEUE_REDIS) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly evaluateIntraday: EvaluateIntradayAlertsUseCase,
  ) {}

  /** @param now 注入时钟 (测试可控; 生产取 `new Date()`)。 */
  async process(now: Date = new Date()): Promise<IntradayTickOutcome> {
    const { dateOnly, minutesOfDay } = marketNow(INTRADAY_MARKET, now);
    if (!isWithinTradingSession(INTRADAY_MARKET, minutesOfDay)) {
      return { status: 'skipped-session' }; // 午休/盘前/盘后: 0 源调用 (SC-003)
    }
    // CROSS-CONTEXT-READ: 盘中 gate 读 marketdata.trading_day 判当日有无交易日记录 (只读, Q7-B per ADR-0052)
    const tradingDays = await this.prisma.tradingDay.count({
      where: { market: INTRADAY_MARKET, date: new Date(dateOnly) },
    });
    // CROSS-CONTEXT-READ: 盘中 gate 读 marketdata.calendar_coverage 取该市场日历覆盖声明 (只读, Q7-B per ADR-0052)
    const coverageRow = await this.prisma.calendarCoverage.findUnique({
      where: { market: INTRADAY_MARKET },
    });
    const coverage: CalendarCoverageRange | null =
      coverageRow === null
        ? null
        : {
            from: coverageRow.coveredFrom.toISOString().slice(0, 10),
            to: coverageRow.coveredTo.toISOString().slice(0, 10),
          };
    // 🚨 判 `=== 'non-trading'` 而**不是** `!== 'trading'` (Impl Guardrail 1 的同一枚硬币):
    // 「还没填到这儿」(unknown) 必须落到放行侧 —— 那正是 2026-08-18 那 43/43 静默跳过的病根。
    const status = classifyTradingDay({
      hasExactRow: tradingDays > 0,
      coverage,
      date: dateOnly,
    });
    if (status === 'non-trading') {
      return { status: 'skipped-holiday' }; // 已填过这一段、当日确实非交易日: 0 源调用
    }

    // FR-012: 盘中采集闸对「未知」的处置 = **继续跑** —— 另有独立时段闸兜着, 且真节假日多跑
    // 一轮的代价 (一次外呼、零触发) 远小于永久静默。FR-013: 留痕落在 outcome 上, 不只在日志里
    // (日志会滚掉; `returnvalue` 是 T013 生产取证的唯一硬证据)。
    const calendar: IntradayCalendarBasis = status === 'trading' ? 'confirmed' : 'unknown';
    if (calendar === 'unknown') {
      this.logger.warn(
        `交易日历视野未覆盖 ${INTRADAY_MARKET} ${dateOnly} — 本拍按「未知」放行照常求值 ` +
          `(coverage=${coverage === null ? '无声明' : `${coverage.from}..${coverage.to}`})`,
      );
    }

    try {
      const summary = await this.evaluateIntraday.execute(dateOnly);
      await this.onSourceSuccess();
      return { status: 'evaluated', calendar, summary };
    } catch (e) {
      await this.onSourceFailure(e);
      return { status: 'source-failed', calendar };
    }
  }

  /** 源成功: 清 failstreak; 若 circuit 曾 open → close + 回升留痕。 */
  private async onSourceSuccess(): Promise<void> {
    await this.redis.set(INTRADAY_FAILSTREAK_KEY, '0');
    if ((await this.redis.get(INTRADAY_CIRCUIT_KEY)) === 'open') {
      await this.redis.set(INTRADAY_CIRCUIT_KEY, 'closed');
      this.logger.warn('实时源恢复 — intraday circuit 回升 closed (EOD-only 降级解除)');
    }
  }

  /** 源失败: failstreak++; 累计达阈值且未 open → open + 降级留痕。 */
  private async onSourceFailure(e: unknown): Promise<void> {
    const streak = await this.redis.incr(INTRADAY_FAILSTREAK_KEY);
    const reason = e instanceof Error ? e.message : String(e);
    this.logger.warn(`实时源失败 (failstreak=${streak}): ${reason}`);
    if (streak >= CIRCUIT_THRESHOLD && (await this.redis.get(INTRADAY_CIRCUIT_KEY)) !== 'open') {
      await this.redis.set(INTRADAY_CIRCUIT_KEY, 'open');
      this.logger.warn(
        `实时源连续 ${streak} 次失败 — intraday circuit open, 降级 EOD-only (每 tick 半开探测自动回升)`,
      );
    }
  }
}
