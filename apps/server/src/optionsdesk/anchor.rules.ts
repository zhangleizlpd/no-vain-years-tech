import { Prisma } from '../generated/prisma/client';

/**
 * 045 optionsdesk 锚派生纯函数 (ADR-0043 §4: rules 文件持无副作用业务规则)。无 I/O、无 DI —
 * 输入决定输出, 全套 vitest 无 DB 可测。
 *
 * 🚨 **本文件是全部档位数值的唯一落点** (FR-030 配置化 / SC-005「代码内零自造参数」): W 系数、
 * 四区间上下界系数、L 层映射档、单票上限档、愿卖锚两系数 —— 其余文件 MUST import 本文件常量,
 * MUST NOT 复写字面量 (机械断言见 `anchor.rules.spec.ts` 末条 grep)。不建配置表: 建表要配
 * CRUD 面, 而单点可改的具名常量已满足 FR-030 (plan D2)。
 *
 * 金融数值一律 `Prisma.Decimal` (Decimal.js, 零新 dep) 精确计算, 与 schema 的 `Decimal(18,4)`
 * (价格) / `Decimal(6,4)` (仓位比例) / `Decimal(4,2)` (confidence) 同量纲; **不返回 number**
 * (二进制浮点在派生链上累积误差)。跨边界的 string 序列化与呈现精度归 DTO 层, 本文件不决定。
 *
 * 生效 V = `COALESCE(v_manual, v)` 由调用方 (写侧 / 读侧 usecase) 解算后传入; 本文件只认一个 V。
 */

/** Decimal 可接受形态: string (DTO / 常量) 或 Prisma.Decimal (PG row)。 */
type Decimalish = string | Prisma.Decimal;

const D = (v: Decimalish): Prisma.Decimal => new Prisma.Decimal(v);

// ─────────────────────────────────────────────────────────────────────────────
// 档位常量 (策略 SoT 口径, FR-030 单点可改)
// ─────────────────────────────────────────────────────────────────────────────

/** W = 0.8V —— 愿买价锚, 四区间的红色加粗界线。 */
export const W_COEFFICIENT = new Prisma.Decimal('0.8');

/** 四区间内段下界 0.6V (买区/深买区分界)。 */
export const ZONE_FLOOR_COEFFICIENT = new Prisma.Decimal('0.6');

/** 四区间内段上界 1.2V (偏贵/高估分界)。 */
export const ZONE_CEILING_COEFFICIENT = new Prisma.Decimal('1.2');

/**
 * 愿卖锚两系数 (FR-003): 长持 1.2V / 收租 1.0V。
 *
 * 🚨 两者 **MUST 独立可配**: `rent` 当前等于 1 倍 V 是**取值巧合而非定义**, MUST NOT 把收租愿卖
 * 写死成「等于 V」 —— 写死即把可调参数烧进代码。同理 `longHold` 与 {@link ZONE_CEILING_COEFFICIENT}
 * 现在同为 1.2 也是巧合, 两者语义无关 (一个是愿卖价, 一个是区间上界), 改一个不得牵动另一个。
 */
export const WILLING_SELL_COEFFICIENTS: WillingSellCoefficients = {
  longHold: new Prisma.Decimal('1.2'),
  rent: new Prisma.Decimal('1.0'),
};

/** 资本身份四层 (策略 SoT 第一章)。雷达筛选主维度 (FR-034 L1–L4 多选)。 */
export const L_LEVELS = ['L1', 'L2', 'L3', 'L4'] as const;

export type LLevel = (typeof L_LEVELS)[number];

/**
 * confidence (10 分制) → L 层映射档: ≥9 → L1 / 7–9 → L2 / 3–7 → L3 / <3 → L4。
 *
 * 🚨 **EC-4 档位边界归属**: 统一「**下界闭、上界开**」—— 恰好 9 → L1, 恰好 7 → L2, 恰好 3 → L3。
 * 全表按 floor 降序声明, 首个命中即归属 ⇒ 边界值有且只有一个档 (不会两档都亮 / 都不亮)。
 * confidence 是 `Decimal(4,2)` 不是 Int (模型可出 8.5), 故档界用 Decimal 比较而非整数区间。
 */
export const L_LEVEL_CONFIDENCE_FLOORS: readonly {
  readonly lLevel: LLevel;
  readonly floor: Prisma.Decimal;
}[] = [
  { lLevel: 'L1', floor: new Prisma.Decimal('9') },
  { lLevel: 'L2', floor: new Prisma.Decimal('7') },
  { lLevel: 'L3', floor: new Prisma.Decimal('3') },
];

