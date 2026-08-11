import { type LegIntent, type RentDepth } from './intent-matrix.rules';

/**
 * 050 optionsdesk **打标层**判据纯函数 (ADR-0043 §4, plan D-MARK-1)。无 I/O、无 DI。
 *
 * 本文件承接 047 `leg-tab.rules.ts` 的两组 Δ 带常量, **取值一字不改、语义整个翻转**:
 *
 * | | 047 (召回) | 050 (打标) |
 * | --- | --- | --- |
 * | Δ 带的作用 | 决定腿**进不进**候选集 | 决定腿**打不打**推荐标 |
 * | 水位未选 (`rentDepth === null`) | 取三档**并集**(放宽收进来) | **不打标** |
 *
 * 🚨 **这是本片最容易照抄错的一点** (Guardrail 1): 上表两行出自**同一条**原则——「不替人做
 * 方向性假设」。在召回语义下它导出「别替人砍掉候选 ⇒ 取并集」, 在打标语义下它导出「打了就是
 * 替人指了个方向 ⇒ 不打」。**同一条原则, 相反的行为。**
 * ⇒ 047 的 `RENT_DEPTH_UNION_BAND` **整条删除、不迁不留**: 留一个返回并集的辅助函数在这里,
 * 「水位未选」时全表就会冒出一片推荐标, 而那段代码 code review 时看着完全合理。
 *
 * 🚨 **Δ 带是本文件的唯一落点** (SC-009): 判定逻辑读这里的常量, MUST NOT 抄字面量。
 */

/** 闭区间带 (两端均可取到)。 */
export interface AbsDeltaBand {
  readonly min: number;
  readonly max: number;
}

/**
 * 建仓意图的推荐带 (FR-011)。自 047 `BUILD_LEG_ABS_DELTA_BAND` 迁入, 值不变。
 *
 * 📌 它判的是**形态**不是**授权**: 意图矩阵有没有给建仓授权由 `intent-matrix.rules.ts` 单独
 * 回答, 与这条腿长什么样是两件事。
 */
export const BUILD_RECOMMEND_ABS_DELTA_BAND: AbsDeltaBand = { min: 0.4, max: 0.55 };

/**
 * 收租意图按水位档的推荐带三档 (FR-011, 策略 SoT 第四章)。自 047
 * `RENT_DEPTH_ABS_DELTA_BANDS` 迁入, 值不变。键序与 `RENT_DEPTHS` 一致 (由浅到深)。
 *
 * 🚫 **水位未选时 MUST NOT 回落到任何一档, 也 MUST NOT 取并集** —— 见文件头。
 */
export const RENT_RECOMMEND_ABS_DELTA_BANDS: Readonly<Record<RentDepth, AbsDeltaBand>> = {
  near_atm: { min: 0.3, max: 0.4 },
  moderate: { min: 0.15, max: 0.3 },
  deep: { min: 0.05, max: 0.15 },
};

/**
 * 这条腿该不该打**推荐标** (FR-011 / FR-012 / FR-013)。`O(1)`。
 *
 * 判定序 (每一条短路都是语义决定的):
 * 1. `absDelta` 缺失 → `false` (FR-013) —— 缺 Δ 不能推定它落在任何带内。该腿**照常在召回集里**
 *    (`leg-recall.rules.ts` 的入参根本没有 Δ), 只是拿不到这个标。
 * 2. 建仓意图 → 取建仓带。**不看 `rentDepth`**: 意图矩阵在该态恒给 `null`, 但本函数不依赖调用方
 *    守约 —— 纯函数的值域由它自己封死。
 * 3. 非收租的其余两态 (`pending` / `no_new_position`) → `false` (FR-012)。没有方向就没有标。
 * 4. 收租 + **水位未选** → `false`。见下。
 * 5. 收租 + 水位已选 → 取该档带。
 *
 * 🚨 **第 4 条是本片最容易照抄错的一点** (Guardrail 1): 「不替人做方向性假设」这条原则在**召回**
 * 语义下导出「取三档并集放宽收进来」, 在**打标**语义下导出「打了标就是替人指了个方向 ⇒ 不打」。
 * 同一条原则、相反的行为。⇒ 这里直接 `return false`, 🚫 **MUST NOT** 复用任何返回并集的辅助
 * 函数 (047 的 `RENT_DEPTH_UNION_BAND` 已整条删除, 结构上不给它存在的机会)。
 *
 * 🚨 **推荐标随标的级意图判, MUST NOT 随当前 Tab 变** (FR-011): 收租意图下打开建仓 Tab 会看到
 * 推荐标数为 0 —— 那是**正确信号**不是 bug (SC-005), 呈现侧配就地说明。
 */
export function isRecommended(
  intent: LegIntent,
  rentDepth: RentDepth | null,
  absDelta: number | null,
): boolean {
  if (absDelta === null) return false;
  if (intent === 'build_position') {
    return withinAbsDeltaBand(absDelta, BUILD_RECOMMEND_ABS_DELTA_BAND);
  }
  if (intent !== 'rent') return false;
  if (rentDepth === null) return false;
  return withinAbsDeltaBand(absDelta, RENT_RECOMMEND_ABS_DELTA_BANDS[rentDepth]);
}

