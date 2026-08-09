// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the two mutation hooks so (a) we drive their mutateAsync and (b) the real
// chains never load (api-client → axios; phone-sms-auth → ./store → expo-secure-
// store → Flow react-native under happy-dom). RHF + zodResolver + zod are
// platform-agnostic (no RN), so they run real. Error paths are T063; this is the
// happy-path core (state machine + countdown + side-effect layering).
const h = vi.hoisted(() => ({
  smsMutateAsync: vi.fn(),
  authMutateAsync: vi.fn(),
}));

vi.mock('@nvy/api-client', () => ({
  useAccountSmsCodeControllerRequest: vi.fn(() => ({
    mutateAsync: h.smsMutateAsync,
    isPending: false,
  })),
}));
vi.mock('./phone-sms-auth', () => ({
  usePhoneSmsAuth: vi.fn(() => ({ mutateAsync: h.authMutateAsync, isPending: false })),
}));

import { loginErrorToast, useLoginForm } from './use-login-form';

const validPhone = '+8613800138000';
const validCode = '123456';

describe('useLoginForm (core)', () => {
  beforeEach(() => {
    h.smsMutateAsync.mockReset().mockResolvedValue({ data: {} });
    h.authMutateAsync
      .mockReset()
      .mockResolvedValue({ data: { accountId: '1', accessToken: 'a', refreshToken: 'r' } });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts idle with no countdown', () => {
    const { result } = renderHook(() => useLoginForm());
    expect(result.current.state).toBe('idle');
    expect(result.current.smsCountdown).toBe(0);
  });

  it('requestSms sends the code (phone only), moves to sms_sent, starts 60s countdown', async () => {
    const { result } = renderHook(() => useLoginForm());
    act(() => result.current.form.setValue('phone', validPhone));
    await act(async () => {
      await result.current.requestSms();
    });
    expect(h.smsMutateAsync).toHaveBeenCalledWith({ data: { phone: validPhone } });
    expect(result.current.state).toBe('sms_sent');
    expect(result.current.smsCountdown).toBe(60);
  });

  it('smsSent latches true only after a successful requestSms (login gated until code requested)', async () => {
    const { result } = renderHook(() => useLoginForm());
    expect(result.current.smsSent).toBe(false);
    act(() => result.current.form.setValue('phone', validPhone));
    await act(async () => {
      await result.current.requestSms();
    });
    expect(result.current.smsSent).toBe(true);
  });

  it('counts the SMS cooldown down each second', async () => {
    const { result } = renderHook(() => useLoginForm());
    act(() => result.current.form.setValue('phone', validPhone));
    await act(async () => {
      await result.current.requestSms();
    });
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current.smsCountdown).toBe(57);
  });

  it('guards requestSms while the countdown is still ticking', async () => {
    const { result } = renderHook(() => useLoginForm());
    act(() => result.current.form.setValue('phone', validPhone));
    await act(async () => {
      await result.current.requestSms();
    });
    await act(async () => {
      await result.current.requestSms();
    });
    expect(h.smsMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('submit authenticates with {phone, code} and moves to success', async () => {
    const { result } = renderHook(() => useLoginForm());
    act(() => {
      result.current.form.setValue('phone', validPhone);
      result.current.form.setValue('code', validCode);
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(h.authMutateAsync).toHaveBeenCalledWith({
      data: { phone: validPhone, code: validCode },
    });
    expect(result.current.state).toBe('success');
  });
});

describe('loginErrorToast (FR-C06 mapping)', () => {
  const ax = (status?: number) => ({
    isAxiosError: true,
    response: status === undefined ? undefined : { status },
  });
  it.each([
    [400, '手机号或验证码错误'],
    [401, '手机号或验证码错误'],
    [429, '请求过于频繁，请稍后再试'],
    [500, '网络异常，请检查网络后重试'],
    [503, '网络异常，请检查网络后重试'],
  ])('maps axios %i', (status, toast) => {
    expect(loginErrorToast(ax(status as number))).toBe(toast);
  });
  it('maps axios error with no response (network) to the network message', () => {
    expect(loginErrorToast(ax())).toBe('网络异常，请检查网络后重试');
  });
  it('maps a non-axios error to the unknown message', () => {
    expect(loginErrorToast(new Error('boom'))).toBe('登录失败，请稍后再试');
  });
});

describe('useLoginForm (errors + anti-enum)', () => {
  beforeEach(() => {
    h.smsMutateAsync.mockReset().mockResolvedValue({ data: {} });
    h.authMutateAsync
      .mockReset()
      .mockResolvedValue({ data: { accountId: '1', accessToken: 'a', refreshToken: 'r' } });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ax = (status: number) => ({ isAxiosError: true, response: { status } });

  it('submit failure → error state, submit scope, mapped toast (401 不区分子码)', async () => {
    h.authMutateAsync.mockReset().mockRejectedValue(ax(401));
    const { result } = renderHook(() => useLoginForm());
    act(() => {
      result.current.form.setValue('phone', validPhone);
      result.current.form.setValue('code', validCode);
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.state).toBe('error');
    expect(result.current.errorToast).toBe('手机号或验证码错误');
    expect(result.current.errorScope).toBe('submit');
  });

  it('requestSms failure → error state, sms scope, mapped toast', async () => {
    h.smsMutateAsync.mockReset().mockRejectedValue(ax(429));
    const { result } = renderHook(() => useLoginForm());
    act(() => result.current.form.setValue('phone', validPhone));
    await act(async () => {
      await result.current.requestSms();
    });
    expect(result.current.state).toBe('error');
    expect(result.current.errorToast).toBe('请求过于频繁，请稍后再试');
    expect(result.current.errorScope).toBe('sms');
    // a failed request must NOT unlock login (smsSent stays false).
    expect(result.current.smsSent).toBe(false);
  });

  it('clearError clears toast/scope and returns to idle', async () => {
    h.authMutateAsync.mockReset().mockRejectedValue(ax(401));
    const { result } = renderHook(() => useLoginForm());
    act(() => {
      result.current.form.setValue('phone', validPhone);
      result.current.form.setValue('code', validCode);
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.state).toBe('error');
    act(() => result.current.clearError());
    expect(result.current.state).toBe('idle');
    expect(result.current.errorToast).toBeNull();
    expect(result.current.errorScope).toBeNull();
  });

  it('registered vs unregistered success are identical — no phone-existed branch (SC-C02)', async () => {
    const submitOnce = async (accountId: string) => {
      h.authMutateAsync
        .mockReset()
        .mockResolvedValue({ data: { accountId, accessToken: 'a', refreshToken: 'r' } });
      const { result } = renderHook(() => useLoginForm());
      act(() => {
        result.current.form.setValue('phone', validPhone);
        result.current.form.setValue('code', validCode);
      });
      await act(async () => {
        await result.current.submit();
      });
      return result.current.state;
    };
    expect(await submitOnce('existing-1')).toBe('success');
    expect(await submitOnce('new-2')).toBe('success');
    expect(h.authMutateAsync).toHaveBeenLastCalledWith({
      data: { phone: validPhone, code: validCode },
    });
  });
});

describe('useLoginForm (FR-C03 FROZEN 拦截)', () => {
  beforeEach(() => {
    h.smsMutateAsync.mockReset().mockResolvedValue({ data: {} });
    h.authMutateAsync
      .mockReset()
      .mockResolvedValue({ data: { accountId: '1', accessToken: 'a', refreshToken: 'r' } });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Full RFC 9457 ProblemDetail body — extractProblemDetail unwraps only when
  // status + title are present (mirrors the real server 403 disclosure).
  const freezeError = {
    isAxiosError: true,
    response: {
      status: 403,
      data: {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        code: 'ACCOUNT_IN_FREEZE_PERIOD',
        freezeUntil: '2026-06-10T00:00:00Z',
      },
    },
  };

  it('submit hitting a FROZEN account → frozen state + freezeUntil (no error toast)', async () => {
    h.authMutateAsync.mockReset().mockRejectedValue(freezeError);
    const { result } = renderHook(() => useLoginForm());
    act(() => {
      result.current.form.setValue('phone', validPhone);
      result.current.form.setValue('code', validCode);
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.state).toBe('frozen');
    expect(result.current.freezeUntil).toBe('2026-06-10T00:00:00Z');
    expect(result.current.errorToast).toBeNull();
  });

  it('dismissFreeze (保持注销) → idle + cleared form', async () => {
    h.authMutateAsync.mockReset().mockRejectedValue(freezeError);
    const { result } = renderHook(() => useLoginForm());
    act(() => {
      result.current.form.setValue('phone', validPhone);
      result.current.form.setValue('code', validCode);
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.state).toBe('frozen');
    act(() => result.current.dismissFreeze());
    expect(result.current.state).toBe('idle');
    expect(result.current.freezeUntil).toBeNull();
    expect(result.current.form.getValues()).toEqual({ phone: '', code: '' });
  });
});
