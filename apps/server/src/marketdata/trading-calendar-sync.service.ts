import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { marketdataSyncConfig, type MarketdataSyncConfig } from '../config/marketdata.config.js';
import { PrismaService } from '../security/prisma.service.js';
import { advanceCoverage } from './calendar-coverage.rules.js';
import type { CalendarCoverageRange } from './trading-day.rules.js';
import {
  TRADING_CALENDAR_FORWARD_SOURCE,
  TRADING_CALENDAR_SOURCE,
  type TradingCalendarSource,
} from './trading-calendar-source.port.js';
import { marketDateFor, shanghaiToday } from './trading-day-gate.js';

/**
 * 交易日历填充服务 (sync-1 S1-T2): `trading_day` 表的**写入端** (populate/seed)。读端是
 * `TRADING_CALENDAR_PORT` (DbTradingCalendarAdapter, S1-T4)。指数日历免费源 (eastmoney) →
 * 逐市场落 `trading_day(market, date)`, 顶替旧「每次 gate 现打理杏仁付费指数 candlestick」。
 *
 * @Cron 每日 21:00 Asia/Shanghai —— **早于 22:00 sync tick**, 破「今日交易日 gate 需今日已入表」
 * 鸡生蛋; 本服务**不受交易日 gate 约束** (它就是 gate 的数据源)。
 */

/** 交易日历覆盖市场 (市场级, 与 universe 维度解耦; eastmoney 指数源三市场齐备)。 */
export const CALENDAR_MARKETS = ['cn', 'hk', 'us'] as const;

