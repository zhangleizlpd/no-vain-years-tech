import { EARNINGS_FORWARD_HORIZON_DAYS } from '../marketdata/sync-earnings-event.usecase';

/**
 * 047 optionsdesk 财报打标纯函数 (ADR-0043 §4)。无 I/O、无 DI。
 *
 * 🚨 **签名不接受合约级输入, 这是 Guardrail 11 的结构保证而非事后断言** (plan D-UI-4):
 * 财报日是**标的属性不是合约属性** ⇒ 逐行算不会红, 但同一标的同一到期日会出现「一行标跨财报、
 * 另一行标不跨」的矛盾 (mockup 原数据实撞)。本文件的形态把这条钉死在类型上:
 *
 * 1. {@link earningsCalendarContext} 按**标的**算一次 (今天 / 覆盖窗右端 / 升序财报日);
 * 2. {@link earningsMark} 只吃 `(标的级日历, 到期日, 腿族)` —— 拿不到行权价 / bid / 档位;
 * 3. {@link earningsMarksByExpiry} 直接返 `到期日 → 标` 的 Map, 调用方**贴回**而不是逐行算;
 *    其腿族解析器签名亦为 `(到期日) => 腿族` ⇒ 想让腿族随合约变就必须先改签名。
 *
 * 📌 **腿族由调用方给, 本文件不推导**: 建仓 / 收租是**意图矩阵**的输出 (标的级, 见
 * `intent-matrix.rules.ts`), 长短是 DTE 的函数 (到期日级) —— 两者都不是合约级, 但都不在本文件
 * 的信息范围内。硬塞进来只会让本文件同时持有区间系数与 DTE 带宽两套口径。
 *
 * 🚫 **全部为提醒语义** (FR-025): 本文件只产出标, **零拦截 / 零置灰 / 零禁选** —— 呈现侧
 * MUST NOT 拿它做任何筛除或禁用。死档行照常打标 (FR-006): 打标发生在分档**之前**, 与档位正交。
 *
 * 📌 **顶部那个跨 ctx import 是常量不是行为** (D-ARCH-1): 取的是采集侧的前向视野天数
 * {@link EARNINGS_FORWARD_HORIZON_DAYS} —— 「覆盖窗右端」必须与**采集侧每日实际重拉的窗**
 * 逐字同源, 自写一个「约 6 个月」就是给同一个事实立第二个真相源 (Guardrail 12 正是这么塌的)。
 * 🚫 这**不是** Q7-C: 没有 `@Inject()` 对方 use case、没有跨 ctx 调用, 只是编译期取一个数;
 * 🚫 亦不触 Guardrail 14 (`marketdata/*.rules.ts` 的 ESLint disallow) —— 那是另一个文件族。
 *
 * 复杂度: 单票一次 `O(E log E)` 排序 (E = 该标的前向视野内财报行数, 量级 ≤ 4); 每个**到期日**
 * 一次二分 `O(log E)`; 腿行本身只做 `O(1)` Map 查表 ⇒ n 行合计 `O(n)`。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 值域常量
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 打标的三个域 (FR-023「按意图分域」)。
 *
 * - `build_position` —— 建仓腿, **恒无标** (建仓意图本就想接货, 财报跌反而是折扣);
 * - `rent_long` —— 收租长腿 (主形态), 看「已知利空是否出清覆盖」;
 * - `rent_short` —— 收租短腿 (SoT: 仅恐慌腿), 只看「是否跨财报」, **不算缓冲**。
 */
export const EARNINGS_LEG_FAMILIES = ['build_position', 'rent_long', 'rent_short'] as const;

export type EarningsLegFamily = (typeof EARNINGS_LEG_FAMILIES)[number];

