import { Prisma } from '../generated/prisma/client';
import { type LegTab } from './leg-tab.rules';

/**
 * 050 optionsdesk **召回层**判据纯函数 (ADR-0043 §4, plan D-RECALL-1)。无 I/O、无 DI。
 *
 * 它整块换代 047 `leg-tab.rules.ts` 的「硬分腿族」成员判据: 047 把腿按 `|Δ|` 带 + 窄 DTE 带
 * 硬分成建仓 / 收租两族, 本层改成**粗召回 + 三道硬约束**——
 *
 * | 判据                            | 作用面             | FR      |
 * | ------------------------------- | ------------------ | ------- |
 * | DTE 段 (建仓 `[1,49]` / 收租 `[30,365]`) | 意图 Tab  | 001/002 |
 * | 有效成本 `K − bid < spot`       | **只**建仓         | 004     |
 * | 权利金绝对门槛                  | **三个 Tab 一律**  | 005     |
 * | 流动性门槛 (相对价差上界)       | 只建仓 / 收租      | 006     |
 *
 * 🚨 **`|Δ|` 不在本文件的任何入参里** (FR-009) —— 这是「Δ 已降级为打标量」的**结构保证**而非
 * 事后约定: 拿不到这个量就不可能拿它做召回判据。想把 Δ 塞回召回必须先改签名, 那一步 review
 * 看得见。⇒ greeks 缺失的腿照常进意图召回集 (与 047 相反)。
 *
 * 🚨 **有效成本判据 MUST 只作用建仓** (Guardrail 5): 收租不接货, 不受此限。误加到收租会砍掉
 * 大量本来正确的深虚腿, 而且**不会红** —— 返回的腿数量与数值全都正常, 只是少了一批。
 *
 * 🚨 **阈值单点** (FR-007 / SC-009): 本文件是两道门槛阈值与三段 DTE 界的**唯一**落点,
 * `scripts/checks/check-optionsdesk-rule-constants.ts` 机器强制 (抄到别处 = PR 门直接红)。
 *
 * 量纲: 金额比较一律 `Prisma.Decimal` (沿 `leg-derive.rules.ts` 既有纪律), DTE 是整数日历日。
 * 复杂度 `O(1)`/腿。
 */

/** 闭区间 DTE 段 (两端均可取到)。 */
export interface DteBand {
  readonly min: number;
  readonly max: number;
}

/**
 * 建仓召回段 (FR-001)。下界取 1 而非 0 —— 读端已滤「到期日 **>** 当日」, DTE=0 的腿根本到不了
 * 这里; 写成 1 是让这条前置在常量上可见, 不是多一道判定。
 */
export const BUILD_RECALL_DTE: DteBand = { min: 1, max: 49 };

/**
 * 收租召回段 (FR-002)。
 *
 * 📌 与建仓段在 `[30,49]` 的**重叠是刻意的**, MUST NOT 被「消歧」掉: 同一张合约用两种眼光看
 * 是两笔账 —— 建仓视角问「被指派后我的成本划不划算」, 收租视角问「这段期限的租金年化多少」。
 */
export const RENT_RECALL_DTE: DteBand = { min: 30, max: 365 };

/** 权利金绝对门槛的双参数 (FR-005 / spec Assumptions)。 */
export interface PremiumFloorParams {
  /** 绝对下限 (美元) —— 管掉「一分钱腿」: `weeklyRate = periodRate × 7/DTE`, DTE=1 时是 ×7 放大。 */
  readonly absolute: Prisma.Decimal;
  /** spot 的比例下限 —— 让门槛随标的价位缩放 (百元票与千元票的「太少」不是同一个数)。 */
  readonly spotRatio: Prisma.Decimal;
}

/**
 * ⚠️ **当前为待标定的临时取值** —— T017 用 dev 真实链数据跑分布统计后定稿并回写 spec。
 *
 * 🚨 标定时 MUST 避开 `leg-tier.rules.ts` 已有的六个档界 (`0.006` / `0.01` / `0.02` / `0.05` /
 * `0.10` / `0.15`): 守门脚本认的是**值不是名字**, 撞值会把那个文件报成违规。撞上时改这里的
 * 取值, 🚫 MUST NOT 放宽检查器 —— 那会让 SC-009 显示为「已机器强制」而实际没有, 比不装更糟。
 */
export const PREMIUM_FLOOR: PremiumFloorParams = {
  absolute: new Prisma.Decimal('0.20'),
  spotRatio: new Prisma.Decimal('0.0012'),
};

/**
 * 流动性门槛: 相对价差上界 (FR-006)。**含端点视为通过**。
 *
 * ⚠️ 同上, T017 标定前的临时取值。
 */
export const LIQUIDITY_MAX_RELATIVE_SPREAD = new Prisma.Decimal('0.35');

/**
 * 腿侧入参 —— 🚨 **MUST NOT 加 `absDelta`** (FR-009, 见文件头)。
 *
 * 也没有档位 / 费率: 召回判据一条都用不到费率, 这是 plan D-RECALL-3 否决「费率下沉 SQL」的
 * 第一条理由, 签名把它固化下来。
 */
export interface RecallLegInput {
  /** 请求时 DTE (整数日历日)。 */
  dteDays: number;
  strike: Prisma.Decimal;
  bid: Prisma.Decimal | null;
  ask: Prisma.Decimal | null;
}

/** 标的级上下文 —— 每票每请求算一次, 全部腿共用。 */
export interface RecallContext {
  /** vendor 随链下发的标的价, **未复权** (沿 047 纪律)。有效成本判据的右操作数。 */
  spot: Prisma.Decimal;
}

