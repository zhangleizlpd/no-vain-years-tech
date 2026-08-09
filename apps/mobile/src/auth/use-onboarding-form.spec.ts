// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the wrapper so we drive its mutateAsync and the real chain (api-client →
// axios; update-display-name → ./store → expo-secure-store → Flow react-native
// under happy-dom) never loads. RHF + zodResolver + zod are platform-agnostic.
const h = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('./update-display-name', () => ({
  useUpdateDisplayName: vi.fn(() => ({ mutateAsync: h.mutateAsync, isPending: false })),
}));

import { onboardingErrorToast, useOnboardingForm } from './use-onboarding-form';

describe('useOnboardingForm (core)', () => {
  beforeEach(() => {
    h.mutateAsync.mockReset().mockResolvedValue({
      data: { accountId: '1', phone: '+8613800138000', displayName: '小明', status: 'ACTIVE' },
    });
  });

  it('starts idle', () => {
    const { result } = renderHook(() => useOnboardingForm());
    expect(result.current.state).toBe('idle');
  });

  it('submit updates displayName and moves to success', async () => {
    const { result } = renderHook(() => useOnboardingForm());
    act(() => result.current.form.setValue('displayName', '小明', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.mutateAsync).toHaveBeenCalledWith({ data: { displayName: '小明' } });
    expect(result.current.state).toBe('success');
  });

  it('trims the submitted value (resolver normalizes per FR-031)', async () => {
    const { result } = renderHook(() => useOnboardingForm());
    act(() => result.current.form.setValue('displayName', '  小明  ', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.mutateAsync).toHaveBeenCalledWith({ data: { displayName: '小明' } });
  });

  it('does not call the mutation when the displayName is invalid (empty)', async () => {
    const { result } = renderHook(() => useOnboardingForm());
    act(() => result.current.form.setValue('displayName', '', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    expect(h.mutateAsync).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
  });
});

describe('onboardingErrorToast (FR-034 mapping)', () => {
  const ax = (status?: number) => ({
    isAxiosError: true,
    response: status === undefined ? undefined : { status },
  });
  it.each([
    [400, '昵称不合法，请重试'],
    [429, '请求过于频繁，请稍后再试'],
    [500, '网络异常，请重试'],
    [503, '网络异常，请重试'],
    [401, '提交失败，请稍后重试'],
  ])('maps axios %i', (status, toast) => {
    expect(onboardingErrorToast(ax(status as number))).toBe(toast);
  });
  it('maps axios error with no response (network) to the network message', () => {
    expect(onboardingErrorToast(ax())).toBe('网络异常，请重试');
  });
  it('maps a non-axios error to the unknown message', () => {
    expect(onboardingErrorToast(new Error('boom'))).toBe('提交失败，请稍后重试');
  });
});

describe('useOnboardingForm (errors)', () => {
  const ax = (status: number) => ({ isAxiosError: true, response: { status } });

  beforeEach(() => {
    h.mutateAsync.mockReset();
  });

  it('submit failure (400) → error state + invalid toast', async () => {
    h.mutateAsync.mockRejectedValue(ax(400));
    const { result } = renderHook(() => useOnboardingForm());
    act(() => result.current.form.setValue('displayName', '小明', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.state).toBe('error');
    expect(result.current.errorToast).toBe('昵称不合法，请重试');
  });

  it('submit failure (429) → rate-limit toast', async () => {
    h.mutateAsync.mockRejectedValue(ax(429));
    const { result } = renderHook(() => useOnboardingForm());
    act(() => result.current.form.setValue('displayName', '小明', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.errorToast).toBe('请求过于频繁，请稍后再试');
  });

  it('clearError clears the toast and returns to idle', async () => {
    h.mutateAsync.mockRejectedValue(ax(400));
    const { result } = renderHook(() => useOnboardingForm());
    act(() => result.current.form.setValue('displayName', '小明', { shouldValidate: true }));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.state).toBe('error');
    act(() => result.current.clearError());
    expect(result.current.state).toBe('idle');
    expect(result.current.errorToast).toBeNull();
  });
});
