import { Prisma } from '../generated/prisma/client';
import { derivePositionCap, mapConfidenceToLLevel, type LLevel } from './anchor.rules';

/**
 * 045 两级链 `confidence → L 层 → 单票上限` 的**回落语义**纯函数 (FR-006 / FR-032 / FR-035,
 * plan D9)。无 I/O、无 DI —— 写侧 (`update-anchor.usecase.ts` / 将来的 import 脚本) 调用后
 * 把返回的人工位状态原样写库。
 *
 * 人工值一律**临时**语义: 上游一变即回落, **不存在「锁定」**。回落触发路径恰好三条,
 * 可观测性各不同:
 *
 * | 路径 | 冲掉什么 | 可观测性 |
 * | --- | --- | --- |
 * | ① 模型批量 import 刷 V/confidence | 三处人工值 | 产出**差异报告数据**逐条列出 (禁静默回落);
 *   M1 的报告是 import 脚本产出的文件, App 内不做页面 |
 * | ② 人工改 L 层 | 单票上限人工值 | 同屏立即可见 (用户就在该表单内) |
 * | ③ 手工锚改 confidence (**仅 `confidence_source = manual`**) | L 层与单票上限人工值 | 同屏立即可见 |
 *
 * 🚨 两条盲写必踩的纪律:
 * - **人工值恰好等于派生值时仍是人工态** ({@link resolveEffectiveAnchorValues} 只看列是否为
 *   null, 不比值) —— 否则痕迹里丢失「这个值是谁设的」, PIT 还原分不清 `source`。
 * - **模型 import MUST NOT 重置 `next_review` / 解除逾期红标** ({@link buildModelImportPatch}
 *   的返回键集里根本没有这两列) —— 复审是人的确认, 模型出新值不构成确认。
 *
 * 两处同时人工态时**一并回落**, 无「只回落其中一处」的中间态: 一次调用返回一个
 * {@link AnchorCascadeOutcome}, 写侧一条 UPDATE 落全部被清列。
 */

/** 三处人工位 (FR-035): V / L 层 / 单票上限。链序 = confidence → lLevel → positionCap。 */
export const ANCHOR_MANUAL_SLOTS = ['v', 'lLevel', 'positionCap'] as const;

export type AnchorManualSlot = (typeof ANCHOR_MANUAL_SLOTS)[number];

/** 人工位 → schema 列名 (痕迹 `changed_fields` 与写侧 patch 共用)。 */
export const ANCHOR_MANUAL_COLUMN_BY_SLOT = {
  v: 'vManual',
  lLevel: 'lLevelManual',
  positionCap: 'positionCapManual',
} as const satisfies Record<AnchorManualSlot, string>;

/**
 * 两级链的下游关系。`v` 不在 confidence 链上 (它喂 W / 四区间, 不喂 L 层) ⇒ 无下游;
 * `positionCap` 是链尾。撤销任一层时下游随之回落。
 */
const DOWNSTREAM_SLOTS = {
  v: [],
  lLevel: ['positionCap'],
  positionCap: [],
} as const satisfies Record<AnchorManualSlot, readonly AnchorManualSlot[]>;

/** 人工位列快照 (贫血, 与锚表三列 1:1)。`null` = 未处于人工态。 */
export interface AnchorManualState {
  vManual: Prisma.Decimal | null;
  lLevelManual: LLevel | null;
  positionCapManual: Prisma.Decimal | null;
}

export interface AnchorCascadeOutcome {
  /** 本次真正被回落的人工位 (本就为空的位不计入 ⇒ 报告无噪声条目)。 */
  clearedSlots: readonly AnchorManualSlot[];
  /** 回落后的人工位状态 —— 写侧直接作为 patch 落库。 */
  manualStateAfter: AnchorManualState;
  /** 被回落列的 schema 列名 (供 FR-031 痕迹的 `changed_fields`)。 */
  changedFields: readonly string[];
}

/** {@link resolveEffectiveAnchorValues} 的输入: 锚行上的模型侧事实。 */
export interface AnchorBaseValues {
  v: Prisma.Decimal | string;
  confidence: Prisma.Decimal | string;
}

