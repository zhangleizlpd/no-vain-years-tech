// FR-C05 撤销错误展示 — 统一映射（不区分子类，与 server 反枚举一致）。
// AxiosError 判别走 duck-type（`isAxiosError` flag），避免给 apps/mobile 直加 axios
// 依赖（axios 是 @nvy/api-client 的依赖）。
//   401 INVALID_CREDENTIALS → 统一凭证错（server 把 5 类失败折叠成字节级一致的 401）
//   422 INVALID_PHONE_FORMAT → 手机号格式（防御性；客户端 zod 已先拦）
//   429 RATE_LIMITED → 限流
//   无 response（网络/超时）或 5xx → 网络
//   其余 → 未知
const TOAST = {
  invalid: '手机号或验证码错误',
  phoneFormat: '手机号格式不正确',
  rateLimit: '请求过于频繁，请稍后再试',
  network: '网络异常，请检查网络后重试',
  unknown: '撤销失败，请稍后再试',
} as const;

export function cancelDeletionErrorToast(error: unknown): string {
  const e = error as { isAxiosError?: boolean; response?: { status?: number } };
  if (e?.isAxiosError) {
    const status = e.response?.status;
    if (status === undefined) return TOAST.network;
    if (status === 401) return TOAST.invalid;
    if (status === 422) return TOAST.phoneFormat;
    if (status === 429) return TOAST.rateLimit;
    if (status >= 500) return TOAST.network;
    return TOAST.unknown;
  }
  return TOAST.unknown;
}
