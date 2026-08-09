import { type AnchorZone, type LLevel } from './anchor.rules';

/**
 * 047 optionsdesk 意图判定矩阵纯函数 (ADR-0043 §4)。无 I/O、无 DI。
 *
 * 🚨 **落的是生成公式, 不是九宫格查表** —— 策略 SoT 第四章明写「本表由公式渲染; 改规则先改公式
 * 再重渲染, **禁逐格手改**」(plan D-SOT-3)。3×3×3 = 27 格全部由 {@link classifyIntent} 三行算式
 * 生成; `intent-matrix.rules.spec.ts` 把 SoT 那张表逐格作为期望值断言 —— 公式对不上表即红。
 *
 * ```text
 * 折扣档数 d：卖put区 = 0 · 买区 = 1 · 深买区 = 2
 * 层级序号 l：L1 = 1 · L2 = 2 · L3 = 3
 * 折扣富余  m = d − (l − 1)
 *
 * m ≥ 1  → 前 m 个水位档 = 建仓腿；其后收租，起步深度 = 贴ATM侧
 * m ≤ 0  → 无建仓授权；收租起步深度 = |m| 档
 * 收租段内每跨一个水位档，Δ 深度加一档（贴ATM侧 → 中度 → 深度，深度为地板）
 * ```
 *
 * 🚨 **区间与 L 层一律复用 `anchor.rules.ts`, 不重写** (plan D-API-2 / Guardrail 13): 本文件只
 * 消费 {@link AnchorZone} / {@link LLevel} 两个已判好的档, **不碰任何区间系数**, 故 045 调参时
 * 本文件零改动。区间的价格界怎么切归 `anchor.rules.ts` 的 `classifyZone`。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 值域常量
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 仓位水位档 (FR-017), **顺序 = 由低到高, 下标即水位档序号** —— 公式里的「跨一个水位档」就是
 * 下标 +1。值域与锚表 `position_bucket_manual` 列逐字一致 (贫血字符串, 无枚举表);
 * schema 注释明写「判定归 optionsdesk 的 rules 单点」⇒ **本文件即那个单点**, 写端点 / DTO 一律
 * 用 {@link isPositionBucket} 校验, MUST NOT 各自抄一份字面量。
 *
 * `null` (未选) **是常驻分支不是过渡态** —— 见 {@link classifyIntent} 的「待定」。
 */
export const POSITION_BUCKETS = ['lt_one_third', 'one_to_two_thirds', 'gte_two_thirds'] as const;

export type PositionBucket = (typeof POSITION_BUCKETS)[number];

/**
 * 水位档的**数据来源**值域 (FR-017 / plan D-UI-5)。
 *
 * 🚨 **单成员枚举是蓄意的, 不是「以后补」的占位**: 本片水位档没有数据面, 唯一来源就是人手选 ——
 * 但「这是人填的」MUST 在**契约层**说出来, 不是靠前端记得。FR-017 原文: 手选值 MUST 标注为人工
 * 输入, 且 MUST 在本片就把数据来源表达出来, 以免 M3 持仓数据到位、同一字段开始混进真实水位时
 * 分不清历史值里哪些是人填的。M3 只需往本数组加一个来源, 消费方的穷尽分支立刻编译期报错。
 */
export const POSITION_BUCKET_SOURCES = ['manual'] as const;

export type PositionBucketSource = (typeof POSITION_BUCKET_SOURCES)[number];

/** 收租腿 Δ 深度三档 (SoT 第四章), **顺序 = 由浅到深, 末档为地板**。具体 Δ 带宽归呈现侧筛选。 */
export const RENT_DEPTHS = ['near_atm', 'moderate', 'deep'] as const;

export type RentDepth = (typeof RENT_DEPTHS)[number];

/** 意图四态: 建仓 / 收租 / 不开新仓 (不动区 或 L4) / 待定 (水位未选)。 */
export const LEG_INTENTS = ['build_position', 'rent', 'no_new_position', 'pending'] as const;

export type LegIntent = (typeof LEG_INTENTS)[number];

/**
 * 045 五段 → SoT 四区间的折扣档数 `d` (plan D-SOT-3 映射表)。
 * `null` = 不动区, 不进公式 (见 {@link classifyIntent} 的短路)。
 *
 * 📌 **薄带与偏贵同属卖put区 ⇒ 两者 `d` 相同、输出必然相同**。⚠️ mockup 帧 ⑦ 写的
 * 「偏贵区 + 水位 ≥2/3 → 不开新仓」与本表冲突, **以本表 (= SoT) 为准**, 那一帧记为 drift 不回改。
 */
export const DISCOUNT_STEPS_BY_ZONE: Readonly<Record<AnchorZone, number | null>> = {
  deep_buy: 2,
  buy: 1,
  thin: 0,
  expensive: 0,
  overvalued: null,
};

/**
 * L 层序号 `l`。`null` = 不进公式 —— L4 按 SoT「只观察、零动作」恒判不开新仓。
 */
export const L_LEVEL_ORDINALS: Readonly<Record<LLevel, number | null>> = {
  L1: 1,
  L2: 2,
  L3: 3,
  L4: null,
};

