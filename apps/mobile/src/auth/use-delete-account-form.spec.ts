// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock both deletion mutation wrappers: drive their mutateAsync + isPending,
// and keep the real ./delete-account chain (api-client → axios; store → expo-
// secure-store → RN under happy-dom) from loading. RHF + zodResolver + zod run
// real against the real schema.
const h = vi.hoisted(() => ({
  smsMutateAsync: vi.fn(),
  deleteMutateAsync: vi.fn(),
}));

vi.mock('./delete-account', () => ({
  useRequestDeletionCode: vi.fn(() => ({ mutateAsync: h.smsMutateAsync, isPending: false })),
  useDeleteAccount: vi.fn(() => ({ mutateAsync: h.deleteMutateAsync, isPending: false })),
}));

import { useDeleteAccountForm } from './use-delete-account-form';

const validCode = '123456';

describe('useDeleteAccountForm (core)', () => {
  beforeEach(() => {
    h.smsMutateAsync.mockReset().mockResolvedValue(undefined);
    h.deleteMutateAsync.mockReset().mockResolvedValue(undefined);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts idle, unchecked, send-code disabled', () => {
    const { result } = renderHook(() => useDeleteAccountForm());
    expect(result.current.state).toBe('idle');
    expect(result.current.bothChecked).toBe(false);
    expect(result.current.canSendCode).toBe(false);
    expect(result.current.smsCountdown).toBe(0);
  });

  it('canSendCode stays false until BOTH confirmations are checked', () => {
    const { result } = renderHook(() => useDeleteAccountForm());
    act(() => result.current.toggleConfirm1());
    expect(result.current.bothChecked).toBe(false);
    expect(result.current.canSendCode).toBe(false);
    act(() => result.current.toggleConfirm2());
    expect(result.current.bothChecked).toBe(true);
    expect(result.current.canSendCode).toBe(true);
  });

  it('requestSms is a no-op while not both-checked (gated)', async () => {
    const { result } = renderHook(() => useDeleteAccountForm());
    await act(async () => {
      await result.current.requestSms();
    });
    expect(h.smsMutateAsync).not.toHaveBeenCalled();
  });

  it('requestSms (both-checked) sends the code, moves to sms_sent, starts 60s countdown', async () => {
    const { result } = renderHook(() => useDeleteAccountForm());
    act(() => {
      result.current.toggleConfirm1();
      result.current.toggleConfirm2();
    });
    await act(async () => {
      await result.current.requestSms();
    });
    expect(h.smsMutateAsync).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('sms_sent');
    expect(result.current.hasSentCode).toBe(true);
    expect(result.current.smsCountdown).toBe(60);
  });

  it('guards requestSms while the countdown is still ticking', async () => {
    const { result } = renderHook(() => useDeleteAccountForm());
    act(() => {
      result.current.toggleConfirm1();
      result.current.toggleConfirm2();
    });
    await act(async () => {
      await result.current.requestSms();
    });
    await act(async () => {
      await result.current.requestSms();
    });
    expect(h.smsMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('submit deletes with {data:{code}} and moves to success', async () => {
    const { result } = renderHook(() => useDeleteAccountForm());
    act(() => result.current.form.setValue('code', validCode));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.deleteMutateAsync).toHaveBeenCalledWith({ data: { code: validCode } });
    expect(result.current.state).toBe('success');
  });
});

describe('useDeleteAccountForm (errors, FR-C02)', () => {
  beforeEach(() => {
    h.smsMutateAsync.mockReset().mockResolvedValue(undefined);
    h.deleteMutateAsync.mockReset().mockResolvedValue(undefined);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ax = (status: number) => ({ isAxiosError: true, response: { status } });

  it('submit failure (401) → error state + mapped toast', async () => {
    h.deleteMutateAsync.mockReset().mockRejectedValue(ax(401));
    const { result } = renderHook(() => useDeleteAccountForm());
    act(() => result.current.form.setValue('code', validCode));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.state).toBe('error');
    expect(result.current.errorToast).toBe('验证码错误');
  });

  it('requestSms failure (429) → error state + mapped toast', async () => {
    h.smsMutateAsync.mockReset().mockRejectedValue(ax(429));
    const { result } = renderHook(() => useDeleteAccountForm());
    act(() => {
      result.current.toggleConfirm1();
      result.current.toggleConfirm2();
    });
    await act(async () => {
      await result.current.requestSms();
    });
    expect(result.current.state).toBe('error');
    expect(result.current.errorToast).toBe('操作太频繁，请稍后再试');
  });

  it('clearError clears the toast and leaves the error state', async () => {
    h.deleteMutateAsync.mockReset().mockRejectedValue(ax(401));
    const { result } = renderHook(() => useDeleteAccountForm());
    act(() => result.current.form.setValue('code', validCode));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.state).toBe('error');
    act(() => result.current.clearError());
    expect(result.current.errorToast).toBeNull();
    expect(result.current.state).not.toBe('error');
  });
});
