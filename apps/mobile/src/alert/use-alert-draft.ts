import { create } from 'zustand';
import type {
  AlertConditionEntry,
  AlertConditionItemType,
  AlertResponse,
  AlertResponseFrequency,
} from '@nvy/api-client';

import { metaOf, isThresholdInRange, NO_PARAM } from './alert-copy';
import { noteCodePointCount, NOTE_MAX_CODE_POINTS } from './use-alerts';

// 屏 2↔3 跨 route 本地草稿态（021 T018 / FR-M02·M03，plan「完成一次提交」）：
// 编辑页/添加条件页共享一份 in-memory zustand（auth store 同范式、无 persist——
// 草稿离开流程即弃）。条件列表操作/校验为纯函数 vitest；屏编排走 Playwright。
//
// 023 PR-3 T014：条件键 type → (type, param)（同 type 不同 param 共存，FR-S07）；
// threshold 校验按 meta 值域族（无阈值类型不校验）；param 按白名单（无参类型必为 0）。

/**
 * 草稿条件（threshold 持输入原串，提交时转 number；param 整数，0 = 无参 sentinel。
 * 无阈值类型 threshold 恒 ''；无参类型 param 恒 0）。
 */
export interface DraftCondition {
  type: AlertConditionItemType;
  param: number;
  threshold: string;
}

/** 条件上限（server rules 同口径 1..4）。 */
export const MAX_CONDITIONS = 4;

/** 条件键（同 type 不同 param 共存，server 重复键口径同）。 */
export function conditionKey(type: string, param: number): string {
  return `${type}:${param}`;
}

/** 同键（type+param）覆盖 threshold，新键追加（上限把守在 UI canAdd）。 */
export function upsertCondition(
  list: readonly DraftCondition[],
  type: AlertConditionItemType,
  param: number,
  threshold: string,
): DraftCondition[] {
  const key = conditionKey(type, param);
  if (list.some((c) => conditionKey(c.type, c.param) === key)) {
    return list.map((c) => (conditionKey(c.type, c.param) === key ? { ...c, threshold } : c));
  }
  return [...list, { type, param, threshold }];
}

/** 删除条件行（按 type+param 精确剔除）。 */
export function removeCondition(
  list: readonly DraftCondition[],
  type: AlertConditionItemType,
  param: number,
): DraftCondition[] {
  const key = conditionKey(type, param);
  return list.filter((c) => conditionKey(c.type, c.param) !== key);
}

/**
 * 批量对齐某 type 的选中集（026 多选 sheet「选好了」/「确定」一次提交，FR-007/009）：
 * 选中的 param 走 upsert（带阈值类附 threshold、纯周期类传 ''）、未选中的同 type param 删除、
 * 其余 type 条目原样保留。组合既有 upsert/remove 纯函数，保留既有顺序（同 type 原位更新、
 * 新选中追加尾部）。上限把守在 UI（multiSelectQuota），本函数只做集合对齐。
 */
export function reconcileConditions(
  list: readonly DraftCondition[],
  type: AlertConditionItemType,
  selectedParams: readonly number[],
  threshold: string,
): DraftCondition[] {
  let next: DraftCondition[] = [...list];
  // 未选中的同 type 旧 param → 删。
  for (const c of list) {
    if (c.type === type && !selectedParams.includes(c.param)) {
      next = removeCondition(next, type, c.param);
    }
  }
  // 选中 param → upsert（同键覆盖阈值、新键追加）。
  for (const param of selectedParams) {
    next = upsertCondition(next, type, param, threshold);
  }
  return next;
}

/**
 * 多选名额（026 FR-008，plan D4）：max = 上限 − 草稿内**非本 type** 条数（别 type 固定占额）；
 * remaining = max − 本 type 已存条数（= sheet 打开时预勾选数，故等于初始可再选数）。组件实时
 * 名额按 `max − selected.size` 算（selected 含预勾选）；本函数给 max 上界 + 打开时初值。
 */
export function multiSelectQuota(
  conditions: readonly DraftCondition[],
  type: AlertConditionItemType,
): { max: number; remaining: number } {
  const otherCount = conditions.filter((c) => c.type !== type).length;
  const sameCount = conditions.length - otherCount;
  const max = MAX_CONDITIONS - otherCount;
  return { max, remaining: Math.max(0, max - sameCount) };
}

/** 已添加判定（按 type+param，同 type 不同 param 可再加）。 */
export function isAdded(list: readonly DraftCondition[], type: string, param: number): boolean {
  const key = conditionKey(type, param);
  return list.some((c) => conditionKey(c.type, c.param) === key);
}

/** param 合法（server 同口径）：无参类型必为 sentinel 0；带参类型必在白名单。 */
export function paramValid(type: AlertConditionItemType, param: number): boolean {
  const meta = metaOf(type);
  if (meta === undefined) return false;
  if (meta.paramWhitelist.length === 0) return param === NO_PARAM;
  return meta.paramWhitelist.includes(param);
}

