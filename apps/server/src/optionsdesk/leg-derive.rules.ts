import { Prisma } from '../generated/prisma/client';
import { computeDistanceToWPct } from './anchor.rules';

/**
 * 047 optionsdesk 腿派生纯函数 (ADR-0043 §4)。无 I/O、无 DI。
 *
 * 全部派生**请求时算, 零物化列** (FR-041): 口径仍在演进 (策略 SoT 会改), 物化的收益远小于
 * drift 风险。单票 `O(n)`, n = 该票当日快照行数 (实测上界 730); 只有活跃度排名是 `O(n log n)`。
 *
 * 两处量纲纪律:
 * - **金额 / 费率一律 `Prisma.Decimal`** (零新 dep), 费率取小数比例 (与 `leg-tier.rules.ts`
 *   的判档口径同量纲, 单测有一条互洽断言)。
 * - **`|Δ|` 与 σ 距是 `number`** —— 它们是**统计量而非金额**, Φ⁻¹ 只有浮点逼近 (Decimal.js
 *   无 erf), 且用途是呈现坐标, 精度要求 1e-9 量级。金额与统计量各用各的类型, 不混。
 *
 * 🚨 **W / 四区间一律复用 045 `anchor.rules.ts`** (plan D-API-2 / Guardrail 13): 本文件不持任何
 * 区间系数, 「有效成本相对 W 的位置」直接委托 `computeDistanceToWPct` —— 它算的就是
 * `(x − W) / W × 100`, 换个入参即得。
 */

/** Decimal 可接受形态: string (DTO / 常量) 或 Prisma.Decimal (PG row)。 */
type Decimalish = string | Prisma.Decimal;

const D = (v: Decimalish): Prisma.Decimal => new Prisma.Decimal(v);

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

/** 折算基准 (SoT 的「周化」= 7 天口径)。 */
export const DAYS_PER_WEEK = 7;

/** 折算基准 (年化 / 折年)。取日历年而非交易日 —— DTE 本身就是日历天数。 */
export const DAYS_PER_YEAR = 365;

/**
 * 美股期权合约乘数 (成交额 = `Vol × 权利金 × 100`, plan D-SOT-5)。
 *
 * 🚨 它**蓄意不落库** (FR-028a 同源纪律: 合约表 MUST NOT 存合约乘数) —— 乘数是市场规则不是
 * 合约属性, 双写必 drift。派生时从这里取。
 */
export const US_OPTION_CONTRACT_MULTIPLIER = 100;

/** 活跃度 Top N 的 N (plan D-SOT-5「取前 3」)。052 起它是**每个到期日**内的 N (FR-023)。 */
export const ACTIVITY_TOP_RANK_COUNT = 3;

/**
 * 052 **活跃标绝对量下限** (FR-024), 作用于**活动量** = `OI + 当日成交` (张)。
 *
 * ✅ **T016 定稿维持 `100`, 但理由换了 —— 它现在有自己的分布依据, 不再只是「借用第二档界」**
 * (2026-08-13, dev `2026-08-11` 期 / 64 个到期日组)。判据面 = **组内 top-1 活动量**在对数尺度上
 * 的密度, 实测是**双峰**: 低峰 `[21.5, 46.4)`(密度 15) 与主峰 `[1000, 2154)`(密度 42), 两峰之间
 * `[46.4, 215)` 是密度 9 的**平坦谷底**。⇒ `100` 落在谷底正中。
 *
 * 🚨 **谷底该有的性质是「取值对位置不敏感」, 实测成立**: 下限取 `50 / 100 / 200` 时零标到期日组
 * 分别是 `10 / 12 / 15`(共 64 组) —— 都在谷内, 结论不随刀口在谷内怎么挪而变。
 * 📌 它与 `LIQUIDITY_TIER_BOUNDS` 的第二档界**同为 `100` 现在是巧合而非引用**: 两者各有各的
 * 分布依据 (那个是分位切分, 这个是谷底)。🚫 MUST NOT 因为「反正一样」就把其中一个改成引用另一个,
 * 它们下次标定会各走各的。
 *
 * 🚨 **它是相对判据之外的第二道门, 不是替代** (plan Guardrail 4): 只用相对判据会在死到期日里
 * 发标 —— 实测某到期日 OI 合计仅 23、其 top-1 只有 `OI = 4`, 而它在组内照样是第一名。
 */
export const ACTIVITY_ABSOLUTE_FLOOR = 100;

// ─────────────────────────────────────────────────────────────────────────────
// ① 三个费率 (分母恒为准备金 K − P)
// ─────────────────────────────────────────────────────────────────────────────

