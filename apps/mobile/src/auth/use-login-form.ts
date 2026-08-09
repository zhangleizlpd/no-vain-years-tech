// GOLDEN SAMPLE — mobile RHF 4 铁律逻辑权威。新表单 hook 起手对照此文件的 4 铁律
// （见就地「铁律 1/2/3」注释）：① <Controller> ≠ register；② 表单态 ≠ 副作用态分层；
// ③ isSubmitting 单源；④ 错误 + a11y 一体。⚠ frozen 拦截态 + SMS 倒计时是 login 专属，
// 标准编辑表单（如 ~/settings/use-name-edit-form.ts）勿照抄此态机复杂度。
// 分层声明见 docs/conventions/mobile-impl-playbook.md § 1。
import { useAccountSmsCodeControllerRequest } from '@nvy/api-client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { phoneSmsAuthSchema, type PhoneSmsAuthValues } from './login-form.schema';
import { usePhoneSmsAuth } from './phone-sms-auth';
import { extractProblemDetail, isFreezePeriod } from '~/core/api/errors';

// FR-C11 state machine. requesting_sms / submitting are *derived* from pending
// flags (not setState'd) so loading has a single source (铁律 3); idle / sms_sent
// / success / error are persistent latches. error is wired in T063.
export type LoginFormState =
  | 'idle'
  | 'requesting_sms'
  | 'sms_sent'
  | 'submitting'
  | 'success'
  | 'error'
  // FR-C03 — login 撞 FROZEN 账号（403 ACCOUNT_IN_FREEZE_PERIOD）→ 弹拦截 modal。
  | 'frozen';

const SMS_COUNTDOWN_SECONDS = 60;

const TOAST = {
  invalid: '手机号或验证码错误',
  rateLimit: '请求过于频繁，请稍后再试',
  network: '网络异常，请检查网络后重试',
  unknown: '登录失败，请稍后再试',
} as const;

// FR-C06 错误映射。AxiosError 判别走 duck-type（`isAxiosError` flag），避免给 apps/mobile
// 加 axios 直接依赖（axios 是 @nvy/api-client 的依赖）。401/400 → 凭证错（不区分 401 子码，
// 反枚举一致）；429 → 限流；无 response（网络/超时）或 5xx → 网络；其余 → 未知。
export function loginErrorToast(error: unknown): string {
  const e = error as { isAxiosError?: boolean; response?: { status?: number } };
  if (e?.isAxiosError) {
    const status = e.response?.status;
    if (status === undefined) return TOAST.network;
    if (status === 401 || status === 400) return TOAST.invalid;
    if (status === 429) return TOAST.rateLimit;
    if (status >= 500) return TOAST.network;
    return TOAST.unknown;
  }
  return TOAST.unknown;
}

export type ErrorScope = 'sms' | 'submit' | null;

export function useLoginForm() {
  const form = useForm<PhoneSmsAuthValues>({
    resolver: zodResolver(phoneSmsAuthSchema),
    mode: 'onChange',
    defaultValues: { phone: '', code: '' },
  });

  // 铁律 2 — side-effect state lives OUTSIDE RHF: the SMS-code request mutation
  // + the 60s cooldown timer are not part of the form submit lifecycle.
  const smsRequest = useAccountSmsCodeControllerRequest();
  const auth = usePhoneSmsAuth();

  const [phase, setPhase] = useState<'idle' | 'sms_sent' | 'success' | 'error' | 'frozen'>('idle');
  // 铁律 2 latch — login submit is gated on a code having actually been requested
  // (a valid 6-digit code can only exist after /sms-codes). Stays true across
  // submit errors so the user can retry; cleared only on dismissFreeze (form reset).
  const [smsSent, setSmsSent] = useState(false);
  const [smsCountdown, setSmsCountdown] = useState(0);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [errorScope, setErrorScope] = useState<ErrorScope>(null);
  const [freezeUntil, setFreezeUntil] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
    },
    [],
  );

  const startCountdown = useCallback(() => {
    setSmsCountdown(SMS_COUNTDOWN_SECONDS);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setSmsCountdown((prev) => {
        if (prev <= 1) {
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const requestSms = useCallback(async () => {
    if (smsCountdown > 0) return; // button is disabled while ticking; guards races
    setErrorToast(null);
    setErrorScope(null);
    try {
      const phone = form.getValues('phone');
      await smsRequest.mutateAsync({ data: { phone } });
      startCountdown();
      setSmsSent(true);
      setPhase('sms_sent');
    } catch (e) {
      setErrorToast(loginErrorToast(e));
      setErrorScope('sms');
      setPhase('error');
    }
  }, [smsCountdown, form, smsRequest, startCountdown]);

  // 铁律 1 — caller wraps inputs in <Controller>; submit goes through handleSubmit
  // so formState.isSubmitting is the single loading source (铁律 3).
  const submit = form.handleSubmit(async (values) => {
    setErrorToast(null);
    setErrorScope(null);
    try {
      await auth.mutateAsync({ data: { phone: values.phone, code: values.code } });
      setPhase('success');
    } catch (e) {
      // FR-C03 — FROZEN disclosure (403) 不进通用错误通道，弹拦截 modal。
      // 识别走 canonical ProblemDetail 层（~/core/api/errors，单一真理源）。
      const freeze = extractProblemDetail(e);
      if (isFreezePeriod(freeze)) {
        setFreezeUntil(freeze.freezeUntil);
        setPhase('frozen');
        return;
      }
      setErrorToast(loginErrorToast(e));
      setErrorScope('submit');
      setPhase('error');
    }
  });

  // error → idle on explicit clear / any input change (FR-C12 / FR-C15).
  const clearError = useCallback(() => {
    setErrorToast(null);
    setErrorScope(null);
    setPhase((prev) => (prev === 'error' ? 'idle' : prev));
  }, []);

  // FR-C03 「保持注销」分支 — 清 form + 关 modal 留在登录页。
  const dismissFreeze = useCallback(() => {
    form.reset({ phone: '', code: '' });
    setFreezeUntil(null);
    setSmsSent(false);
    setPhase('idle');
  }, [form]);

  const { isSubmitting } = form.formState;
  const state: LoginFormState = isSubmitting
    ? 'submitting'
    : smsRequest.isPending
      ? 'requesting_sms'
      : phase;

  return {
    form,
    state,
    smsSent,
    smsCountdown,
    errorToast,
    errorScope,
    freezeUntil,
    requestSms,
    submit,
    clearError,
    dismissFreeze,
    isSubmitting,
  };
}
