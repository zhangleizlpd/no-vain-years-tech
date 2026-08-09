/**
 * 财报日历端口 (047 T018, FR-034 / plan D-SHIM)。**capability-scoped** —— 一个端口 = 一种能力
 * (沿仓内既有 28 个端口的惯例): 「取某市场一个日期窗内的全部财报事件」这件事, 换成
 * Nasdaq / 嘉信也是同一份接口, 只换 adapter。
 *
 * ## 🚨 这是**市场级**接口, 不是 per-code (tasks Guardrail 2 / plan D-DATA-1)
 *
 * 查询入参是 **`market` + 日期窗**, **没有** `symbol` / `codes` —— 一发返该市场窗内**全部**
 * 标的 (实测峰值周 1559 条, p3b E8)。这不是"少写了一个可选过滤参数", 是**结构上的保证**:
 *
 * - 调用数只跟**前向视野**有关, 与锚有几只**完全无关** ⇒ 锚闸对它零收窄作用, 挂上去只会
 *   复刻 046 `FR-027` 那个坑 (零锚时静默不采, 且**不会红**)。**判据是「接口是不是 per-code」,
 *   不是「维度归属哪一片」** —— 046 已在指数维度上订正过一次同形状问题, 本片是第三次。
 * - 消费端按白名单收窄看着省事, 但 PIT 三件套 (`first_seen_at` / `date_changed_at` /
 *   变更前日期) 只有**连续观察全市场**才成立: 日后加一只票时, 它此前的改期史无从回补,
 *   且 `first_seen_at` 会变成「建锚那天」—— **语义是错的, 不只是缺数据** (FR-035b)。
 *   ⇒ 过滤既不发生在 shim 侧 (`filter_list` 恒不传), 也不发生在本端口。
 *
 * ## 窗宽是硬约束 (`EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS`)
 *
 * 超窗一律**在本地前置拒绝**、**绝不截断** (被悄悄裁掉的那几天在下游读作「那几天全市场没有
 * 财报」)。上限的真值与实测证据见该常量注释。分窗是调用方的事, 见
 * `sync-earnings-event.usecase.ts` 的前向视野窗序列。
 *
 * ## 失败语义显式 (同 `option-chain.port.ts` / `option-snapshot.port.ts` 的同一对, 不另造第三套)
 *
 * | 结局 | 错误 | 调用方处置 |
 * | --- | --- | --- |
 * | 限频耗尽 (429) | {@link EarningsCalendarBudgetExhaustedError} | **顺延重入队, 不耗 attempts** (deferral ≠ failure) |
 * | 参数被永久拒绝 (400 / 本地前置拒绝) | {@link EarningsCalendarRejectedError} | 计 failed 继续下一窗, **重试无意义** |
 *
 * 其余 (5xx / 网络 / 契约变更) 原样上抛 —— 吞成上面任一类都会把「vendor 坏了」说成
 * 「预算用完了」或「参数写错了」, 两种都会让真故障静默顺延。
 *
 * 金融数值一律 `string | null` 跨边界 (FR-S08 全 marketdata 惯例): 落库列是 `Decimal`,
 * 中途走一趟 JS `number` 就把精度丢在半路。
 */

/** DI token。 */
export const EARNINGS_CALENDAR_PORT = Symbol('EARNINGS_CALENDAR_PORT');

/**
 * 单窗 `start` / `end` 的**端点差**上限 (自然日)。
 *
 * 🚨 **6, 不是官方原文那个 7** —— 原文「与 beginDate 间隔不超过 7 天」说的是**含首尾的 7 天窗**。
 * 2026-08-07 打真 shim 实测 (三个相隔一个多月的 start: 08-07 / 09-02 / 10-19, **3/3 一致**):
 *
 * | 端点差 | 真端结局 |
 * | --- | --- |
 * | 5 / 6 | 200 |
 * | **7** | **502 `NN_ProtoRet_SvrFailed`** (vendor 侧炸, 不是 400) |
 * | 8 | shim 自己的 400「window too wide」 |
 *
 * 本常量曾按端点差读作 7 (宽整一天) ⇒ 窗序列切出的**每一个**窗都恰好差 7 ⇒ 财报采集**窗窗 502**;
 * 而 502 映射成瞬时错误 ⇒ 一路重试 / 顺延, **永远不会以「参数错」的形状说出来**, 只表现为
 * 「财报维度一直很慢」。回归锚见 `test/integration/marketdata.futu-shim.vendor.spec.ts`。
 *
 * ✅ **2026-08-08 shim 侧已同步收紧到 6** (`services/futu-shim/src/futu_shim/app.py` 的
 * `EARNINGS_MAX_SPAN_DAYS`) ⇒ 端点差 7 现在在 shim 就 400, 不再漏到 vendor 变 502。同日复测把
 * 采样面扩到**端点差 0–8 全扫**, 并加了两条对照: **HK 同样 diff 7 → 502** (上限与市场无关);
 * **吃完 502 后回打 diff 6 仍 200 且 count 与首发一致** (⇒ 确定性参数拒绝, 非瞬时故障)。
 * 两侧同值是**刻意**的, 且各自独立成立: 本侧管「不发出非法窗」, shim 侧管「不放行非法窗」。
 */
