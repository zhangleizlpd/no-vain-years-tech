// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api-client gender mutation + query-key fn and the auth store so the
// real axios / expo-secure-store chain never loads. The hook scopes the /me
// invalidation by accountId (meQueryKey), read from useAuthStore.getState().
const h = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));

vi.mock('@nvy/api-client', () => ({
  useAccountProfileControllerUpdateGender: vi.fn(() => ({
    mutateAsync: h.mutateAsync,
    isPending: h.isPending,
  })),
  getAccountProfileControllerGetProfileQueryKey: vi.fn(() => ['/api/v1/accounts/me']),
}));
vi.mock('~/auth', () => ({
  useAuthStore: Object.assign(vi.fn(), { getState: () => ({ accountId: '1' }) }),
}));

import { genderEditErrorToast, useGenderEdit } from './use-gender-edit';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

describe('useGenderEdit (core, tap-to-select)', () => {
  beforeEach(() => {
    h.isPending = false;
    h.mutateAsync.mockReset().mockResolvedValue({ data: { gender: 'FEMALE' } });
  });

  it('starts idle', () => {
    const { result } = renderHook(() => useGenderEdit(), { wrapper });
    expect(result.current.state).toBe('idle');
  });

  it('select persists the chosen enum and moves to success', async () => {
    const { result } = renderHook(() => useGenderEdit(), { wrapper });
    await act(async () => {
      await result.current.select('FEMALE');
    });
    expect(h.mutateAsync).toHaveBeenCalledWith({ data: { gender: 'FEMALE' } });
    expect(result.current.state).toBe('success');
  });

  it('select is a no-op while a mutation is in flight (防重复点)', async () => {
    h.isPending = true;
    const { result } = renderHook(() => useGenderEdit(), { wrapper });
    await act(async () => {
      await result.current.select('MALE');
    });
    expect(h.mutateAsync).not.toHaveBeenCalled();
  });

  it('moves to error and latches a toast when the mutation rejects', async () => {
    h.mutateAsync.mockRejectedValueOnce({ isAxiosError: true, response: { status: 400 } });
    const { result } = renderHook(() => useGenderEdit(), { wrapper });
    await act(async () => {
      await result.current.select('PRIVATE');
    });
    expect(result.current.state).toBe('error');
    expect(result.current.errorToast).toBe('性别设置失败，请重试');
  });
});

describe('genderEditErrorToast (mapping)', () => {
  const ax = (status?: number) => ({
    isAxiosError: true,
    response: status ? { status } : undefined,
  });

  it.each([
    [400, '性别设置失败，请重试'],
    [429, '请求过于频繁，请稍后再试'],
    [500, '网络异常，请重试'],
  ])('axios %s → %s', (status, toast) => {
    expect(genderEditErrorToast(ax(status as number))).toBe(toast);
  });

  it('axios without response (network) → 网络异常', () => {
    expect(genderEditErrorToast(ax())).toBe('网络异常，请重试');
  });

  it('non-axios error → unknown', () => {
    expect(genderEditErrorToast(new Error('boom'))).toBe('保存失败，请稍后重试');
  });
});
