// FR-C02 account-deletion error mapping — one unified toast (mirror
// cancel-deletion-errors, not kind+copy). AxiosError is duck-typed via the
// `isAxiosError` flag so apps/mobile needn't take a direct axios dependency
// (axios is @nvy/api-client's dependency). 禁 import @nvy/api-client 旧栈错误类型.
//   401 INVALID_DELETION_CODE → 验证码错误（server folds all code failures here）
//   429 RATE_LIMITED          → 限流
//   400 FORM_VALIDATION       → 格式（防御性；客户端 zod 已先拦 6 位）
//   ≥500 / 无 response / TypeError（fetch 层网络错） → 网络
//   其余 → 未知
const TOAST = {
  invalidCode: '验证码错误',
  rateLimit: '操作太频繁，请稍后再试',
  format: '验证码格式不正确',
  network: '网络错误，请重试',
  unknown: '发生未知错误',
} as const;

export function deleteAccountErrorToast(error: unknown): string {
  const e = error as { isAxiosError?: boolean; response?: { status?: number } };
  if (e?.isAxiosError) {
    const status = e.response?.status;
    if (status === undefined) return TOAST.network;
    if (status === 401) return TOAST.invalidCode;
    if (status === 429) return TOAST.rateLimit;
    if (status === 400) return TOAST.format;
    if (status >= 500) return TOAST.network;
    return TOAST.unknown;
  }
  if (error instanceof TypeError) return TOAST.network;
  return TOAST.unknown;
}
