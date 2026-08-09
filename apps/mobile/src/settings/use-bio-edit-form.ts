import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { useAccountProfileControllerUpdateBio } from '@nvy/api-client';
import { useAuthStore } from '~/auth';
import { meQueryKey } from '~/core/api/me-query-key';
import { bioEditFormSchema, type BioEditFormValues } from './bio-edit-form.schema';

// bio 编辑 RHF 状态机（镜像 useOnboardingForm，Golden Sample = login）。submitting 由
// formState.isSubmitting 派生（不另设 loading bool，铁律 3）；idle / success / error 为
// persistent latch。success 由页面（非本 hook）驱动 router.back()（hook 不导航）。
export type BioEditFormState = 'idle' | 'submitting' | 'success' | 'error';

const TOAST = {
  invalid: '简介不合法，请重试',
  rateLimit: '请求过于频繁，请稍后再试',
  network: '网络异常，请重试',
  unknown: '保存失败，请稍后重试',
} as const;

// 错误映射，镜像 onboardingErrorToast：400 INVALID_BIO → 简介不合法；429 → 限流；
// 无 response（网络/超时）或 5xx → 网络；其余（含 401，api-client 拦截器透明 refresh，
// 落到这里属边缘）→ 未知。AxiosError 走 duck-type（`isAxiosError` flag）判别。
export function bioEditErrorToast(error: unknown): string {
  const e = error as { isAxiosError?: boolean; response?: { status?: number } };
  if (e?.isAxiosError) {
    const status = e.response?.status;
    if (status === undefined) return TOAST.network;
    if (status === 400) return TOAST.invalid;
    if (status === 429) return TOAST.rateLimit;
    if (status >= 500) return TOAST.network;
    return TOAST.unknown;
  }
  return TOAST.unknown;
}

export function useBioEditForm(initialBio: string) {
  const form = useForm<BioEditFormValues>({
    resolver: zodResolver(bioEditFormSchema),
    mode: 'onChange',
    defaultValues: { bio: initialBio },
  });

  // 铁律 2 — side-effect state lives OUTSIDE RHF：PATCH mutation + error latch 不属
  // 表单 submit 生命周期。
  const update = useAccountProfileControllerUpdateBio();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // 铁律 1 — caller 用 <Controller> 包 TextInput；submit 走 handleSubmit 使
  // formState.isSubmitting 成为唯一 loading 源（铁律 3）。resolver 已 trim，故
  // values.bio 是规范化值（空串 = 清空）。成功 → invalidate /me（plan D7）→ 页面 back。
  const submit = form.handleSubmit(async (values) => {
    setErrorToast(null);
    try {
      await update.mutateAsync({ data: { bio: values.bio } });
      await queryClient.invalidateQueries({
        queryKey: meQueryKey(useAuthStore.getState().accountId),
      });
      setPhase('success');
    } catch (e) {
      setErrorToast(bioEditErrorToast(e));
      setPhase('error');
    }
  });

  // error → idle on explicit clear / any input change。
  const clearError = useCallback(() => {
    setErrorToast(null);
    setPhase((prev) => (prev === 'error' ? 'idle' : prev));
  }, []);

  const { isSubmitting } = form.formState;
  const state: BioEditFormState = isSubmitting ? 'submitting' : phase;

  return { form, state, errorToast, submit, clearError };
}