export interface LegRateInput {
  /** 行权价 K。 */
  strike: Decimalish;
  /** 权利金 P (判档口径恒为 `bid`, 取哪一边归调用方)。 */
  premium: Decimalish;
  /** 距到期日历天数。 */
  dteDays: number;
}

export interface LegRates {
  /** 期间费率 `P / (K − P)` —— 未折算, 三者的共同根。 */
  periodRate: Prisma.Decimal;
  /** 周化 (建仓短腿的决策值, FR-018)。 */
  weeklyRate: Prisma.Decimal;
  /**
   * 年化。收租腿的**决策值**; 落在周化族的行上时它就是**折年参照列**。
   * 🚫 折年 MUST NOT 作短腿的决策变量或排序键 (FR-004: 年化 ∝ 1/√T, 跨 DTE 直比系统性偏向短腿)。
   * 两者是同一个数的两种角色 —— 蓄意不做成两个字段, 免得有人拿「折年」字段去排序时以为它是别的东西。
   */
  annualizedRate: Prisma.Decimal;
}

/**
 * 三个费率 (FR-018, plan D-API-2)。`O(1)`。
 *
 * 分母恒为**准备金** `K − P` (不是 K, 也不是保证金) —— 卖 put 真正占用的现金。
 * `K − P ≤ 0` (权利金吃掉整个行权价) 或 `DTE ≤ 0` (已到期 / 当日到期) ⇒ 费率无定义,
 * 返回 `null` 而**不伪造 0** (承 046「禁显 0、显未知」)。
 */
