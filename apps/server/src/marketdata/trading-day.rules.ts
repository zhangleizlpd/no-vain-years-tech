/**
 * **交易日三态判据**（062 T001, FR-010 / FR-011, plan §D2）。纯函数、无 I/O、无 DI
 * （ADR-0043 §4）。
 *
 * 病根：`trading_day` 只向后填充，而读侧把「无记录」读成「不是交易日」（closed-world
 * assumption）⇒ 今天那一行落库之前，所有问「今天是不是交易日」的消费方都拿到静默的错误答案。
 * 修法不是换源、也不是把窗口调宽，而是让「**还没到**」与「**不是交易日**」在类型上分开：布尔
 * 必然把「未知」折进「不是」，三态才折不掉。
 *
 * 🚨 **本文件 MUST 保持零 IO / 零 class / 零 DI** —— 不接 `PrismaService`、不 import 任何
 * Prisma 类型。带 IO 进去会当场触发 **ADR-0053 sunset_trigger #1**，`marketdata-rules` 这个
 * 细分元素的判据随即失效，而那条元素是 `alert` ctx 唯一的合法跨 ctx 边。
 * ⚠️ `eslint-plugin-boundaries` 只看**路径**不看内容 ⇒ 这条它拦不住，只能靠读到这里的人守。
 *
 * 两个事实（该日有没有行 / 该市场声明覆盖到哪儿）由各消费 ctx 用**自己的合法边**取到再喂进来：
 * `alert` 自持 `PrismaService` 只读直查（`CROSS-CONTEXT-READ`），`optionsdesk` 注入
 * `TRADING_CALENDAR_PORT`（`CROSS-CONTEXT-SYNC`）。**MUST NOT** 为了「少写两行」把查询搬进
 * 本文件 —— 搬进来 alert → `trading_day` 这条跨 ctx 读边就从 `check-server-moat` 视野里消失了。
 */

/**
 * 三态判定结果。**互斥且穷尽**：
 * · `trading` —— 该日有记录，是交易日。
 * · `non-trading` —— 该日无记录，**且**该日落在已声明的覆盖区间内 ⇒ 「填过了，确实没有」。
 * · `unknown` —— 该日无记录，且落在覆盖区间之外（含无声明）⇒ 「根本没填到这儿」。
 *
 * 🚫 **MUST NOT** 有人后来加一个布尔便捷函数（`isTradingDay(...) => status === 'trading'`）:
 * 那等于把三态又折回二态，且折的方向恰好是本 feature 要消灭的那个（`unknown` → 假）。消费方
 * 对 `unknown` 的处置**按调用点语义分派**（见 spec `state_branches` 5–9），不存在通用默认值。
 */
export type TradingDayStatus = 'trading' | 'non-trading' | 'unknown';

/** 某市场的交易日历覆盖声明（闭区间，`YYYY-MM-DD`）。`null` = 该市场尚无任何声明。 */
export interface CalendarCoverageRange {
  from: string;
  to: string;
}

export interface ClassifyTradingDayInput {
  /** 该 (market, date) 在 `trading_day` 有没有行。 */
  hasExactRow: boolean;
  /** 该市场的覆盖声明；`null` = 尚无声明（首次上线 / 被清空）。 */
  coverage: CalendarCoverageRange | null;
  /** 被判定的日期（该市场交易所时区的「今天」，`YYYY-MM-DD`）。 */
  date: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ISO 日期格式闸 —— 覆盖判定靠**字典序比较**（`YYYY-MM-DD` 下等价于时序），格式不合即比较
 * 无意义 ⇒ 必须先 throw，否则 `'2026/03/01' >= '2026-01-01'` 之类会**静默误判为在覆盖内**
 * （体例照 `static-calendar.adapter.ts` 的同名守卫）。
 */
function assertIsoDate(date: string, field: string): void {
  if (!ISO_DATE_RE.test(date)) {
    throw new Error(`[trading-day] 非法日期 ${field}="${date}" (须 YYYY-MM-DD)`);
  }
}

/**
 * 三态判定。复杂度 O(1)（两次字典序比较）。
 *
 * 🚨 `coverage === null` → **`unknown`**，绝不是 `non-trading`。「没有声明」意味着从没人承诺
 * 过填到哪儿；把它读成 `non-trading` 就是把「库里没有的即为假」换个地方原样犯一遍，且犯在
 * **首次上线**那一刻（声明为空 ⇒ 全市场被判休市 ⇒ 整体静默停摆）。单测里有一条专门的反例断言
 * 钉住这点。
 *
 * ⚠️ 格式校验在 `hasExactRow` 短路**之前**：脏日期串不该因为「恰好有行」而漏网 —— 它下一次
 * 落在别的分支上就会静默参与比较。
 *
 * ⚠️ 蓄意**不**校验 `from <= to`：区间反了会让每个日期都落到区间外 ⇒ 一律 `unknown`，那是判据
 * 的**安全侧**（各消费方按 unknown 分派继续工作 + 视野探针告警），不需要在这里抛。
 */
export function classifyTradingDay({
  hasExactRow,
  coverage,
  date,
}: ClassifyTradingDayInput): TradingDayStatus {
  assertIsoDate(date, 'date');
  if (coverage !== null) {
    assertIsoDate(coverage.from, 'coverage.from');
    assertIsoDate(coverage.to, 'coverage.to');
  }

  if (hasExactRow) return 'trading';
  if (coverage === null) return 'unknown';
  return date >= coverage.from && date <= coverage.to ? 'non-trading' : 'unknown';
}
