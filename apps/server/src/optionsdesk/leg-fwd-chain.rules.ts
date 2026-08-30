import { Prisma } from '../generated/prisma/client';
import { computeLegRates, DAYS_PER_YEAR } from './leg-derive.rules';

/**
 * 069 optionsdesk **特征加工层**清链判据纯函数 (ADR-0043 §4, ADR-0068 决策 3, plan D1)。
 * 无 I/O、无 DI、**θ 无关** (FR-005): 本文件不读 θ / 意图 / 档界 —— 纯几何。
 *
 * 管道分工 (T002 → T004 渐进落于本文件):
 * · fwd 链构造 (T002): 收租段每 K 到期日梯 → 邻档边际费率链
 * · 凸包剔劣 + 劣档标 (T003) · tick-共线合并 (T004)
 *
 * 🚨 **13 类审计枚举单点** (plan Guardrail 5): {@link MARCH_EXCLUSION_CATEGORIES} 全仓恰好
 * 本文件一处定义, A/D 家族由本层产出, B/C 家族由精排层 (`leg-march.rules.ts`) import 复用,
 * 🚫 DTO / mobile MUST NOT 各抄一份字面量 (契约经 regen 传导)。
 *
 * 🚨 **费率零第二份** (ADR-0064 不变量 ③): periodRate / 年化恒经 `leg-derive.rules.ts`
 * `computeLegRates` 单点 ({@link buildFwdLadder}), 🚫 本文件 MUST NOT 手写 `P/(K−P)`。
 *
 * 量纲: 金额 `Prisma.Decimal` (沿既有纪律), DTE 整数日历日, 费率年化小数比例。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 13 类四家族审计枚举 (FR-015, 2026-08-30 clarify 定稿)
// ─────────────────────────────────────────────────────────────────────────────

/** 四个家族 (FR-014): A 清链 / B 行军 / C 可成交 / D 呈现-召回边界。 */
export const MARCH_EXCLUSION_FAMILIES = [
  'chain_clean',
  'march',
  'tradability',
  'boundary',
] as const;

export type MarchExclusionFamily = (typeof MARCH_EXCLUSION_FAMILIES)[number];

/**
 * 13 类去除原因 (FR-015 表逐条, #1–#13 次序与 spec 严格一致)。
 *
 * 🚨 **全仓唯一定义处** —— 前后端类别集合 MUST 严格一致 (FR-015), 一致性靠「DTO 引用本常量 →
 * openapi → api-client regen」的生成链传导, 不靠两边手抄对齐。
 */
export const MARCH_EXCLUSION_CATEGORIES = [
  /** #1 A 报价异常 (ask ≤ bid 交叉/锁定, 护栏剔候选)。 */
  'crossed_quote',
  /** #2 A 凹陷支配 (凸包弹出)。 */
  'concave_dominated',
  /** #3 A 绝对支配 (总权利金 ≤ 更短档, 疑似陈旧报价)。 */
  'absolute_dominated',
  /** #4 A 共线除名 (并入合并段)。 */
  'collinear_merged',
  /** #5 B 水平违规: fwd < φ (含链头即违规 → 无合格档)。 */
  'fwd_below_phi',
  /** #6 B 形状违规: 每日衰减回升超 β × 前段。 */
  'decay_rebound_above_beta',
  /** #7 B 形状违规: γ 绝对帽 (前段衰减 ≤ 0 的退化分支)。 */
  'decay_above_gamma_cap',
  /** #8 B 档界终检未过。 */
  'tier_floor_failed',
  /** #9 B 合格非停点 (在推荐路径内, 被更长档胜出)。 */
  'qualified_not_stop',
  /** #10 C 停点 OI 不过闸 (沿凸包回退弃档)。 */
  'stop_oi_below_min',
  /** #11 C 整梯无过闸 (全梯弃 → 整梯无可成交)。 */
  'ladder_oi_all_below_min',
  /** #12 D 带外横档 (预测带外保留比价, 非候选; 对齐 068 `bandStatus: 'out'`)。 */
  'band_out',
  /** #13 D 报价缺失 / fwd 不可算 (缺 bid 或缺相邻基准)。 */
  'quote_missing',
] as const;

export type MarchExclusionCategory = (typeof MARCH_EXCLUSION_CATEGORIES)[number];

/**
 * 类目 → 家族 (FR-015: A 4 类 / B 5 类 / C 2 类 / D 2 类)。
 *
 * 📌 `Record` 按 {@link MarchExclusionCategory} 穷举 ⇒ 往清单加类而不归家族 = 编译红
 * (「恰 13 成员四家族」的编译期一半, 运行期一半在同名 spec)。
 */
export const MARCH_EXCLUSION_FAMILY_OF: Readonly<
  Record<MarchExclusionCategory, MarchExclusionFamily>
