/**
 * 021 预警配置校验纯函数 (ADR-0043 §4: rules 文件持无副作用业务规则)。
 *
 * 设计取舍 (对照 013 watchlist.rules)：本文件**只出校验纯计算**，不 throw 框架
 * 异常 —— 错误以 `AlertValidationError[]` 并列返回，由写侧 UC 一次性映射
 * 400 ProblemDetail (ADR-0038)，让用户单次提交看到全部违规而非挤牙膏。
 *
 * 023 扩展 (FR-S07)：词表/参数白名单/阈值值域族单源迁至 alert-condition-meta.ts
 * (32 type)，本文件按 meta 查表校验——param 白名单 per type (无参类型必为 sentinel 0)、
 * threshold 值域 per 族 (price/percent/positive/pctile/rsi、无阈值类型禁带)、
 * 重复键 type → (type, param) (同 type 不同 param 共存)。021 既有 4 type 行为不变。
 *
 * 校验面 (FR-S02 + plan D10)：conditions 1..4 / 同类型同参数限 1 / 阈值值域 per 族 /
 * note ≤22 Unicode code point / market 仅 cn / frequency 三档。
 */

import {
  ALERT_CONDITION_META,
  ALERT_CONDITION_TYPES,
  NO_PARAM_SENTINEL,
  isThresholdInRange,
  type AlertConditionType,
  type ThresholdFamily,
} from './alert-condition-meta';

/** 词表 re-export (023 起单源在 meta；DTO/response 既有 import 路径不动)。 */
export { ALERT_CONDITION_TYPES, type AlertConditionType } from './alert-condition-meta';

/** 预警市场词表 (V1 仅 A股；015 Instrument.market 同词不映射)。 */
export const ALERT_MARKETS = ['cn'] as const;
export type AlertMarket = (typeof ALERT_MARKETS)[number];

/** 提醒频率三档 (FR-S03；默认 DAILY)。 */
export const ALERT_FREQUENCIES = ['ONCE_DELETE', 'ONCE_DISABLE', 'DAILY'] as const;
export type AlertFrequency = (typeof ALERT_FREQUENCIES)[number];
export const DEFAULT_ALERT_FREQUENCY: AlertFrequency = 'DAILY';

export const MAX_ALERT_CONDITIONS = 4;
export const MAX_NOTE_CODE_POINTS = 22;

/** 校验错误码 (UC 映射 RFC 9457 code；mobile 文案分流同码, plan §错误分流)。 */
export type AlertValidationCode =
  | 'ALERT_CONDITIONS_EMPTY'
  | 'ALERT_CONDITIONS_TOO_MANY'
  | 'ALERT_CONDITION_TYPE_DUPLICATE'
  | 'ALERT_CONDITION_TYPE_UNKNOWN'
  | 'ALERT_PRICE_THRESHOLD_INVALID'
  | 'ALERT_PERCENT_THRESHOLD_INVALID'
  | 'ALERT_POSITIVE_THRESHOLD_INVALID'
  | 'ALERT_PCTL_THRESHOLD_INVALID'
  | 'ALERT_RSI_THRESHOLD_INVALID'
  | 'ALERT_THRESHOLD_FORBIDDEN'
  | 'ALERT_PARAM_INVALID'
  | 'ALERT_NOTE_TOO_LONG'
  | 'ALERT_MARKET_UNSUPPORTED'
  | 'ALERT_FREQUENCY_UNKNOWN';

export interface AlertValidationError {
  code: AlertValidationCode;
  message: string;
}

/** 条件输入最小形 (DTO 兼容超集；023: param/threshold 可缺省, 按 meta 矩阵校验)。 */
export interface AlertConditionInput {
  type: string;
  param?: number | null;
  threshold?: number | null;
}

/** 预警草稿输入 (创建全量；编辑由 UC merge 现值后整体复验)。 */
export interface AlertDraftInput {
  market: string;
  conditions: readonly AlertConditionInput[];
  frequency: string;
  note?: string | null;
}

/** 错误码 → 表单字段 (ADR-0038 invalidAttributes → mobile form.setError 映射)。 */
const FIELD_BY_CODE: Record<AlertValidationCode, string> = {
  ALERT_CONDITIONS_EMPTY: 'conditions',
  ALERT_CONDITIONS_TOO_MANY: 'conditions',
  ALERT_CONDITION_TYPE_DUPLICATE: 'conditions',
  ALERT_CONDITION_TYPE_UNKNOWN: 'conditions',
  ALERT_PRICE_THRESHOLD_INVALID: 'conditions',
  ALERT_PERCENT_THRESHOLD_INVALID: 'conditions',
  ALERT_POSITIVE_THRESHOLD_INVALID: 'conditions',
  ALERT_PCTL_THRESHOLD_INVALID: 'conditions',
  ALERT_RSI_THRESHOLD_INVALID: 'conditions',
  ALERT_THRESHOLD_FORBIDDEN: 'conditions',
  ALERT_PARAM_INVALID: 'conditions',
  ALERT_NOTE_TOO_LONG: 'note',
  ALERT_MARKET_UNSUPPORTED: 'instruments',
  ALERT_FREQUENCY_UNKNOWN: 'frequency',
};

