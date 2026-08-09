// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// mutate 驱动 onSuccess/onError (镜像 hook 的声明式范式)。
const h = vi.hoisted(() => ({
  sendMutate: vi.fn(),
  sendPending: false,
  sendError: null as unknown,
  unbindMutate: vi.fn(),
  unbindPending: false,
  unbindError: null as unknown,
  clearSession: vi.fn(),
}));

vi.mock('@nvy/api-client', () => ({
  useWechatBindingControllerSendUnbindCodeForMe: vi.fn(
    (opts?: { mutation?: { onSuccess?: () => void; onError?: (e: unknown) => void } }) => ({
      mutate: (...a: unknown[]) => {
        h.sendMutate(...a);
        if (h.sendError) opts?.mutation?.onError?.(h.sendError);
        else opts?.mutation?.onSuccess?.();
      },
      isPending: h.sendPending,
    }),
  ),
  useWechatBindingControllerUnbindWechatForMe: vi.fn(
    (opts?: { mutation?: { onSuccess?: () => void; onError?: (e: unknown) => void } }) => ({
      mutate: (...a: unknown[]) => {
        h.unbindMutate(...a);
        if (h.unbindError) opts?.mutation?.onError?.(h.unbindError);
        else void opts?.mutation?.onSuccess?.();
      },
      isPending: h.unbindPending,
    }),
  ),
  getAccountProfileControllerGetProfileQueryKey: vi.fn(() => ['/api/v1/accounts/me']),
}));
vi.mock('~/auth', () => ({
  SMS_CODE_REGEX: /^\d{6}$/,
  useAuthStore: Object.assign(vi.fn(), {
    getState: () => ({ accountId: '1', clearSession: h.clearSession }),
  }),
}));

import { useWechatUnbindForm } from './use-wechat-unbind-form';

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}
const render = () =>
  renderHook(() => useWechatUnbindForm(), { wrapper: ({ children }) => wrap(children) });

describe('useWechatUnbindForm', () => {
  beforeEach(() => {
    h.sendPending = false;
    h.unbindPending = false;
    h.sendError = null;
    h.unbindError = null;
    h.sendMutate.mockReset();
    h.unbindMutate.mockReset();
    h.clearSession.mockReset();
  });

  it('starts idle', () => {
    expect(render().result.current.state).toBe('idle');
  });

  it('发码成功 (onSuccess) → sms_sent + countdown=60; 1s 后递减', async () => {
    vi.useFakeTimers();
    try {
      const { result } = render();
      act(() => result.current.requestSms());
      expect(h.sendMutate).toHaveBeenCalledOnce();
      expect(result.current.state).toBe('sms_sent');
      expect(result.current.smsCountdown).toBe(60);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(result.current.smsCountdown).toBe(59);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cooldown 中 requestSms no-op (countdown>0)', () => {
    const { result } = render();
    act(() => result.current.requestSms());
    h.sendMutate.mockClear();
    act(() => result.current.requestSms());
    expect(h.sendMutate).not.toHaveBeenCalled();
  });

  it('提交成功 (onSuccess) → success + **不** clearSession (解绑保留 session)', async () => {
    const { result } = render();
    await act(async () => {
      result.current.form.setValue('code', '123456');
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(h.unbindMutate).toHaveBeenCalledWith({ data: { code: '123456' } });
    await waitFor(() => expect(result.current.state).toBe('success'));
    expect(h.clearSession).not.toHaveBeenCalled();
  });

  it('提交失败 401 (onError) → error latch「验证码错误」', async () => {
    h.unbindError = { isAxiosError: true, response: { status: 401 } };
    const { result } = render();
    await act(async () => {
      result.current.form.setValue('code', '123456');
    });
    await act(async () => {
      await result.current.submit();
    });
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorToast).toBe('验证码错误');
  });

  it('requesting_sms 单源: sendPending 时 state=requesting_sms (mutation.isPending 派生)', () => {
    h.sendPending = true;
    expect(render().result.current.state).toBe('requesting_sms');
  });
});