export const EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS = 6;

/**
 * 单窗财报日历查询。**没有标的入参**是本端口的承重设计, 见文件头「市场级接口」。
 *
 * `start` / `end` 闭区间, 端点差 MUST ≤ {@link EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS}。
 */
export interface EarningsCalendarWindowQuery {
  /** canonical market (`us`); 非受支持市场由 adapter 直接抛, 零外呼。 */
  market: string;
  /** `YYYY-MM-DD`, 窗起 (含)。 */
  start: string;
  /** `YYYY-MM-DD`, 窗止 (含)。 */
  end: string;
}

/**
 * 一条财报事件 (`get_earnings_calendar` 一行)。与 `marketdata.earnings_event` 的 vendor 直给列
 * 逐列对应 —— PIT 三件套 (`first_seen_at` / `date_changed_at` / `prev_earnings_date`) **不在此**:
 * 它们是**我们自己观察出来的**, 由 use case 的逐日 diff 产出, vendor 无对应字段
 * (业界 confirmed/estimated 双状态与修订历史只在机构级付费源存在, p3b §6.3)。
 */
export interface EarningsCalendarEvent {
  /**
   * 标的 canonical `market:code` (vendor 的 `security` 翻译而来, `US.PEP` → `us:PEP`)。
   *
   * ⚠️ **全市场返回 ⇒ 这里会出现 `Instrument` 表内没有的标的** (新上市 / OTC)。那是预期状态,
   * 处置在 use case (跳过并计数作监控信号, FR-035b / plan D-DATA-8), **不在端口层过滤掉** ——
   * 过滤掉就没法数了。
   */
  underlyingSymbol: string;
  /** `YYYY-MM-DD` (vendor `earnings_date`)。 */
  earningsDate: string;
  /**
   * 盘前 / 盘后 / 盘中标记, **vendor 原样** (实测值域 `BEFORE` / `AFTER` / `REGULAR`, p3b E8)。
   *
   * 不在这里归一成自造枚举: 换算一次就再也说不清库里那个值是谁的口径 (同链接口对
   * `expiration_cycle` / `option_settlement_mode` 的处置)。缓冲判定该怎么读它是 T026 的事。
   */
  pubType: string;
  /** 报告期文本 (如 `Q3 2026`), vendor 原样; 缺失 null。 */
  periodText: string | null;
  /**
   * 每股收益**实际值**; 尚未公布 → null (**不回落 0** —— 0 是一个能被下游当真的业绩)。
   *
   * 它与 {@link epsPredict} 的组合正是 FR-026 三态里「已确认」与「预估」的判据来源:
   * 有 actual ⇒ 该期已公布; 只有 predict ⇒ 仍是前瞻预估。
   */
  epsActual: string | null;
  /** 每股收益**预期值**; 缺失 null。 */
  epsPredict: string | null;
}

/**
 * vendor 限频预算耗尽 (429 且退避重试后仍未过)。
 *
 * 🚨 **这不是失败, 是顺延信号** —— 调用方 MUST 转成 `ExecutorResult.budgetExhausted` 让 worker
 * 延迟重入队且**不耗 attempts** (D5 deferral ≠ failure)。判成 failure 会把「等 30 秒就能继续」
 * 的一轮记成红, 并白白吃掉重试次数。
 */
export class EarningsCalendarBudgetExhaustedError extends Error {
  constructor(what: string, cause?: unknown) {
    super(`[earnings-calendar] vendor 限频预算耗尽 (429), 应顺延重入队: ${what}`);
    this.name = 'EarningsCalendarBudgetExhaustedError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * 请求被**永久拒绝**: 窗跨度越界 / 非法日期 (本地前置拒绝或 shim 400)。
 *
 * 🚨 **不可重试** —— 窗宽是永久事实, 重试只是把同一个 400 再要一遍。调用方计 failed 后继续
 * 下一窗, MUST NOT 走顺延路径 (那会让一个永久性的参数错无限期占着队列)。
 */
export class EarningsCalendarRejectedError extends Error {
  constructor(what: string, cause?: unknown) {
    super(`[earnings-calendar] 请求被永久拒绝 (不可重试): ${what}`);
    this.name = 'EarningsCalendarRejectedError';
    if (cause !== undefined) this.cause = cause;
  }
}

export interface EarningsCalendarPort {
  /**
   * 单窗**全市场**财报事件。**单次调用 = 单个窗**, adapter 不做窗切分 —— 切分由 use case 的
   * 前向视野窗序列承担; 同一段边界逻辑写两遍必然漂移。
   *
   * 窗内该市场无财报 → 空数组 (合法状态, 非错误 —— 财报按季度高度聚集, 淡季整周为空是常态)。
   */
  getWindow(query: EarningsCalendarWindowQuery): Promise<EarningsCalendarEvent[]>;
}