/**
 * 走建仓网格的 L 层。
 *
 * 🚨 **L3 蓄意不在内**: SoT 的 L3 建仓仅由腰斩触发, 而腰斩本片不实现 ⇒ L3 的建仓格恒判收租
 * (plan D-SOT-3 / M3 兑现清单第 3 条)。当前系数下 L3 的 `m ≤ 0` 本就取不到建仓, 这条是**调参
 * 护栏**: 将来把某区间的 `d` 调大, L3 也不会悄悄长出建仓授权。
 */
export const BUILD_GRID_L_LEVELS: readonly LLevel[] = ['L1', 'L2'];

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 水位档 + 来源标 + 设置时刻。
 *
 * `bucket` 与 `source` **严格成对** —— 不存在「有档无来源」的中间态 (来源标是这个值的身份, 缺了它
 * M3 就分不清人填与真实水位)。`setAt` 由写端与档位一并落列, 但**不参与该不变量**: T002 建列时
 * 未回填, 故理论上的历史行可以有档而无时刻, 那时它照实回 `null` 而非编一个时刻。
 */
export interface PositionBucketProvenance {
  bucket: PositionBucket | null;
  source: PositionBucketSource | null;
  setAt: Date | null;
}

export interface IntentVerdict {
  intent: LegIntent;
  /** 收租意图的 Δ 深度档; 其余三态恒 `null` (建仓腿的带由 `|Δ| ∈ [0.40, 0.55]` 定义, 不分深度)。 */
  rentDepth: RentDepth | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 派生
// ─────────────────────────────────────────────────────────────────────────────

/** 锚表列 (贫血 `String?`) → 值域收窄。非三个字面量之一 (含 `null` / 空串) 一律 false。 */
export function isPositionBucket(raw: string | null | undefined): raw is PositionBucket {
  return typeof raw === 'string' && (POSITION_BUCKETS as readonly string[]).includes(raw);
}

/**
 * 锚表两列 (贫血 `String?` + `DateTime?`) → 带来源标的水位档。读端与写端**共用本函数**, 免得
 * 「档位怎么收窄 / 来源标怎么配」在两处各写一份而悄悄漂移。`O(1)`。
 *
 * 未选 (`null` / 脏值) 一律折成三项全 `null` —— 🚫 MUST NOT 给默认档 (FR-017 明禁替人做方向性
 * 假设), 也 MUST NOT 只回档位不回来源。
 */
export function resolvePositionBucket(
  positionBucketManual: string | null | undefined,
  positionBucketSetAt: Date | null | undefined,
): PositionBucketProvenance {
  if (!isPositionBucket(positionBucketManual)) {
    return { bucket: null, source: null, setAt: null };
  }
  return { bucket: positionBucketManual, source: 'manual', setAt: positionBucketSetAt ?? null };
}

/**
 * 意图判定矩阵 (FR-016 / FR-021, plan D-SOT-3)。`O(1)`。
 *
 * 判定序 (三条短路的先后是**语义决定的**, 不可换):
 * 1. **不开新仓 ⟺ 不动区 或 L4** —— plan D-SOT-3 写的是「⟺」, 即它**不以水位为条件**;
 *    水位未选也照样不开新仓 (否则「⟺」不成立)。此时 FR-021 的警示注置顶生效, 腿数据照常全量展示。
 * 2. **水位未选 → 「待定」** —— MUST NOT 落任何档位。FR-017 明禁「按最保守档静默假设」,
 *    那是替人做方向性假设。
 * 3. 其余走公式。
 *
 * @param zone 045 `classifyZone` 的输出 (spot 落在四区间的哪一段)。
 * @param lLevel 045 `mapConfidenceToLLevel` 的输出。
 * @param positionBucket 手选水位档; `null` = 未选。
 */
export function classifyIntent(
  zone: AnchorZone,
  lLevel: LLevel,
  positionBucket: PositionBucket | null,
): IntentVerdict {
  const d = DISCOUNT_STEPS_BY_ZONE[zone];
  const l = L_LEVEL_ORDINALS[lLevel];
  if (d === null || l === null) return { intent: 'no_new_position', rentDepth: null };
  if (positionBucket === null) return { intent: 'pending', rentDepth: null };

  const surplus = d - (l - 1);
  const bucketIndex = POSITION_BUCKETS.indexOf(positionBucket);
  if (surplus >= 1 && bucketIndex < surplus && BUILD_GRID_L_LEVELS.includes(lLevel)) {
    return { intent: 'build_position', rentDepth: null };
  }

  // 一条式子覆盖公式两个分支: m ≤ 0 时 = |m| + 下标 (起步已带深度); m ≥ 1 时 = 下标 − m
  // (建仓段之后从贴ATM侧起步), 下溢夹到贴ATM侧 —— 该下溢只在 L3 的建仓格转收租时出现。
  const depthIndex = Math.min(Math.max(bucketIndex - surplus, 0), RENT_DEPTHS.length - 1);
  return { intent: 'rent', rentDepth: RENT_DEPTHS[depthIndex] };
}
