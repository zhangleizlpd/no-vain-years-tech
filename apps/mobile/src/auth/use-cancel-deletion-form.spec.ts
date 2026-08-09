// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the two mutation hooks: (a) drive their mutateAsync, (b) keep the real
// chains from loading (api-client → axios; cancel-deletion → ./store → expo-
// secure-store → RN under happy-dom). RHF + zodResolver + zod run real.
const h = vi.hoisted(() => ({
  smsMutateAsync: vi.fn(),
  cancelMutateAsync: vi.fn(),
}));

vi.mock('@nvy/api-client', () => ({
  useCancelDeletionControllerSendCancelCode: vi.fn(() => ({
    mutateAsync: h.smsMutateAsync,
    isPending: false,
  })),
}));
vi.mock('./cancel-deletion', () => ({
  useCancelDeletion: vi.fn(() => ({ mutateAsync: h.cancelMutateAsync, isPending: false })),
}));

import { useCancelDeletionForm } from './use-cancel-deletion-form';

const validPhone = '+8613800138000';
const validCode = '123456';

describe('useCancelDeletionForm (core)', () => {
  beforeEach(() => {
    h.smsMutateAsync.mockReset().mockResolvedValue({ data: {} });
    h.cancelMutateAsync
      .mockReset()
      .mockResolvedValue({ data: { accountId: '1', accessToken: 'a', refreshToken: 'r' } });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts idle with no countdown', () => {
    const { result } = renderHook(() => useCancelDeletionForm());
    expect(result.current.state).toBe('idle');
    expect(result.current.smsCountdown).toBe(0);
  });

  it('prefills phone from the route param (FROZEN modal hand-off)', () => {
    const { result } = renderHook(() => useCancelDeletionForm(validPhone));
    expect(result.current.form.getValues('phone')).toBe(validPhone);
  });

  it('falls back to empty phone when no route param (deep-link, hand-fill)', () => {
    const { result } = renderHook(() => useCancelDeletionForm());
    expect(result.current.form.getValues('phone')).toBe('');
  });

  it('requestSms sends the cancel code (phone only), moves to sms_sent, starts 60s countdown', async () => {
    const { result } = renderHook(() => useCancelDeletionForm(validPhone));
    await act(async () => {
      await result.current.requestSms();
    });
    expect(h.smsMutateAsync).toHaveBeenCalledWith({ data: { phone: validPhone } });
    expect(result.current.state).toBe('sms_sent');
    expect(result.current.smsCountdown).toBe(60);
  });

  it('guards requestSms while the countdown is still ticking', async () => {
    const { result } = renderHook(() => useCancelDeletionForm(validPhone));
    await act(async () => {
      await result.current.requestSms();
    });
    await act(async () => {
      await result.current.requestSms();
    });
    expect(h.smsMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('submit cancels with {phone, code} and moves to success', async () => {
    const { result } = renderHook(() => useCancelDeletionForm(validPhone));
    act(() => result.current.form.setValue('code', validCode));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.cancelMutateAsync).toHaveBeenCalledWith({
      data: { phone: validPhone, code: validCode },
    });
    expect(result.current.state).toBe('success');
  });
});

describe('useCancelDeletionForm (errors + anti-enum, FR-C05)', () => {
  beforeEach(() => {
    h.smsMutateAsync.mockReset().mockResolvedValue({ data: {} });
    h.cancelMutateAsync
      .mockReset()
      .mockResolvedValue({ data: { accountId: '1', accessToken: 'a', refreshToken: 'r' } });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ax = (status: number) => ({ isAxiosError: true, response: { status } });

  it('submit failure → error state, submit scope, unified toast (401 不区分子码)', async () => {
    h.cancelMutateAsync.mockReset().mockRejectedValue(ax(401));
    const { result } = renderHook(() => useCancelDeletionForm(validPhone));
    act(() => result.current.form.setValue('code', validCode));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.state).toBe('error');
    expect(result.current.errorToast).toBe('手机号或验证码错误');
    expect(result.current.errorScope).toBe('submit');
  });

  it('requestSms failure → error state, sms scope, mapped toast', async () => {
    h.smsMutateAsync.mockReset().mockRejectedValue(ax(429));
    const { result } = renderHook(() => useCancelDeletionForm(validPhone));
    await act(async () => {
      await result.current.requestSms();
    });
    expect(result.current.state).toBe('error');
    expect(result.current.errorToast).toBe('请求过于频繁，请稍后再试');
    expect(result.current.errorScope).toBe('sms');
  });

  it('clearError clears toast/scope and returns to idle', async () => {
    h.cancelMutateAsync.mockReset().mockRejectedValue(ax(401));
    const { result } = renderHook(() => useCancelDeletionForm(validPhone));
    act(() => result.current.form.setValue('code', validCode));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.state).toBe('error');
    act(() => result.current.clearError());
    expect(result.current.state).toBe('idle');
    expect(result.current.errorToast).toBeNull();
    expect(result.current.errorScope).toBeNull();
  });
});
