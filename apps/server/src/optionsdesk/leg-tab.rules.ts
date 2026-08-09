import { Prisma } from '../generated/prisma/client';
import { type AnchorZone } from './anchor.rules';
import type { EarningsLegFamily } from './earnings-mark.rules';
import { RENT_DEPTHS, type LegIntent, type RentDepth } from './intent-matrix.rules';

/**
 * 047 optionsdesk 意图 Tab 成员判据纯函数 (ADR-0043 §4, plan D-SOT-4)。无 I/O、无 DI。
 *
 * 🚨 **成员判据只住这一处**: 端点返全量腿、三个 Tab 在客户端过滤 (D-API-1), 而活跃度又是
 * 「**当前 Tab 候选集内**的相对排名」(D-SOT-5) —— 两条合起来意味着 server 与 client 都要知道
 * 「这条腿属于哪个 Tab」。各写一份必 drift (client 筛出来的集合与 server 排名用的集合不是同一个,
 * 而**排名照样算得出来**, 不会红)。⇒ 判据在本文件单点求值, 端点把 `tabs` 与
 * `activityByTab` 一起下发, **客户端按 `tabs` 过滤而不是重算判据**。
 *
 * 🚫 **Tab 归属零拦截语义** (FR-021 / FR-025): 不属于某 Tab 只影响它在那一屏出不出现,
 * MUST NOT 用它筛掉腿、置灰或禁选 —— 全量腿恒在响应里 (FR-005)。
 *
 * 复杂度 `O(1)`/腿。
 */

/** 三个 Tab (FR-002)。`all` 不筛 (除 FR-008 非标 + FR-028a 已到期, 那两条在读端就滤了)。 */
export const LEG_TABS = ['all', 'build', 'rent'] as const;

export type LegTab = (typeof LEG_TABS)[number];

/** 闭区间带 (两端均可取到)。 */
export interface AbsDeltaBand {
  readonly min: number;
  readonly max: number;
}

/**
 * 建仓腿·周化的形态带 (D-SOT-4)。
 *
 * 📌 判据是**形态**不是**授权**: 意图矩阵有没有给建仓授权由 `intent-matrix.rules.ts` 单独回答
 * (FR-016), 与这条腿长什么样是两件事。混在一起会让「无建仓授权时建仓 Tab 整个空掉」——
 * 而 FR-021 要求的恰恰相反: 警示注置顶, 腿数据照常全量展示。
 */
export const BUILD_LEG_ABS_DELTA_BAND: AbsDeltaBand = { min: 0.4, max: 0.55 };

export const BUILD_LEG_MAX_DTE_DAYS = 14;

/** 收租腿·年化两轴共用的 DTE 带 —— SoT「5–12 月」的天数化 (D-SOT-4)。 */
export const RENT_LEG_MIN_DTE_DAYS = 150;

export const RENT_LEG_MAX_DTE_DAYS = 365;

/**
 * 收租腿市场轴的 Δ 三档 (SoT 第四章)。键序与 `RENT_DEPTHS` 一致 (由浅到深)。
 *
 * 🚫 **水位未选时取三档并集而非某一档** (D-SOT-4 明禁): 静默取一档 = 替人做方向性假设,
 * 正是 FR-017 否掉的做法。并集由 {@link RENT_DEPTH_UNION_BAND} 从本表派生, 不手抄。
 */
export const RENT_DEPTH_ABS_DELTA_BANDS: Readonly<Record<RentDepth, AbsDeltaBand>> = {
  near_atm: { min: 0.3, max: 0.4 },
  moderate: { min: 0.15, max: 0.3 },
  deep: { min: 0.05, max: 0.15 },
};

/** 三档并集 —— 水位未选 / 无 Δ 档授权时的带 (从上表派生, 改档表即跟随)。 */
export const RENT_DEPTH_UNION_BAND: AbsDeltaBand = {
  min: Math.min(...RENT_DEPTHS.map((d) => RENT_DEPTH_ABS_DELTA_BANDS[d].min)),
  max: Math.max(...RENT_DEPTHS.map((d) => RENT_DEPTH_ABS_DELTA_BANDS[d].max)),
};

/**
 * 收租腿走**锚轴**(`K ≤ W`) 的区间 —— 即 spot 落在 W 上方那一侧。
 *
 * 📌 D-SOT-4 只列了卖put区 (`thin` / `expensive`) 走锚轴、买区与深买区走市场轴, **没列不动区**
 * (`overvalued`)。按同侧延用锚轴: 不动区与卖put区同在 W 上方, 「只在愿买价及以下卖 put」这条
 * 在更贵的地方只会更成立。⇒ 判据实为「spot 在不在 W 上方」的二分, 无空洞。
 * 🚫 归到哪个轴**不改变**不动区「不开新仓」的意图输出 (那归 `intent-matrix.rules.ts`),
 * 也不拦任何腿 (FR-021)。
 */
