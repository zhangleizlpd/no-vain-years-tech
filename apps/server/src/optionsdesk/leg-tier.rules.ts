import { Prisma } from '../generated/prisma/client';

/**
 * 047 optionsdesk 档位判定纯函数 (ADR-0043 §4: rules 文件持无副作用业务规则)。无 I/O、无 DI —
 * 输入决定输出, 全套 vitest 无 DB 可测。
 *
 * 🚨 **本文件是六个档位边界的唯一落点** (FR-022「MUST NOT 在代码中自造参数, 参数 MUST 可配置」
 * / plan D-SOT-1): 年化 15 / 10 / 5%, 周化 2 / 1 / 0.6% —— 判定函数内 MUST NOT 散落任何边界
 * 数值, 呈现侧图例文案亦从 {@link tierBands} 派生, 不手抄。策略 SoT 演进 → 改本文件常量 → 全链生效。
 *
 * **量纲 = 小数比例** (`0.15` = 15%), 与 `anchor.rules.ts` 的 `POSITION_CAP_BY_L_LEVEL`
 * (0.25 = 25%) 同口径; 百分号是呈现层的事, 本文件不决定。金融数值一律 `Prisma.Decimal`
 * (Decimal.js, 零新 dep), 不返回 number。
 *
 * 三条口径纪律 (plan D-SOT-1, 均来自策略 SoT 而非本片自造):
 * 1. **分档口径恒为 `bid`** ——「流动性 = bid 年化一根轴」。🚫 `ask` MUST NOT 参与判档,
 *    它只在薄档 (SoT「尴尬区」) 作为**带出值**供人自行套用 SoT 的二分 (D-SOT-2)。
 * 2. **分母恒为准备金 `K − P`** —— 费率怎么算归 `leg-derive.rules.ts`, 本文件只认一个已算好的费率。
 * 3. **死线 5% (年化) / 0.6% (周化) 是操作门槛, 与利率环境无关** —— 不随 T-bill 收益率浮动,
 *    故本文件**没有任何利率入参** (机械判据: {@link classifyLegTier} 的 arity, 见 spec 末段)。
 */

/** Decimal 可接受形态: string (DTO / 常量) 或 Prisma.Decimal (PG row)。 */
type Decimalish = string | Prisma.Decimal;

const D = (v: Decimalish): Prisma.Decimal => new Prisma.Decimal(v);

// ─────────────────────────────────────────────────────────────────────────────
// 档位常量 (策略 SoT 口径, FR-022 单点可改)
// ─────────────────────────────────────────────────────────────────────────────

/** 腿族费率口径 (FR-018): 建仓腿按周化判档, 收租腿按年化判档。两族 MUST NOT 拿折年数互比。 */
export const LEG_BASES = ['weekly', 'annualized'] as const;

export type LegBasis = (typeof LEG_BASES)[number];

/** 四档 (FR-010 四态动作标签的判定来源): 好 / 可接受 / 薄 (SoT 称「尴尬区」) / 死档。 */
export const LEG_TIERS = ['good', 'acceptable', 'thin', 'dead'] as const;

export type LegTier = (typeof LEG_TIERS)[number];

/** 有下界的三档 —— `dead` 是兜底档, 无下界。 */
export type LegTierWithFloor = Exclude<LegTier, 'dead'>;

/**
 * 两个口径各三道界, **按 floor 降序声明, 首个命中即归属** (与 `anchor.rules.ts` 的
 * `L_LEVEL_CONFIDENCE_FLOORS` 同体例)。
 *
 * 🚨 **边界归属统一「下界闭、上界开」**: 恰好 15% → `good`, 恰好 10% → `acceptable`,
 * 恰好 5% → `thin`; 周化同理 (2 / 1 / 0.6%)。⇒ 六个边界值有且只有一档 (不会两档都亮 / 都不亮)。
 */
export const TIER_FLOORS_BY_BASIS: Readonly<
  Record<LegBasis, readonly { readonly tier: LegTierWithFloor; readonly floor: Prisma.Decimal }[]>
