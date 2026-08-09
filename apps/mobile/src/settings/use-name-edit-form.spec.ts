// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the wrapper (useUpdateDisplayName) so the real chain (update-display-name →
// ./store → expo-secure-store → Flow react-native under happy-dom) never loads — same
// pattern as use-onboarding-form.spec.ts. The wrapper owns store sync (asserted via the
// e2e card-refresh in profile-name-gender-edit.spec.ts); here we drive its mutateAsync.
// getAccountProfileControllerGetProfileQueryKey is mocked so @nvy/api-client's real entry
// (axios chain) never resolves.
const h = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('~/auth/update-display-name', () => ({
  useUpdateDisplayName: vi.fn(() => ({ mutateAsync: h.mutateAsync, isPending: false })),
}));
vi.mock('@nvy/api-client', () => ({
  getAccountProfileControllerGetProfileQueryKey: vi.fn(() => ['/api/v1/accounts/me']),
}));

import { nameEditErrorToast, useNameEditForm } from './use-name-edit-form';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

describe('useNameEditForm (core)', () => {
  beforeEach(() => {
    h.mutateAsync.mockReset().mockResolvedValue({
      data: {
        accountId: '1',
        phone: '+8613800138000',
        displayName: '拾光者',
        bio: null,
        gender: null,
        status: 'ACTIVE',
        createdAt: '2026-05-30T00:00:00.000Z',
      },
    });
  });

  it('prefills the form with the initial displayName', () => {
    const { result } = renderHook(() => useNameEditForm('夜航西飞'), { wrapper });
    expect(result.current.form.getValues('displayName')).toBe('夜航西飞');
  });

  it('submit persists the trimmed name (via write-through wrapper) and moves to success', async () => {
    const { result } = renderHook(() => useNameEditForm('夜航西飞'), { wrapper });
    act(() => result.current.form.setValue('displayName', '  拾光者  ', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    // wrapper.mutateAsync is the write-through path (useUpdateDisplayName.onSuccess
    // → setQueryData into the /me cache); this hook no longer invalidates itself.
    expect(h.mutateAsync).toHaveBeenCalledWith({ data: { displayName: '拾光者' } });
    expect(result.current.state).toBe('success');
  });

  it('does NOT call the mutation when name is empty (NotEmpty — 不可空)', async () => {
    const { result } = renderHook(() => useNameEditForm('夜航西飞'), { wrapper });
    act(() => result.current.form.setValue('displayName', '', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.mutateAsync).not.toHaveBeenCalled();
  });

  it('does NOT call the mutation when name exceeds 32 code points', async () => {
    const { result } = renderHook(() => useNameEditForm('夜航西飞'), { wrapper });
    act(() =>
      result.current.form.setValue('displayName', 'a'.repeat(33), { shouldValidate: true }),
    );
    await act(async () => {
      await result.current.submit();
    });
    expect(h.mutateAsync).not.toHaveBeenCalled();
  });
});

describe('nameEditErrorToast (reuses onboarding mapping)', () => {
  const ax = (status?: number) => ({
    isAxiosError: true,
    response: status ? { status } : undefined,
  });

  it.each([
    [400, '昵称不合法，请重试'],
    [429, '请求过于频繁，请稍后再试'],
    [500, '网络异常，请重试'],
  ])('axios %s → %s', (status, toast) => {
    expect(nameEditErrorToast(ax(status as number))).toBe(toast);
  });

  it('non-axios error → unknown', () => {
    expect(nameEditErrorToast(new Error('boom'))).toBe('提交失败，请稍后重试');
  });
});