> = {
  crossed_quote: 'chain_clean',
  concave_dominated: 'chain_clean',
  absolute_dominated: 'chain_clean',
  collinear_merged: 'chain_clean',
  fwd_below_phi: 'march',
  decay_rebound_above_beta: 'march',
  decay_above_gamma_cap: 'march',
  tier_floor_failed: 'march',
  qualified_not_stop: 'march',
  stop_oi_below_min: 'tradability',
  ladder_oi_all_below_min: 'tradability',
  band_out: 'boundary',
  quote_missing: 'boundary',
};

// ─────────────────────────────────────────────────────────────────────────────
// 审计条目 (FR-014: 逐档一行 = 类目 + 数值证据; server 只出结构化数值, 文案归 mobile)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 结构化数值证据 —— **按类目取用, 其余恒 null** (plan D3)。字段与 FR-015「数值证据示例」列
 * 一一对应; 🚫 server MUST NOT 拼展示字符串 (plan Guardrail 6), 格式化归 `optionsdesk-copy.ts`。
 */
export interface MarchAuditEvidence {
  /** #1 / #13: 买价 (缺失时 null 本身即证据)。 */
  readonly bid: Prisma.Decimal | null;
  /** #1: 卖价。 */
  readonly ask: Prisma.Decimal | null;
  /** #2 进 X 的 fwd / #5 该档水平 fwd。 */
  readonly fwd: Prisma.Decimal | null;
  /** #2 出 X 的 fwd (凹陷对比的另一半)。 */
  readonly fwdOut: Prisma.Decimal | null;
  /** #3: 本档总权利金。 */
  readonly premium: Prisma.Decimal | null;
  /** #3: 更短档总权利金 (被它支配)。 */
  readonly premiumShorter: Prisma.Decimal | null;
  /** #4: 节点对弦垂距, tick 单位 (阈值恒为 1 tick, 判据零自由参数)。 */
  readonly chordDistanceTicks: Prisma.Decimal | null;
  /** #5: φ (行军水平线)。 */
  readonly phi: Prisma.Decimal | null;
  /** #6 / #7: 每日衰减实测值。 */
  readonly decay: Prisma.Decimal | null;
  /** #6: β × 前段 / #7: γ 绝对帽 —— 衰减对比的上界。 */
  readonly decayCap: Prisma.Decimal | null;
  /** #8: 该档年化。 */
  readonly annualized: Prisma.Decimal | null;
  /** #8: 档界 (行军档界终检的下限)。 */
  readonly tierFloor: Prisma.Decimal | null;
  /** #9: 胜出它的推荐档 DTE。 */
  readonly recommendedDteDays: number | null;
  /** #10: 停点档 OI / #11: 整梯 max OI。 */
  readonly oi: number | null;
  /** #10 / #11: `OI_MIN` (收租 OI 口径)。 */
  readonly oiMin: number | null;
  /** #12: 该腿 |Δ|。 */
  readonly absDelta: Prisma.Decimal | null;
  /** #12: Δ 带下限。 */
  readonly bandFloor: Prisma.Decimal | null;
}

/** 全 null 证据袋 —— 各产出点以 override 取用本类目的字段 ({@link marchEvidence})。 */
const EMPTY_EVIDENCE: MarchAuditEvidence = {
  bid: null,
  ask: null,
  fwd: null,
  fwdOut: null,
  premium: null,
  premiumShorter: null,
  chordDistanceTicks: null,
  phi: null,
  decay: null,
  decayCap: null,
  annualized: null,
  tierFloor: null,
  recommendedDteDays: null,
  oi: null,
  oiMin: null,
  absDelta: null,
  bandFloor: null,
};

/** 证据袋构造 —— 未取用字段恒 null (「不知道」不伪造 0, 承 046 纪律)。`O(1)`。 */
export function marchEvidence(used: Partial<MarchAuditEvidence>): MarchAuditEvidence {
  return { ...EMPTY_EVIDENCE, ...used };
}

/**
 * 一条审计条目 (FR-014): 每个被剔 / 被标 / 未推荐档**恰一条**, 零「无原因排除」。
 * 呈现 (文案 / 家族色条 / 灰显) 全归表达层, 本类型只运结构化事实。
 */
export interface MarchAuditEntry {
  readonly category: MarchExclusionCategory;
  /** 条目归属档的 DTE (合并段条目 = 段尾档 DTE)。 */
  readonly dteDays: number;
  /** #4 共线除名: 并入的合并段段尾 DTE; 其余类目恒 null。 */
  readonly mergedIntoDteDays: number | null;
  readonly evidence: MarchAuditEvidence;
}

// ─────────────────────────────────────────────────────────────────────────────
// fwd 链构造 (T002, ADR-0068 决策 3 前置量)
// ─────────────────────────────────────────────────────────────────────────────