export interface AnchorEffectiveValues {
  /** 生效 V = COALESCE(v_manual, v)。 */
  v: Prisma.Decimal;
  /** 生效 L 层 = COALESCE(l_level_manual, 映射档) —— 落库列的求值口径 (plan D3)。 */
  lLevel: LLevel;
  /** 生效单票上限 = COALESCE(position_cap_manual, 按**生效** L 层派生); L4 无口径 ⇒ null。 */
  positionCap: Prisma.Decimal | null;
  vIsManual: boolean;
  lLevelIsManual: boolean;
  positionCapIsManual: boolean;
  /** FR-032 ②: 处于人工态时同屏须展示的派生值 (「L1 · 人工调整（映射档 L2）」)。 */
  derived: {
    lLevel: LLevel;
    positionCap: Prisma.Decimal | null;
  };
}

/**
 * 模型 import 的单条输入 = import 写的四个模型事实: V / confidence 与其口径 (估值 as-of 日 +
 * 估值方法名)。后两者 059 补入 —— 估值换了口径日或换了方法而 `asof` / `method` 停在旧值,
 * 库里的锚就成了「说不清是哪一版估值」的行。
 */
export interface AnchorModelImportInput {
  v: Prisma.Decimal | string;
  confidence: Prisma.Decimal | string;
  asof: Date;
  method: string;
}

/**
 * import 写侧 patch。键集**刻意封闭**: 除这 9 列外一律不碰 —— 尤其 `nextReview` /
 * `lastReviewedOn` / `breachStartedOn` (Guardrail 11)。
 *
 * 🚨 要加列**加进本函数**, MUST NOT 在调用侧 `{ ...patch, 新列 }` —— 那把列放到封闭键集
 * **之外**, 下一个人照抄那个位置, 单点就此失效 (059 plan §3)。
 */
export interface AnchorModelImportPatch {
  v: Prisma.Decimal | string;
  confidence: Prisma.Decimal | string;
  asof: Date;
  method: string;
  confidenceSource: 'model';
  vManual: null;
  lLevelManual: null;
  positionCapManual: null;
  lLevelEffective: LLevel;
}

/** 差异报告的一条 = 一个被回落的人工位 (FR-035 ①「逐条列出」)。 */
export interface AnchorFallbackReportEntry {
  ticker: string;
  slot: AnchorManualSlot;
  /** 被冲掉的人工值 (string 呈现形态, 报告端无需依赖 Decimal)。 */
  manualValue: string;
  /** 回落后的模型值 / 派生值; L4 档无上限口径 ⇒ null (禁自造)。 */
  fallbackValue: string | null;
}

function isManual(state: AnchorManualState, slot: AnchorManualSlot): boolean {
  return state[ANCHOR_MANUAL_COLUMN_BY_SLOT[slot]] !== null;
}

/**
 * 清空给定人工位 (幂等)。本就为空的位不计入 `clearedSlots` / `changedFields` ——
 * 差异报告只列真正被冲掉的项。O(|slots|) = O(1)。
 */
function clearSlots(
  state: AnchorManualState,
  slots: readonly AnchorManualSlot[],
): AnchorCascadeOutcome {
  const cleared = slots.filter((slot) => isManual(state, slot));
  const after: AnchorManualState = { ...state };
  for (const slot of cleared) {
    // 三列类型不同 (Decimal / string), 逐列显式置 null 而非按 key 动态赋值。
    if (slot === 'v') after.vManual = null;
    if (slot === 'lLevel') after.lLevelManual = null;
    if (slot === 'positionCap') after.positionCapManual = null;
  }
  return {
    clearedSlots: cleared,
    manualStateAfter: after,
    changedFields: cleared.map((slot) => ANCHOR_MANUAL_COLUMN_BY_SLOT[slot]),
  };
}

/** 路径 ①: 模型批量 import 刷 V/confidence → 三处人工值全部回落。 */
export function cascadeOnModelImport(state: AnchorManualState): AnchorCascadeOutcome {
  return clearSlots(state, ANCHOR_MANUAL_SLOTS);
}

/**
 * 路径 ②: 人工改 L 层 → 冲掉单票上限的人工值 (EC-6 上游赢)。
 * L 层自身的人工态由调用方设置, 本函数不动它。
 */
export function cascadeOnManualLLevelChange(state: AnchorManualState): AnchorCascadeOutcome {
  return clearSlots(state, DOWNSTREAM_SLOTS.lLevel);
}

/**
 * 路径 ③: 手工锚 (`confidence_source = manual`) 改 confidence → 沿两级链冲掉 L 层与单票上限
 * (EC-9)。两处一并给出, 无中间态。model 来源的锚不存在本路径 (其 confidence 只读)。
 */
