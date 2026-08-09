import { describe, expect, it } from 'vitest';

import { deviceErrorCopy, mapDeviceError, type DeviceErrorKind } from './device-errors';

// Build an AxiosError-shaped object via duck-typing (matches cancel-deletion-errors precedent —
// apps/mobile has no direct axios dep; the isAxiosError flag is what the wrapper surfaces).
function axiosErr(status: number | undefined, code?: string): unknown {
  return {
    isAxiosError: true,
    response: status === undefined ? undefined : { status, data: code ? { code } : {} },
  };
}

describe('mapDeviceError', () => {
  it('401 → session_expired', () => {
    expect(mapDeviceError(axiosErr(401))).toBe('session_expired');
  });

  it('403 + ACCOUNT_IN_FREEZE_PERIOD → frozen', () => {
    expect(mapDeviceError(axiosErr(403, 'ACCOUNT_IN_FREEZE_PERIOD'))).toBe('frozen');
  });

  it('403 without the freeze code → unknown (only freeze 403 maps)', () => {
    expect(mapDeviceError(axiosErr(403, 'SOMETHING_ELSE'))).toBe('unknown');
  });

  it('404 DEVICE_NOT_FOUND → not_found', () => {
    expect(mapDeviceError(axiosErr(404, 'DEVICE_NOT_FOUND'))).toBe('not_found');
  });

  it('409 CANNOT_REMOVE_CURRENT_DEVICE → cannot_remove_current', () => {
    expect(mapDeviceError(axiosErr(409, 'CANNOT_REMOVE_CURRENT_DEVICE'))).toBe(
      'cannot_remove_current',
    );
  });

  it('429 → rate_limit', () => {
    expect(mapDeviceError(axiosErr(429))).toBe('rate_limit');
  });

  it('5xx → network', () => {
    expect(mapDeviceError(axiosErr(503))).toBe('network');
  });

  it('axios error with no response (timeout / offline) → network', () => {
    expect(mapDeviceError(axiosErr(undefined))).toBe('network');
  });

  it('TypeError (fetch-layer failure) → network', () => {
    expect(mapDeviceError(new TypeError('Failed to fetch'))).toBe('network');
  });

  it('non-axios / unknown throwable → unknown', () => {
    expect(mapDeviceError(new Error('boom'))).toBe('unknown');
    expect(mapDeviceError('weird')).toBe('unknown');
    expect(mapDeviceError(null)).toBe('unknown');
  });
});

describe('deviceErrorCopy', () => {
  const cases: Array<[DeviceErrorKind, string]> = [
    ['session_expired', '会话已失效，请重新登录'],
    ['frozen', '账号已冻结，请联系客服'],
    ['not_found', '设备不存在或已被移除'],
    ['cannot_remove_current', '无法移除当前设备，请改用退出登录'],
    ['rate_limit', '操作太频繁，请稍后再试'],
    ['network', '网络错误，请重试'],
    ['unknown', '发生未知错误'],
  ];

  it.each(cases)('%s → 文案', (kind, copy) => {
    expect(deviceErrorCopy(kind)).toBe(copy);
  });
});
