import { Prisma } from '../generated/prisma/client';
import { activityVolume } from './leg-derive.rules';
import { type LegTab } from './leg-tab.rules';
import { type LegBasis } from './leg-tier.rules';

/**
 * 050 optionsdesk **精排层**特征集 (ADR-0043 §4, plan D-RANK-1)。无 I/O、无 DI。
 *
 * 特征集是精排层的**唯一输入面**: 排序器只读它 (FR-020), 拿不到原始腿数据。16 项 ——
 * 连续量 9 项按**该 Tab 本次请求候选集内的 min-max** 归一化到 `[0,1]`, 固定取值量 7 项按
 * **固定映射**取值 (布尔 `0`/`1` 是其二值特例), 不参与 min-max (FR-019 / FR-019a)。
 *
 * 🚨 **字段现在就算全, 哪怕当前排序一项都用不到** (FR-019): 050 时唯一的 ranker 只读 `rate`
 * 一项, 052 的 {@link layeredRanker} 用到了其中三项 (流动性档 / 费率 / DTE)。备着其余项的理由
 * 是将来切加权评分时**零改动** —— 不变量的驱动力是「切换时发现某个量拿不到」。
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
 * | 固定取值量 (布尔 / 分档)                  | 固定映射到 `[0,1]`, 不参与 min-max                |
 *
 * 🚫 **归一化不翻转方向**: 相对价差是「越小越好」的量, 但本层只做量纲统一, **不表达偏好** ——
 * 方向与权重归将来的加权器。现在翻转等于把一个 spec 没做的判断烧进特征层, 而本片唯一的 ranker
 * 读不到这一项 ⇒ 翻错了也不会红。
 *
 * 量纲: 归一化后是 `number` (统计量) 而**不是** `Prisma.Decimal` —— 沿 `leg-derive.rules.ts`
 * 的「金额 / 费率用 Decimal, 统计量用 number」纪律。复杂度 `O(项数 × n)` = `O(n)`/候选集。
 */

/**
 * Tab → 档位判定口径 (FR-023)。**每腿一个 `tier`** 的现役标量在新范式下不够用了 —— 同一条腿
 * 可同时在建仓与收租 Tab 且档界不同 ⇒ `tier` 是 **(腿, Tab)** 的属性。
 *
 * 🚨 **全腿 Tab 例外恒年化**: 它混着 10 天与 200 天的腿, 用周化档界判长腿会让整列全是死档。
 *
 * 📌 口径决定的是**显示与档界, 不是顺序**: 周化与年化差一个常数因子 (严格单调变换) ⇒ 两者
 * 降序结果逐行相同 (FR-021 的 📌)。三个 Tab 共用同一个 ranker 正是因为这个。
 */
export const BASIS_BY_TAB: Readonly<Record<LegTab, LegBasis>> = {
  all: 'annualized',
  build: 'weekly',
  rent: 'annualized',
};

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
 * 052 **流动性档界** (FR-017), 作用于**活动量** = `OI + 当日成交` (张)。**降序**列出, 长度 = 档数 − 1。
 *
 * ✅ **T016 定稿维持 `500 / 100 / 10`** (2026-08-13, dev `2026-08-11` 期 / 意图候选并集 325 条)。
 *
 * 🚨 **三刀里只有最低那一刀有分布依据, 这一点 MUST 说清楚**: 活动量在对数尺度上是**单峰 + 一个
 * 死腿尖峰** —— 尖峰在 `[1, 2.2)`(密度 96), 唯一的谷底在 `[2.2, 4.6)`(密度 **30**), 其后一路单调
 * 上升到主峰 `[215, 464)`(密度 195) 再单调回落, **谷底只有一个**。⇒ `10` 是死/活那一刀 (取在谷底
 * 之上一档, 属保守侧: 把 `4.6–10` 的 21 条也归进最低档); `100` 与 `500` **不是谷底而是分位切分**
 * (≈ `p40` / `p69`), 判据是「每档成员数够让档内费率排序说得上话」。
 * 📌 **这不是缺陷而是量的性质**: 找谷底适用于**阈值**(在/不在的二分), 而档界是把连续量**分箱**,
 * 分位切分本就是它的标准做法。🚫 将来要动它, 判据是档内成员数与分位平衡, **MUST NOT 再去找一个
 * 不存在的谷底**。实测三条厚链 (`ACN` / `LULU` / `PEP`) 逐票占满 4 档, 零票全挤一档。
 *
 * 🚨 **量取「持仓 + 成交」而不是价差** (2026-08-12 定, 数据驱动): 实测按 OI 四分位分组时,
 * 相对价差几乎不动 (`0.239 → 0.191`), 而反过来按价差分组时 OI 中位数**非单调**
 * (`316 → 249 → 90 → 185`) —— 价差对「这张合约上有没有人活动」几乎没有分辨力。OI 档则能把
 * 「年化 80.6% 而 OI 中位仅 3」的公式退化组单独分出来。这与 spec Assumptions「流动性的有效
 * 信号偏向持仓与成交」一致。📌 plan `D-RANK-1` 提的两个价差口径 T016 仍会评, 但作为**对照**
 * 而非主键。
 *
 * 📌 **存量 (OI) 与流量 (成交) 同量纲相加是刻意的粗化** —— 分档要的是活动量的**量级**, 不是
 * 精确的流动性模型。T016 标定时若发现两者需要不同权重, 那时再拆。
 */
