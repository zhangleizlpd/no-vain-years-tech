// 010 微信绑定/解绑错误映射 — 镜像 deletion-errors。AxiosError 经 `isAxiosError`
// flag duck-type，apps/mobile 不直依赖 axios。禁 import @nvy/api-client 旧栈错误类型。
const TOAST = {
  alreadyBoundOther: '该微信已绑定其他账号',
  invalidCode: '验证码错误',
  rateLimit: '操作太频繁，请稍后再试',
  format: '验证码格式不正确',
  network: '网络错误，请重试',
  unknown: '发生未知错误',
} as const;

function axiosStatus(error: unknown): number | undefined | 'not-axios' {
  const e = error as { isAxiosError?: boolean; response?: { status?: number } };
  if (e?.isAxiosError) return e.response?.status;
  return 'not-axios';
}

// 绑定错误: 409 → 该微信已绑定其他账号 (WECHAT_ALREADY_BOUND_OTHER); 429 → 限流;
// 无 response / 5xx / TypeError → 网络; 其余 → 未知。
export function wechatBindErrorToast(error: unknown): string {
  const status = axiosStatus(error);
  if (status === 'not-axios') return error instanceof TypeError ? TOAST.network : TOAST.unknown;
  if (status === undefined) return TOAST.network;
  if (status === 409) return TOAST.alreadyBoundOther;
  if (status === 429) return TOAST.rateLimit;
  if (status >= 500) return TOAST.network;
  return TOAST.unknown;
}

// 解绑错误: 401 → 验证码错误 (server 折叠 INVALID_UNBIND_CODE); 429 → 限流;
// 400 → 格式 (防御性, 客户端 zod 已先拦 6 位); 无 response / 5xx / TypeError → 网络; 其余 → 未知。
export function wechatUnbindErrorToast(error: unknown): string {
  const status = axiosStatus(error);
  if (status === 'not-axios') return error instanceof TypeError ? TOAST.network : TOAST.unknown;
  if (status === undefined) return TOAST.network;
  if (status === 401) return TOAST.invalidCode;
  if (status === 429) return TOAST.rateLimit;
  if (status === 400) return TOAST.format;
  if (status >= 500) return TOAST.network;
  return TOAST.unknown;
}