/** 低于最低档界 (<3) 的兜底档 —— 与上表合起来覆盖整个实数轴, 无空洞。 */
export const L_LEVEL_BELOW_LOWEST_FLOOR: LLevel = 'L4';

/**
 * 单票上限档 (L 层派生): L1 ≤25% / L2 ~5% / L3 ~2%。
 *
 * 量纲 = **小数比例** (0.25 = 25%), 与 `anchor.position_cap_manual` (`Decimal(6,4)`) 同量纲。
 * `L4 = null`: 策略 SoT 只定义了 L1–L3 三档, L4 档没有上限口径 —— 按 FR-030「MUST NOT 自造参数」
 * 留空 (呈现侧显示「—」), **不得**擅自填 0 或任何数值。
 */
export const POSITION_CAP_BY_L_LEVEL: Readonly<Record<LLevel, Prisma.Decimal | null>> = {
  L1: new Prisma.Decimal('0.25'),
  L2: new Prisma.Decimal('0.05'),
  L3: new Prisma.Decimal('0.02'),
  L4: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export interface WillingSellCoefficients {
  /** 长持愿卖系数 (× V)。 */
  longHold: Prisma.Decimal;
  /** 收租愿卖系数 (× V)。 */
  rent: Prisma.Decimal;
}

export interface WillingSellAnchors {
  longHold: Prisma.Decimal;
  rent: Prisma.Decimal;
}

/** 四区间边界值 (五段的四道界)。请求时算, MUST NOT 落库 (FR-003a ①)。 */
export interface AnchorZoneBoundaries {
  /** 内段下界 (深买区 / 买区 分界)。 */
  floor: Prisma.Decimal;
  /** W (买区 / 薄带 分界, 界线标值且红色加粗)。 */
  w: Prisma.Decimal;
  /** V 本身 (薄带 / 偏贵 分界), 标在值轴真实位置。 */
  fairValue: Prisma.Decimal;
  /** 内段上界 (偏贵 / 高估 分界)。 */
  ceiling: Prisma.Decimal;
}

/** 四区间色带的五段 (两端为开区间截断段, 呈现为示意端帽)。 */
export const ANCHOR_ZONES = ['deep_buy', 'buy', 'thin', 'expensive', 'overvalued'] as const;

export type AnchorZone = (typeof ANCHOR_ZONES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// 派生
// ─────────────────────────────────────────────────────────────────────────────

/**
 * V ≤ 0 拒绝 (EC-3): W 与四区间在非正 V 下无意义 (界线全部塌到 0 或翻转), 距 W% 还会除零。
 * 错误 message 前缀 `INVALID_ANCHOR_V` 供写侧 catch → 映射 400。
 */
function requirePositiveV(v: Decimalish): Prisma.Decimal {
  const value = D(v);
  if (value.lessThanOrEqualTo(0)) {
    throw new Error('INVALID_ANCHOR_V: must be greater than 0 (W and zone boundaries undefined)');
  }
  return value;
}

/** W = 0.8V (FR-003)。 */
export function computeW(v: Decimalish): Prisma.Decimal {
  return requirePositiveV(v).times(W_COEFFICIENT);
}

/** 四区间四道界 (0.6V / W / V / 1.2V) → 五段 (FR-003)。 */
export function computeZoneBoundaries(v: Decimalish): AnchorZoneBoundaries {
  const value = requirePositiveV(v);
  return {
    floor: value.times(ZONE_FLOOR_COEFFICIENT),
    w: value.times(W_COEFFICIENT),
    fairValue: value,
    ceiling: value.times(ZONE_CEILING_COEFFICIENT),
  };
}

/**
 * spot 落在四区间的哪一段。
 *
 * 🚨 **EC-11 边界纪律**: 五段统一「**下界闭、上界开**」⇒ spot 恰好 = W 归**上侧**段 (`thin`),
 * 与 {@link isBelowW} (`spot < W` ⇒ 恰好等于时 false) 判在同一侧。两处共用这一条规则,
 * 不各写各的, 故「区间归属」与「复核锚触发」在 W 上永不打架。
 */
export function classifyZone(v: Decimalish, spot: Decimalish): AnchorZone {
  const b = computeZoneBoundaries(v);
  const s = D(spot);
  if (s.lessThan(b.floor)) return 'deep_buy';
  if (s.lessThan(b.w)) return 'buy';
  if (s.lessThan(b.fairValue)) return 'thin';
  if (s.lessThan(b.ceiling)) return 'expensive';
  return 'overvalued';
}

/**
 * 复核锚红标的价格侧判据 (FR-013 左半): spot < W。
 * 完整红标还要叠「最近复审日 < 本轮跌破首次观测日」的状态机 (归雷达读端), 本函数只管价格比较。
 */
export function isBelowW(v: Decimalish, spot: Decimalish): boolean {
  return D(spot).lessThan(computeW(v));
}

/**
 * confidence → L 层 (两级链第一级)。O(档数) = O(1), 档表仅 3 行。
 * 边界归属见 {@link L_LEVEL_CONFIDENCE_FLOORS} (EC-4)。
 */
export function mapConfidenceToLLevel(confidence: Decimalish): LLevel {
  const c = D(confidence);
  for (const { lLevel, floor } of L_LEVEL_CONFIDENCE_FLOORS) {
    if (c.greaterThanOrEqualTo(floor)) return lLevel;
  }
  return L_LEVEL_BELOW_LOWEST_FLOOR;
}

/**
 * L 层 → 单票上限 (两级链第二级)。返回小数比例; L4 无 SoT 口径 ⇒ `null` (见
 * {@link POSITION_CAP_BY_L_LEVEL})。
 */
export function derivePositionCap(lLevel: LLevel): Prisma.Decimal | null {
  return POSITION_CAP_BY_L_LEVEL[lLevel];
}

/**
 * 愿卖锚两档 (FR-003)。`coefficients` 默认取 {@link WILLING_SELL_COEFFICIENTS} —— 该入参是
 * **两系数独立性的验证缝**: 改其一 MUST NOT 牵动其二 (禁「收租 = V」写死)。
 */
export function computeWillingSellAnchors(
  v: Decimalish,
  coefficients: WillingSellCoefficients = WILLING_SELL_COEFFICIENTS,
): WillingSellAnchors {
  const value = requirePositiveV(v);
  return {
    longHold: value.times(coefficients.longHold),
    rent: value.times(coefficients.rent),
  };
}

/**
 * 距 W 百分比 (雷达主指标, FR-010 默认升序排序键): `(lastClose − W) / W × 100`。
 * 正 = spot 在 W 上方还有多少空间; 负 = 已跌破 W。`lastClose` 缺失 (行情未覆盖该锚, FR-017
 * 降级态) → `null`, **不伪造 0**。
 */
export function computeDistanceToWPct(
  v: Decimalish,
  lastClose: Decimalish | null,
): Prisma.Decimal | null {
  if (lastClose === null) return null;
  const w = computeW(v);
  return D(lastClose).minus(w).div(w).times(100);
}

/**
 * 按 L 层计数 (雷达 / 锚列表的档位筛选项)。O(n)。
 *
 * 🚨 **FR-008**: 恒返回全部四档的 key, 空档位计 0 —— 某档 (一期是 L1) 无任何锚落入是估值管道
 * 现状, **MUST NOT** 当作校验错误, 也不得因此隐藏该筛选项。此处不特判、不抛。
 */
export function countByLLevel(lLevels: readonly LLevel[]): Record<LLevel, number> {
  const counts = Object.fromEntries(L_LEVELS.map((l) => [l, 0])) as Record<LLevel, number>;
  for (const lLevel of lLevels) counts[lLevel] += 1;
  return counts;
}

/**
 * canonical `market:code` 拆解。
 *
 * ⚠️ 与 `marketdata.rules.ts` 的 `parseCanonicalSymbol` 同形但**本 ctx 自持**: import 他 ctx 的
 * `*.rules.ts` 正是 ADR-0053 的 sunset_trigger #2 (ADR-0062 已判「未命中」), 为三行字符串切分
 * 去踩它不划算。ticker 形态本身是**跨 ctx 共享的标识约定**, 不是 marketdata 的业务规则。
 *
 * 📌 原住 `sync-anchor-quote.ts`, 2026-08-04 迁到本文件 —— 那边 import 了
 * `create-anchor.usecase.ts`, 而写侧 usecase 现在也要解析 ticker 求新鲜度基准, 留在原处会成环。
 * 纯字符串函数本就该落在本 ctx 的纯函数文件。
 */
export function parseAnchorTicker(ticker: string): { market: string; code: string } | null {
  const idx = ticker.indexOf(':');
  if (idx <= 0 || idx === ticker.length - 1) return null;
  return { market: ticker.slice(0, idx), code: ticker.slice(idx + 1) };
}