export function computeLegRates({ strike, premium, dteDays }: LegRateInput): LegRates | null {
  if (!Number.isFinite(dteDays) || dteDays <= 0) return null;
  const p = D(premium);
  const reserve = D(strike).minus(p);
  if (reserve.lessThanOrEqualTo(0)) return null;

  const periodRate = p.div(reserve);
  return {
    periodRate,
    weeklyRate: periodRate.times(DAYS_PER_WEEK).div(dteDays),
    annualizedRate: periodRate.times(DAYS_PER_YEAR).div(dteDays),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 有效成本相对 W 的位置
// ─────────────────────────────────────────────────────────────────────────────

/** 有效成本 = `K − P` (被指派后的实际持仓成本)。`O(1)`。 */
export function computeEffectiveCost(strike: Decimalish, premium: Decimalish): Prisma.Decimal {
  return D(strike).minus(D(premium));
}

/**
 * 有效成本相对愿买价 W 的位置, 百分数 (FR-003)。负 = 有效成本落在 W 下方 (比愿买价还便宜)。
 * `O(1)`。
 *
 * 口径与 045 雷达的「距 W%」完全一致 —— **同一个函数**, 只是把 spot 换成有效成本, 故两处永不打架。
 * `v ≤ 0` 由 `anchor.rules.ts` 拒绝 (抛 `INVALID_ANCHOR_V`), 本文件不重复判。
 */
export function computeEffectiveCostVsWPct(
  v: Decimalish,
  strike: Decimalish,
  premium: Decimalish,
): Prisma.Decimal | null {
  return computeDistanceToWPct(v, computeEffectiveCost(strike, premium));
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ Δ 与 σ 距离 (同源, Guardrail 10)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 标准正态分位函数 Φ⁻¹, **Acklam 有理逼近** (定义域开区间 `(0,1)`, 绝对误差 < 1.15e-9)。`O(1)`。
 *
 * 🚨 **蓄意手写而非引库** (plan 依赖决策): 单个初等函数不值得挂 `jstat` / `simple-statistics`
 * 一整个统计库 (SC-008 零新依赖); vendor 已给 Δ, Φ⁻¹ 只用于呈现坐标换算, 1e-9 的逼近误差
 * 远宽于需求。系数取自 Peter Acklam 的公开算法, 未做 Halley 精化 (精化需要 erfc, 又要一坨代码,
 * 而 1.15e-9 已比断言口径 1e-6 严三个数量级)。
 */
function inverseStandardNormalCdf(p: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

export interface DeltaColumns {
  /** `|Δ|` 真值 (FR-003 定案: 显真值不显符号)。 */
  absDelta: number | null;
  /** σ 距 `= −Φ⁻¹(|Δ|)` —— 跨期限可比的坐标 (Δ 不可跨期限横比)。 */
  sigmaDistance: number | null;
}

/**
 * Δ 列与 σ 距列 (plan D-UI-3)。`O(1)`。
 *
 * 🚨 **两列由同一个 `absDelta` 派生是结构保证, 不是事后断言** (Guardrail 10): 本函数**只吃一个
 * 入参**并同时产出两列 ⇒ 想「一列取 vendor Δ、另一列拿 spot/K/IV 反算」就必须先改签名。
 *
 * `|Δ| ∈ {0, 1}` 时 Φ⁻¹ 发散 ⇒ **两列同时留空** (按 FR-007「数据不全」处置), 不允许一列有一列无。
 * greeks 缺失 (`null` / `NaN`) 与越界值同此处置。
 *
 * @param absDelta **绝对值**, 由调用方对 vendor 的负 Δ (本片只含认沽) 取绝对值后传入。
 *   传负值视为脏数据 → 两列留空, 本函数不代为取绝对值 (代取会掩盖 FR-043 硬门的漏网行)。
 */
export function deriveDeltaColumns(absDelta: number | null | undefined): DeltaColumns {
  const empty: DeltaColumns = { absDelta: null, sigmaDistance: null };
  if (typeof absDelta !== 'number' || !Number.isFinite(absDelta)) return empty;
  if (absDelta <= 0 || absDelta >= 1) return empty;
  return { absDelta, sigmaDistance: -inverseStandardNormalCdf(absDelta) };
}

// ─────────────────────────────────────────────────────────────────────────────
// ④ 活跃度 (候选集内的相对排名)
// ─────────────────────────────────────────────────────────────────────────────

export interface ActivityInput {
  /** 行权价 —— 整数档判据。 */
  strike: Decimalish;
  /**
   * 到期日分组键 (052 FR-023) —— 调用方给**已归一到「日」**的键, 与月度链标 / 财报标同源
   * (`get-legs.usecase.ts` 的 `dateOnlyOf`), 三处分组键同一口径才不会 drift。
   *
   * 🚨 **MUST NOT 传含时分秒的字符串或 `Date.toISOString()` 全串**: 同一到期日会因此分裂成多组,
   * 每组只剩一条腿 ⇒ 条条都是「组内第一」, 标满天飞 —— 而**标照常有、函数照常返回**, 不会红。
   */
  expiryKey: string;
  /** 未平仓合约数; 缺失 → `null` (排末位, 不当 0)。⚠️ 它归属 T−1 交易日 (Guardrail 6)。 */
  openInterest: number | null;
  /** 当日成交量; 缺失 → `null`。 */
  volume: number | null;
}

/** 活跃度呈现标签。两个标记可同真, 标签**整数档优先** (SoT「整数档优先」)。 */
export type ActivityLabel = 'round_strike' | 'top_ranked';

export interface ActivityMark {
  /** 行权价为整数 —— 做市商深度天然集中在整数档。 */
  isRoundStrike: boolean;
  /** 在**当前候选集**内, `OI` 与 `Volume` 各自排名之和进前 {@link ACTIVITY_TOP_RANK_COUNT}。 */
  isTopRanked: boolean;
  /** 呈现标签; 两者皆否 → `null` (留空, MUST NOT 伪造默认档)。 */
  label: ActivityLabel | null;
}

/** 单指标名次: 降序, 缺失排末位, 并列共享最好名次 (competition ranking)。`O(n log n)`。 */
function rankDescending(values: readonly (number | null)[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((x, y) => {
      if (x.value === y.value) return x.index - y.index;
      if (x.value === null) return 1;
      if (y.value === null) return -1;
      return y.value - x.value;
    });
  const ranks = new Array<number>(values.length);
  for (let i = 0; i < order.length; i += 1) {
    const tiedWithPrevious = i > 0 && order[i].value === order[i - 1].value;
    ranks[order[i].index] = tiedWithPrevious ? ranks[order[i - 1].index] : i + 1;
  }
  return ranks;
}

/**
 * **活动量** = `OI + 当日成交` (张)。缺失一侧按「没观测到活动」取 `0`。`O(1)`。
 *
 * 🚨 **单一计算地点** (052): 流动性档界 (`leg-rank.rules.ts` `LIQUIDITY_TIER_BOUNDS`) 与活跃标
 * 绝对线 ({@link ACTIVITY_ABSOLUTE_FLOOR}) 是同一个量的两条界, 两处各写一份表达式的话
 * T016 标定只改一处就会静默 drift —— 而两边照样都算得出数。
 *
 * 📌 存量 (`OI`) 与流量 (成交) 同量纲相加是刻意的粗化: 要的是活动量的**量级**, 不是精确的
 * 流动性模型。
 */
export function activityVolume(openInterest: number | null, volume: number | null): number {
  return (openInterest ?? 0) + (volume ?? 0);
}

/**
 * 活跃度标记 (plan D-SOT-5, 052 D-MARK-1)。`O(n log n)` (逐组两次排名 + 取前 N)。
 *
 * **两条判据同时成立才发标** (052 FR-024):
 * ① 相对 —— 在**同一到期日**内 `OI` 与 `Volume` 各自排名之和进前 {@link ACTIVITY_TOP_RANK_COUNT};
 * ② 绝对 —— 活动量 ≥ {@link ACTIVITY_ABSOLUTE_FLOOR}。
 *
 * 🚨 **相对判据的分母是「组」不是「全链绝对阈值」** —— SoT 原文明确 **不用** 全链 Top-N /
 * OI 中位 / V/OI。⇒ 同一条腿换一个候选集 (换 Tab / 换筛选) 归属会变, 这是**定义如此**不是 bug;
 * 故本函数**只接受整个候选集**, 不提供单行版本 —— 单行版本必然要拿全局阈值凑, 正是被否的做法。
 *
 * 🚨 **052 起分组维度是到期日** (FR-023): 候选集口径下标会全部堆在流动性最好的那个到期日上,
 * 其余到期日一个标没有 —— 而**标照常发得出来**, 只是看不见「每个到期日各自谁最活跃」。
 *
 * 🚨 **绝对线只否决、不递补** (FR-024 字面「进前 N **且**过线」): 前 N 在**全组**内定死, 组内
 * 第 3 被绝对线挡下时第 4 名即使过线也不顶上。反过来写 (先滤过线的再取前 N) 会把「排名」的
 * 分母悄悄换成「过线的那批」, 结果照样有、名次却是另一个口径的。
 *
 * 并列处置: 排名和相同时依次按 `OI` 降序 → `Volume` 降序 → 组内原序, **取满 N 个不外溢** ——
 * 「前 3」就是 3 行, 免得并列时列里冒出 5 个标记 (窄表里视觉噪音直接盖过信号)。决胜链到原序
 * 为止全确定 ⇒ 同一输入两次调用逐字相同 (plan Guardrail 10)。
 */
export function markActivity(rows: readonly ActivityInput[]): ActivityMark[] {
  // 只装出现过的到期日 ⇒ 无候选的到期日既不成组也不参与除法 (D-MARK-1「不产生空分组」)。
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const members = groups.get(row.expiryKey);
    if (members === undefined) groups.set(row.expiryKey, [index]);
    else members.push(index);
  });

  const topIndexes = new Set<number>();
  for (const members of groups.values()) {
    const oiRanks = rankDescending(members.map((index) => rows[index].openInterest));
    const volumeRanks = rankDescending(members.map((index) => rows[index].volume));
    members
      .map((index, seat) => ({
        index,
        seat,
        rankSum: oiRanks[seat] + volumeRanks[seat],
        openInterest: rows[index].openInterest ?? -1,
        volume: rows[index].volume ?? -1,
      }))
      .sort(
        (x, y) =>
          x.rankSum - y.rankSum ||
          y.openInterest - x.openInterest ||
          y.volume - x.volume ||
          x.seat - y.seat,
      )
      .slice(0, ACTIVITY_TOP_RANK_COUNT)
      .filter(
        ({ index }) =>
          activityVolume(rows[index].openInterest, rows[index].volume) >= ACTIVITY_ABSOLUTE_FLOOR,
      )
      .forEach(({ index }) => topIndexes.add(index));
  }

  return rows.map((row, index) => {
    const isRoundStrike = D(row.strike).isInteger();
    const isTopRanked = topIndexes.has(index);
    let label: ActivityLabel | null = null;
    if (isRoundStrike) label = 'round_strike';
    else if (isTopRanked) label = 'top_ranked';
    return { isRoundStrike, isTopRanked, label };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 成交额
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 成交额 = `Vol × 权利金 × 合约乘数` (plan D-SOT-5)。`O(1)`。
 *
 * 📌 口径注常驻: **成交额高 ≠ 真流动** (可能是一两笔大单), 与 `OI` (会 stale) / `Vol` (反映当下)
 * 三者互补看。缺 `Vol` 或缺权利金 → `null`, MUST NOT 当 0 —— 0 成交与「不知道成交多少」是两件事。
 */
export function computeTurnover(
  volume: number | null,
  premium: Decimalish | null,
): Prisma.Decimal | null {
  if (volume === null || !Number.isFinite(volume) || premium === null) return null;
  return D(premium).times(volume).times(US_OPTION_CONTRACT_MULTIPLIER);
}
