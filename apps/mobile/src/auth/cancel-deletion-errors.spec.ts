import { describe, expect, it } from 'vitest';

import { cancelDeletionErrorToast } from './cancel-deletion-errors';

// FR-C05 — 统一错误映射。401 折叠成单一凭证错（与 server 5-类反枚举一致）；
// 422 / 429 / 网络分别独立文案。
describe('cancelDeletionErrorToast (FR-C05 mapping)', () => {
  const ax = (status?: number) => ({
    isAxiosError: true,
    response: status === undefined ? undefined : { status },
  });

  it.each([
    [401, '手机号或验证码错误'],
    [422, '手机号格式不正确'],
    [429, '请求过于频繁，请稍后再试'],
    [500, '网络异常，请检查网络后重试'],
    [503, '网络异常，请检查网络后重试'],
    [418, '撤销失败，请稍后再试'],
  ])('maps axios %i', (status, toast) => {
    expect(cancelDeletionErrorToast(ax(status as number))).toBe(toast);
  });

  it('maps axios error with no response (network) to the network message', () => {
    expect(cancelDeletionErrorToast(ax())).toBe('网络异常，请检查网络后重试');
  });

  it('maps a non-axios error to the unknown message', () => {
    expect(cancelDeletionErrorToast(new Error('boom'))).toBe('撤销失败，请稍后再试');
  });
});
