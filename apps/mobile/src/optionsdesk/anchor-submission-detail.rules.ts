// 072 T019 — 审批详情的纯判定（FR-002 / FR-005 / US2 / US3）。
//
// 🚨 只 import type（`@nvy/api-client` 的运行时入口在 mobile vitest 下解析不到，
//    整个 spec 文件会 0 用例跑起来而 exit code 照样是 1 —— 见 T018 留痕）。
import type {
  AnchorSubmissionDetailResponse,
  ApproveAnchorSubmissionRequest,
  ApproveAnchorSubmissionResponse,
} from '@nvy/api-client';

import type { AnchorSubmissionFormValues } from './anchor-submission.schema';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.anchorSubmission;

/** 口径日闸的出口。顺序即渲染顺序（主 → 次 → 取消）。 */
export type AsofGateExit = 'shift' | 'accept' | 'cancel';

/**
 * 三出口 / 两出口（sb-5, sb-6; US3）。
 *
 * 🚨 `asofSuggested === null` ⇒ 「改送前一交易日」**整个出口不渲染**，而不是渲成 disabled：
 * 日历解不出那一天时系统**不猜**，屏上多一个点不动的按钮只会让人以为是自己没选对。
 * 服务端在 ack='shift' 时同样硬停（409 ASOF_SHIFT_UNRESOLVABLE），两端同一个态度。
 */
export function asofGateExits(asofSuggested: string | null): AsofGateExit[] {
  return asofSuggested === null ? ['accept', 'cancel'] : ['shift', 'accept', 'cancel'];
}

/** 详情页顶部的处置提示：什么都不写 / 会冲掉人工位 / 无需提示。 */
export type DetailNotice = 'noop' | 'fallback' | 'none';

/**
 * 🚨 `willBeNoop` 优先于 `fallbackPreview`（sb-11）：给一个**什么都不写**的操作配上
 * 「将清掉你的 3 处人工位」，正是训练人闭眼点确认的机制。server 保证 noop 时预览为空，
 * 这里仍然显式先判 noop —— 不替上游做「不可能发生」的假设。
 */
export function detailNotice(
  detail: Pick<AnchorSubmissionDetailResponse, 'willBeNoop' | 'fallbackPreview'>,
): DetailNotice {
  if (detail.willBeNoop) return 'noop';
  return detail.fallbackPreview.length > 0 ? 'fallback' : 'none';
}

/**
 * 表单 → 采纳载荷：**只带真正改过的字段**（省略 = 沿用提交值）。
 *
 * 全量回传也能工作，但那样「审核方改过什么」就再也读不出来了 —— appliedAsof 与提交行
 * 不同是唯一能追溯「这条被改过」的痕迹，把四个字段一律回传等于把这条痕迹抹平。
 */
export function approveChanges(
  values: AnchorSubmissionFormValues,
  detail: Pick<AnchorSubmissionDetailResponse, 'v' | 'asof' | 'method' | 'confidence'>,
  asofAck?: 'shift' | 'accept',
): ApproveAnchorSubmissionRequest {
  const payload: ApproveAnchorSubmissionRequest = {};
  if (values.v !== detail.v) payload.v = values.v;
  if (values.asof !== detail.asof) payload.asof = values.asof;
  if (values.method !== detail.method) payload.method = values.method;
  if (values.confidence !== detail.confidence) payload.confidence = values.confidence;
  const note = values.reviewNote.trim();
  if (note.length > 0) payload.reviewNote = note;
  if (asofAck) payload.asofAck = asofAck;
  return payload;
}

/** 审核方是否改动了口径日 —— 改过则本地那份 asofFlag / asofSuggested 已经不作数。 */
export function asofEdited(
  values: Pick<AnchorSubmissionFormValues, 'asof'>,
  detail: Pick<AnchorSubmissionDetailResponse, 'asof'>,
): boolean {
  return values.asof !== detail.asof;
}

/** AxiosError 判别走 duck-type（同 anchor-form.rules.ts）—— 不给 apps/mobile 加 axios 直接依赖。 */
function problemOf(error: unknown): { status?: number; code?: string } | null {
  const e = error as {
    isAxiosError?: boolean;
    response?: { status?: number; data?: { code?: unknown } };
  };
  if (!e?.isAxiosError) return null;
  const code = e.response?.data?.code;
  return { status: e.response?.status, code: typeof code === 'string' ? code : undefined };
}

/**
 * 口径日闸的 409（sb-1~3）。
 *
 * ⚠️ 服务端连 `asofFlag` / `asofSuggested` 一起抛了，但 `ProblemDetailFilter` **只透传
 * 白名单字段**（code / freezeUntil / retryAfterSeconds / invalidAttributes），那两样到不了
 * 客户端 —— 045 EC-7 已经踩过同一处（见 `anchor-form.rules.ts` 的 `isDuplicateAnchorError`）。
 * ⇒ 建议日一律取自**详情响应**；审核方改过口径日时我们没有新的建议日，此时按
 * 「解不出」渲染（只剩「按原日期照发」），这与「不猜」是同一个态度。
 */
export function isAsofSuspectError(error: unknown): boolean {
  const p = problemOf(error);
  return p?.status === 409 && p.code === 'ASOF_SUSPECT';
}

/** ack='shift' 但日历解不出前一交易日（sb-6）—— 系统硬停，不拿最接近的日期凑。 */
export function isAsofShiftUnresolvableError(error: unknown): boolean {
  const p = problemOf(error);
  return p?.status === 409 && p.code === 'ASOF_SHIFT_UNRESOLVABLE';
}

/** 这条待审已被别处处置过（sb-8）：409 SUBMISSION_NOT_PENDING —— 与「不存在」是两件事。 */
export function isSubmissionNotPendingError(error: unknown): boolean {
  const p = problemOf(error);
  return p?.status === 409 && p.code === 'SUBMISSION_NOT_PENDING';
}

/** 采纳失败 → 文案。三个 409 各自单列，其余按状态码分流。 */
export function approveErrorToast(error: unknown): string {
  const p = problemOf(error);
  if (p === null) return COPY.approveFailed;
  if (isAsofShiftUnresolvableError(error)) return COPY.asofShiftUnresolvable;
  if (isSubmissionNotPendingError(error)) return COPY.notPending;
  if (p.status === undefined) return COPY.networkFailed;
  if (p.status === 429) return COPY.rateLimited;
  return COPY.approveFailed;
}

/**
 * 半截态（sb-13）：锚已经写了，只是收件箱状态没翻。
 *
 * 🚨 `statusFlipped === false` **不是失败** —— MUST 提示人工核对，且 MUST NOT 重试
 * （重试会写第二遍锚）。这也是服务端刻意回 200 而不是 5xx 的原因。
 */
export function isHalfCommitted(
  res: Pick<ApproveAnchorSubmissionResponse, 'statusFlipped'>,
): boolean {
  return !res.statusFlipped;
}
