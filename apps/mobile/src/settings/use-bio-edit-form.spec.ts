// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api-client bio mutation + query-key fn and the auth store so the real
// axios / expo-secure-store RN chain never loads. The hook scopes the /me
// invalidation by accountId (meQueryKey), reading it from useAuthStore.getState().
// RHF + zodResolver + zod are platform-agnostic.
const h = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('@nvy/api-client', () => ({
  useAccountProfileControllerUpdateBio: vi.fn(() => ({
    mutateAsync: h.mutateAsync,
    isPending: false,
  })),
  getAccountProfileControllerGetProfileQueryKey: vi.fn(() => ['/api/v1/accounts/me']),
}));
vi.mock('~/auth', () => ({
  useAuthStore: Object.assign(vi.fn(), { getState: () => ({ accountId: '1' }) }),
}));

import { bioEditErrorToast, useBioEditForm } from './use-bio-edit-form';

// useBioEditForm calls useQueryClient → needs a QueryClientProvider in the tree.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

describe('useBioEditForm (core)', () => {
  beforeEach(() => {
    h.mutateAsync.mockReset().mockResolvedValue({
      data: {
        accountId: '1',
        phone: '+8613800138000',
        displayName: '小明',
        bio: '美股研究员',
        status: 'ACTIVE',
        createdAt: '2026-05-30T00:00:00.000Z',
      },
    });
  });

  it('starts idle', () => {
    const { result } = renderHook(() => useBioEditForm(''), { wrapper });
    expect(result.current.state).toBe('idle');
  });

  it('prefills the form with the initial bio', () => {
    const { result } = renderHook(() => useBioEditForm('量化交易员'), { wrapper });
    expect(result.current.form.getValues('bio')).toBe('量化交易员');
  });

  it('submit persists bio and moves to success', async () => {
    const { result } = renderHook(() => useBioEditForm(''), { wrapper });
    act(() => result.current.form.setValue('bio', '美股研究员', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.mutateAsync).toHaveBeenCalledWith({ data: { bio: '美股研究员' } });
    expect(result.current.state).toBe('success');
  });

  it('trims the submitted value (resolver normalizes)', async () => {
    const { result } = renderHook(() => useBioEditForm(''), { wrapper });
    act(() => result.current.form.setValue('bio', '  量化交易员  ', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.mutateAsync).toHaveBeenCalledWith({ data: { bio: '量化交易员' } });
  });

  it('allows empty bio (clear) — submits empty string, moves to success', async () => {
    const { result } = renderHook(() => useBioEditForm('旧简介'), { wrapper });
    act(() => result.current.form.setValue('bio', '', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.mutateAsync).toHaveBeenCalledWith({ data: { bio: '' } });
    expect(result.current.state).toBe('success');
  });

  it('does NOT call the mutation when bio exceeds 120 code points', async () => {
    const { result } = renderHook(() => useBioEditForm(''), { wrapper });
    act(() => result.current.form.setValue('bio', 'a'.repeat(121), { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.mutateAsync).not.toHaveBeenCalled();
  });
});

describe('bioEditErrorToast (mapping)', () => {
  const ax = (status?: number) => ({
    isAxiosError: true,
    response: status ? { status } : undefined,
  });

  it.each([
    [400, '简介不合法，请重试'],
    [429, '请求过于频繁，请稍后再试'],
    [500, '网络异常，请重试'],
  ])('axios %s → %s', (status, toast) => {
    expect(bioEditErrorToast(ax(status as number))).toBe(toast);
  });

  it('axios without response (network/timeout) → 网络异常', () => {
    expect(bioEditErrorToast(ax())).toBe('网络异常，请重试');
  });

  it('non-axios error → unknown', () => {
    expect(bioEditErrorToast(new Error('boom'))).toBe('保存失败，请稍后重试');
  });
});
