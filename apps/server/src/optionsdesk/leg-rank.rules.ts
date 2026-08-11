import { Prisma } from '../generated/prisma/client';

/**
 * 050 optionsdesk **精排层**特征集 (ADR-0043 §4, plan D-RANK-1)。无 I/O、无 DI。
 *
 * 特征集是精排层的**唯一输入面**: 排序器只读它 (FR-020), 拿不到原始腿数据。13 项 ——
 * 连续量 8 项按**该 Tab 本次请求候选集内的 min-max** 归一化到 `[0,1]`, 布尔 / 序数量 5 项取
 * `0` / `1` 不参与 min-max (FR-019 / FR-019a)。
 *
 * 🚨 **字段现在就算全, 哪怕当前排序一项都用不到** (FR-019): 本片唯一的 ranker 只读 `rate`
 * 一项。备着的理由是将来切加权评分时**零改动** —— 不变量的驱动力是「切换时发现某个量拿不到」,
 * 而最可能被加权的恰是布尔量 (月度链 = 流动性代理 / Δ 贴合度 = 意图贴合)。
 *
 * 🚨 **归一化基准是候选集内的相对量 ⇒ 特征值不可跨请求比较, 也不可跨 Tab 比较** —— 同一条腿
 * 换一个候选集取值就变, 这是**定义如此**不是 bug (同 047 `markActivity` 的活跃度排名)。
 * ⇒ 本函数**只接受整个候选集, 不提供单行版本**: 单行版本必然要拿全局阈值凑, 而那正是被否的做法。
 *
 * 🚨 **除零必须先判** (Guardrail 2, FR-019a 第一条的真实动机): `min === max` 时
 * `(v−min)/(max−min)` = `0/0` = `NaN`。NaN 一旦进 `Array.prototype.sort`, 比较结果**不可预测
 * 且不抛任何错** (与 NaN 的任何比较恒 `false`) ⇒ 顺序变成 V8 实现相关。故三条边界一律显式:
 *
 * | 情形                                      | 取值                                              |
 * | ----------------------------------------- | ------------------------------------------------- |
 * | 该项在候选集内全等 (含候选集只有 1 条腿)  | {@link FEATURE_VALUE_WHEN_UNIFORM} (中性)         |
 * | 原始量缺失 (无 OI / 无成交量 / 费率无定义) | {@link FEATURE_VALUE_WHEN_MISSING} (同「排末位」) |
 * | 布尔量                                    | `0` / `1`, 不参与 min-max                         |
 *
 * 🚫 **归一化不翻转方向**: 相对价差是「越小越好」的量, 但本层只做量纲统一, **不表达偏好** ——
 * 方向与权重归将来的加权器。现在翻转等于把一个 spec 没做的判断烧进特征层, 而本片唯一的 ranker
 * 读不到这一项 ⇒ 翻错了也不会红。
 *
 * 量纲: 归一化后是 `number` (统计量) 而**不是** `Prisma.Decimal` —— 沿 `leg-derive.rules.ts`
 * 的「金额 / 费率用 Decimal, 统计量用 number」纪律。复杂度 `O(项数 × n)` = `O(n)`/候选集。
 */

/**
 * 该项在候选集内**全等**时的取值 (含候选集只有 1 条腿)。
 *
 * 取中性值而非端点: 取 `0` 会把全体误报成「都最差」, 取 `1` 反之; 而常数取值不影响任何排序,
 * 故取中点最不会误导将来的加权器。
 */
export const FEATURE_VALUE_WHEN_UNIFORM = 0.5;

/**
 * 原始量**缺失**时的取值 —— 与 047 活跃度排名「缺失排末位」同口径。
 *
 * 📌 它与「真实值为 0」在下游**蓄意不可区分** (FR-019a): 特征层只表达相对位置, 「不知道」与
 * 「知道且最低」的区分归呈现层 (那里有 `null`)。
 */
export const FEATURE_VALUE_WHEN_MISSING = 0;

/**
 * 连续量 8 项 (FR-019), 逐项按候选集内 min-max 归一化。
 *
 * 顺序 = spec FR-019 的字面顺序, 改动会让 `RANKING_FEATURE_KEYS` 的读者对不上 spec。
 */
