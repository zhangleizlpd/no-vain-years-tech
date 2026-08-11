import type { EarningsLegFamily } from './earnings-mark.rules';
import { type LegIntent } from './intent-matrix.rules';

/**
 * optionsdesk Tab 类型 + 财报打标域划分 (ADR-0043 §4)。无 I/O、无 DI。
 *
 * 📌 **本文件已在 050 瘦身**: 047 的 Tab 成员判据 (`legTabs` / `isBuildLeg` / `isRentLeg` +
 * Δ 带 + DTE 界 + 锚轴) 整块换代到 `leg-recall.rules.ts` (粗召回 + 三道硬约束), 两组 Δ 带常量
 * 迁 `leg-mark.rules.ts` (语义由「过滤器」降级为「推荐标」, plan D-MARK-1)。留下的两件事与
 * 召回换代**正交**:
 *
 * 1. `LEG_TABS` / `LegTab` —— Tab 这个概念不随成员判据换代。
 * 2. 财报打标的域划分 —— `FR-017` 明写本片 MUST NOT 改动其算法, 一行不改。
 *
 * 🚫 **收租锚轴判据 (`K ≤ W`) 整条退役, 不迁不留**: 新范式下收租召回只看 DTE 段 + 两道门槛,
 * Δ 只打标 ⇒ 锚轴不再是成员判据。这会**扩大**收租召回集 (047 下买区只收 Δ 带内的腿), 属已
 * flag 的成员集合行为变化 (`FR-028`)。
 *
 * 复杂度 `O(1)`/腿。
 */

/** 三个 Tab (FR-002)。`all` 不筛 (除 FR-008 非标 + FR-028a 已到期, 那两条在读端就滤了)。 */
export const LEG_TABS = ['all', 'build', 'rent'] as const;

export type LegTab = (typeof LEG_TABS)[number];

/**
 * 收租**短**腿的 DTE 上界 —— SoT「恐慌增强器腿取短 1-4 周」的天数化 (4 周)。
 *
 * 📌 它只服务**财报打标的域划分** (FR-023: 长腿看出清覆盖 / 短腿看跨不跨), 与
 * `leg-recall.rules.ts` 的 `RENT_RECALL_DTE` 那条召回段是两件事 —— 中间那段 (28 < DTE < 30)
 * 的腿不进收租召回集, 但在全腿 Tab 里照常可见、照常要打标, 故两条界不可合并。
 * (047 下这个缺口是 `28 < DTE < 150`; 050 收租召回段放宽到 `[30,365]` 后只剩 2 天, 但**两条界
 * 仍是两件事** —— 恰好挨在一起不是可以合并的理由。)
 */
export const RENT_SHORT_MAX_DTE_DAYS = 28;

/**
 * 财报打标的域 (FR-023「按意图分域」) —— **只吃标的级意图 + 到期日级 DTE**, 拿不到合约。
 *
 * 🚨 建仓 / 收租之分是**意图矩阵的输出** (标的级, `intent-matrix.rules.ts`), 不是 DTE 的函数:
 * 同一票在同一时刻要么整体建仓要么整体收租。长 / 短之分才是 DTE 的函数。两者混着推会让
 * 「水位一改, 财报标整列变」这种正确行为看起来像 bug, 也会让 mockup 帧① 那种「收租意图下的
 * 4d / 11d 短腿」拿不到标。
 * 📌 `pending` (水位未选) 与 `no_new_position` (不动区 / L4) 都不是建仓授权 ⇒ 按收租域打标,
 * 腿数据照常全量展示 (FR-021)。
 */
export function earningsLegFamilyFor(intent: LegIntent, dteDays: number): EarningsLegFamily {
  if (intent === 'build_position') return 'build_position';
  return dteDays > RENT_SHORT_MAX_DTE_DAYS ? 'rent_long' : 'rent_short';
}
