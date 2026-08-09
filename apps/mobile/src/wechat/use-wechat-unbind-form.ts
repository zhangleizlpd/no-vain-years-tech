import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import {
  useWechatBindingControllerSendUnbindCodeForMe,
  useWechatBindingControllerUnbindWechatForMe,
} from '@nvy/api-client';

import { useAuthStore } from '~/auth';
import { meQueryKey } from '~/core/api/me-query-key';
import { wechatUnbindFormSchema, type WechatUnbindFormValues } from './wechat-unbind-form.schema';
import { wechatUnbindErrorToast } from './wechat-errors';

// 微信解绑表单 (010 FR-C, RHF 镜像 useDeleteAccountForm 但**去双勾选**(解绑可逆) +
// **去 success-clearSession**(解绑保留 session, 仅刷新 /me))。仅 6 位码进 RHF (铁律 2)。
//
// 状态迁移走 React Query **声明式 onSuccess/onError**(非 post-await imperative
// setState) —— 后者在 expo-web/Playwright 下与 setInterval 倒计时同批时偶发不刷新
// (实测: 加日志即过、去日志即挂)。onSuccess 在 RQ flush 周期内可靠触发。loading 单源
// = mutation.isPending(铁律 3, 不另设 bool)。
export type WechatUnbindFormState =
  | 'idle'
  | 'requesting_sms'
  | 'sms_sent'
  | 'submitting'
  | 'success'
  | 'error';

const SMS_COUNTDOWN_SECONDS = 60;

export function useWechatUnbindForm() {
  const form = useForm<WechatUnbindFormValues>({
    resolver: zodResolver(wechatUnbindFormSchema),
    mode: 'onChange',
    defaultValues: { code: '' },
  });
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<'idle' | 'sms_sent' | 'success' | 'error'>('idle');
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

  // 发码 (EP2, 无 body, server 由 bearer 取账号)。
  const smsRequest = useWechatBindingControllerSendUnbindCodeForMe({
    mutation: {
      onSuccess: () => {
        setHasSentCode(true);
        startCountdown();
        setPhase('sms_sent');
      },
      onError: (e) => {
        setErrorToast(wechatUnbindErrorToast(e));
        setPhase('error');
      },
    },
  });

  // 验码解绑 (EP3)。成功**不** clearSession (解绑保留登录态) —— 仅 invalidate /me
  // (wechatBound 刷新); 屏驱动 router.back()。
  const unbind = useWechatBindingControllerUnbindWechatForMe({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: meQueryKey(useAuthStore.getState().accountId),
        });
        setPhase('success');
      },
      onError: (e) => {
        setErrorToast(wechatUnbindErrorToast(e));
        setPhase('error');
      },
    },
  });

  // 仅 cooldown 门槛 (无双勾选)。fire-and-forget: onSuccess/onError 驱动状态迁移。
  const requestSms = useCallback(() => {
    if (smsCountdown > 0 || smsRequest.isPending) return;
    setErrorToast(null);
    smsRequest.mutate();
  }, [smsCountdown, smsRequest]);

  // 铁律 1 — caller 用 <Controller> 包 code input; handleSubmit 校验后 fire mutate。
  const submit = form.handleSubmit(({ code }) => {
    setErrorToast(null);
    unbind.mutate({ data: { code } });
  });

  // error → 回 sms_sent (码已发, input 留活) 或 idle; 清 toast。
  const clearError = useCallback(() => {
    setErrorToast(null);
    setPhase((prev) => (prev === 'error' ? (hasSentCode ? 'sms_sent' : 'idle') : prev));
  }, [hasSentCode]);

  const state: WechatUnbindFormState = unbind.isPending
    ? 'submitting'
    : smsRequest.isPending
      ? 'requesting_sms'
      : phase;

  const canSendCode = smsCountdown === 0 && state !== 'requesting_sms' && state !== 'submitting';
  const isSubmitting = state === 'submitting';

  return {
    form,
    state,
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
