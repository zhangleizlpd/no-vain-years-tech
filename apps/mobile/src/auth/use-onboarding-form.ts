import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';
import { onboardingFormSchema, type OnboardingFormValues } from './onboarding-form.schema';
import { useUpdateDisplayName } from './update-display-name';

// FR-033 state machine. submitting is *derived* from formState.isSubmitting (not
// setState'd) so loading has a single source (铁律 3); idle / success / error are
// persistent latches. Mirrors useLoginForm.
export type OnboardingFormState = 'idle' | 'submitting' | 'success' | 'error';

const TOAST = {
  invalid: '昵称不合法，请重试',
  rateLimit: '请求过于频繁，请稍后再试',
  network: '网络异常，请重试',
  unknown: '提交失败，请稍后重试',
} as const;

// FR-034 错误映射。AxiosError 判别走 duck-type（`isAxiosError` flag），与 login
// loginErrorToast 同款判别逻辑，仅文案不同：400 INVALID_DISPLAY_NAME → 昵称不合法；
// 429 → 限流；无 response（网络/超时）或 5xx → 网络；其余（含 401，由 api-client 拦截器
// 透明 refresh，落到这里属边缘）→ 未知。
export function onboardingErrorToast(error: unknown): string {
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

export function useOnboardingForm() {
  const form = useForm<OnboardingFormValues>({
    resolver: zodResolver(onboardingFormSchema),
    mode: 'onChange',
    defaultValues: { displayName: '' },
  });

  // 铁律 2 — side-effect state lives OUTSIDE RHF: the PATCH mutation + the error
  // latch are not part of the form submit lifecycle.
  const update = useUpdateDisplayName();
  const [phase, setPhase] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // 铁律 1 — caller wraps the input in <Controller>; submit goes through
  // handleSubmit so formState.isSubmitting is the single loading source (铁律 3).
  // The resolver trims, so values.displayName is the normalized value (FR-031).
  // On success the wrapper writes store.displayName; AuthGate redirects (FR-032).
  const submit = form.handleSubmit(async (values) => {
    setErrorToast(null);
    try {
      await update.mutateAsync({ data: { displayName: values.displayName } });
      setPhase('success');
    } catch (e) {
      setErrorToast(onboardingErrorToast(e));
      setPhase('error');
    }
  });

  // error → idle on explicit clear / any input change (FR-034).
  const clearError = useCallback(() => {
    setErrorToast(null);
    setPhase((prev) => (prev === 'error' ? 'idle' : prev));
  }, []);

  const { isSubmitting } = form.formState;
  const state: OnboardingFormState = isSubmitting ? 'submitting' : phase;

  return { form, state, errorToast, submit, clearError, isSubmitting };
}