/**
 * 相对价差 `(ask − bid) / mid`, `mid = (bid + ask) / 2` (spec Assumptions: 业内通行口径)。`O(1)`。
 *
 * 任一侧缺失 → `null`; `mid ≤ 0` → `null` (禁除零 —— 双边报价都是 0 的死合约算不出价差)。
 */
export function relativeSpread(
  bid: Prisma.Decimal | null,
  ask: Prisma.Decimal | null,
): Prisma.Decimal | null {
  if (bid === null || ask === null) return null;
  const mid = bid.plus(ask).div(2);
  if (mid.lessThanOrEqualTo(0)) return null;
  return ask.minus(bid).div(mid);
}

/**
 * 权利金绝对门槛 (FR-005): `bid ≥ max(绝对下限, spot × 比例)`。`O(1)`。
 *
 * 🚫 **无 `bid` 判 `false`, MUST NOT 通过「把无 bid 当 0」实现** —— 那会污染费率与有效成本的
 * 所有下游计算, 而且算得出数、不会红。「不知道」与「知道且很低」在**处置上同归**(都挡下并
 * 计数), 但 MUST 是两条路径。
 */
export function passesPremiumFloor(bid: Prisma.Decimal | null, spot: Prisma.Decimal): boolean {
  if (bid === null) return false;
  const ratioFloor = spot.times(PREMIUM_FLOOR.spotRatio);
  const floor = ratioFloor.greaterThan(PREMIUM_FLOOR.absolute)
    ? ratioFloor
    : PREMIUM_FLOOR.absolute;
  return bid.greaterThanOrEqualTo(floor);
}

/**
 * 流动性门槛 (FR-006), 只作用建仓 / 收租。`O(1)`。
 *
 * 🚨 **算不出价差 ⇒ fail-closed** (spec Assumptions): 没有卖价就无法确认这条腿挂得出去,
 * 宁可少收不可错收。该腿在**全腿 Tab 仍可见**, 信息不丢。
 */
export function passesLiquidityGate(
  bid: Prisma.Decimal | null,
  ask: Prisma.Decimal | null,
): boolean {
  const spread = relativeSpread(bid, ask);
  return spread !== null && spread.lessThanOrEqualTo(LIQUIDITY_MAX_RELATIVE_SPREAD);
}

/**
 * 有效成本硬判据 (FR-004): 被指派后的持仓成本 `K − bid` **严格低于**当前 spot。`O(1)`。
 *
 * 严格小于而非 `≤`: 成本持平时「用 put 代替直接买」没有任何优势, 只多出被指派的不确定性。
 *
 * 🚨 **只在建仓语义下成立** —— 调用点只有 {@link recallTabs} 的 build 分支一处。
 */
export function passesEffectiveCostGate(
  spot: Prisma.Decimal,
  strike: Prisma.Decimal,
  bid: Prisma.Decimal | null,
): boolean {
  // 无 bid ⇒ 有效成本无定义。🚫 MUST NOT 拿 `K − 0` 冒充 (那是「白拿股票」的意思)。
  if (bid === null) return false;
  return strike.minus(bid).lessThan(spot);
}

/**
 * 这条腿进哪几个召回集 (plan D-RECALL-1)。`O(1)`。
 *
 * `all` 恒在内 —— 全腿 Tab 不设期限段 (FR-003)、不受流动性门槛约束 (FR-006)。
 *
 * 📌 **权利金门槛不在这里** (FR-005): 它作用于三个 Tab, 被它挡下的腿是从**响应里整条移出**,
 * 而不是「没进某个 Tab」⇒ 语义上属读端过滤, 由 use case 在建表之前施加。
 */
export function recallTabs(context: RecallContext, leg: RecallLegInput): LegTab[] {
  if (!passesLiquidityGate(leg.bid, leg.ask)) return ['all'];
  return ['all', ...intentTabsByTerm(context, leg)];
}

/**
 * 这条腿是否**仅因流动性门槛**被挡在意图 Tab 之外 —— `gateCounts.excludedFromIntentTabs`
 * 的判据 (FR-008)。`O(1)`。
 *
 * 🚨 期限段本就不合格的腿 (如 DTE=400) **不计入**: 它不是被门槛挡下的, 把它算进去会让
 * 「流动性排除 N 条」这个数失去它唯一的用途 —— 提示该注意的流动性信号。
 *
 * 与 {@link recallTabs} **同源派生** ({@link intentTabsByTerm} 一处求值), 两者不会 drift。
 */
export function isExcludedFromIntentTabsByLiquidity(
  context: RecallContext,
  leg: RecallLegInput,
): boolean {
  return !passesLiquidityGate(leg.bid, leg.ask) && intentTabsByTerm(context, leg).length > 0;
}

/** 只看期限段 + 建仓的有效成本硬判据, **不含**流动性门槛 —— 上面两个导出的共同根。 */
function intentTabsByTerm(context: RecallContext, leg: RecallLegInput): LegTab[] {
  const tabs: LegTab[] = [];
  if (
    withinDteBand(leg.dteDays, BUILD_RECALL_DTE) &&
    passesEffectiveCostGate(context.spot, leg.strike, leg.bid)
  ) {
    tabs.push('build');
  }
  if (withinDteBand(leg.dteDays, RENT_RECALL_DTE)) tabs.push('rent');
  return tabs;
}

/** 闭区间含两端。段界一律走常量, 本文件内也不写字面量比较。 */
function withinDteBand(dteDays: number, band: DteBand): boolean {
  return dteDays >= band.min && dteDays <= band.max;
}
