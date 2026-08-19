import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../security/prisma.service.js';
import type { ExecutorInput, ExecutorSyncDimensionRow } from './dimension-executor.js';
import {
  EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS,
  EARNINGS_CALENDAR_PORT,
  EarningsCalendarBudgetExhaustedError,
  type EarningsCalendarEvent,
  type EarningsCalendarPort,
} from './earnings-calendar.port.js';
import type { SyncRunStats } from './sync-run.recorder.js';
import { exchangeCalendarDateForScope } from './session-clock.js';

/**
 * 财报日历维度 use case (047 T019, FR-026/027/034/035a/035b/036/037)。
 *
 * 一轮到底: 前向视野切成合规窗序列 (端点差 ≤ {@link EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS}
 * 天) → 逐窗取**全市场**财报事件 → 与库内同一视野的行做
 * PIT diff → 新事件 insert / 改期与订正 update, 落 `marketdata.earnings_event`。
 *
 * ## 🚨 工作集 = 固定前向时间窗序列, **不挂锚闸** (FR-035a, tasks Guardrail 2, plan D-DATA-1)
 *
 * 本 use case **不接受 `instruments` 入参**, 且注册时**刻意不走 `factExecutor`** —— 那条路径
 * 起手就 `loadActiveInstruments`(`market ∈ scope ∧ active ∧ needSync`), 一挂上去零锚时工作集
 * 为空 ⇒ **整个维度静默不跑**, 而且**不会红**。
 *
 * **判据是「接口是不是 per-code」, 不是「维度归属哪一片」**: `get_earnings_calendar(US)` 是
 * **市场级**接口 (单次一个合规窗返全市场), 调用数只跟前向视野有关、**与锚有几只完全无关**
 * (SC-006a) ⇒ 锚闸对它零收窄作用, 挂了只有坏处。`dim.marketScope` 对本维度**只是元数据**
 * (决定业务日期时区与问哪个市场), 不用来推导工作集。
 *
 * 📌 046 已在 `us_index_daily` 上订正过一次同形状问题 (FR-026 → FR-027), 本片是**第三次**。
 * 形态上它属于「自己管自己前置」的那一类 (同 `us_index_daily`), 不是 fact 维度。
 *
 * ## 🚨 每日重拉**整个**前向视野, 不是只拉增量窗 (FR-034 / plan D-DATA-9)
 *
 * PIT diff 要发现的是「**已公布的日期被改了**」—— 只拉新窗永远看不到旧窗里的改动 (改期发生在
 * 早已拉过的那一天上)。⇒ 每晚 {@link EARNINGS_FORWARD_HORIZON_DAYS} 天视野整段重来, 约
 * {@link planEarningsWindows} 31 次调用, 该数**与锚数量无关**。
 *
 * ## 🚨 全市场落库 (FR-035b)
 *
 * 拉回什么存什么, **不按锚白名单收窄**。理由不是「顺手多存点」而是 PIT 语义本身:
 * `first_seen_at` / `date_changed_at` 只有**连续观察**才成立 —— 只落白名单则某票建锚**之前**
 * 的改期史永久缺失, 且建锚后 `first_seen_at` 会变成「建锚那天」, **语义是错的, 不只是缺数据**。
 * 红利: 新建锚的票, 其财报数据**建锚当刻即在库**, 无需等下一轮 (比 FR-038 对另两个维度的保证
 * 更强)。
 *
 * ## 🚨 `Instrument` 表外的标的 → 跳过并计数, **MUST NOT 改幂等键绕 FK** (plan D-DATA-8)
 *
 * 全市场必然撞上库里没有的票 (新上市 / OTC)。跳过并把计数**上抛作监控信号** (WARN +
 * `failedTargets` 审计明细 → `SyncRun`): 该数**持续升高 = universe 枚举漏了一类标的**。把幂等键
 * 改成不依赖 `Instrument` 的裸 (市场, 代码) 能让这些行落库, 但会同时废掉「标的」这个概念在
 * 本表的锚点, 且让漏枚举彻底静默。
 *
 * ## PIT 事件同一性 (FR-027)
 *
 * 「同一次财报」跨日的识别按**三趟**收敛, 每趟都不猜:
 *
 * 1. **同日期** —— 库内该标的已有同日行 ⇒ 就是它 (常态: 日期没变, 只是 eps 由预估变实际)。
 * 2. **同报告期** (`period_text`, vendor 自己的事件身份) 且日期不同 ⇒ **改期**: 原地改
 *    `earnings_date`, 记 `prev_earnings_date` + `date_changed_at`, `first_seen_at` **不动**。
 * 3. 双方**各恰好剩一条** ⇒ 无歧义配对 (vendor 未给 `period_text` 时改期只能这么认)。
 *    剩多条则**一律当新事件 insert**, 宁可少认一次改期也不乱配对。
 *
 * 🚫 **改期 MUST 原地改而不是插新行**: 插新行会让旧日期那条**留在库里继续声称那天有财报**,
 * 下游跨财报判定会照着一个已经不存在的日期打标 —— 而两条路径都不会红。
 *
 * ## 幂等 (FR-037)
 *
 * 同日重跑: 三趟全部命中「同日期」且字段逐个相等 ⇒ **零 insert 零 update**,
 * `date_changed_at` 不被扰动 (它一被无谓刷新, 复核名单就再也不可信)。insert 侧另有
 * `createMany(skipDuplicates)` 兜底幂等键 `(instrument_id, earnings_date)`。
 */

