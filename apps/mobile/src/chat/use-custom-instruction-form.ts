import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import {
  getChatPreferenceControllerGetQueryKey,
  useChatPreferenceControllerUpsert,
} from '@nvy/api-client';
import {
  customInstructionFormSchema,
  type CustomInstructionFormValues,
} from './custom-instruction-form.schema';

// 自定义指令编辑 RHF 状态机，镜像 settings/use-bio-edit-form.ts（标准编辑表单 golden）。
// submitting 由 formState.isSubmitting 派生（不另设 loading bool，铁律 3）；idle / success /
// error 为 persistent latch。success 由页面（非本 hook）驱动 router.back()（hook 不导航）。
export type CustomInstructionFormState = 'idle' | 'submitting' | 'success' | 'error';

const TOAST = {
  invalid: '自定义指令不合法，请重试',
  rateLimit: '请求过于频繁，请稍后再试',
  network: '网络异常，请重试',
  unknown: '保存失败，请稍后重试',
} as const;

// 错误映射，镜像 bioEditErrorToast：400（超长 / 不合法）→ 不合法；429 → 限流；
// 无 response（网络/超时）或 5xx → 网络；其余（含 401，api-client 拦截器透明 refresh，
// 落到这里属边缘）→ 未知。AxiosError 走 duck-type（`isAxiosError` flag）判别。
export function customInstructionErrorToast(error: unknown): string {
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

export function useCustomInstructionForm(initialInstruction: string) {
  const form = useForm<CustomInstructionFormValues>({
    resolver: zodResolver(customInstructionFormSchema),
    mode: 'onChange',
    defaultValues: { customInstruction: initialInstruction },
  });

  // 铁律 2 — side-effect state lives OUTSIDE RHF：PUT mutation + error latch 不属
  // 表单 submit 生命周期。
  const upsert = useChatPreferenceControllerUpsert();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // 铁律 1 — caller 用 <Controller> 包 TextInput；submit 走 handleSubmit 使
  // formState.isSubmitting 成为唯一 loading 源（铁律 3）。空串合法（清空，D9）。
  // 成功 → invalidate GET /chat/preferences（下次进屏 hydrate 最新值）→ 页面 back。
  const submit = form.handleSubmit(async (values) => {
    setErrorToast(null);
    try {
      await upsert.mutateAsync({ data: { customInstruction: values.customInstruction } });
      await queryClient.invalidateQueries({
        queryKey: getChatPreferenceControllerGetQueryKey(),
      });
      setPhase('success');
    } catch (e) {
      setErrorToast(customInstructionErrorToast(e));
      setPhase('error');
    }
  });

  // error → idle on explicit clear / any input change。
  const clearError = useCallback(() => {
    setErrorToast(null);
    setPhase((prev) => (prev === 'error' ? 'idle' : prev));
  }, []);

  const { isSubmitting } = form.formState;
  const state: CustomInstructionFormState = isSubmitting ? 'submitting' : phase;

  return { form, state, errorToast, submit, clearError };
}
