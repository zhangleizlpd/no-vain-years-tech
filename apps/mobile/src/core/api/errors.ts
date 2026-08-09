/**
 * Client-side ProblemDetail type guards + display map (per ADR-0038 +
 * ai-friction-catalog F-005 untyped-error-code-hallucination).
 *
 * Server emits RFC 9457 ProblemDetail with 5 business extension fields
 * (per ADR-0038 — code/traceId/freezeUntil/retryAfterSeconds/invalidAttributes).
 * Orval (per ADR-0027) gives us typed access via `AxiosError<ProblemDetailResponse>`.
 *
 * Use guards in catch blocks / useMutation onError:
 *   try { await mutate(...); }
 *   catch (e) {
 *     const p = extractProblemDetail(e);
 *     if (isFormValidationError(p)) p.invalidAttributes.forEach(({field, messages}) =>
 *       form.setError(field, { message: messages.join('; ') }));
 *     else if (isFreezePeriod(p)) router.push(`/freeze?until=${p.freezeUntil}`);
 *     else show(ERROR_DISPLAY_MAP[p?.code ?? ''] ?? p?.detail ?? '未知错误,请稍后再试');
 *   }
 */
import { AxiosError, isAxiosError } from 'axios';
import type { ProblemDetailResponse } from '@nvy/api-client';

type ProblemWithCode<C extends string, Extra = unknown> = ProblemDetailResponse & {
  code: C;
} & Extra;

export type FormValidationProblem = ProblemWithCode<
  'FORM_VALIDATION',
  { invalidAttributes: NonNullable<ProblemDetailResponse['invalidAttributes']> }
>;
export type FreezePeriodProblem = ProblemWithCode<
  'ACCOUNT_IN_FREEZE_PERIOD',
  { freezeUntil: string }
>;
export type AuthAttemptLockedProblem = ProblemWithCode<
  'AUTH_ATTEMPT_LOCKED',
  { retryAfterSeconds: number }
>;

/**
 * Unwrap a thrown error into ProblemDetailResponse if possible.
 * Returns null when the error is not an axios error or carries no
 * ProblemDetail-shaped body (network failure / non-JSON / etc.).
 */
export function extractProblemDetail(err: unknown): ProblemDetailResponse | null {
  if (
    isAxiosError(err) &&
    err.response?.data &&
    typeof err.response.data === 'object' &&
    'status' in (err.response.data as object) &&
    'title' in (err.response.data as object)
  ) {
    return err.response.data as ProblemDetailResponse;
  }
  return null;
}

export function isFormValidationError(p: ProblemDetailResponse | null): p is FormValidationProblem {
  return p !== null && p.code === 'FORM_VALIDATION' && Array.isArray(p.invalidAttributes);
}

export function isFreezePeriod(p: ProblemDetailResponse | null): p is FreezePeriodProblem {
  return p !== null && p.code === 'ACCOUNT_IN_FREEZE_PERIOD' && typeof p.freezeUntil === 'string';
}

export function isAuthLocked(p: ProblemDetailResponse | null): p is AuthAttemptLockedProblem {
  return p !== null && p.code === 'AUTH_ATTEMPT_LOCKED' && typeof p.retryAfterSeconds === 'number';
}

/**
 * Whether the request should be retried by the caller — 5xx + network
 * failures (no problem detail body extractable). 4xx business rejects
 * are NOT retryable from the caller's POV (the input is the problem).
 */
export function isRetryable(err: unknown): boolean {
  if (isAxiosError(err)) {
    if (!err.response) return true; // network failure
    return err.response.status >= 500;
  }
  return false;
}

/**
 * Get the trace id for UI display from a thrown error or ProblemDetail.
 * Fallback chain: problem.traceId body field → response header → 'no-trace'.
 */
export function extractTraceId(err: unknown): string {
  if (isAxiosError(err)) {
    const fromBody = (err.response?.data as { traceId?: string } | undefined)?.traceId;
    if (fromBody) return fromBody;
    const fromHeader = err.response?.headers?.['x-trace-id'];
    if (typeof fromHeader === 'string') return fromHeader;
  }
  return 'no-trace';
}

/**
 * Chinese inline error messages keyed by ProblemDetail.code. Not i18n —
 * Plan 4 will introduce i18next when multi-locale becomes a requirement.
 * Per ADR-0038 fallback chain: this map → problem.detail → problem.title
 * → generic '未知错误,请稍后再试'.
 */
export const ERROR_DISPLAY_MAP: Record<string, string> = {
  ACCOUNT_IN_FREEZE_PERIOD: '账号处于注销冻结期内,暂不可登录',
  AUTH_ATTEMPT_LOCKED: '验证失败次数过多,账号已暂时锁定,请稍后再试',
  RATE_LIMIT_EXCEEDED: '操作过于频繁,请稍后再试',
  SMS_CODE_INVALID: '验证码错误或已过期',
  SMS_CODE_EXPIRED: '验证码已过期,请重新获取',
  FORM_VALIDATION: '表单信息有误,请检查后重新提交',
  INVALID_CREDENTIALS: '账号或验证码不正确',
  SESSION_EXPIRED: '登录已过期,请重新登录',
};

/**
 * Resolve a user-facing message for any thrown error.
 * Walks the ADR-0038 fallback chain.
 */
export function formatErrorMessage(err: unknown): string {
  const p = extractProblemDetail(err);
  if (p) {
    if (p.code) {
      const mapped = ERROR_DISPLAY_MAP[p.code];
      if (mapped) return mapped;
    }
    if (p.detail) return p.detail;
    if (p.title) return p.title;
  }
  if (err instanceof AxiosError && err.message) return err.message;
  if (err instanceof Error) return err.message;
  return '未知错误,请稍后再试';
}
