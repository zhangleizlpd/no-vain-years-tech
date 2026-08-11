import { type RentDepth } from './intent-matrix.rules';

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
