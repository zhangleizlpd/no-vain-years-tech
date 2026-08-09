// 045 T022 — 锚表单纯函数规则（组件 / hook 只做接线，判定全在这里，per ~/ui MarketBadge 体例）。
import type {
  AnchorResponseConfidenceSource,
  CreateAnchorRequest,
  UpdateAnchorRequest,
} from '@nvy/api-client';

import type { AnchorFormValues } from './anchor-form.schema';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.anchorForm;

/** AxiosError 判别走 duck-type（同 use-login-form）—— 不给 apps/mobile 加 axios 直接依赖。 */
function axiosStatus(error: unknown): number | undefined | null {
  const e = error as { isAxiosError?: boolean; response?: { status?: number } };
  if (!e?.isAxiosError) return null;
  return e.response?.status;
}

/**
 * 🚨 EC-7 —— 同一 ticker 重复建锚，server 返 409。既有锚 id 嵌在 message 串里而
 * `ProblemDetailFilter` 只透传白名单字段 ⇒ **拿不到结构化 `existingAnchorId`**，
 * 前端改按刚提交的 ticker 在锚列表里定位既有锚（见 `findAnchorIdByTicker`）。
 */
export function isDuplicateAnchorError(error: unknown): boolean {
  return axiosStatus(error) === 409;
}

/** 提交错误 → 文案。409 单列（EC-7 要给「去编辑」引导，不能混进通用失败）。 */
export function anchorSubmitErrorToast(error: unknown): string {
  const status = axiosStatus(error);
  if (status === null) return COPY.unknown;
  if (status === undefined) return COPY.network;
  if (status === 409) return COPY.duplicateAnchor;
  if (status === 400 || status === 422) return COPY.invalidInput;
  if (status === 429) return COPY.rateLimit;
  if (status >= 500) return COPY.network;
  return COPY.unknown;
}

/** EC-7 定位既有锚：按 canonical ticker 在已加载的锚列表里找。找不到 → null（只显文案不给跳转）。 */
export function findAnchorIdByTicker(
  items: readonly { id: string; ticker: string }[],
  ticker: string | null,
): string | null {
  if (!ticker) return null;
  return items.find((a) => a.ticker === ticker)?.id ?? null;
}

/**
 * FR-001 confidence 来源门控。`model` ⇒ **只读、无编辑入口**（不是 disabled 输入框，是压根没有
 * 编辑路径）—— 对模型评分有异议时人工位在 L 层，不回头改 confidence。
 */
export function isConfidenceEditable(source: AnchorResponseConfidenceSource): boolean {
  return source === 'manual';
}

/**
 * FR-032 ② 人工态提示：措辞必须表达**临时**语义（「将回落」），并同屏带出其派生值。
 * 与 2026-08-01 前的「永久覆盖」语义区分 —— 人工值一律临时、上游一刷新就回落，不存在锁定。
 */
export function manualSlotHint(derivedLabel: string): string {
  return `${COPY.manualHintPrefix}${derivedLabel}`;
}

/**
 * 单票上限（小数比例）→ 百分比串。
 * 🚨 L4 的上限 = `null`（策略 SoT 未定义 L4 档上限，server 照实返 null）→ 展示「—」，**不自造值**。
 * 先 ×1000 取整再 ÷10 是为绕开浮点尾数（`0.05 * 100 === 5.000000000000001`）。
 */
export function formatPositionCap(cap: string | null): string {
  if (cap === null || cap === '') return COPY.noValue;
  const n = Number(cap);
  if (!Number.isFinite(n)) return COPY.noValue;
  return `${Math.round(n * 1000) / 10}%`;
}

function orNull(s: string): string | null {
  const t = s.trim();
  return t.length > 0 ? t : null;
}

/** 建锚 payload。`confidenceSource` 不送 —— server 缺省即 `manual`（手工建锚，FR-001）。 */
export function toCreateRequest(values: AnchorFormValues): CreateAnchorRequest {
  return {
    ticker: values.ticker,
    v: values.v.trim(),
    asof: values.asof,
    method: values.method.trim(),
    confidence: values.confidence.trim(),
    excluded: values.excluded,
    excludeReason: orNull(values.excludeReason),
    nextReview: orNull(values.nextReview),
  };
}

/**
 * 改锚 payload。两条硬约束：
 * ① `confidence` 只在**可改**（`manual` 来源）时进 payload —— `model` 来源改它会被 server 写侧 400。
 * ② **不带任何人工位键**（`vManual` / `lLevelManual` / `positionCapManual`）—— 人工调整是显式动作
 *    （FR-032 ①），走各自的即时 PATCH，不搭表单保存的便车。
 */
export function toUpdateRequest(
  values: AnchorFormValues,
  opts: { confidenceEditable: boolean },
): UpdateAnchorRequest {
  const body: UpdateAnchorRequest = {
    v: values.v.trim(),
    asof: values.asof,
    method: values.method.trim(),
    excluded: values.excluded,
    excludeReason: orNull(values.excludeReason),
    nextReview: orNull(values.nextReview),
  };
  if (opts.confidenceEditable) body.confidence = values.confidence.trim();
  return body;
}
