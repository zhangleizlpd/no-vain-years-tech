// FR-C06 设备撤销错误 — 统一映射（错误码沿用 server DEVICE_NOT_FOUND / CANNOT_REMOVE_CURRENT_DEVICE）。
// 两段式（kind → copy）：caller 可按 kind 分支（如 not_found 触发列表 refetch），sheet 取 copy 展示。
// AxiosError 判别走 duck-type（`isAxiosError` flag + `response.data.code`），避免给 apps/mobile
// 直加 axios 依赖（axios 是 @nvy/api-client 的依赖），与 cancel-deletion-errors 同款。

export type DeviceErrorKind =
  | 'session_expired'
  | 'frozen'
  | 'not_found'
  | 'cannot_remove_current'
  | 'rate_limit'
  | 'network'
  | 'unknown';

export function mapDeviceError(error: unknown): DeviceErrorKind {
  const e = error as {
    isAxiosError?: boolean;
    response?: { status?: number; data?: { code?: string } };
  };
  if (e?.isAxiosError) {
    const status = e.response?.status;
    const code = e.response?.data?.code;
    if (status === undefined) return 'network'; // timeout / offline — no response
    if (status === 401) return 'session_expired';
    if (status === 403 && code === 'ACCOUNT_IN_FREEZE_PERIOD') return 'frozen';
    if (status === 404) return 'not_found'; // endpoint's only 404 = DEVICE_NOT_FOUND (anti-enum)
    if (status === 409) return 'cannot_remove_current'; // only 409 = CANNOT_REMOVE_CURRENT_DEVICE
    if (status === 429) return 'rate_limit';
    if (status >= 500) return 'network';
    return 'unknown';
  }
  if (error instanceof TypeError) return 'network'; // fetch-layer failure
  return 'unknown';
}

const COPY: Record<DeviceErrorKind, string> = {
  session_expired: '会话已失效，请重新登录',
  frozen: '账号已冻结，请联系客服',
  not_found: '设备不存在或已被移除',
  cannot_remove_current: '无法移除当前设备，请改用退出登录',
  rate_limit: '操作太频繁，请稍后再试',
  network: '网络错误，请重试',
  unknown: '发生未知错误',
};

export function deviceErrorCopy(kind: DeviceErrorKind): string {
  return COPY[kind];
}