/** 阈值合法（server isThresholdInRange 同口径）：无阈值类型恒合法；有阈值类型按族值域。 */
export function thresholdValid(type: AlertConditionItemType, raw: string): boolean {
  const meta = metaOf(type);
  if (meta === undefined) return false;
  if (meta.thresholdFamily === null) return true; // 无阈值类型不校验阈值
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) return false;
  return isThresholdInRange(meta.thresholdFamily, n);
}

/** 单条件合法 = param 合法 ∧ threshold 合法。 */
export function conditionValid(c: DraftCondition): boolean {
  return paramValid(c.type, c.param) && thresholdValid(c.type, c.threshold);
}

/**
 * 新增条件初始 (param, threshold)（参数 sheet 新建 seed，T016）：
 * 带参类型默认首个白名单值；RSI 预填 meta 默认阈值（FR-S04 70/30）；其余阈值/无参类空。
 */
export function newConditionDefaults(type: AlertConditionItemType): {
  param: number;
  threshold: string;
} {
  const meta = metaOf(type);
  if (meta === undefined) return { param: NO_PARAM, threshold: '' };
  return {
    param: meta.paramWhitelist[0] ?? NO_PARAM,
    threshold: meta.defaultThreshold !== undefined ? String(meta.defaultThreshold) : '',
  };
}

/** 完成可提交：1..4 条且全合法 + note ≤22 code point（D10）。 */
export function draftSubmittable(conditions: readonly DraftCondition[], note: string): boolean {
  return (
    conditions.length >= 1 &&
    conditions.length <= MAX_CONDITIONS &&
    conditions.every(conditionValid) &&
    noteCodePointCount(note) <= NOTE_MAX_CODE_POINTS
  );
}

/**
 * 草稿 → request 条件集（调用前提 draftSubmittable=true）。
 * 按 meta 决定携带：带参类型附 param；有阈值类型附 threshold（string→number）。
 */
export function toConditionEntries(list: readonly DraftCondition[]): AlertConditionEntry[] {
  return list.map((c) => {
    const meta = metaOf(c.type);
    const entry: AlertConditionEntry = { type: c.type };
    if (meta && meta.paramWhitelist.length > 0) entry.param = c.param;
    if (meta && meta.thresholdFamily !== null) entry.threshold = Number.parseFloat(c.threshold);
    return entry;
  });
}

export interface AlertDraftState {
  /** 防重入 init 键（edit:alertId / new:symbols join；route effect 比对后才 start*）。 */
  initKey: string | null;
  /** 编辑目标（null = 新建）。 */
  alertId: string | null;
  /** 新建标的（屏 1 单只 / 屏 4 批量；编辑态为原 alert 单只，供失效定位）。 */
  instruments: { market: string; code: string }[];
  conditions: DraftCondition[];
  frequency: AlertResponseFrequency;
  note: string;
  startNew: (key: string, instruments: { market: string; code: string }[]) => void;
  startEdit: (key: string, alert: AlertResponse) => void;
  upsert: (type: AlertConditionItemType, param: number, threshold: string) => void;
  remove: (type: AlertConditionItemType, param: number) => void;
  /** 批量对齐某 type 的选中集（026 多选 sheet 一次提交）。 */
  reconcile: (type: AlertConditionItemType, params: readonly number[], threshold: string) => void;
  setFrequency: (frequency: AlertResponseFrequency) => void;
  setNote: (note: string) => void;
  reset: () => void;
}

const EMPTY = {
  initKey: null,
  alertId: null,
  instruments: [],
  conditions: [],
  frequency: 'DAILY' as AlertResponseFrequency,
  note: '',
};

export const useAlertDraft = create<AlertDraftState>()((set) => ({
  ...EMPTY,

  startNew: (key, instruments) => set({ ...EMPTY, initKey: key, instruments }),

  startEdit: (key, alert) =>
    set({
      initKey: key,
      alertId: alert.id,
      instruments: [{ market: alert.market, code: alert.code }],
      // 023 契约：param number（0 sentinel）/ threshold nullable（无阈值类型）。空串/0 兜底。
      conditions: alert.conditions.map((c) => ({
        type: c.type,
        param: c.param ?? NO_PARAM,
        threshold: c.threshold ?? '',
      })),
      frequency: alert.frequency,
      note: alert.note ?? '',
    }),

  upsert: (type, param, threshold) =>
    set((s) => ({ conditions: upsertCondition(s.conditions, type, param, threshold) })),

  remove: (type, param) => set((s) => ({ conditions: removeCondition(s.conditions, type, param) })),

  reconcile: (type, params, threshold) =>
    set((s) => ({ conditions: reconcileConditions(s.conditions, type, params, threshold) })),

  setFrequency: (frequency) => set({ frequency }),

  setNote: (note) => set({ note }),

  reset: () => set({ ...EMPTY }),
}));