export const LIQUIDITY_TIER_BOUNDS = [500, 100, 10] as const;

/**
 * 052 **分档降级阈值** (FR-019): 候选数**严格小于**它就不分档, 直接费率降序。
 *
 * ✅ **T016 定稿维持 `10`** (2026-08-13)。🚨 **数据只把它定到一个区间, 不是一个点** —— 逐票候选数
 * 有个大缺口: 建仓 `1/1/2/2/2/2/3/4` 然后直接跳到 `31/32/69`; 收租 `1/2/2/3/4/7/8/9/9` 然后
 * `27/59/92`。⇒ 阈值取 `[10, 27]` 内**任何值, 本数据面上行为逐字相同**。
 * 取区间下沿 `10` 的理由是**方向**: 分档是功能、降级是保险, 该让尽量多的链吃到分档; 而下沿不能
 * 再低 —— 四个档要每档平均 ≥ 2 条腿才谈得上「档内按费率排」⇒ 阈值 ≥ 8, `10` 是同时满足 `≥ 8`
 * 且落在区间内的最小值。
 *
 * 🚨 **边界取严格小于** (`< 阈值` 才降级): 恰好等于阈值仍分档。
 */
export const RANK_TIERING_MIN_CANDIDATES = 10;

/**
 * 052 **费率打平带宽** (FR-018), 作用于**归一化后**的费率差。
 *
 * ✅ **T016 实测标定: `0.02 → 0.01`** (2026-08-13)。原值让期限先验从「例外」变成了「规则」。
 *
 * 🚨 **判据取「它实际翻转了多少对顺序」而不是「带内占比」** —— 后者会把「两条腿费率接近但期限
 * 也同向」的无害对也算进去。实测档内相邻对 (build 125 / rent 191):
 * · `0.02`: 带内 `35.2% / 45.5%`, **实际翻转 `15.2% / 20.9%`** ⇒ 收租每五对里就有一对由期限决胜。
 * · `0.01`: 带内 `21.6% / 23.6%`, **实际翻转 `8.8% / 12.0%`** ⇒ 回到「例外」的量级。
 * 这条线是 spec Assumptions「本片 MUST NOT 引入任何期限先验」画的 —— `FR-018` 只给打平留了口子,
 * 而翻转两成的相邻序不叫打平。
 *
 * 🚨 **换算回绝对量再验一次** (相对口径的代价, 见下): 收租候选集的年化跨度中位 `33.16pp` ⇒
 * `0.01` 的绝对含义中位 **`0.332pp` 年化** (最大 `0.684pp`, `us:LULU`), 而一档报价 tick 在收租
 * 口径上约值 `0.15pp` ⇒ 带宽 ≈ **2 档 tick 的报价噪声**, 「打平」名副其实。`0.02` 则是 `0.663pp`
 * ≈ 4 档 tick, 那已经是真实收益差。
 *
 * 🚨 **口径是相对而非绝对, 这是一个取舍**: ranker 的输入面只有归一化特征 ({@link LegRanker}
 * 签名即约束), 故带宽的语义是「差不超过该候选集费率跨度的 1%」。
 * · 好处: 不必为同一个量在特征表里放两份 (一份连续、一份按绝对带宽离散), 那会撞 FR-025
 *   「每个特征恰好一个计算地点」的精神。
 * · 代价: 候选集里出现一条极端高费率的腿时跨度被拉大, 带宽的**绝对**含义随之变大。⇒ 上面那段
 *   绝对量换算就是这条代价的实测体检, **改值时 MUST 重做一次**。
 */