export const CONTINUOUS_FEATURE_KEYS = [
  /** 折算费率 —— 本 Tab 口径 (建仓周化 / 收租与全腿年化), 由调用方按 Tab 取好。 */
  'rate',
  /** 有效成本相对 spot 的折价 `(spot − (K − bid)) / spot`。越大 = 接货成本越便宜。 */
  'effectiveCostDiscount',
  /** 相对价差 `(ask − bid) / mid` —— 🚫 未翻转方向, 越大 = 越宽 = 越差。 */
  'relativeSpread',
  /** 未平仓量 (⚠️ 归属 T−1 交易日, 同 047 Guardrail 6)。 */
  'openInterest',
  /** 当日成交量。 */
  'volume',
  /** 成交额 `Vol × 权利金 × 合约乘数`。 */
  'turnover',
  /** `|Δ|` 真值 —— 🚨 只是 13 项之一, **不参与召回** (FR-009 已在 `leg-recall.rules.ts` 封死)。 */
  'absDelta',
  /**
   * 距到期日历天数。
   *
   * 🚨 **在特征集里但 MUST NOT 进 ranker** (FR-022): 两条禁令都要守 —— 既不许当排序主键, 也不许
   * 实现「离理想 DTE 越近越靠前」。那会让年化 20% 的 60 天腿排在年化 8% 的 35 天腿之后, 而要的是
   * 收益不是接近某个数字; DTE 已隐含在费率的分母里。机械判据 = `rateDescendingRanker` 函数体
   * `grep -i dte` 零命中。
   */
  'dteDays',
] as const;

/**
 * 布尔 / 序数量 5 项 (FR-019)。取 `0` / `1`, **不参与 min-max** —— 参与了会让「全 true」的
 * 候选集里每一项都变 `0.5`, 于是「是」与「不是」在下游不可区分, 而取值仍落 `[0,1]`。
 */
export const ORDINAL_FEATURE_KEYS = [
  /** 是否月度链 (月度链的流动性通常显著好于周链)。 */
  'isMonthlyChain',
  /** 行权价是否整数档 (做市商深度天然集中在整数档)。 */
  'isRoundStrike',
  /** `|Δ|` 是否落在**当前标的级意图**的 Δ 带内 (= 推荐标, `leg-mark.rules.ts` 判)。 */
  'isDeltaInIntentBand',
  /** 该到期日是否跨越财报 (`no_cross` 与「不知道」都取 `0`)。 */
  'crossesEarnings',
  /** 活跃度排名 —— 候选集内 `OI` 与 `Volume` 排名和进前 N (047 `markActivity` 判)。 */
  'isTopRanked',
] as const;

/** 13 项 = 8 + 5。**键表是唯一来源**, 产出面由它派生 ⇒ 两者不可能 drift。 */
export const RANKING_FEATURE_KEYS = [...CONTINUOUS_FEATURE_KEYS, ...ORDINAL_FEATURE_KEYS] as const;

export type ContinuousFeatureKey = (typeof CONTINUOUS_FEATURE_KEYS)[number];
export type OrdinalFeatureKey = (typeof ORDINAL_FEATURE_KEYS)[number];
export type RankingFeatureKey = (typeof RANKING_FEATURE_KEYS)[number];

/**
 * 特征集 —— 13 项, 每项 `∈ [0,1]` (SC-003a)。
 *
 * 🚨 **MUST NOT 下发** (FR-019b): 排序已在 server 完成 (FR-021a), 下发一批无人消费的字段会被
 * 「只加不删」(FR-027) 永久锁死。机械判据 = 生成的 OpenAPI schema 里 `grep RankingFeatures`
 * 零命中。
 *
 * 🚨 **身份键不在这里** (plan D-RANK-2): 到期日 / 行权价 / 合约代码是**身份**不是特征 (合约代码
 * 更没法归一化到 `0–1`), 确定性次键归排序的外层。
 */
export type RankingFeatures = Readonly<Record<RankingFeatureKey, number>>;

/** 标的级上下文 —— 每票每请求算一次, 全部腿共用。 */
export interface RankingContext {
  /** vendor 随链下发的标的价, 未复权 (沿 047 纪律) —— 有效成本折价的分母。 */
  spot: Prisma.Decimal;
}

/**
 * 腿侧原始量 —— 全部**已派生好**的裸值, 本文件只做归一化不做派生。
 *
 * 📌 没有 `code` / `expiryDate` / `strike`: 特征计算拿不到身份就不可能把身份混进特征
 * (同 `leg-recall.rules.ts` 的入参里没有 `absDelta` 那条结构保证)。
 */
export interface RankingLegInput {
  /** 本 Tab 口径的折算费率; 无 bid 或准备金 `K − P ≤ 0` → `null`。 */
  rate: Prisma.Decimal | null;
  /** 有效成本 `K − bid`; 无 bid → `null` (🚫 MUST NOT 拿 `K − 0` 冒充)。 */
  effectiveCost: Prisma.Decimal | null;
  relativeSpread: Prisma.Decimal | null;
  openInterest: number | null;
  volume: number | null;
  turnover: Prisma.Decimal | null;
  absDelta: number | null;
  dteDays: number;
  isMonthlyChain: boolean;
  isRoundStrike: boolean;
  isDeltaInIntentBand: boolean;
  crossesEarnings: boolean;
  isTopRanked: boolean;
}

