import { useCancelDeletionControllerSendCancelCode } from '@nvy/api-client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { phoneSmsAuthSchema, type PhoneSmsAuthValues } from './login-form.schema';
import { useCancelDeletion } from './cancel-deletion';
import { cancelDeletionErrorToast } from './cancel-deletion-errors';

// Cancel-deletion form (FR-C04). Same {phone, code} shape + validation as login
// (CancelDeletionRequest 与 PhoneSmsAuthRequest 正则字节一致 → 复用 phoneSmsAuthSchema).
// State machine mirrors useLoginForm: requesting_sms / submitting are *derived*
// from pending flags (loading single source 铁律 3); idle / sms_sent / success /
// error are persistent latches. Side-effect state (mutations + countdown) lives
// OUTSIDE RHF (铁律 2).
export type CancelDeletionFormState =
  | 'idle'
  | 'requesting_sms'
  | 'sms_sent'
  | 'submitting'
  | 'success'
  | 'error';

export type CancelErrorScope = 'sms' | 'submit' | null;

const SMS_COUNTDOWN_SECONDS = 60;

// initialPhone 来自路由参数（FROZEN modal 跳转预填）；深链缺失时为空、可手填（spec edge）。
export function useCancelDeletionForm(initialPhone?: string) {
  const form = useForm<PhoneSmsAuthValues>({
    resolver: zodResolver(phoneSmsAuthSchema),
    mode: 'onChange',
    defaultValues: { phone: initialPhone ?? '', code: '' },
  });

  const smsRequest = useCancelDeletionControllerSendCancelCode();
  const cancel = useCancelDeletion();

  const [phase, setPhase] = useState<'idle' | 'sms_sent' | 'success' | 'error'>('idle');
  const [smsCountdown, setSmsCountdown] = useState(0);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [errorScope, setErrorScope] = useState<CancelErrorScope>(null);
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
    if (smsCountdown > 0) return; // button disabled while ticking; guards races
    setErrorToast(null);
    setErrorScope(null);
    try {
      const phone = form.getValues('phone');
      await smsRequest.mutateAsync({ data: { phone } });
      startCountdown();
      setPhase('sms_sent');
    } catch (e) {
      setErrorToast(cancelDeletionErrorToast(e));
      setErrorScope('sms');
      setPhase('error');
    }
  }, [smsCountdown, form, smsRequest, startCountdown]);

  // 铁律 1 — caller wraps inputs in <Controller>; submit goes through handleSubmit
  // so formState.isSubmitting is the single loading source (铁律 3). On success the
  // wrapper已 setSession（不在此 navigate）→ AuthGate redirect。
  const submit = form.handleSubmit(async (values) => {
    setErrorToast(null);
    setErrorScope(null);
    try {
      await cancel.mutateAsync({ data: { phone: values.phone, code: values.code } });
      setPhase('success');
    } catch (e) {
      setErrorToast(cancelDeletionErrorToast(e));
      setErrorScope('submit');
      setPhase('error');
    }
  });

  // error → idle on explicit clear / any input change (FR-C05 统一提示清除).
  const clearError = useCallback(() => {
    setErrorToast(null);
    setErrorScope(null);
    setPhase((prev) => (prev === 'error' ? 'idle' : prev));
  }, []);

  const { isSubmitting } = form.formState;
  const state: CancelDeletionFormState = isSubmitting
    ? 'submitting'
    : smsRequest.isPending
      ? 'requesting_sms'
      : phase;

  return {
    form,
    state,
    smsCountdown,
    errorToast,
    errorScope,
    requestSms,
    submit,
    clearError,
    isSubmitting,
  };
}