> = {
  /** 年化 (收租腿 / 锚轴腿): 好 ≥15% / 可接受 10–15% / 薄 5–10% / 死档 <5%。 */
  annualized: [
    { tier: 'good', floor: new Prisma.Decimal('0.15') },
    { tier: 'acceptable', floor: new Prisma.Decimal('0.10') },
    { tier: 'thin', floor: new Prisma.Decimal('0.05') },
  ],
  /** 周化 (建仓短腿): 好 ≥2% / 可接受 1–2% / 薄 0.6–1% / 死档 <0.6%。 */
  weekly: [
    { tier: 'good', floor: new Prisma.Decimal('0.02') },
    { tier: 'acceptable', floor: new Prisma.Decimal('0.01') },
    { tier: 'thin', floor: new Prisma.Decimal('0.006') },
  ],
};

/** 低于最低档界的兜底档 —— 与上表合起来覆盖整个实数轴, 无空洞。 */
export const TIER_BELOW_LOWEST_FLOOR: LegTier = 'dead';

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export interface LegTierVerdict {
  /** 四档之一。判定值恒为 `bid` 口径费率。 */
  tier: LegTier;
  /**
   * 薄档行的 `ask` 口径费率, **仅供呈现** (D-SOT-2: 形如 `7.2% (ask 11.4%)`, 使人能自行套用
   * SoT 的尴尬区二分)。其余三档恒 `null` —— 带出值只服务尴尬区, 不是通用附加列。
   * 🚫 它**不参与**任何判定。
   */
  askRate: Prisma.Decimal | null;
}

/** 图例一段 (呈现侧文案的唯一数值来源)。`floor` / `ceiling` 为 `null` = 该侧无界。 */
export interface LegTierBand {
  tier: LegTier;
  floor: Prisma.Decimal | null;
  ceiling: Prisma.Decimal | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 派生
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 费率 → 四档 (FR-018 / FR-022)。`O(档数)` = `O(1)`, 档表仅 3 行。
 *
 * @param bidRate **bid 口径**费率, 小数比例量纲 (分母 = 准备金 `K − P`, 由调用方算好)。
 * @param basis 腿族口径 —— 无默认值: 同一个数值在两个口径下判出不同档 (3% 周化是「好」、
 *   年化是「死档」), 默认任何一侧都会静默判错。
 * @param askRate 该行 `ask` 口径费率 (无报价 → `null`)。**只被带出、不被判定**, 见
 *   {@link LegTierVerdict.askRate}。
 *
 * 🚫 greeks 缺失的腿 **MUST NOT 走到这里** (FR-007: 不判档不着色) —— 它们的费率算得出来但会骗人
 * (99.5% 是深实值腿, 折年可达 307%)。筛除归调用方, 本文件不特判: 判定函数认一个数就该给一个档。
 */
export function classifyLegTier(
  bidRate: Decimalish,
  basis: LegBasis,
  askRate: Decimalish | null,
): LegTierVerdict {
  const rate = D(bidRate);
  let tier: LegTier = TIER_BELOW_LOWEST_FLOOR;
  for (const band of TIER_FLOORS_BY_BASIS[basis]) {
    if (rate.greaterThanOrEqualTo(band.floor)) {
      tier = band.tier;
      break;
    }
  }
  return {
    tier,
    askRate: tier === 'thin' && askRate !== null ? D(askRate) : null,
  };
}

/**
 * 四档的完整区间 (呈现侧图例文案的唯一数值来源, D-SOT-1「图例从同一常量派生, 不手抄」)。
 * 相邻两段首尾相接 ⇒ 图例与 {@link classifyLegTier} 永不打架。`O(1)`。
 */
export function tierBands(basis: LegBasis): readonly LegTierBand[] {
  const floors = TIER_FLOORS_BY_BASIS[basis];
  return [
    ...floors.map((band, i) => ({
      tier: band.tier,
      floor: band.floor,
      ceiling: i === 0 ? null : floors[i - 1].floor,
    })),
    { tier: TIER_BELOW_LOWEST_FLOOR, floor: null, ceiling: floors[floors.length - 1].floor },
  ];
}