/** 一梯 (同 K) 内单档腿入参 —— K 由 {@link buildFwdLadder} 单独收 (单点, 不逐腿重复)。 */
export interface FwdLadderLeg {
  /** 请求时 DTE (整数日历日)。 */
  readonly dteDays: number;
  /** 权利金判档口径恒为 bid (沿 `computeLegRates` 纪律); 缺失 ⇒ #13 条目。 */
  readonly bid: Prisma.Decimal | null;
  /** 卖价 —— fwd 不吃它, 带着走是给 T004 tick 推断 (梯内全部 bid/ask 的公约粒度)。 */
  readonly ask: Prisma.Decimal | null;
  /** 未平仓量 (张) —— 精排层停点闸的入参, 特征层只携带不判。 */
  readonly openInterest: number | null;
}

/** 梯上一个合格档 (费率可算) —— 凸包 / 共线 / 行军的节点。 */
export interface FwdLadderNode {
  readonly dteDays: number;
  readonly bid: Prisma.Decimal;
  readonly ask: Prisma.Decimal | null;
  readonly openInterest: number | null;
  /**
   * 累计费率·天 = `periodRate × 365` = `年化 × DTE` —— 凸包的纵轴与恒等式
   * `年化₂ = [T₁·年化₁ + (T₂−T₁)·fwd]/T₂` 的共同根 (该恒等式由本构造**代数保证**,
   * 同名 spec 以性质测试锁死)。
   */
  readonly cumRateDays: Prisma.Decimal;
  /** 年化 (= `cumRateDays / dteDays`), 经 `computeLegRates` 单点。 */
  readonly annualized: Prisma.Decimal;
}

/** 邻档边际费率 —— fwd 链的一段 (`(cum₂ − cum₁) / (T₂ − T₁)`, 年化小数)。 */
export interface FwdRung {
  readonly fromDteDays: number;
  readonly toDteDays: number;
  readonly fwd: Prisma.Decimal;
}

/** fwd 链构造产物 —— 节点 + 邻档链 + #13 条目三者同源一趟产出。 */
export interface FwdLadderBuildResult {
  /** 费率可算的档, DTE 升序。 */
  readonly nodes: readonly FwdLadderNode[];
  /**
   * 邻档边际费率链。**单档梯退化为空链** (无相邻档), 非异常 —— 该档自身的判定
   * (直接判 φ + 停点闸) 归精排层的净链语义, 不在本链上表达。
   */
  readonly rungs: readonly FwdRung[];
  /** #13 报价缺失 / fwd 不可算 条目 —— 🚫 MUST NOT 伪造 0 费率混进 nodes。 */
  readonly audits: readonly MarchAuditEntry[];
}

/**
 * 收租段每 K 到期日梯 → fwd 链 (T002, FR-005)。`O(n log n)` (按 DTE 排序主导; 逐档 `O(1)`)。
 *
 * · 边际费率 = 相邻档**准备金口径期间费率差**折年: `fwd = (cum₂ − cum₁) / (T₂ − T₁)`,
 *   `cum = periodRate × 365` (periodRate = `P/(K−P)` 经 `computeLegRates` 单点) ——
 *   恒等式 `年化₂ = [T₁·年化₁ + (T₂−T₁)·fwd]/T₂` 由该构造代数成立, 不是近似。
 * · `bid` 缺失 / `K − P ≤ 0` / `DTE ≤ 0` ⇒ **#13 条目 + 不进链** (费率无定义, 非伪造 0)。
 * · 同 DTE 重复档 (上游按 (K, 到期日) 唯一, 结构上不应出现) ⇒ 后到的记 #13 (fwd 不可算:
 *   零时间差无相邻基准), 防御性处置而非静默丢弃。
 */
export function buildFwdLadder(
  strike: Prisma.Decimal,
  legs: readonly FwdLadderLeg[],
): FwdLadderBuildResult {
  const nodes: FwdLadderNode[] = [];
  const audits: MarchAuditEntry[] = [];

  const sorted = [...legs].sort((a, b) => a.dteDays - b.dteDays);
  for (const leg of sorted) {
    const duplicate = nodes.length > 0 && nodes[nodes.length - 1].dteDays === leg.dteDays;
    const rates =
      leg.bid === null || duplicate
        ? null
        : computeLegRates({ strike, premium: leg.bid, dteDays: leg.dteDays });
    if (leg.bid === null || rates === null) {
      audits.push({
        category: 'quote_missing',
        dteDays: leg.dteDays,
        mergedIntoDteDays: null,
        evidence: marchEvidence({ bid: leg.bid }),
      });
      continue;
    }
    nodes.push({
      dteDays: leg.dteDays,
      bid: leg.bid,
      ask: leg.ask,
      openInterest: leg.openInterest,
      cumRateDays: rates.periodRate.times(DAYS_PER_YEAR),
      annualized: rates.annualizedRate,
    });
  }

  const rungs: FwdRung[] = [];
  for (let i = 1; i < nodes.length; i += 1) {
    const shorter = nodes[i - 1];
    const longer = nodes[i];
    rungs.push({
      fromDteDays: shorter.dteDays,
      toDteDays: longer.dteDays,
      fwd: longer.cumRateDays.minus(shorter.cumRateDays).div(longer.dteDays - shorter.dteDays),
    });
  }

  return { nodes, rungs, audits };
}