export const RATE_TIE_BAND = 0.01;

/**
 * 连续量 9 项 (FR-019), 逐项按候选集内 min-max 归一化。
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
  /** `|Δ|` 真值 —— 🚨 只是 16 项之一, **不参与召回** (FR-009 已在 `leg-recall.rules.ts` 封死)。 */
  'absDelta',
  /**
   * 距到期日历天数。
   *
   * 🚨 **MUST NOT 当排序主键, 也 MUST NOT 实现「离理想 DTE 越近越靠前」** (050 FR-022): 那会让
   * 年化 20% 的 60 天腿排在年化 8% 的 35 天腿之后, 而要的是收益不是接近某个数字; DTE 已隐含在
   * 费率的分母里。机械判据 = `rateDescendingRanker` 函数体 `grep -i dte` 零命中。
   *
   * 📌 **052 起 {@link layeredRanker} 可以读它** (052 FR-018): 只在**费率已经打平**的带内决胜,
   * 长期优先。收益仍是主导, 期限只在收益说不出话时开口 ⇒ 那是对上面这条禁令的**精确化**,
   * 不是推翻它 (上面那句机械判据仍逐字有效, 它盯的是全腿视角那个 ranker)。
   */
  'dteDays',
  /**
   * **成色** (052 FR-020): 行权价相对 spot 的折价 `(spot − K) / spot`。越大 = 越虚值 = 成色越好;
   * 深度实值腿为**负**。
   *
   * 📌 它与召回层的成色上界是**同一个概念的两种形态** —— 那边是布尔判据 (`K ≤ 上界`, 只作用
   * 收租), 这边是连续量 (供全腿视角排序令深度实值沉底; 052 FR-006 要求全腿 MUST NOT 砍腿,
   * 所以只能靠序把它压下去)。
   * 🚫 **MUST NOT 拿 `effectiveCostDiscount` 代替** (052 Guardrail 2): 后者含 `bid`, 权利金厚时
   * 深度实值腿的有效成本折价照样好看 —— 那正是「拿有效成本冒充成色」这条错的连续版。两项
   * 各表达各的, 都留在表里。
   *
   * 🚨 **入参给的是已派生好的折价而不是行权价** —— 行权价是**身份键** ({@link LegIdentity}),
   * 放进 {@link RankingLegInput} 就等于允许特征层按身份算特征 (同下方那条结构保证)。
   */
  'strikeDiscount',
] as const;

