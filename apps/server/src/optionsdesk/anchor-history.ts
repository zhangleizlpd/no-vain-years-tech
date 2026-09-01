import { Prisma } from '../generated/prisma/client';
import {
  computeW,
  computeWillingSellAnchors,
  type LLevel,
  type WillingSellAnchors,
} from './anchor.rules';
import { resolveEffectiveAnchorValues, type AnchorManualState } from './anchor-cascade';

/**
 * 045 变更痕迹构造 + PIT (point-in-time) 还原纯函数 (FR-031 / FR-035 / **SC-011**, plan D2/D15)。
 * 无 I/O、无 DI —— 写侧 (create / update / delete usecase) 与读侧 (`get-anchor-at.usecase.ts`)
 * 共用同一套字段口径。
 *
 * **一行痕迹 = 一次变更**, 不是一行一字段 (FR-031 原文是「本次变更的字段集」): 一条含
 * `changed_fields` 字段集 + `before_values` 改前值 + `source`。写入与主行变更**同一个 tx**。
 *
 * 🚨 **`last_close` / `last_close_date` 不进痕迹**: 它们是收盘后从 vendor 抄来的行情事实
 * (FR-036), 不是锚事实 —— 若纳入, 每日行情同步都会刷一行「变更」, 把真正的估值变更淹掉,
 * 且 PIT 还原的语义会从「当时的估值口径」滑成「当时的行情」。
 *
 * **PIT 算法 = 按时点倒放 `before_values`**: 从当前行 (删锚则从删锚痕迹的整行快照) 出发,
 * 把 `changed_at > at` 的痕迹**由新到旧**逐条覆盖回去, 得该时点的行快照; 再走同一套派生
 * (`anchor.rules` + `anchor-cascade`) 算出 V / W / L 层 / 单票上限 / 愿卖锚 —— 与当时显示
 * 逐项一致 (SC-011)。复杂度 O(k)，k = 时点之后的痕迹条数。
 */

/** 痕迹来源 (FR-035): 使任一历史时点可分辨该值来自模型还是人工。 */
export const ANCHOR_CHANGE_SOURCES = ['model', 'manual'] as const;

export type AnchorChangeSource = (typeof ANCHOR_CHANGE_SOURCES)[number];

/** 进痕迹 / 参与 PIT 还原的列及其量纲 (决定 `before_values` 的 JSON 序列化形态)。 */
const ANCHOR_TRACKED_FIELD_KINDS = {
  ticker: 'string',
  v: 'decimal',
  asof: 'date',
  method: 'string',
  confidence: 'decimal',
  confidenceSource: 'string',
  excluded: 'boolean',
  excludeReason: 'string',
  nextReview: 'date',
  lastReviewedOn: 'date',
  vManual: 'decimal',
  lLevelManual: 'string',
  positionCapManual: 'decimal',
  lLevelEffective: 'string',
  breachStartedOn: 'date',
} as const;

export type AnchorTrackedField = keyof typeof ANCHOR_TRACKED_FIELD_KINDS;

export const ANCHOR_TRACKED_FIELDS = Object.keys(
  ANCHOR_TRACKED_FIELD_KINDS,
) as readonly AnchorTrackedField[];

/** 行快照 = 贫血 JSON (字段名 → 标量), 与 `before_values` 的 Json 列同形。 */
export type AnchorSnapshot = Record<string, string | boolean | null>;

export interface AnchorChangeDraft {
  changedFields: readonly string[];
  beforeValues: AnchorSnapshot;
  source: AnchorChangeSource;
}

/** 痕迹行 (读侧回放输入; `anchor_change` 表的贫血投影)。 */
export interface AnchorChangeRecord {
  changedAt: Date;
  changedFields: readonly string[];
  beforeValues: AnchorSnapshot;
  source: string;
}

export interface PointInTimeAnchorValues {
  /** 生效 V = COALESCE(v_manual, v)。 */
  v: Prisma.Decimal;
  w: Prisma.Decimal;
  lLevel: LLevel;
  positionCap: Prisma.Decimal | null;
  willingSell: WillingSellAnchors;
  vIsManual: boolean;
  lLevelIsManual: boolean;
  positionCapIsManual: boolean;
  /** 当时的派生值 (人工态时用于对照, FR-032 ②)。 */
  derived: { lLevel: LLevel; positionCap: Prisma.Decimal | null };
}

/** 按列量纲把任意入参归一成 JSON 标量 —— 归一后才能做「值有没有真变」的比较。 */
function serializeField(field: AnchorTrackedField, value: unknown): string | boolean | null {
  if (value === null || value === undefined) return null;
  const kind = ANCHOR_TRACKED_FIELD_KINDS[field];
  if (kind === 'boolean') return Boolean(value);
  if (kind === 'decimal') {
    return new Prisma.Decimal(value as string | number | Prisma.Decimal).toString();
  }
  if (kind === 'date')
    return (value instanceof Date ? value : new Date(String(value))).toISOString();
  return String(value);
}

