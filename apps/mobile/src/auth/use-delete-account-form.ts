import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';

import { useDeleteAccount, useRequestDeletionCode } from './delete-account';
import {
  deleteAccountFormSchema,
  type DeleteAccountFormValues,
} from './delete-account-form.schema';
import { deleteAccountErrorToast } from './deletion-errors';

// Account-deletion form (FR-C01/C02). RHF mirrors useCancelDeletionForm:
// requesting_sms / submitting are *derived* from pending flags (loading single
// source 铁律 3); idle / sms_sent / success / error are persistent latches.
// Side-effect state (the two confirmation checkboxes + countdown) lives OUTSIDE
// RHF (铁律 2); only the 6-digit code is a form field.
export type DeleteAccountFormState =
  | 'idle'
  | 'requesting_sms'
  | 'sms_sent'
  | 'submitting'
  | 'success'
  | 'error';

const SMS_COUNTDOWN_SECONDS = 60;

export function useDeleteAccountForm() {
  const form = useForm<DeleteAccountFormValues>({
    resolver: zodResolver(deleteAccountFormSchema),
    mode: 'onChange',
    defaultValues: { code: '' },
  });

  const smsRequest = useRequestDeletionCode();
  const deletion = useDeleteAccount();

  const [phase, setPhase] = useState<'idle' | 'sms_sent' | 'success' | 'error'>('idle');
  const [confirm1, setConfirm1] = useState(false);
  const [confirm2, setConfirm2] = useState(false);
  const [smsCountdown, setSmsCountdown] = useState(0);
  const [hasSentCode, setHasSentCode] = useState(false);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
    },
    [],
  );

  const bothChecked = confirm1 && confirm2;

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

  // Gated on 双确认 + cooldown (FR-C01). EP1 takes no body — the server derives
  // the account from the bearer token. On failure the toast maps but the
  // checkboxes stay checked so the user can retry.
  const requestSms = useCallback(async () => {
    if (!bothChecked || smsCountdown > 0) return; // button disabled in these states; guards races
    setErrorToast(null);
    try {
      await smsRequest.mutateAsync();
      setHasSentCode(true);
      startCountdown();
      setPhase('sms_sent');
    } catch (e) {
      setErrorToast(deleteAccountErrorToast(e));
      setPhase('error');
    }
  }, [bothChecked, smsCountdown, smsRequest, startCountdown]);

  // 铁律 1 — caller wraps the code input in <Controller>; submit goes through
  // handleSubmit so formState.isSubmitting is the single loading source (铁律 3).
  // On success the wrapper已 clearSession → AuthGate redirects; the screen also
  // router.replace's into /(auth)/login.
  const submit = form.handleSubmit(async ({ code }) => {
    setErrorToast(null);
    try {
      await deletion.mutateAsync({ data: { code } });
      setPhase('success');
    } catch (e) {
      setErrorToast(deleteAccountErrorToast(e));
      setPhase('error');
    }
  });

  // error → back to sms_sent (code已发, input stays live) or idle; clears toast.
  const clearError = useCallback(() => {
    setErrorToast(null);
    setPhase((prev) => (prev === 'error' ? (hasSentCode ? 'sms_sent' : 'idle') : prev));
  }, [hasSentCode]);

  const toggleConfirm1 = useCallback(() => setConfirm1((v) => !v), []);
  const toggleConfirm2 = useCallback(() => setConfirm2((v) => !v), []);

  const { isSubmitting } = form.formState;
  const state: DeleteAccountFormState = isSubmitting
    ? 'submitting'
    : smsRequest.isPending
      ? 'requesting_sms'
      : phase;

  const canSendCode =
    bothChecked && smsCountdown === 0 && state !== 'requesting_sms' && state !== 'submitting';

  return {
    form,
    state,
    confirm1,
    confirm2,
    toggleConfirm1,
    toggleConfirm2,
    bothChecked,
    canSendCode,
    hasSentCode,
    smsCountdown,
    errorToast,
    requestSms,
    submit,
    clearError,
    isSubmitting,
  };
}
