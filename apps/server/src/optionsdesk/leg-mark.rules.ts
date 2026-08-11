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