/** 锚行 → 快照 (只取受追踪列)。入参用 `object` 以兼容 interface 形态的行类型 (无隐式索引签名)。 */
export function toAnchorSnapshot(row: object): AnchorSnapshot {
  const source = row as Record<string, unknown>;
  const snapshot: AnchorSnapshot = {};
  for (const field of ANCHOR_TRACKED_FIELDS) {
    snapshot[field] = serializeField(field, source[field]);
  }
  return snapshot;
}

/**
 * 一次改动 → 一条痕迹草稿。`patch` 里未受追踪的列 (如行情投影) 与**值没真变**的列都不计入
 * ⇒ 零变更返回 `null` (幂等重写不刷噪声行)。O(|patch|)。
 */
export function buildAnchorChange(
  before: AnchorSnapshot,
  patch: Record<string, unknown>,
  source: AnchorChangeSource,
): AnchorChangeDraft | null {
  const changedFields: string[] = [];
  const beforeValues: AnchorSnapshot = {};
  for (const field of ANCHOR_TRACKED_FIELDS) {
    if (!(field in patch)) continue;
    const next = serializeField(field, patch[field]);
    if (next === (before[field] ?? null)) continue;
    changedFields.push(field);
    beforeValues[field] = before[field] ?? null;
  }
  return changedFields.length === 0 ? null : { changedFields, beforeValues, source };
}

/** 建锚痕迹: 锚此前不存在 ⇒ `before_values` 为空对象 (PIT 回放遇到它即判「当时无锚」)。 */
export function buildCreationChange(row: object, source: AnchorChangeSource): AnchorChangeDraft {
  return { changedFields: Object.keys(toAnchorSnapshot(row)), beforeValues: {}, source };
}

/** 删锚痕迹: `before_values` 存整行快照 —— 删锚本身也是一次变更, 且痕迹不随主行级联清除。 */
export function buildDeletionChange(row: object, source: AnchorChangeSource): AnchorChangeDraft {
  return {
    changedFields: [...ANCHOR_TRACKED_FIELDS],
    beforeValues: toAnchorSnapshot(row),
    source,
  };
}

/**
 * PIT 回放: 倒放 `before_values` 得给定时点的行快照。`current` 为 `null` = 锚已删除, 此时
 * 首条 (最新) 痕迹应是删锚那条, 其整行快照即回放起点。时点早于建锚 → `null`。
 *
 * 调用方不必预排序 (本函数按 `changed_at` 降序自排, 同刻按传入序稳定)。O(k log k)。
 */
export function replayAnchorAt(
  current: AnchorSnapshot | null,
  changes: readonly AnchorChangeRecord[],
  at: Date,
): AnchorSnapshot | null {
  const ordered = [...changes].sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime());
  let working: AnchorSnapshot | null = current;
  for (const change of ordered) {
    if (change.changedAt.getTime() <= at.getTime()) continue;
    // 建锚痕迹 (改前值为空) ⇒ 该时点锚尚不存在, 不返回半截快照。
    if (Object.keys(change.beforeValues).length === 0) return null;
    working = { ...(working ?? {}), ...change.beforeValues };
  }
  return working;
}

/** 快照 → 当时显示的五项 (SC-011): V / W / L 层 / 单票上限 / 愿卖锚 + 三处人工态标记。 */
export function derivePointInTimeValues(snapshot: AnchorSnapshot): PointInTimeAnchorValues {
  const manual: AnchorManualState = {
    vManual: toDecimalOrNull(snapshot.vManual),
    lLevelManual: (snapshot.lLevelManual as LLevel | null) ?? null,
    positionCapManual: toDecimalOrNull(snapshot.positionCapManual),
  };
  const effective = resolveEffectiveAnchorValues(
    { v: String(snapshot.v), confidence: String(snapshot.confidence) },
    manual,
  );
  return {
    v: effective.v,
    w: computeW(effective.v),
    lLevel: effective.lLevel,
    positionCap: effective.positionCap,
    willingSell: computeWillingSellAnchors(effective.v),
    vIsManual: effective.vIsManual,
    lLevelIsManual: effective.lLevelIsManual,
    positionCapIsManual: effective.positionCapIsManual,
    derived: effective.derived,
  };
}

function toDecimalOrNull(value: string | boolean | null | undefined): Prisma.Decimal | null {
  return value === null || value === undefined ? null : new Prisma.Decimal(String(value));
}
