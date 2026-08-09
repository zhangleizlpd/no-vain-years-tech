import { describe, expect, it } from 'vitest';

import { deleteAccountErrorToast } from './deletion-errors';

// FR-C02 — account-deletion error mapping. One-step toast (mirror
// cancel-deletion-errors, not kind+copy). Server folds all code failures to
// 401 INVALID_DELETION_CODE; 400 is a defensive body-validation guard (client
// zod already enforces 6 digits).
describe('deleteAccountErrorToast (FR-C02 mapping)', () => {
  const ax = (status?: number) => ({
    isAxiosError: true,
    response: status === undefined ? undefined : { status },
  });

  it.each([
    [401, '验证码错误'],
    [429, '操作太频繁，请稍后再试'],
    [400, '验证码格式不正确'],
    [500, '网络错误，请重试'],
    [503, '网络错误，请重试'],
    [418, '发生未知错误'],
  ])('maps axios %i', (status, toast) => {
    expect(deleteAccountErrorToast(ax(status as number))).toBe(toast);
  });

  it('maps axios error with no response (network) to the network message', () => {
    expect(deleteAccountErrorToast(ax())).toBe('网络错误，请重试');
  });

  it('maps a TypeError (fetch-level network failure) to the network message', () => {
    expect(deleteAccountErrorToast(new TypeError('Failed to fetch'))).toBe('网络错误，请重试');
  });

  it('maps a non-axios error to the unknown message', () => {
    expect(deleteAccountErrorToast(new Error('boom'))).toBe('发生未知错误');
  });
});