type ContinuousExtractor = (leg: RankingLegInput, context: RankingContext) => number | null;

const CONTINUOUS_EXTRACTORS: Readonly<Record<ContinuousFeatureKey, ContinuousExtractor>> = {
  rate: (leg) => finiteOrNull(leg.rate),
  effectiveCostDiscount: (leg, context) => {
    // spot ≤ 0 是脏数据 (真实链上不会有) —— 除零判在这里, 与上面那条 Guardrail 同一条纪律。
    if (leg.effectiveCost === null || context.spot.lessThanOrEqualTo(0)) return null;
    return finiteOrNull(context.spot.minus(leg.effectiveCost).div(context.spot));
  },
  relativeSpread: (leg) => finiteOrNull(leg.relativeSpread),
  openInterest: (leg) => finiteOrNull(leg.openInterest),
  volume: (leg) => finiteOrNull(leg.volume),
  turnover: (leg) => finiteOrNull(leg.turnover),
  absDelta: (leg) => finiteOrNull(leg.absDelta),
  dteDays: (leg) => finiteOrNull(leg.dteDays),
};

const ORDINAL_EXTRACTORS: Readonly<Record<OrdinalFeatureKey, (leg: RankingLegInput) => boolean>> = {
  isMonthlyChain: (leg) => leg.isMonthlyChain,
  isRoundStrike: (leg) => leg.isRoundStrike,
  isDeltaInIntentBand: (leg) => leg.isDeltaInIntentBand,
  crossesEarnings: (leg) => leg.crossesEarnings,
  isTopRanked: (leg) => leg.isTopRanked,
};

/**
 * 整个候选集的特征集 (FR-019 / FR-019a)。`O(n)` (13 项各扫一趟定长的候选集)。
 *
 * 🚨 **只接受整个候选集** —— 见文件头。调用方 MUST 传该 Tab 的**召回全量成员** (FR-016 同款
 * 基准): 传筛选后的子集会让每一行的取值都变, 而**数字照样有、照样落 `[0,1]`**。
 */
export function computeRankingFeatures(
  context: RankingContext,
  members: readonly RankingLegInput[],
): RankingFeatures[] {
  const normalized = {} as Record<ContinuousFeatureKey, number[]>;
  for (const key of CONTINUOUS_FEATURE_KEYS) {
    normalized[key] = normalizeMinMax(
      members.map((leg) => CONTINUOUS_EXTRACTORS[key](leg, context)),
    );
  }

  return members.map((leg, index) => {
    // 产出面由键表派生 (不是手写 13 个字段) ⇒ 「加了一项特征却忘了填」这条缝结构上不存在。
    const features = {} as Record<RankingFeatureKey, number>;
    for (const key of CONTINUOUS_FEATURE_KEYS) features[key] = normalized[key][index];
    for (const key of ORDINAL_FEATURE_KEYS) {
      features[key] = ORDINAL_EXTRACTORS[key](leg) ? 1 : 0;
    }
    return features;
  });
}

/**
 * 单项 min-max 归一化。`O(n)`。
 *
 * 🚨 **`min === max` 先判** (Guardrail 2): 否则 `0/0` = NaN, 而 NaN 进 sort 不抛错、顺序不可
 * 预测。缺失项**不参与**定基准 —— 把它当 0 会把下界拉到 0, 于是「真实最小值」也变成 0, 整列
 * 的相对位置全被压扁, 而取值照样落 `[0,1]`。
 */
function normalizeMinMax(values: readonly (number | null)[]): number[] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value === null) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min;
  return values.map((value) => {
    if (value === null) return FEATURE_VALUE_WHEN_MISSING;
    // 全等 (含单条候选集): 走到这里 span 恒为 0 —— 全缺失时压根到不了这一行。
    if (span === 0) return FEATURE_VALUE_WHEN_UNIFORM;
    return (value - min) / span;
  });
}

/** 非有限值 (NaN / ±Infinity) 一律按**缺失**处置 —— 它们进 min-max 会把整列毒掉。 */
function finiteOrNull(value: Prisma.Decimal | number | null): number | null {
  if (value === null) return null;
  const numeric = typeof value === 'number' ? value : value.toNumber();
  return Number.isFinite(numeric) ? numeric : null;
}
