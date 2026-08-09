// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api-client bind mutation + query-key fn and the auth store so the
// real axios / expo-secure-store chain never loads. invalidation scoped by
// accountId (meQueryKey → getAccountProfileControllerGetProfileQueryKey).
const h = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));

vi.mock('@nvy/api-client', () => ({
  useWechatBindingControllerBindWechatForMe: vi.fn(() => ({
    mutateAsync: h.mutateAsync,
    isPending: h.isPending,
  })),
  getAccountProfileControllerGetProfileQueryKey: vi.fn(() => ['/api/v1/accounts/me']),
}));
vi.mock('~/auth', () => ({
  useAuthStore: Object.assign(vi.fn(), { getState: () => ({ accountId: '1' }) }),
}));

import { useWechatBind, authorizeWechatStub } from './use-wechat-bind';
import { wechatBindErrorToast, wechatUnbindErrorToast } from './wechat-errors';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(client, 'invalidateQueries');
  return { node: createElement(QueryClientProvider, { client }, children), spy };
}

describe('useWechatBind (core)', () => {
  beforeEach(() => {
    h.isPending = false;
    h.mutateAsync.mockReset().mockResolvedValue(undefined);
  });

  it('starts idle', () => {
    const { result } = renderHook(() => useWechatBind(), {
      wrapper: ({ children }) => wrapper({ children }).node,
    });
    expect(result.current.state).toBe('idle');
  });

  it('成功: stub authCode → bind → invalidate /me → success', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useWechatBind(), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
    });
    await act(async () => {
      await result.current.start();
    });
    expect(h.mutateAsync).toHaveBeenCalledWith({ data: { authCode: 'wx-stub-authcode' } });
    expect(spy).toHaveBeenCalled(); // invalidate /me (行翻解绑)
    expect(result.current.state).toBe('success');
  });

  it('in-flight 防重复 (isPending) → no-op', async () => {
    h.isPending = true;
    const { result } = renderHook(() => useWechatBind(), {
      wrapper: ({ children }) => wrapper({ children }).node,
    });
    await act(async () => {
      await result.current.start();
    });
    expect(h.mutateAsync).not.toHaveBeenCalled();
  });

  it('409 → error latch toast「该微信已绑定其他账号」+ 不 invalidate (不脏写)', async () => {
    h.mutateAsync.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409 } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useWechatBind(), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
    });
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe('error');
    expect(result.current.errorToast).toBe('该微信已绑定其他账号');
    expect(spy).not.toHaveBeenCalled(); // 失败不翻行 (FR-C06)
  });

  it('authorizeWechatStub 返确定性 authCode', () => {
    expect(authorizeWechatStub()).toBe(authorizeWechatStub());
  });
});

describe('wechat error mapping', () => {
  const ax = (status?: number) => ({
    isAxiosError: true,
    response: status ? { status } : undefined,
  });

  it.each([
    [409, '该微信已绑定其他账号'],
    [429, '操作太频繁，请稍后再试'],
    [500, '网络错误，请重试'],
  ])('bind axios %s → %s', (status, toast) => {
    expect(wechatBindErrorToast(ax(status as number))).toBe(toast);
  });

  it.each([
    [401, '验证码错误'],
    [400, '验证码格式不正确'],
    [429, '操作太频繁，请稍后再试'],
  ])('unbind axios %s → %s', (status, toast) => {
    expect(wechatUnbindErrorToast(ax(status as number))).toBe(toast);
  });

  it('无 response → 网络; 非 axios → 未知', () => {
    expect(wechatBindErrorToast(ax())).toBe('网络错误，请重试');
    expect(wechatUnbindErrorToast(new Error('boom'))).toBe('发生未知错误');
  });
});