/**
 * 前向视野天数。vendor 的财报日历可得视野约 6 个月 (p3b E8), 取 182 天 = 26 周。
 *
 * 📌 **不必被窗宽整除** —— 除不尽时 {@link planEarningsWindows} 把末窗夹紧到视野末端 (窗宽是
 * vendor 的硬约束, 视野是我们的业务选择, 让后者去迁就前者会把两件事绑成一个数)。
 *
 * 📌 **超视野的到期日落 FR-026 三态之「无」是预期状态, 不是缺陷** —— 本片采到 LEAPS
 * (FR-032), 远月腿天然没有财报数据。🚫 MUST NOT 为此把「无日期」渲染成「不跨财报」。
 */
export const EARNINGS_FORWARD_HORIZON_DAYS = 182;

/** 单次 `createMany` 的行数配额 (同 `sync-option-contract.usecase.ts` 的 `CONTRACT_ROW_CHUNK`)。 */
const EARNINGS_ROW_CHUNK = 500;

/** 库外标的 WARN 里附带的样本上限 (够定位是哪一类标的, 又不把日志刷爆)。 */
const UNMATCHED_SAMPLE_LIMIT = 10;

/** `YYYY-MM-DD` → `@db.Date` 列的 UTC 零点 Date。 */
const toDateOnly = (s: string): Date => new Date(`${s}T00:00:00Z`);