/** 闭区间含两端。带界一律走常量, 本文件内也不写字面量比较 (同 `leg-recall.rules.ts` 的纪律)。 */
function withinAbsDeltaBand(absDelta: number, band: AbsDeltaBand): boolean {
  return absDelta >= band.min && absDelta <= band.max;
}

// ─────────────────────────────────────────────────────────────────────────────
// 月度链标 (FR-014 / FR-015, plan D-MARK-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 假日回退的**最大距离**, 同时也是调用方那次日历查询的下界外扩量 (两处必须是同一个数,
 * 否则窗口取不到的日子回退逻辑却敢用)。
 *
 * 取 7 的依据: **美股连续休市 (含周末) 从不超过 4 个日历日** —— 周五收盘后遇周一假日是
 * 3 天, 圣诞 / 元旦那种双假日最多 4 天。留到 7 是一倍余量。
 *
 * 🚨 **它同时是一条 fail-closed 判据**: 回退超过一周只可能是**日历数据缺了一段**, 而不是
 * 真有那么长的休市。那时宁可一个都不标 —— 标错的月度日看着完全正常 (标还在, 只是落错了
 * 到期日), 与 clarify 否决「从链自身到期日分布反推」是同一条理由。
 */
export const MONTHLY_EXPIRY_LOOKBACK_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/**
 * 该月**第三个周五**的日历日 (FR-015 判据的前半段), `YYYY-MM-DD`。`O(1)`, 零 I/O。
 *
 * 🚨 一律走 UTC (`Date.UTC` + `getUTCDay`) —— 用本地时区会让宿主在 UTC−N 的机器上把 1 号
 * 算成上个月的最后一天, 整个月的标随之错位一周, 而**测试在 UTC+8 的开发机上照样绿**。
 *
 * @param month 1–12 (自然月份, 不是 `Date` 的 0-based)。
 */
export function thirdFridayOf(year: number, month: number): string {
  const FRIDAY = 5;
  const firstDayOfWeek = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstFriday = 1 + ((FRIDAY - firstDayOfWeek + 7) % 7);
  return `${year}-${pad2(month)}-${pad2(firstFriday + 14)}`;
}

/**
 * 链上到期日 → 逐 (年, 月) 去重后的**候选**月度日, 升序 (plan D-MARK-2)。
 * `O(n + k log k)`, n = 到期日数, k = 不同月份数 (实测 ≤ 20)。
 *
 * 📌 「候选」而非「结论」: 假日回退要查交易日历, 那一步在 {@link resolveMonthlyExpiries}。
 * 本函数与调用方之间的分工是**先算出要查哪一段日历**, 好让那次查询只发一次 (Guardrail 7)。
 */
export function monthlyExpiryCandidates(expiryDates: readonly string[]): string[] {
  const months = new Set(expiryDates.map((date) => date.slice(0, 7)));
  return [...months]
    .map((ym) => thirdFridayOf(Number(ym.slice(0, 4)), Number(ym.slice(5, 7))))
    .sort();
}

/**
 * 候选月度日 + 交易日历切片 → **实际**月度到期日集合 (FR-015)。
 * `O(m log m + k log m)`, m = 日历行数, k = 候选数。
 *
 * 每个候选取「≤ 它的最大交易日」—— 候选本身是交易日时该式就取到它自己, 故**不需要**先判一次
 * 命中再走回退, 两种情形是同一条路径 (少一条分支就少一处能漂的地方)。
 *
 * 三种取不到的情形一律**跳过该候选、不炸**: 日历为空 / 候选之前一个交易日都没有 / 回退距离
 * 超过 {@link MONTHLY_EXPIRY_LOOKBACK_DAYS}。都是「日历没覆盖到」的事实, 不是故障。
 *
 * @param tradingDays 顺序不限 —— 内部自己排, 不依赖调用方记得写 `orderBy`。
 */
export function resolveMonthlyExpiries(
  candidates: readonly string[],
  tradingDays: readonly string[],
): Set<string> {
  const sorted = [...tradingDays].sort();
  const resolved = new Set<string>();
  for (const candidate of candidates) {
    const fallback = latestOnOrBefore(sorted, candidate);
    if (fallback === null) continue;
    if (daysBetween(fallback, candidate) > MONTHLY_EXPIRY_LOOKBACK_DAYS) continue;
    resolved.add(fallback);
  }
  return resolved;
}

/** 二分取 ≤ `target` 的最大元素 (`YYYY-MM-DD` 的字典序 == 时序); 没有则 `null`。`O(log m)`。 */
function latestOnOrBefore(sortedDays: readonly string[], target: string): string | null {
  let low = 0;
  let high = sortedDays.length - 1;
  let best: string | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (sortedDays[mid] <= target) {
      best = sortedDays[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/** 两个 `YYYY-MM-DD` 相差几个日历日 (两侧都按 UTC 午夜解析 ⇒ 无夏令时误差)。 */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