/**
 * **固定取值量** 7 项 (FR-019; 052 起由「布尔量」扩为本名)。取值在 `[0,1]` 内**固定映射**,
 * **不参与 min-max** —— 参与了会让「全 true」的候选集里每一项都变 `0.5`, 于是「是」与「不是」
 * 在下游不可区分, 而取值仍落 `[0,1]`。
 *
 * 📌 布尔量是本类的二值特例 (`0` / `1`); 052 的 {@link LIQUIDITY_TIER_BOUNDS} 分档量取多值。
 * 🚨 **分档量 MUST 走本类而非连续类**: min-max 会把「候选集恰好全在同一档」拉伸成 `0..1`,
 * 于是**绝对档界的语义当场消失** —— 而排出来的顺序照样有、照样落 `[0,1]`。
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
  /**
   * **流动性档** (052 FR-017) —— lexicographic 的**主键**。档界见 {@link LIQUIDITY_TIER_BOUNDS},
   * 取值 `0`(最差档) … `1`(最好档), 与其余项同向 (越大越好)。
   *
   * 🚨 **主键必须先离散化**: 纯 lexicographic 用连续流动性值当主键会让 `OI 501` 无条件压过
   * `OI 500` —— 无论费率差多少, **费率完全失声** (052 Guardrail 3)。分档把流动性粗化成几个
   * 等价类, 档内才轮到费率说话。
   */
  'liquidityTier',
  /**
   * 是否**实值** (`K > spot`, 052 FR-020) —— 全腿视角把它当沉底键。
   *
   * 🚨 **必须是固定取值量而不是拿归一化后的成色去判**: min-max 之后**符号信息就没了** ——
   * 候选集里最实值的那条恒取 `0`、最虚值的恒取 `1`, 而「`0` 是深度实值还是只是本批里最不虚」
   * 无从分辨。⇒ 实值与否在归一化**之前**判定, 判据取 {@link RankingLegInput.strikeDiscount}
   * 的符号 (它是 `(spot − K) / spot` 的裸值)。
   *
   * 📌 与 `strikeDiscount` 两项并存不是冗余: 前者回答「要不要沉底」(离散、跨候选集可比),
   * 后者回答「在没沉底的那批里成色排多少」(连续、候选集内相对)。
   */
  'isInTheMoney',
] as const;

/** 16 项 = 9 + 7。**键表是唯一来源**, 产出面由它派生 ⇒ 两者不可能 drift。 */
export const RANKING_FEATURE_KEYS = [...CONTINUOUS_FEATURE_KEYS, ...ORDINAL_FEATURE_KEYS] as const;

export type ContinuousFeatureKey = (typeof CONTINUOUS_FEATURE_KEYS)[number];
export type OrdinalFeatureKey = (typeof ORDINAL_FEATURE_KEYS)[number];
export type RankingFeatureKey = (typeof RANKING_FEATURE_KEYS)[number];

/**
 * 特征集 —— 16 项, 每项 `∈ [0,1]` (SC-003a)。
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
  /** 成色 `(spot − K) / spot`, 由调用方派生 (见键表注释: 行权价本身是身份键, 不进本类型)。 */
  strikeDiscount: Prisma.Decimal | null;
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
  strikeDiscount: (leg) => finiteOrNull(leg.strikeDiscount),
};

/** 固定映射到 `[0,1]`, **不过 min-max** —— 布尔量走 {@link boolFeature}, 分档量自算。 */
type OrdinalExtractor = (leg: RankingLegInput) => number;

const boolFeature = (value: boolean): number => (value ? 1 : 0);

const ORDINAL_EXTRACTORS: Readonly<Record<OrdinalFeatureKey, OrdinalExtractor>> = {
  isMonthlyChain: (leg) => boolFeature(leg.isMonthlyChain),
  isRoundStrike: (leg) => boolFeature(leg.isRoundStrike),
  isDeltaInIntentBand: (leg) => boolFeature(leg.isDeltaInIntentBand),
  crossesEarnings: (leg) => boolFeature(leg.crossesEarnings),
  isTopRanked: (leg) => boolFeature(leg.isTopRanked),
  liquidityTier: (leg) => liquidityTierFeature(leg.openInterest, leg.volume),
  // 折价为负 ⇒ `K > spot` ⇒ 实值。缺失 (spot 脏数据) 判 `false`: 不知道就不沉底, 与
  // 「知道它是虚值」处置同归但成因不同 —— 沉底是**惩罚**, 拿不准时 MUST NOT 施加。
  isInTheMoney: (leg) => boolFeature(leg.strikeDiscount !== null && leg.strikeDiscount.lessThan(0)),
};