/** UTC `Date` → `YYYY-MM-DD`。 */
const toIsoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** `YYYY-MM-DD` 加 n 天 (UTC)。 */
function addDays(dateStr: string, days: number): string {
  const d = toDateOnly(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/** 切片成 size 大小的块。 */
function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 一个前向视野窗 (闭区间, 端点差 = {@link EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS})。 */
export interface EarningsWindow {
  start: string;
  end: string;
}

/**
 * 前向视野 → 窗序列 (FR-034)。**与锚数量无关**, 这正是 SC-006a 的可验证判据。
 *
 * 步长取窗宽本身 ⇒ 相邻窗**共享一个端点日** (窗 i 的 `end` = 窗 i+1 的 `start`)。重叠是**刻意**
 * 的: 不对称性一边倒 —— 重叠一天在幂等落库下是零成本的 no-op, 而少一天则是「那一天全市场的
 * 财报没有任何一次请求会问起」, 且缺口完全静默。
 *
 * 🚨 末窗**夹紧到视野末端** (视野未必被窗宽整除: 182 / 6 除不尽)。越过视野的那几天会被拿回来,
 * 却落在 {@link SyncEarningsEventUseCase} 取既有行的区间之外 ⇒ 它们每天都被当成「第一次见」
 * 重新 diff, `first_seen_at` 天天刷新、改期认不出来 —— PIT 三件套失真且全程不红。
 *
 * 复杂度 O(视野 / 窗宽) = 31 个窗 (端点差 6 ⇒ 含首尾 7 天/窗)。
 */
export function planEarningsWindows(businessDate: string): EarningsWindow[] {
  const windows: EarningsWindow[] = [];
  for (
    let offset = 0;
    offset < EARNINGS_FORWARD_HORIZON_DAYS;
    offset += EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS
  ) {
    windows.push({
      start: addDays(businessDate, offset),
      end: addDays(
        businessDate,
        Math.min(offset + EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS, EARNINGS_FORWARD_HORIZON_DAYS),
      ),
    });
  }
  return windows;
}

/** 库内既有行的最小投影 (diff 只需要身份 + 可变字段)。 */
interface ExistingEarningsRow {
  id: bigint;
  instrumentId: bigint;
  earningsDate: Date;
  pubType: string;
  periodText: string | null;
  epsActual: Prisma.Decimal | null;
  epsPredict: Prisma.Decimal | null;
}

/** 一条待改期记录 (WARN 复核名单 + `SyncRun` 审计明细共用)。 */
interface EarningsDateChange {
  symbol: string;
  from: string;
  to: string;
  periodText: string | null;
}

/**
 * Decimal 列与端口给的 string 是否等值。
 *
 * 🚨 **不能比字符串**: PG `numeric(18,6)` 取回来是 `'2.310000'`, 端口给的是 `'2.31'` ——
 * 按字面比会把每一行都判成「变了」, 于是每晚全表 UPDATE 一遍 (慢, 且把真正的变更淹掉)。
 */
function decimalEquals(existing: Prisma.Decimal | null, observed: string | null): boolean {
  if (existing === null || observed === null) return existing === null && observed === null;
  return existing.equals(new Prisma.Decimal(observed));
}

@Injectable()
export class SyncEarningsEventUseCase {
  private readonly logger = new Logger(SyncEarningsEventUseCase.name);

  constructor(
    @Inject(EARNINGS_CALENDAR_PORT) private readonly calendar: EarningsCalendarPort,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 一轮财报日历同步。返 `true` = vendor 预算耗尽 (顺延信号, `ExecutorResult.budgetExhausted`)。
   *
   * **per-window 隔离**: 单窗失败计 `failed` + `failedTargets` 后继续下一窗, 不整轮塌
   * (财报日历每日重拉整个视野 ⇒ 当窗失败次日自愈); **HTTP 全在事务外**。
   *
   * 计数单位 (同 `us_index_daily` 的记账口径): `scanned` / `ok` / `skipped` 是**事件行**,
   * `failed` 是**窗** —— 取数失败时一行都没拿到, 没有行可计。正常路径下
   * `scanned = ok + skipped` 恒成立。
   *
   * 复杂度: O(市场数 × 31) 次 HTTP + 1 次标的表全量读 + 1 次视野内既有行区间读 +
   * O(新增行 / 500) 次 createMany + O(**真变更**行) 次 update (稳态趋近 0)。
   */
  async run(
    dim: ExecutorSyncDimensionRow,
    stats: SyncRunStats,
    input: ExecutorInput,
  ): Promise<boolean> {
    // 🚨 业务日期按 us 市场时区 (FR-036), **不吃 `input.asOf`** —— 后者是**入队时刻**算的,
    // 而前向视野窗要从**执行时刻**的交易所今天起算 (ADR-0066: event time ≠ processing time);
    // 且运维显式 `--as-of <过去某天>` 会把视野窗整体前移, 漏掉近端财报。
    const businessDate = exchangeCalendarDateForScope(dim.marketScope, input.now);
    const horizonEnd = addDays(businessDate, EARNINGS_FORWARD_HORIZON_DAYS);

    const { observed, budgetExhausted } = await this.fetchHorizon(dim, businessDate, stats);
    stats.scanned += observed.size;
    if (observed.size === 0) return budgetExhausted;

    const byInstrument = await this.groupByInstrument(observed, dim.marketScope, stats);
    if (byInstrument.size === 0) return budgetExhausted;

    const existing = await this.loadExistingRows(businessDate, horizonEnd);
    const inserts: Prisma.EarningsEventCreateManyInput[] = [];
    const updates: { id: bigint; data: Prisma.EarningsEventUpdateInput }[] = [];
    const changes: EarningsDateChange[] = [];

    for (const [instrumentId, events] of byInstrument) {
      this.diffInstrument(
        { instrumentId, events, rows: existing.get(instrumentId) ?? [], now: input.now },
        { inserts, updates, changes },
      );
    }

    for (const chunk of chunked(inserts, EARNINGS_ROW_CHUNK)) {
      await this.prisma.earningsEvent.createMany({ data: chunk, skipDuplicates: true });
    }
    for (const { id, data } of updates) {
      await this.prisma.earningsEvent.update({ where: { id }, data });
    }
    this.reportDateChanges(changes, stats);

    return budgetExhausted;
  }

  /**
   * 逐窗取全市场事件, 按 `(标的, 财报日)` 去重。
   *
   * 相邻窗共享端点日 ⇒ 边界那天的事件会被拿到两次, 去重后语义不变 (窗重叠是刻意的, 见
   * {@link planEarningsWindows})。同一 `(标的, 财报日)` 若 vendor 给了多行 (一票多报告期),
   * 幂等键本就只容得下一行, 这里取最后一条。
   */
  private async fetchHorizon(
    dim: ExecutorSyncDimensionRow,
    businessDate: string,
    stats: SyncRunStats,
  ): Promise<{ observed: Map<string, EarningsCalendarEvent>; budgetExhausted: boolean }> {
    const observed = new Map<string, EarningsCalendarEvent>();
    // 🚨 窗序列**只由业务日期推导**, 与锚表无任何关系 (Guardrail 2 / SC-006a)。
    const plan = dim.marketScope.flatMap((market) =>
      planEarningsWindows(businessDate).map((window) => ({ market, ...window })),
    );

    for (const { market, start, end } of plan) {
      try {
        const events = await this.calendar.getWindow({ market, start, end }); // HTTP (事务外)
        for (const event of events) {
          observed.set(`${event.underlyingSymbol} ${event.earningsDate}`, event);
        }
      } catch (err) {
        if (err instanceof EarningsCalendarBudgetExhaustedError) {
          // deferral ≠ failure: 剩余窗整批顺延下一轮, 不耗 attempts。已取到的窗照常落库 ——
          // 财报日历每日整段重拉, 半份视野不会沉淀成缺口。
          this.logger.warn(
            `财报日历限频顺延 (已取 ${observed.size} 条, 剩余窗下一轮续跑): ${market} ${start}..${end}`,
          );
          return { observed, budgetExhausted: true };
        }
        // 窗级隔离: Rejected (永久) 与 5xx / 契约变更同处置 —— 都不该让其余那些窗陪葬。
        stats.failed++;
        stats.failedTargets.push({
          symbol: `${market} ${start}..${end}`,
          step: 'earnings_event',
          error: String(err),
        });
        this.logger.warn(
          `财报日历取数失败 (窗级隔离, 次日整段重拉自愈): ${market} ${start}..${end} ${String(err)}`,
        );
      }
    }
    return { observed, budgetExhausted: false };
  }

  /**
   * 观测事件 → 按 `instrument_id` 分组; **库外标的跳过并计数** (plan D-DATA-8)。
   *
   * 一次性读全 `marketScope` 的标的表 (us 约 1.9 万行的两个短字符串列) 而不是拼一个几千元素的
   * `IN` 列表: 全市场财报的去重标的数本就与库内标的数同量级, 一次全量读换掉一个巨型
   * `IN` 更稳且更快。
   */
  private async groupByInstrument(
    observed: Map<string, EarningsCalendarEvent>,
    marketScope: string[],
    stats: SyncRunStats,
  ): Promise<Map<bigint, EarningsCalendarEvent[]>> {
    const instruments = await this.prisma.instrument.findMany({
      where: { market: { in: marketScope } },
      select: { id: true, market: true, code: true },
    });
    const idBySymbol = new Map(instruments.map((i) => [`${i.market}:${i.code}`, i.id]));

    const byInstrument = new Map<bigint, EarningsCalendarEvent[]>();
    const unmatched: string[] = [];
    let unmatchedCount = 0;

    for (const event of observed.values()) {
      const instrumentId = idBySymbol.get(event.underlyingSymbol);
      if (instrumentId === undefined) {
        unmatchedCount++;
        if (unmatched.length < UNMATCHED_SAMPLE_LIMIT) unmatched.push(event.underlyingSymbol);
        continue;
      }
      const bucket = byInstrument.get(instrumentId);
      if (bucket === undefined) byInstrument.set(instrumentId, [event]);
      else bucket.push(event);
    }

    stats.ok += observed.size - unmatchedCount;
    if (unmatchedCount > 0) {
      stats.skipped += unmatchedCount;
      // 🚨 这个计数是**监控信号**不是噪音: 持续升高 = universe 枚举漏了一类标的。
      this.logger.warn(
        `财报日历有 ${unmatchedCount} 条事件的标的不在 Instrument 表内 (已跳过保 FK; ` +
          `持续升高 = universe 枚举漏了一类标的): 样本 ${unmatched.join(', ')}`,
      );
      stats.failedTargets.push({
        step: 'earnings_instrument_unmatched',
        unmatched: unmatchedCount,
        samples: unmatched,
      });
    }
    return byInstrument;
  }

  /**
   * 载入**与本轮重拉范围同一区间**的既有行, 按 `instrument_id` 分组。
   *
   * 区间口径 = 本轮窗序列的并集 ⇒ diff 只对「今晚真的重问过的日期」下结论。窗外的既有行不参与
   * (没问过就不该断言它变没变)。vendor 若返回窗外行, 它照常 insert, 只是不参与本轮 diff ——
   * `createMany(skipDuplicates)` 兜住幂等。
   *
   * 走 `ix_earnings_event_date` 上的区间扫描, **不拼 instrument_id 的巨型 `IN`**。
   */
  private async loadExistingRows(
    businessDate: string,
    horizonEnd: string,
  ): Promise<Map<bigint, ExistingEarningsRow[]>> {
    const rows: ExistingEarningsRow[] = await this.prisma.earningsEvent.findMany({
      where: { earningsDate: { gte: toDateOnly(businessDate), lte: toDateOnly(horizonEnd) } },
      select: {
        id: true,
        instrumentId: true,
        earningsDate: true,
        pubType: true,
        periodText: true,
        epsActual: true,
        epsPredict: true,
      },
    });

    const byInstrument = new Map<bigint, ExistingEarningsRow[]>();
    for (const row of rows) {
      const bucket = byInstrument.get(row.instrumentId);
      if (bucket === undefined) byInstrument.set(row.instrumentId, [row]);
      else bucket.push(row);
    }
    return byInstrument;
  }

  /**
   * 单标的 PIT diff: 三趟收敛出「同一次财报」, 产出 insert / update / 改期名单。
   *
   * 三趟的判据与不猜的理由见类注释「PIT 事件同一性」。复杂度 O(该标的事件数), 全内存。
   */
  private diffInstrument(
    ctx: {
      instrumentId: bigint;
      events: EarningsCalendarEvent[];
      rows: ExistingEarningsRow[];
      now: Date;
    },
    out: {
      inserts: Prisma.EarningsEventCreateManyInput[];
      updates: { id: bigint; data: Prisma.EarningsEventUpdateInput }[];
      changes: EarningsDateChange[];
    },
  ): void {
    const claimed = new Set<bigint>();
    const pairs: { event: EarningsCalendarEvent; row: ExistingEarningsRow }[] = [];
    let pending = ctx.events;

    // 第一趟: 同日期 —— 常态 (日期没变, 只是 eps 由预估变实际)。
    const byDate = new Map(ctx.rows.map((r) => [toIsoDate(r.earningsDate), r]));
    pending = pending.filter((event) => {
      const row = byDate.get(event.earningsDate);
      if (row === undefined || claimed.has(row.id)) return true;
      claimed.add(row.id);
      pairs.push({ event, row });
      return false;
    });

    // 第二趟: 同报告期 (vendor 自己的事件身份) 且日期不同 ⇒ 改期。
    const byPeriod = new Map(
      ctx.rows.filter((r) => r.periodText !== null).map((r) => [r.periodText as string, r]),
    );
    pending = pending.filter((event) => {
      const row = event.periodText === null ? undefined : byPeriod.get(event.periodText);
      if (row === undefined || claimed.has(row.id)) return true;
      claimed.add(row.id);
      pairs.push({ event, row });
      return false;
    });

    // 第三趟: 双方各恰好剩一条 ⇒ 无歧义配对 (vendor 未给 period_text 时, 改期只能这么认)。
    // 剩多条则**一律当新事件**: 乱配对会写出一条假的改期史, 比少认一次改期坏得多。
    const leftoverRows = ctx.rows.filter((r) => !claimed.has(r.id));
    if (pending.length === 1 && leftoverRows.length === 1) {
      pairs.push({ event: pending[0], row: leftoverRows[0] });
      pending = [];
    }

    for (const event of pending) out.inserts.push(this.insertRow(ctx.instrumentId, event, ctx.now));
    for (const { event, row } of pairs) {
      const update = this.updateFor(event, row, ctx.now);
      if (update === null) continue; // 逐字段相等 ⇒ 零写 (同日重跑幂等, FR-037)
      out.updates.push({ id: row.id, data: update });
      if (update.earningsDate !== undefined) {
        out.changes.push({
          symbol: event.underlyingSymbol,
          from: toIsoDate(row.earningsDate),
          to: event.earningsDate,
          periodText: event.periodText,
        });
      }
    }
  }

  /**
   * 新事件行。`first_seen_at` **显式落注入时钟**而非 DB `now()` 默认值: 它与
   * `date_changed_at` 必须同一把钟, 否则 PIT 两列一个来自库、一个来自控时注入, 回填与测试里
   * 的先后顺序会倒过来 (而那正是本表唯一要承载的信息)。
   */
  private insertRow(
    instrumentId: bigint,
    event: EarningsCalendarEvent,
    now: Date,
  ): Prisma.EarningsEventCreateManyInput {
    return {
      instrumentId,
      earningsDate: toDateOnly(event.earningsDate),
      pubType: event.pubType,
      periodText: event.periodText,
      // 金融数值全程 string 直传 Decimal 列 (FR-S08); 未公布恒 null, 禁 0 冒充。
      epsActual: event.epsActual,
      epsPredict: event.epsPredict,
      firstSeenAt: now,
    };
  }

  /**
   * 既有行 → 更新片段; **逐字段全等则返 `null`** (不写 = 幂等)。
   *
   * 改期时一并落 `prev_earnings_date` + `date_changed_at`, 且 `first_seen_at` **绝不重写** ——
   * 它的意思是「这次财报第一次被我们看见的时刻」, 改期不改变这件事。
   */
  private updateFor(
    event: EarningsCalendarEvent,
    row: ExistingEarningsRow,
    now: Date,
  ): Prisma.EarningsEventUpdateInput | null {
    const dateChanged = toIsoDate(row.earningsDate) !== event.earningsDate;
    const fieldsChanged =
      row.pubType !== event.pubType ||
      row.periodText !== event.periodText ||
      !decimalEquals(row.epsActual, event.epsActual) ||
      !decimalEquals(row.epsPredict, event.epsPredict);
    if (!dateChanged && !fieldsChanged) return null;

    return {
      pubType: event.pubType,
      periodText: event.periodText,
      epsActual: event.epsActual,
      epsPredict: event.epsPredict,
      ...(dateChanged
        ? {
            earningsDate: toDateOnly(event.earningsDate),
            prevEarningsDate: row.earningsDate,
            dateChangedAt: now,
          }
        : {}),
    };
  }

  /**
   * 改期 → **WARN 复核名单** + `SyncRun` 审计明细 (FR-027)。
   *
   * 两条通路都要: WARN 是当下能被人看见的那条, `failedTargets` 是事后可查询的那条。
   * 🚫 计数**不计 `failed`** —— 改期不是本轮同步的失败, 它是本维度存在的理由。
   */
  private reportDateChanges(changes: EarningsDateChange[], stats: SyncRunStats): void {
    if (changes.length === 0) return;
    this.logger.warn(
      `财报日相较库内记录发生变更 ${changes.length} 条 (已记 PIT, 进复核名单): ` +
        changes.map((c) => `${c.symbol} ${c.from}→${c.to}`).join(' | '),
    );
    stats.failedTargets.push({ step: 'earnings_date_changed', changed: changes.length, changes });
  }
}