/** threshold 值域族 → 错误码/文案 (021 price/percent 码沿用, FR-S09)。 */
const THRESHOLD_ERROR_BY_FAMILY: Record<
  ThresholdFamily,
  { code: AlertValidationCode; message: string }
> = {
  price: { code: 'ALERT_PRICE_THRESHOLD_INVALID', message: '价格阈值必须 > 0' },
  percent: { code: 'ALERT_PERCENT_THRESHOLD_INVALID', message: '百分比阈值必须 ∈ (0,100]' },
  positive: { code: 'ALERT_POSITIVE_THRESHOLD_INVALID', message: '阈值必须 > 0' },
  pctile: { code: 'ALERT_PCTL_THRESHOLD_INVALID', message: '分位阈值必须 ∈ [0,100]' },
  rsi: { code: 'ALERT_RSI_THRESHOLD_INVALID', message: 'RSI 阈值必须 ∈ (0,100)' },
};

/** InvalidAttribute 兼容形 (security/form-validation.exception 同构, rules 保持 framework-free)。 */
export interface AlertInvalidAttribute {
  field: string;
  messages: string[];
}

/** 校验错误 → per-field 聚合 (喂 FormValidationException → 400 ProblemDetail)。 */
export function toInvalidAttributes(
  errors: readonly AlertValidationError[],
): AlertInvalidAttribute[] {
  const byField = new Map<string, string[]>();
  for (const e of errors) {
    const field = FIELD_BY_CODE[e.code];
    const messages = byField.get(field) ?? [];
    messages.push(e.message);
    byField.set(field, messages);
  }
  return [...byField.entries()].map(([field, messages]) => ({ field, messages }));
}

/** note 长度按 Unicode code point 计 (D10；mobile `[...s].length` 同口径)。O(n)。 */
export function noteCodePoints(note: string): number {
  return [...note].length;
}

/**
 * 全量校验，违规**并列**返回 (同码去重)；空数组 = 合法。
 * 数量违规 (空/超 4) 时仍继续扫其余维度，但同维度内不重复报。
 */
export function validateAlertDraft(draft: AlertDraftInput): AlertValidationError[] {
  const errors: AlertValidationError[] = [];
  const push = (code: AlertValidationCode, message: string) => {
    if (!errors.some((e) => e.code === code)) errors.push({ code, message });
  };

  if (!(ALERT_MARKETS as readonly string[]).includes(draft.market)) {
    push('ALERT_MARKET_UNSUPPORTED', `market 仅支持 ${ALERT_MARKETS.join('/')} (V1)`);
  }

  if (!(ALERT_FREQUENCIES as readonly string[]).includes(draft.frequency)) {
    push('ALERT_FREQUENCY_UNKNOWN', `frequency 必须为 ${ALERT_FREQUENCIES.join('/')}`);
  }

  if (draft.note != null && noteCodePoints(draft.note) > MAX_NOTE_CODE_POINTS) {
    push('ALERT_NOTE_TOO_LONG', `备注最长 ${MAX_NOTE_CODE_POINTS} 字 (Unicode code point 计)`);
  }

  if (draft.conditions.length === 0) {
    push('ALERT_CONDITIONS_EMPTY', '预警至少需要 1 条条件');
  } else if (draft.conditions.length > MAX_ALERT_CONDITIONS) {
    push('ALERT_CONDITIONS_TOO_MANY', `条件最多 ${MAX_ALERT_CONDITIONS} 条`);
  }

  const seenKeys = new Set<string>();
  for (const c of draft.conditions) {
    // 重复键 (type, param)：param 缺省与 sentinel 0 同键 (plan D3)
    const key = `${c.type}:${c.param ?? NO_PARAM_SENTINEL}`;
    if (seenKeys.has(key)) {
      push('ALERT_CONDITION_TYPE_DUPLICATE', '同类型同参数条件限 1 条 (同类型不同参数可共存)');
    }
    seenKeys.add(key);

    if (!(ALERT_CONDITION_TYPES as readonly string[]).includes(c.type)) {
      push('ALERT_CONDITION_TYPE_UNKNOWN', `未知条件类型 ${c.type}`);
      continue;
    }
    const meta = ALERT_CONDITION_META[c.type as AlertConditionType];

    // param 白名单 per type (FR-S07)：无参类型必为 sentinel 0/缺省；带参类型必在白名单
    if (meta.paramWhitelist.length === 0) {
      if ((c.param ?? NO_PARAM_SENTINEL) !== NO_PARAM_SENTINEL) {
        push('ALERT_PARAM_INVALID', `${c.type} 不接受参数`);
      }
    } else if (c.param == null || !meta.paramWhitelist.includes(c.param)) {
      push('ALERT_PARAM_INVALID', `参数必须 ∈ {${meta.paramWhitelist.join('/')}}`);
    }

    // threshold 值域 per 族 (FR-S07)：无阈值类型禁带；必带类型缺省/出域同码
    if (meta.thresholdFamily === null) {
      if (c.threshold != null) {
        push('ALERT_THRESHOLD_FORBIDDEN', `${c.type} 不接受阈值`);
      }
    } else if (c.threshold == null || !isThresholdInRange(meta.thresholdFamily, c.threshold)) {
      const { code, message } = THRESHOLD_ERROR_BY_FAMILY[meta.thresholdFamily];
      push(code, message);
    }
  }

  return errors;
}