/**
 * 五个标 (FR-023 / FR-026, mockup handoff「财报五形态同屏」)。
 *
 * 🚨 **`no_date` 与 `no_cross` 是两个值, MUST NOT 合并** (FR-026): 前者 = 我们**不知道**
 * (vendor 视野外 / 该标的零财报数据), 后者 = 我们**知道且确认不跨**。合并等于用「已确认」的
 * 语气说一件未知的事。呈现侧亦分开 (`no_date` = 虚线 chip · `no_cross` = 无 chip 纯文字)。
 *
 * 🚨 与**建仓腿的 `null`** 又是第三件事 (plan D-UI-4「`null` 与「无日期」是两个值」):
 * `null` = 按设计不打标 (UI 显「—」), `no_date` = 该打但数据不知道 (UI 显虚线 chip)。
 */
export const EARNINGS_MARKS = [
  /** 利空出清覆盖 ✓ —— 跨了财报, 但最后一个利空到到期日之间缓冲充足。 */
  'covered',
  /** 缓冲不足 +Nd —— 跨了财报, 缓冲不够; N = **还差几天** (FR-024 验收场景 2 原文)。 */
  'buffer_short',
  /** 跨财报 ⚠ —— 收租短腿跨了财报。提醒语义, 该腿仍可被选中 (FR-025)。 */
  'crosses_earnings',
  /** 不跨 —— 日历覆盖到了这个到期日, 且窗口内确认无财报。 */
  'no_cross',
  /** 无日期 —— 超 vendor 前向视野 (Guardrail 12) 或该标的整个视野内零财报行。 */
  'no_date',
] as const;

export type EarningsMark = (typeof EARNINGS_MARKS)[number];

/**
 * 收租长腿的最小消化缓冲 (日历日), 「最后利空 → 到期」这一侧。
 *
 * 📌 **起手值, 单点可改**: spec / plan 只给了「+Nd」的形态没给 N 的基准。取 7 的依据 =
 * 仓内唯一实装过的财报缓冲值 (策略 SoT 的 R1 财报护栏 `N=7`, 2026-07-29 该护栏退役改为本片的
 * 按意图分域打标, 但 7 这个「一个完整周消化利空」的量级随之保留)。策略 SoT 定档后改这一处即可,
 * 判定与呈现全链跟随 —— 与 `leg-tier.rules.ts` 六个档位边界同体例。
 */
export const EARNINGS_BUFFER_MIN_DAYS = 7;

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

/** 标的级财报日历上下文 —— 每个标的**每次请求算一次**, 供该票所有到期日共用。 */
export interface EarningsCalendarContext {
  /** canonical `market:code` —— 回显用, **不参与判定** (一个 context 只服务一个标的)。 */
  symbol: string;
  /** 交易所的今天 (`marketDateFor(['us'], now)`, canonical = cross-timezone-date-semantics §3)。 */
  today: string;
  /**
   * 财报日历当前覆盖窗右端 = `today + EARNINGS_FORWARD_HORIZON_DAYS`。
   * 超出它的到期日一律 `no_date` (Guardrail 12) —— 采集侧每日重拉的就是这个窗 (FR-034)。
   */
  coverageEnd: string;
  /** 该标的前向视野内的财报日, **升序去重**。空 = 该标的零财报数据 (⇒ 一律 `no_date`)。 */
  dates: readonly string[];
}

export interface EarningsMarkVerdict {
  mark: EarningsMark;
  /**
   * `buffer_short` 的 N —— **还差几天**凑够 {@link EARNINGS_BUFFER_MIN_DAYS} (spec 验收场景
   * 「给出还差几天」)。其余四标恒 `null`。
   *
   * ⚠️ mockup 帧①「缓冲不足 +3d」把 N 写成了**实际缓冲**天数 (该行缓冲恰好 3 天), 与 spec
   * 原文冲突 —— 以 spec 为准, 该帧记为 drift 不回改 (同帧⑦ 先例, per `sdd-authoring.md`)。
   */
  bufferShortfallDays: number | null;
  /**
   * 命中窗口内的**最后一个**财报日 (供呈现侧写悬浮说明); 未跨 / 无日期时 `null`。
   * 🚫 不参与判定 —— 判定只认 {@link mark}。
   */
  lastEarningsDate: string | null;
}

/** 腿族解析器: **只吃到期日** —— 想让腿族随合约变就必须先改这个签名 (Guardrail 11)。 */
export type LegFamilyByExpiry = (expiryDate: string) => EarningsLegFamily;

