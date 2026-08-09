import { describe, expect, it } from 'vitest';

import {
  ERROR_DISPLAY_MAP,
  extractProblemDetail,
  extractTraceId,
  formatErrorMessage,
  isAuthLocked,
  isFormValidationError,
  isFreezePeriod,
  isRetryable,
} from './errors';

// Canonical ProblemDetail layer (per ADR-0038). First consumer = 004 FROZEN
// login interception (use-login-form → extractProblemDetail + isFreezePeriod);
// this spec retires the previously-untested-foundation gap for the whole module.

// Axios errors are duck-shaped here: the real `isAxiosError` only checks
// `payload.isAxiosError === true`, so plain objects suffice.
const axErr = (overrides: Record<string, unknown>) => ({ isAxiosError: true, ...overrides });
const problem = (extra: Record<string, unknown> = {}) => ({
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  ...extra,
});

describe('extractProblemDetail', () => {
  it('unwraps a ProblemDetail-shaped body (status + title present)', () => {
    const p = problem({ code: 'X' });
    expect(extractProblemDetail(axErr({ response: { data: p } }))).toEqual(p);
  });

  it('returns null when body lacks status/title (not a ProblemDetail)', () => {
    expect(extractProblemDetail(axErr({ response: { data: { code: 'X' } } }))).toBeNull();
  });

  it('returns null for a network error (no response)', () => {
    expect(extractProblemDetail(axErr({}))).toBeNull();
  });

  it('returns null for a non-axios error', () => {
    expect(extractProblemDetail(new Error('boom'))).toBeNull();
  });
});

describe('isFreezePeriod (T034 consumer)', () => {
  it('is true for ACCOUNT_IN_FREEZE_PERIOD with a string freezeUntil', () => {
    const p = problem({ code: 'ACCOUNT_IN_FREEZE_PERIOD', freezeUntil: '2026-06-10T00:00:00Z' });
    expect(isFreezePeriod(p)).toBe(true);
  });

  it('is false for null', () => {
    expect(isFreezePeriod(null)).toBe(false);
  });

  it('is false for a different code', () => {
    expect(isFreezePeriod(problem({ code: 'INVALID_CREDENTIALS' }))).toBe(false);
  });

  it('is false when freezeUntil is missing', () => {
    expect(isFreezePeriod(problem({ code: 'ACCOUNT_IN_FREEZE_PERIOD' }))).toBe(false);
  });
});

describe('isFormValidationError', () => {
  it('is true for FORM_VALIDATION with an invalidAttributes array', () => {
    const p = problem({
      code: 'FORM_VALIDATION',
      invalidAttributes: [{ field: 'phone', messages: ['x'] }],
    });
    expect(isFormValidationError(p)).toBe(true);
  });

  it('is false without the invalidAttributes array', () => {
    expect(isFormValidationError(problem({ code: 'FORM_VALIDATION' }))).toBe(false);
  });
});

describe('isAuthLocked', () => {
  it('is true for AUTH_ATTEMPT_LOCKED with a numeric retryAfterSeconds', () => {
    expect(isAuthLocked(problem({ code: 'AUTH_ATTEMPT_LOCKED', retryAfterSeconds: 30 }))).toBe(
      true,
    );
  });

  it('is false when retryAfterSeconds is absent', () => {
    expect(isAuthLocked(problem({ code: 'AUTH_ATTEMPT_LOCKED' }))).toBe(false);
  });
});

describe('isRetryable', () => {
  it('is true for 5xx', () => {
    expect(isRetryable(axErr({ response: { status: 500 } }))).toBe(true);
  });

  it('is true for a network failure (no response)', () => {
    expect(isRetryable(axErr({}))).toBe(true);
  });

  it('is false for a 4xx business reject', () => {
    expect(isRetryable(axErr({ response: { status: 400 } }))).toBe(false);
  });

  it('is false for a non-axios error', () => {
    expect(isRetryable(new Error('boom'))).toBe(false);
  });
});

describe('extractTraceId (fallback chain)', () => {
  it('prefers the body traceId', () => {
    expect(extractTraceId(axErr({ response: { data: { traceId: 'body-1' } } }))).toBe('body-1');
  });

  it('falls back to the x-trace-id response header', () => {
    expect(extractTraceId(axErr({ response: { headers: { 'x-trace-id': 'hdr-1' } } }))).toBe(
      'hdr-1',
    );
  });

  it('returns no-trace when neither is present', () => {
    expect(extractTraceId(new Error('boom'))).toBe('no-trace');
  });
});

describe('formatErrorMessage (ADR-0038 fallback chain)', () => {
  it('maps a known code via ERROR_DISPLAY_MAP', () => {
    expect(
      formatErrorMessage(axErr({ response: { data: problem({ code: 'INVALID_CREDENTIALS' }) } })),
    ).toBe(ERROR_DISPLAY_MAP['INVALID_CREDENTIALS']);
  });

  it('falls back to detail for an unmapped code', () => {
    const p = problem({ code: 'SOMETHING_NEW', detail: '具体说明' });
    expect(formatErrorMessage(axErr({ response: { data: p } }))).toBe('具体说明');
  });

  it('falls back to title when no code/detail', () => {
    expect(formatErrorMessage(axErr({ response: { data: problem({ title: '禁止访问' }) } }))).toBe(
      '禁止访问',
    );
  });

  it('uses the Error message for a plain error', () => {
    expect(formatErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns the generic fallback for an unknown throwable', () => {
    expect(formatErrorMessage('weird')).toBe('未知错误,请稍后再试');
  });
});