/**
 * 活动量 → 流动性档 → `[0,1]` (052 FR-017)。`O(档数)` = `O(1)`。
 *
 * 🚨 **两侧缺失一律按「没观测到活动」处置** (取 `0` 参与求和): 与 `leg-recall.rules.ts` 那条
 * 「`null` 不等于 0」的纪律**不冲突** —— 那里判的是「这条腿死没死」(处置是移出候选, 必须区分
 * 未采集与确认为零), 这里判的是「它在哪一档」, 而没观测到活动与没有活动落同一档是对的。
 * 📌 进得到这里的腿都已过持仓量条件 ⇒ 至少一侧 `> 0`, 全缺失只可能来自测试或换 vendor。
 */
function liquidityTierFeature(openInterest: number | null, volume: number | null): number {
  // 052: 活动量的定义单点在 `leg-derive.rules.ts` —— 档界与活跃标绝对线是同一个量的两条界。
  const activity = activityVolume(openInterest, volume);
  const tiers = LIQUIDITY_TIER_BOUNDS.length + 1;
  // 档界降序 ⇒ 第一个够得着的就是它的档; 都够不着 = 最差档。
  const rank = LIQUIDITY_TIER_BOUNDS.findIndex((bound) => activity >= bound);
  const tierIndex = rank === -1 ? LIQUIDITY_TIER_BOUNDS.length : rank;
  // 最好档 → 1, 最差档 → 0 (与其余项同向: 越大越好)。
  return (tiers - 1 - tierIndex) / (tiers - 1);
}

/**
 * 整个候选集的特征集 (FR-019 / FR-019a)。`O(n)` (16 项各扫一趟定长的候选集)。
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
    for (const key of ORDINAL_FEATURE_KEYS) features[key] = ORDINAL_EXTRACTORS[key](leg);
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

// ─────────────────────────────────────────────────────────────────────────────
// 排序 (FR-020 / FR-021 / FR-022 / FR-025, plan D-RANK-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 腿的**身份** —— 只服务确定性次键, 🚫 **MUST NOT 进特征集** (plan D-RANK-2)。
 *
 * 到期日 / 行权价 / 合约代码回答的是「这是哪一条腿」而不是「这条腿好在哪」; 合约代码更没法
 * 归一化到 `0–1`。把它们塞进特征集就等于允许排序器按身份排序, 而那是**每次都排得出结果**的错。
 */
export interface LegIdentity {
  /** vendor 合约代码 (行身份, 也是三级次键)。 */
  code: string;
  expiryDate: Date;
  strike: Prisma.Decimal;
}

/**
 * 排序器 —— **只吃特征集** (FR-020)。返回值同 `Array.prototype.sort` 的比较器: 负 = `a` 在前。
 *
 * 🚨 签名即约束: 拿不到原始腿数据就不可能绕过特征层去读 `bid` / `tier` / 到期日。想读就必须先
 * 改这个签名, 那一步 review 看得见 (同 `leg-recall.rules.ts` 的入参里没有 `absDelta`)。
 */
export type LegRanker = (a: RankingFeatures, b: RankingFeatures) => number;

/**
 * 本片**唯一**的排序器: 折算费率降序 (FR-021)。`O(1)`。
 *
 * 📌 归一化是单调变换 ⇒ 「归一化后费率降序」与「原始费率降序」逐行同序; 周化 / 年化亦然
 * (两者差一个常数因子)。⇒ 三个 Tab 共用它一个, 选 `basis` 是在选**显示口径与档界**不是选顺序。
 *
 * 🚫 **MUST NOT 引入加权评分** (FR-026): 判定手段限定为「硬门槛 + 单主键 + 标签」。特征层已为
 * 将来切加权备好 16 项 (FR-019), 切换点在这里 —— 换一个 `LegRanker` 实现即可, 别在这条上加项。
 * 🚫 **MUST NOT 提 DTE** (FR-022): 机械判据是本函数体 `grep -i dte` 零命中。
 */
export const rateDescendingRanker: LegRanker = (a, b) => b.rate - a.rate;