// ─────────────────────────────────────────────────────────────────────────────
// 派生
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 标的级日历上下文 (每票每请求一次)。`O(E log E)`, E = 该标的财报行数。
 *
 * @param today 交易所的今天 (`YYYY-MM-DD`)。🚫 MUST NOT 传宿主本地日期 —— 见 Guardrail 18。
 * @param earningsDates 该标的的财报日 (`YYYY-MM-DD`, 顺序不限, 允许重复)。
 */
export function earningsCalendarContext(
  symbol: string,
  today: string,
  earningsDates: readonly string[],
): EarningsCalendarContext {
  const todayEpoch = epochDay(today);
  const dates = [...new Set(earningsDates)].sort();
  for (const date of dates) epochDay(date); // 形态校验: 脏日期在这里抛, 不悄悄参与比较
  return {
    symbol,
    today,
    coverageEnd: fromEpochDay(todayEpoch + EARNINGS_FORWARD_HORIZON_DAYS),
    dates,
  };
}

/**
 * 单个 `(到期日, 腿族)` 的财报标。`O(log E)` (窗口右端二分)。
 *
 * 判定序 (每一步的先后都是语义决定的):
 * 1. **建仓腿恒 `null`** —— 先于一切, 含超视野与确实跨财报的情形 (FR-023 建仓腿无标);
 * 2. **超覆盖窗右端 → `no_date`** —— Guardrail 12: 渲成「不跨」是**编造一个未知事实**,
 *    而且不会红。本片采到 LEAPS 而 vendor 视野约半年 ⇒ 远月腿天然落这里, 是预期不是缺陷;
 * 3. **该标的零财报行 → `no_date`** —— 与 2 同理: 没有数据 ≠ 确认不跨 (FR-026 要求两者可分);
 * 4. **窗口 `[today, expiry]` 内无财报 → `no_cross`** (已确认不跨);
 * 5. **收租短腿 → `crosses_earnings`** —— 只看跨不跨, **不进缓冲算式** (FR-023 短腿域);
 * 6. **收租长腿** —— 缓冲 = `到期日 − 最后一个财报日`, 达标 `covered` / 否则 `buffer_short`。
 *
 * 🚨 **缓冲只约束「最后利空 → 到期」一侧** (FR-024): 窗口右端外的财报 (到期之后才发) 与
 * 窗口左端外的财报 (开仓前已发) **一律不参与** —— MUST NOT 双侧约束。
 *
 * @param expiryDate 到期日 (`YYYY-MM-DD`)。已到期腿由调用方在上游滤掉 (FR-028a)。
 */
export function earningsMark(
  calendar: EarningsCalendarContext,
  expiryDate: string,
  legFamily: EarningsLegFamily,
): EarningsMarkVerdict | null {
  if (legFamily === 'build_position') return null;

  const expiryEpoch = epochDay(expiryDate);
  if (expiryEpoch > epochDay(calendar.coverageEnd)) return verdict('no_date');
  if (calendar.dates.length === 0) return verdict('no_date');

  const lastEarningsDate = lastDateWithin(calendar.dates, calendar.today, expiryDate);
  if (lastEarningsDate === null) return verdict('no_cross');
  if (legFamily === 'rent_short') return verdict('crosses_earnings', null, lastEarningsDate);

  const bufferDays = expiryEpoch - epochDay(lastEarningsDate);
  return bufferDays >= EARNINGS_BUFFER_MIN_DAYS
    ? verdict('covered', null, lastEarningsDate)
    : verdict('buffer_short', EARNINGS_BUFFER_MIN_DAYS - bufferDays, lastEarningsDate);
}

/**
 * `到期日 → 标` 的查表 (Guardrail 11 的落地形态)。`O(k log E)`, k = 不同到期日数。
 *
 * 调用方拿到本 Map 后**逐行贴回** (`O(1)`/行) ⇒ 同一到期日的所有腿 —— 含死档行 (FR-006) 与
 * greeks 缺失行 (FR-007) —— 拿到的是**同一个对象引用**, 不同标在结构上不可能发生。
 *
 * @param expiryDates 本次候选集里出现过的到期日 (顺序不限, 允许重复)。
 * @param legFamilyByExpiry 见 {@link LegFamilyByExpiry}。
 */