export function cascadeOnManualConfidenceChange(state: AnchorManualState): AnchorCascadeOutcome {
  return clearSlots(state, ['lLevel', 'positionCap']);
}

/** 撤销某个人工位 (FR-032 ③ 一键撤销) → 自身立即回落 + 下游随之。 */
export function cascadeOnUndoManualSlot(
  state: AnchorManualState,
  slot: AnchorManualSlot,
): AnchorCascadeOutcome {
  return clearSlots(state, [slot, ...DOWNSTREAM_SLOTS[slot]]);
}

/**
 * 生效值解算 —— **一致性铁律的单点实现** (FR-006 末句: 任一时刻每个数只有一个生效值)。
 *
 * 🚨 人工态判定只看列是否为 null, **不比值** ⇒ 人工值恰好等于派生值时仍为人工态 (EC-5)。
 * 单票上限从**生效** L 层派生 (人工 L 层时按人工档派生), `derived` 段另给映射档供同屏对照。
 */
export function resolveEffectiveAnchorValues(
  base: AnchorBaseValues,
  manual: AnchorManualState,
): AnchorEffectiveValues {
  const derivedLLevel = mapConfidenceToLLevel(base.confidence);
  const lLevel = manual.lLevelManual ?? derivedLLevel;
  const derivedPositionCap = derivePositionCap(lLevel);
  return {
    v: manual.vManual ?? new Prisma.Decimal(base.v),
    lLevel,
    positionCap: manual.positionCapManual ?? derivedPositionCap,
    vIsManual: manual.vManual !== null,
    lLevelIsManual: manual.lLevelManual !== null,
    positionCapIsManual: manual.positionCapManual !== null,
    derived: { lLevel: derivedLLevel, positionCap: derivedPositionCap },
  };
}

/**
 * 模型 import 的写侧 patch。`confidence_source` 翻 `model` ⇒ 该锚**自动转只读**, 无需人工干预
 * (FR-001)。生效 L 层随新 confidence 写入时求值 (plan D3)。
 *
 * 🚨 返回键集封闭是本函数的**核心契约**: 不含 `nextReview` / `lastReviewedOn` /
 * `breachStartedOn` ⇒ 模型跑一遍不会把逾期红标全清、不会推进复核锚状态机 (Guardrail 11)。
 */
export function buildModelImportPatch(input: AnchorModelImportInput): AnchorModelImportPatch {
  return {
    v: input.v,
    confidence: input.confidence,
    asof: input.asof,
    method: input.method,
    confidenceSource: 'model',
    vManual: null,
    lLevelManual: null,
    positionCapManual: null,
    lLevelEffective: mapConfidenceToLLevel(input.confidence),
  };
}

/**
 * 批量 import 的差异报告数据 (FR-035 ①「禁静默回落」)。O(n) —— n = 本批锚数, 每锚至多 3 条。
 * 报告文件的排版归 import 脚本, 本函数只产出结构化条目。
 */
export function buildImportFallbackReport(
  anchors: readonly {
    ticker: string;
    manual: AnchorManualState;
    // 回落值只由估值两列派生 ⇒ 只收这两列, 不逼调用方为一份报告编 `asof` / `method`。
    next: Pick<AnchorModelImportInput, 'v' | 'confidence'>;
  }[],
): AnchorFallbackReportEntry[] {
  const entries: AnchorFallbackReportEntry[] = [];
  for (const anchor of anchors) {
    const { clearedSlots } = cascadeOnModelImport(anchor.manual);
    if (clearedSlots.length === 0) continue;
    const fallbackLLevel = mapConfidenceToLLevel(anchor.next.confidence);
    const fallbackPositionCap = derivePositionCap(fallbackLLevel);
    for (const slot of clearedSlots) {
      entries.push({
        ticker: anchor.ticker,
        slot,
        manualValue: String(anchor.manual[ANCHOR_MANUAL_COLUMN_BY_SLOT[slot]]),
        fallbackValue: fallbackValueOf(slot, anchor.next.v, fallbackLLevel, fallbackPositionCap),
      });
    }
  }
  return entries;
}

function fallbackValueOf(
  slot: AnchorManualSlot,
  nextV: Prisma.Decimal | string,
  lLevel: LLevel,
  positionCap: Prisma.Decimal | null,
): string | null {
  if (slot === 'v') return String(nextV);
  if (slot === 'lLevel') return lLevel;
  return positionCap === null ? null : positionCap.toString();
}