/**
 * **全腿视角的排序器** (052 FR-020, plan D-RANK-1)。`O(1)`/比较。
 *
 * 两级键: **实值沉底 → 费率降序**。非实值的那批之间**逐条保持费率降序** (FR-020 的「保持」),
 * 实值腿整体落到末段。
 *
 * 🚨 **MUST NOT 靠移出候选实现沉底** (FR-006 / SC-006): 全腿是参照视角, 051 已 ship 的
 * 「切到全腿看被排除的腿」那个入口依赖它保留全部腿。⇒ 这里只改**序**, 一条腿都不砍。
 *
 * 🚨 **为什么实值腿该沉底**: 认沽腿 `K > spot` 时权利金里绝大部分是**内在价值**, 折算费率会
 * 算出三位数年化 —— 那是公式退化产物, 不是收益 (052 spec 的起因就是收租视角被这批占满)。
 * 全腿视角不砍它们 (它们是「被排除的腿」的一部分, 用户要能查到), 但让它们不占前排。
 *
 * 🚫 **MUST NOT 提 DTE** —— 全腿混着 10 天与 200 天的腿, 期限先验在这里尤其危险 (050 FR-022
 * 那条禁令对本 ranker 一字有效; `layeredRanker` 的打平带例外只在意图视角成立)。
 */
export const allLegsRanker: LegRanker = (a, b) => {
  const byMoneyness = a.isInTheMoney - b.isInTheMoney;
  if (byMoneyness !== 0) return byMoneyness;
  return b.rate - a.rate;
};

/**
 * **意图视角的分层排序器** (052 FR-017 / FR-018 / FR-019, plan D-RANK-1)。`O(1)`/比较。
 *
 * 三级键, lexicographic:
 * ```text
 * 流动性档 (离散, 高档在前) → 档内折算费率降序 → 费率打平带内**长期优先**
 * ```
 *
 * 🚨 **候选数 < {@link RANK_TIERING_MIN_CANDIDATES} 时降级为纯费率降序** (FR-019): 薄链上档内
 * 没有足够多腿可比收益, 分档会退化成「按流动性排」—— 而那时**排得出顺序、看不出错**。边界取
 * **严格小于**, 恰好等于阈值仍分档。
 *
 * 🚨 **本 ranker 读 `dteDays` 是 052 FR-018 的授权, 不是违反 050 FR-022**: 050 禁的是拿 DTE 当
 * **排序主键**或实现「离理想 DTE 越近越靠前」(那会让年化 20% 的 60 天腿排在年化 8% 的 35 天腿
 * 之后)。这里 DTE 只在**费率已经打平**时决胜 —— 收益仍是主导, 期限只在收益说不出话时开口。
 * ⇒ 052 是对那条禁令的**精确化**而非推翻; `rateDescendingRanker` 那边的禁令一字不改。
 *
 * 🚫 **MUST NOT 引入加权评分** (FR-021 / ADR-0064 决策 3): 权重无可校准数据。lexicographic 的
 * 全部价值就在于它不需要权重 —— 加一个 `0.3 × 流动性 + 0.7 × 费率` 就把这个性质丢了。
 */
export function layeredRanker(candidateCount: number): LegRanker {
  if (candidateCount < RANK_TIERING_MIN_CANDIDATES) return rateDescendingRanker;
  return (a, b) => {
    const byTier = b.liquidityTier - a.liquidityTier;
    if (byTier !== 0) return byTier;
    const byRate = b.rate - a.rate;
    if (Math.abs(byRate) > RATE_TIE_BAND) return byRate;
    // 打平带内: 长期优先。仍分不出 ⇒ 返 0, 由 `rankLegs` 的身份键兜底 (确定性在那一层保住)。
    return b.dteDays - a.dteDays;
  };
}

/**
 * 候选集 → **有序的合约代码列表** (FR-021a / FR-025)。`O(n log n)`。
 *
 * 分层 (plan D-RANK-2): `ranker` 管主键, 主键分不出时用**身份键**兜底 —— 到期日升序 → 行权价
 * 降序 → 合约代码。三级次键各自都有判别性, 合起来在同一份候选集上是全序 ⇒ 同输入两次调用逐行
 * 相同 (SC-006), 且**与入参次序无关**。
 *
 * 🚨 **`ranker` 返回非有限值时退回身份键**: NaN 进 `Array.prototype.sort` 顺序不可预测**且不抛
 * 任何错**。确定性是本函数自己要保住的性质, 不能寄望于「特征集那边不会产 NaN」—— 两个函数各自
 * 守住自己那一半, 中间那条缝才不存在。
 *
 * @throws RangeError 成员数与特征数不等。这只可能是调用方没拿同一份成员算特征, 而静默会让整列
 *   错位 —— 每一行都拿到别人的特征, 顺序看着完全正常。
 */