export function earningsMarksByExpiry(
  calendar: EarningsCalendarContext,
  expiryDates: readonly string[],
  legFamilyByExpiry: LegFamilyByExpiry,
): ReadonlyMap<string, EarningsMarkVerdict | null> {
  const marks = new Map<string, EarningsMarkVerdict | null>();
  for (const expiryDate of expiryDates) {
    if (marks.has(expiryDate)) continue;
    marks.set(expiryDate, earningsMark(calendar, expiryDate, legFamilyByExpiry(expiryDate)));
  }
  return marks;
}

/** 五个标里表示「该到期日**跨了**财报」的三个 —— `covered` 也是跨了, 只是缓冲够。 */
const CROSSING_MARKS: ReadonlySet<EarningsMark> = new Set([
  'covered',
  'buffer_short',
  'crosses_earnings',
]);

/**
 * 该到期日跨不跨财报 (050 `FR-019` 特征集的布尔项)。`O(1)`。
 *
 * 🚨 **只读已算好的 {@link EarningsMarkVerdict.mark}, 不重算日历** —— 050 `FR-017` 明写本片
 * MUST NOT 改动财报打标算法, 这里是把结论**读出来**而不是第二份实现。
 *
 * 📌 三种「不算跨」在特征层**蓄意合流为 `false`**: `no_cross` (知道且确认不跨) / `no_date`
 * (不知道) / `null` (建仓域按设计不打标)。呈现层要分三态 (FR-026 明写不可合并), 但特征是个
 * 归一化到 `0/1` 的量, 没有第三格能装「不知道」—— 与 `FR-019a`「缺失取 0」同一条口径。
 */
export function crossesEarnings(mark: EarningsMarkVerdict | null): boolean {
  return mark !== null && CROSSING_MARKS.has(mark.mark);
}

function verdict(
  mark: EarningsMark,
  bufferShortfallDays: number | null = null,
  lastEarningsDate: string | null = null,
): EarningsMarkVerdict {
  return { mark, bufferShortfallDays, lastEarningsDate };
}

/**
 * 升序日期数组里落在 `[from, to]` 闭区间内的**最后一个**; 无则 `null`。二分, `O(log E)`。
 *
 * 闭区间两端都取到: 财报日 == 到期日 算跨 (当天盘后发的财报, 到期时利空尚未消化);
 * 财报日 == today 亦算跨 (今天挂的单要扛今天盘后那一发)。
 */
function lastDateWithin(sorted: readonly string[], from: string, to: string): string | null {
  let lo = 0;
  let hi = sorted.length - 1;
  let found: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= to) {
      if (sorted[mid] >= from) found = sorted[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

const MS_PER_CALENDAR_DAY = 86_400_000;

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD` → 自 epoch 起的整数日序 (UTC 午夜锚点 ⇒ 减法恒为整数日, DST 不参与)。
 * 口径与 `marketdata/trading-day-gate.ts` 的 `daysToExpiry` 一致 —— 整数日历日含周末与节假日。
 */
function epochDay(dateOnly: string): number {
  const parts = DATE_ONLY_PATTERN.exec(dateOnly);
  const ms = parts
    ? Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : Number.NaN;
  // 回写比对: `Date.UTC` 把溢出日**静默滚进下个月** (2026-02-30 → 2026-03-02), 不回比就是一个
  // 不报错的两天误差 (同 `trading-day-gate.ts` 的纪律)。
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== dateOnly) {
    throw new Error(`[earnings-mark] 不是合法的 YYYY-MM-DD 日期: ${JSON.stringify(dateOnly)}`);
  }
  return ms / MS_PER_CALENDAR_DAY;
}

function fromEpochDay(epoch: number): string {
  return new Date(epoch * MS_PER_CALENDAR_DAY).toISOString().slice(0, 10);
}