export const ANCHOR_AXIS_ZONES: readonly AnchorZone[] = ['thin', 'expensive', 'overvalued'];

/** 腿侧入参 —— **只有形态量**, 无档位 / 无费率 (Tab 归属 MUST NOT 受档位影响, FR-006)。 */
export interface LegTabLegInput {
  /** `|Δ|` 真值; greeks 缺失 → `null` (⇒ 两个意图 Tab 都进不去, 但恒在 `all` 里, FR-007)。 */
  absDelta: number | null;
  /** 请求时 DTE (`daysToExpiry`, 整数日历日)。 */
  dteDays: number;
  strike: Prisma.Decimal;
}

/** 标的级上下文 —— 每票每请求算一次, 全部腿共用。 */
export interface LegTabContext {
  zone: AnchorZone;
  /** W = 愿买价锚 (045 `computeW`)。锚轴判据 `K ≤ W` 的右操作数。 */
  w: Prisma.Decimal;
  /** 意图矩阵输出的 Δ 深度档; `null` (水位未选 / 不开新仓) → 取三档并集。 */
  rentDepth: RentDepth | null;
}

/**
 * 这条腿属于哪几个 Tab (plan D-SOT-4)。`O(1)`。
 *
 * `all` 恒在内 —— 「全腿」就是不筛 (FR-005 全量呈现原则的落地: 任何腿至少在一个 Tab 里可见,
 * 不存在「落库了但哪儿都看不见」的腿)。
 */
export function legTabs(context: LegTabContext, leg: LegTabLegInput): LegTab[] {
  const tabs: LegTab[] = ['all'];
  if (isBuildLeg(leg)) tabs.push('build');
  if (isRentLeg(context, leg)) tabs.push('rent');
  return tabs;
}

/** 建仓腿·周化: `|Δ| ∈ [0.40, 0.55]` ∧ `DTE ≤ 14`。 */
export function isBuildLeg(leg: LegTabLegInput): boolean {
  return (
    leg.dteDays <= BUILD_LEG_MAX_DTE_DAYS && withinBand(leg.absDelta, BUILD_LEG_ABS_DELTA_BAND)
  );
}

/**
 * 收租腿·年化: `DTE ∈ [150, 365]` ∧ (锚轴 `K ≤ W` | 市场轴 `|Δ|` 落在矩阵输出的 Δ 档内)。
 *
 * 两轴按 {@link ANCHOR_AXIS_ZONES} 二选一, **不取并集** —— 取并集会让买区冒出一堆 `K ≤ W` 的
 * 深虚腿, 而买区的语义本就是「按市场轴的 Δ 档收租」。
 */
export function isRentLeg(context: LegTabContext, leg: LegTabLegInput): boolean {
  if (leg.dteDays < RENT_LEG_MIN_DTE_DAYS || leg.dteDays > RENT_LEG_MAX_DTE_DAYS) return false;
  if (ANCHOR_AXIS_ZONES.includes(context.zone)) return leg.strike.lessThanOrEqualTo(context.w);
  return withinBand(leg.absDelta, rentAbsDeltaBand(context.rentDepth));
}

/** 市场轴当前生效的 Δ 带 —— 水位未选 (`null`) 取三档并集 (D-SOT-4)。 */
export function rentAbsDeltaBand(rentDepth: RentDepth | null): AbsDeltaBand {
  return rentDepth === null ? RENT_DEPTH_UNION_BAND : RENT_DEPTH_ABS_DELTA_BANDS[rentDepth];
}

/**
 * 收租**短**腿的 DTE 上界 —— SoT「恐慌增强器腿取短 1-4 周」的天数化 (4 周)。
 *
 * 📌 它只服务**财报打标的域划分** (FR-023: 长腿看出清覆盖 / 短腿看跨不跨), 与
 * {@link RENT_LEG_MIN_DTE_DAYS} 那条 Tab 成员带是两件事 —— 中间那段 (28 < DTE < 150) 的腿
 * 不进收租 Tab, 但在全腿 Tab 里照常可见、照常要打标, 故两条界不可合并。
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

/** 闭区间含端点; `null` (greeks 缺失) 恒不在带内 —— 缺 Δ 不能推定落在任何带里。 */
function withinBand(absDelta: number | null, band: AbsDeltaBand): boolean {
  return absDelta !== null && absDelta >= band.min && absDelta <= band.max;
}