export function rankLegs(
  members: readonly LegIdentity[],
  features: readonly RankingFeatures[],
  ranker: LegRanker,
): string[] {
  if (members.length !== features.length) {
    throw new RangeError(
      `rankLegs: 成员 ${members.length} 条与特征 ${features.length} 条不等 —— ` +
        '特征集 MUST 由同一份成员数组算出',
    );
  }

  return members
    .map((leg, index) => ({ leg, index }))
    .sort((x, y) => {
      const primary = ranker(features[x.index], features[y.index]);
      if (Number.isFinite(primary) && primary !== 0) return primary;
      return (
        x.leg.expiryDate.getTime() - y.leg.expiryDate.getTime() ||
        y.leg.strike.comparedTo(x.leg.strike) ||
        x.leg.code.localeCompare(y.leg.code)
      );
    })
    .map(({ leg }) => leg.code);
}

// ─────────────────────────────────────────────────────────────────────────────
// 表达层截断 (053 FR-004 / FR-010 - FR-012, plan D-ORDER-1 / D-LIMIT-1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 053 **表达层截断阈值 `N`**, 按视角分档 (FR-012)。条数, 整数; `null` = **不设该视角的阈值**
 * (零截断) —— FR-013 的「分布无断点则记为不设, 不许拍数」在类型上就有落点。
 *
 * ✅ **T012 实测标定** (2026-08-14, dev `2026-08-13` 期 / 12 链 / 三视角 `matchedCount` =
 * 全腿 `20–430` · 建仓 `0–115` · 收租 `0–85`; 全过程与逐链读数在
 * `specs/053-optionsdesk-leg-query-pushdown/spec.md` §标定实测)。
 *
 * · **两个意图视角 `80`** —— 判据取「值得看」= **活档** (流动性档 ≠ 最差档) **且** 费率档
 *   ∈ {甜点, 合理}。两者都是已实装判据, 合取的顺序就是 {@link layeredRanker} 的键序 (只看
 *   费率会把「活动量 3 张、年化 210%」判成值得看, 而那正是分档要防的)。22 个链-视角 pooled
 *   后按名次每 10 名一桶, 该类腿的占比是 `71/42/33/59/70/90/65/`**`10`**`/`**`0`**`/0/0/0`
 *   ⇒ 断点在**名次 80 与 81 之间**: 全域最深的一条在第 **72** 名 (`us:ACN` 收租, 活动量 41 /
 *   合理档 / 年化 10.1%), 其后零条。
 *   🚨 **取桶界 `80` 而不是那个 `72`**: 后者是**单个观测点**, 而直方图分辨得出的最细刀口是
 *   桶界; 方向上截断是减法宁可少截 (取 `70` 会砍掉 `us:ACN` 收租第 71 / 72 名两条合理档活腿)。
 *   📌 **建仓与收租取同一个数是实测结论而非省事**: 两者断点各自实测 `65` / `72`, 差在单个
 *   观测点的量级内; FR-012 要的分档是「全腿 vs 意图」, 那一档由下面的 `null` 兑现。
 *   爆炸半径: 今日 22 个链-视角只有 2 个触发 —— `us:LULU` 建仓截 35 条、`us:ACN` 收租截 5 条,
 *   **两处被截段里「活档 + 达标档」均为 0 条**。
 *
 * · **全腿视角 `null` (不设该视角阈值)** —— 两条独立理由, 任一条单独成立:
 *   ① **无断点**: 同一判据下「值得看」的占比沿名次**不衰减反而上升**, 名次 351 之后的桶是
 *   `95/95/94/100/100/100/100/100`%。成因是结构性的 —— 实值腿沉底 ({@link allLegsRanker}) 让
 *   尾段整块是**公式退化**的高年化腿 (`us:ACN` 第 214 名起 `2326%` / `2000%` / `1278%`, 而紧邻
 *   其前的第 213 名是 `0.7%`), 而档位判据认年化 ⇒ 尾巴整块判「甜点档」。
 *   ② **FR-014 的硬下界不是一个常数**: 被意图视角流动性条件排除的腿在本视角序列里的最深名次
 *   实测 **285** (`us:ACN`, n=376), 而逐链「最深 / 该链规模」= `0.300 … 0.956` (上界 `us:PEP`
 *   216/226) ⇒ 下界随链规模成比例, 而下面那条 `limit × 5 ≤ K` 把 `N` 封在 600 以内 ⇒
 *   **不存在一个对更大的链仍然安全的固定值**。`null` 是唯一无条件满足 FR-014 的取值, SC-012
 *   因此由构造成立、不依赖标定值。
 *   📌 **两条读法的分歧对裁定无影响**: 若把实值块判为「公式退化不值得看」, 断点落在非实值段内
 *   最深值得看的第 **113** 名 —— 低于下界 285 ⇒ 断点不可用, 而下界之上再无分布依据可定点 ⇒
 *   仍然是「不设」。
 *   ⚠️ 连带: 本视角的 `displayLimit` 恒下发 `null` ⇒ 逼近度 `matchedCount / displayLimit` 对它
 *   无定义 (没有阈值可逼近), FR-015 的观测面只作用两个意图视角。
 *
 * 🚨 **分档不是三个对称的数** (FR-012): 全腿视角与两个意图视角的成员规模差一个量级, 一律取
 * 同一个数会让其中一档要么形同虚设、要么砍掉不该砍的。
 * 🚨 **改动意图视角的取值时 MUST 一并重验全腿那一档仍不设** (FR-014): `051` ship 的「点流动性
 * 排除数 → 切到全腿看被排除的腿」这个入口依赖那些腿仍在表内 —— 给全腿设一个截在它们之前的
 * 阈值, 该入口就指向一张不含目标的表, **且不会红**。
 *
 * 🚨 **它与召回层的候选上限 `K` (`leg-recall.rules.ts` 的 `RECALL_CANDIDATE_CAP`) MUST 是两个
 * 独立常量** (ADR-0064 不变量 ①): 前者是「给用户看几条」, 后者是「给下游限流的保险丝」。共用
 * 一个数的话, 调展示条数就会顺手改掉召回容量 —— 而候选集变小这件事**在响应里看不出来**。
 * 对照断言在 `leg-rank.rules.spec.ts` (052 T005 当时只能写量级占位, 本片起是真对照)。
 */