/** @Cron 每日填充回看窗 (天): 覆盖今日 + 近期缺口 (服务短暂停摆自愈); 一次 vendor 调用覆盖整窗。 */
const POPULATE_LOOKBACK_DAYS = 30;

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` 的次日 (跨月/跨年/闰年交给 `Date` 算, 别手工加 1)。 */
function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/** 心跳 `lastError` 存文截断: vendor 报错可能挟带整页 HTML, 心跳行只需可诊断的开头。 */
const ERROR_TEXT_MAX = 1000;

/** 交叉校验 WARN 里列举的冲突日上限 (完整口径看 `count`; 日志行不该被一整年的日期撑爆)。 */
const CROSS_CHECK_SAMPLE_MAX = 20;

/** per-market 填充结果 (IT 断言面 + 日志)。 */
export interface CalendarSyncResult {
  market: string;
  /** vendor 返回的交易日数 (区间内)。 */
  fetched: number;
  /** 新落库行数 (幂等: 已存在的 (market,date) 由 skipDuplicates 跳过, 不计入)。 */
  inserted: number;
}

@Injectable()
export class TradingCalendarSyncService {
  private readonly logger = new Logger(TradingCalendarSyncService.name);

  constructor(
    @Inject(TRADING_CALENDAR_SOURCE) private readonly source: TradingCalendarSource,
    private readonly prisma: PrismaService,
    @Inject(marketdataSyncConfig.KEY) private readonly cfg: MarketdataSyncConfig,
    /**
     * 前瞻段专用源 (062 T004): `us → 富途` / `cn,hk → 静态年历`, 见
     * `createForwardCalendarSource`。**必填而非可选** —— 可选会让「接线漏了」退化成「前瞻段
     * 静默不跑」, 而那正好是本 feature 在消灭的那类静默 (视野不动没人知道)。
     */
    @Inject(TRADING_CALENDAR_FORWARD_SOURCE)
    private readonly forwardSource: TradingCalendarSource,
  ) {}

  /**
   * 每日 21:00 Asia/Shanghai (@Cron 表达式静态)。灰度 flag 短路 (tickEnabled 默认 false):
   * 与 SyncTickDriver 同门 —— dev/test 不外呼 eastmoney; prod 开启后随夜间调度一并生效。
   */
  @Cron('0 0 21 * * *', { timeZone: 'Asia/Shanghai' })
  async handleCron(): Promise<void> {
    if (!this.cfg.tickEnabled) return;
    await this.populate(new Date());
  }

  /**
   * @Cron 本体 (可直调控时, IT 面) —— **两段** (062 T004, plan §D4):
   *
   * 1. **历史段** `[今天-30, 今天]` 走活源链 (`TRADING_CALENDAR_SOURCE`), 与 062 之前**完全
   *    一致** (窗口口径一字不改)。
   * 2. **前瞻段** `[明天, 当年 12-31]` 走前瞻源 (`TRADING_CALENDAR_FORWARD_SOURCE`, 权威年历)。
   *
   * 顺序是**先历史后前瞻**: 历史段是既有职责 (今天那一行必须尽早落库), 前瞻段是增量。两段
   * **各自留痕、各自推进覆盖声明** —— 一段失败 MUST NOT 让另一段的声明失真 (`state_branch` 16)。
   *
   * 🚨 **前瞻窗的年份按市场时区算, 不是宿主 `getFullYear()`** (Impl Guardrail 3): 跨年那几
   * 小时 us 与 cn 不在同一年 (北京 1 月 1 日 08:00 = ET 前一年 12 月 31 日 19:00)。拿宿主年份
   * 去问 us, 轻则请求一个已经过去的年末 (返空/抛错), 重则**问到次年整年而源直接返空 ⇒ 声明
   * 被推到一个从没填过的次年末**, 于是次年每一天都从 `unknown` 翻成 `non-trading`。单测不跨年
   * ⇒ 这条不会自己红, 靠 IT 里那条「时钟停在北京 1 月 1 日 08:00」的断言钉住。
   *
   * ⚠️ 因此前瞻段**逐市场**跑 (各市场窗口不同), 而历史段一次跑完三市场。
   *
   * ⚠️ 市场时区的今天恰为 12-31 那一天, 前瞻窗退化成 `[次年 01-01, 当年 12-31]` (反向)。
   * **蓄意不特判**: 各 adapter 自己的 `from > to` 闸会抛 → per-market catch 留痕 → 声明停在
   * 当年末不动。这正是 `state_branch` 13 要的形状 (年末自然收缩), 而**特判成静默 skip** 会把
   * 唯一的信号也抹掉。
   */
  async populate(now: Date): Promise<CalendarSyncResult[]> {
    const to = shanghaiToday(now);
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - POPULATE_LOOKBACK_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const historical = await this.syncRangeWith(this.source, [...CALENDAR_MARKETS], from, to);

    const forward: CalendarSyncResult[] = [];
    for (const market of CALENDAR_MARKETS) {
      const marketToday = marketDateFor([market], now);
      forward.push(
        ...(await this.syncRangeWith(
          this.forwardSource,
          [market],
          nextDay(marketToday),
          `${marketToday.slice(0, 4)}-12-31`,
        )),
      );
    }
    return [...historical, ...forward];
  }

  /**
   * 核心填充 (populate 近窗 + seed CLI 宽区间共用): per market 拉指数日历 → `createMany`
   * `skipDuplicates` 幂等落 `trading_day` → 写 `calendar_sync_health` 心跳。
   * 单市场失败**续跑其余** (一市场坏不拖垮全局, FR-004) 但**必留痕** (FR-008)。
   * 复杂度 O(市场数 × 区间交易日数)。
   */
  async syncRange(markets: string[], from: string, to: string): Promise<CalendarSyncResult[]> {
    return this.syncRangeWith(this.source, markets, from, to);
  }

  /**
   * `syncRange` 的**源参数化**形态 (062 T003, plan §D4)。同一段填充逻辑要被两个源各跑一遍
   * —— 历史段走 `TRADING_CALENDAR_SOURCE` (活源链, 问过去), 前瞻段走
   * `TRADING_CALENDAR_FORWARD_SOURCE` (权威年历, 问未来) —— 而 per-market 隔离 / 心跳留痕 /
   * 幂等落库三条语义两段完全一致, 故抽参数而**不是**复制一份。
   *
   * ⚠️ 心跳是 **per-market 一行**, 两段共用: 后跑的那段会覆盖同市场的心跳。这是刻意的 ——
   * 心跳答的是「填充这件事还活着吗」(liveness), 分段的成败区分由**覆盖声明**承担 (062 T004),
   * 别为了分段再去把心跳表按段拆列。
   */
  async syncRangeWith(
    source: TradingCalendarSource,
    markets: string[],
    from: string,
    to: string,
  ): Promise<CalendarSyncResult[]> {
    const results: CalendarSyncResult[] = [];
    for (const market of markets) {
      try {
        const { dates, servedBy } = await source.fetchTradingDates(market, from, to);
        // 🚨 **必须在 createMany 之前**: 之后取快照就把本次写入也算成「已存在」, 差集恒为空
        // ⇒ 这条校验静默失效**且不会红**。
        await this.crossCheckAgainstExisting(market, from, to, dates);
        const { count } = await this.prisma.tradingDay.createMany({
          data: dates.map((d) => ({ market, date: new Date(`${d}T00:00:00Z`) })),
          skipDuplicates: true,
        });
        await this.recordHeartbeat(market, servedBy);
        // 🚨 **只在成功分支** —— 见 `advanceCoverageFor` 与下面 catch 分支的注释。
        await this.advanceCoverageFor(market, { from, to }, servedBy);
        results.push({ market, fetched: dates.length, inserted: count });
      } catch (err) {
        // 🚨 044 病根: 旧实现在此**只 WARN + inserted:0** —— 失败除日志外零留痕, 于是源被下线后
        // 静默停摆 2 天。续跑保留 (韧性), 静默废除 (病): 心跳记 lastError 且**不刷 lastSuccessAt**
        // → 心跳陈旧 → 探针告警 (FR-008/FR-010)。
        this.logger.warn(
          `trading-calendar 填充失败 (续跑其余市场): ${JSON.stringify({ market, from, to, error: String(err) })}`,
        );
        // 🚨🚨 **本分支绝不碰 `calendar_coverage`** (062 Impl Guardrail 2): 声明是三态判定的
        // 唯一真相源, 一旦在填充失败时照样前进, 「没填到」就会被读成「填过了, 确实不是交易日」
        // ⇒ 全线失真。而测试通常只断言「成功时推进」**所以不会红** —— 反例断言 (源抛错 →
        // `covered_to` 一天不动) 在 `marketdata.calendar-062.horizon.it.spec.ts`。
        await this.recordHeartbeat(market, undefined, err);
        results.push({ market, fetched: 0, inserted: 0 });
      }
    }
    this.logger.log(`trading-calendar 填充完成: ${JSON.stringify({ from, to, results })}`);
    return results;
  }

  /**
   * **前瞻 / 历史两条路径的交叉校验**留痕 (062 T005, FR-009, `state_branch` 17, plan §D8)。
   *
   * 场景: 某日在成为「今天」之前先由**前瞻段**按权威年历落库, 日后被**历史段**的活源覆盖到
   * —— 同一个日期被两条**物理独立**的路径先后回答。答案相反 (库里有行、本次活源没给) →
   * `WARN` + 计数, 不阻断本轮。⚠️ 这与 `populate()` 内两段的执行顺序 (先历史后前瞻) 无关。
   *
   * 🚫 **MUST NOT 自动订正**: 谁对谁错要人判 —— 「交易所临时休市」(年历错) 与「年历解析错」
   * (活源对) 两者的处置**完全相反**。本方法**只读**, 一行数据都不动。这条留痕的价值就是
   * 「两条独立路径互为校验」: 单源时代根本发现不了这一类错。
   *
   * ⚠️ 只报「库里有、源没给」这一个方向。反向 (源给了库里没有) 是**填充的常态** (那正是本次
   * 要写入的新行), 报它等于每轮都刷屏。
   *
   * 自身失败只 ERROR 不外抛 —— 观测设施不该把一次成功的填充记成失败 (同 `recordHeartbeat`)。
   * 复杂度 O(区间内已有行数 + 源返回天数)。
   */
  private async crossCheckAgainstExisting(
    market: string,
    from: string,
    to: string,
    fetched: string[],
  ): Promise<void> {
    try {
      const existing = await this.prisma.tradingDay.findMany({
        where: {
          market,
          date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
        },
        select: { date: true },
      });
      const fetchedSet = new Set(fetched);
      const disputed = existing
        .map((row) => row.date.toISOString().slice(0, 10))
        .filter((date) => !fetchedSet.has(date))
        .sort();
      if (disputed.length === 0) return;

      this.logger.warn(
        `trading-calendar 交叉校验不一致 (库里有行、本次源没给; **不自动订正**, 待人判): ` +
          `${JSON.stringify({
            market,
            from,
            to,
            count: disputed.length,
            dates: disputed.slice(0, CROSS_CHECK_SAMPLE_MAX),
          })}`,
      );
    } catch (err) {
      this.logger.error(
        `trading-calendar 交叉校验失败 (不影响填充结果): ${JSON.stringify({ market, from, to, error: String(err) })}`,
      );
    }
  }

  /**
   * per-market **覆盖声明**推进 (`calendar_coverage`, 062 T004, FR-002 / FR-004)。判据本体是
   * `calendar-coverage.rules.ts` 的纯函数 {@link advanceCoverage}, 本方法只做 read → 判 → write。
   *
   * 🚨 **只在整段填充成功后调**: 「声明」= 「这一段我已经完备填过了」的承诺, 不是「我试过了」。
   * 调用点在 `syncRangeWith` 的 try 尾部, **catch 分支绝不调**。
   *
   * 🚨 **两段各推各的**: 历史段推进到今天、前瞻段推进到当年末, 一段失败只是它自己那截不前进,
   * 另一段的承诺**不受污染** (`state_branch` 16)。
   *
   * 🚫 **MUST NOT 用 `max(trading_day.date)` 派生终点** (FR-003): 最大值看不出区间中间的空洞。
   *
   * 不推进 (与既有声明之间有缺口) → **ERROR 留痕**且声明纹丝不动 (`state_branch` 11)。自身
   * 写失败同样只 ERROR 不外抛: 抛出去会被 per-market catch 接住, 从而把一次**成功的填充**记成
   * 失败心跳 (结果计数也跟着变 0) —— 观测/声明设施不该反过来伪造填充结局。视野不前进这件事
   * 由视野探针 (读 `covered_to`) 独立看得见, 不依赖本条日志。
   *
   * 复杂度 O(1) (单行 read + 单行 upsert)。⚠️ read-modify-write 无锁: 唯二写者 (夜间 @Cron
   * 与手工 seed CLI) 若真撞上, 后写者可能把声明写回较窄的区间 —— 方向偏**保守** (更多日期落回
   * `unknown`, 各消费方按 unknown 分派继续工作 + 探针告警), 不会造出假的「已覆盖」。
   */
  private async advanceCoverageFor(
    market: string,
    filled: CalendarCoverageRange,
    servedBy: string,
  ): Promise<void> {
    try {
      const row = await this.prisma.calendarCoverage.findUnique({ where: { market } });
      const current: CalendarCoverageRange | null = row
        ? {
            from: row.coveredFrom.toISOString().slice(0, 10),
            to: row.coveredTo.toISOString().slice(0, 10),
          }
        : null;

      const advanced = advanceCoverage(current, filled);
      if (!advanced.advanced) {
        this.logger.error(
          `trading-calendar 覆盖声明未推进: ${JSON.stringify({ market, filled, current, reason: advanced.reason })}`,
        );
        return;
      }

      const data = {
        coveredFrom: new Date(`${advanced.coverage.from}T00:00:00Z`),
        coveredTo: new Date(`${advanced.coverage.to}T00:00:00Z`),
        servedBy,
      };
      await this.prisma.calendarCoverage.upsert({
        where: { market },
        create: { market, ...data },
        update: data,
      });
    } catch (covErr) {
      this.logger.error(
        `trading-calendar 覆盖声明写入失败 (填充本身已成功, 视野暂不前进): ${JSON.stringify({ market, filled, error: String(covErr) })}`,
      );
    }
  }

  /**
   * per-market 心跳 upsert (`calendar_sync_health`)。**liveness 而非 freshness**: 填充成功即刷
   * `lastSuccessAt` —— 长假「成功但零新增」心跳照样新 (不误报, SC-005); app 挂掉心跳自然陈旧
   * (照样告警, FR-010)。
   *
   * · 成功 → `lastSuccessAt` + `servedBy` (**降级 ≠ 健康**, FR-014: 记胜出层, 非主源 → 探针告警)
   *   + 清 `lastError` (恢复的市场不该挂着陈年错误)。
   * · 失败 → 只动 `lastAttemptAt` + `lastError`; `lastSuccessAt`/`servedBy` **纹丝不动**
   *   ——「本次跑过」绝不等于「本次成功」。
   *
   * 🚨 心跳是**观测面**, 自身写失败只记 ERROR 不外抛: 否则 PG 抖动会把「一市场坏不拖垮全局」
   * (FR-004) 反噬掉 —— 观测设施不该反过来当故障源。
   */
  private async recordHeartbeat(market: string, servedBy?: string, err?: unknown): Promise<void> {
    const at = new Date();
    const data =
      err === undefined
        ? { lastSuccessAt: at, lastAttemptAt: at, lastError: null, servedBy }
        : { lastAttemptAt: at, lastError: String(err).slice(0, ERROR_TEXT_MAX) };
    try {
      await this.prisma.calendarSyncHealth.upsert({
        where: { market },
        create: { market, ...data },
        update: data,
      });
    } catch (hbErr) {
      this.logger.error(
        `trading-calendar 心跳写入失败 (不影响填充结果): ${JSON.stringify({ market, error: String(hbErr) })}`,
      );
    }
  }
}