export const DISPLAY_LIMIT_BY_PERSPECTIVE: Readonly<Record<LegTab, number | null>> = {
  all: null,
  build: 80,
  rent: 80,
};

/**
 * 精排结果 → **表达层实际呈现的那一段** (FR-004 / FR-010)。`O(N)` (一次 slice, 不重排)。
 *
 * 🚨 **判据是「严格大于阈值才截」** —— 恰等于阈值不截: 那时「其余 0 条未显示」这句话不该出现
 * (spec Edge Case)。
 * 🚨 **未触发时返回入参本体** (同一引用): 让「这次没截」成为调用点可判定的事实, 而不是靠比
 * 长度反推 —— 后者在「阈值为 `null`」与「恰好没超」两种成因下会得出同一个结论。
 *
 * 🚫 **本函数 MUST NOT 做任何成员判定** (053 Guardrail 1): 六维条件已由 `052` 并入召回层,
 * 排名基准就是当前条件下的召回集; 在这里再判一次就是第二条成员判据路径, 而它**不会红** ——
 * 截出来的条数照样对, 只是截掉的不是排序尾部。
 * ⇒ 可验证形态: 截断前后**前 D 条逐条相同** (只断条数抓不到「截错了哪一段」, Guardrail 8)。
 */
export function truncateToDisplayLimit<T>(
  ranked: readonly T[],
  limit: number | null,
): readonly T[] {
  if (limit === null || ranked.length <= limit) return ranked;
  return ranked.slice(0, limit);
}
