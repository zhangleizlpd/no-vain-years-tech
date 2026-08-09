import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';
import { onboardingFormSchema, type OnboardingFormValues } from '~/auth/onboarding-form.schema';
import { onboardingErrorToast } from '~/auth/use-onboarding-form';
import { useUpdateDisplayName } from '~/auth/update-display-name';

// 昵称编辑 RHF 状态机（镜像 useBioEditForm / useOnboardingForm，Golden Sample = login）。
// 复用 onboardingFormSchema（= z.object({ displayName: displayNameSchema })，1–32 码点、
// NotEmpty、拒控制字符，plan D7）+ onboardingErrorToast（同 displayName 错误文案，DRY）。
// 写路径复用 002 `PATCH /me {displayName}` 经 useUpdateDisplayName —— 该 wrapper 成功即
// write-through 把新 profile 写入 /me 缓存（单一真相源），故本 hook 不再手写 store 同步。
// submitting 由 formState.isSubmitting 派生（铁律 3）；success 由页面驱动 router.back()。
export type NameEditFormState = 'idle' | 'submitting' | 'success' | 'error';

export const nameEditErrorToast = onboardingErrorToast;

export function useNameEditForm(initialName: string) {
  const form = useForm<OnboardingFormValues>({
    resolver: zodResolver(onboardingFormSchema),
    mode: 'onChange',
    defaultValues: { displayName: initialName },
  });

  // 铁律 2 — side-effect state lives OUTSIDE RHF。useUpdateDisplayName 的 onSuccess
  // 已 write-through 把新 profile 写入 /me 缓存（单一真相源），资料卡 / AuthGate 随即读到，
  // 故本 hook 不再手写 invalidate / store 同步。
  const update = useUpdateDisplayName();
  const [phase, setPhase] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // 铁律 1 — caller 用 <Controller> 包 TextInput；submit 走 handleSubmit 使
  // formState.isSubmitting 成唯一 loading 源（铁律 3）。resolver 已 trim + 校验非空，故
  // values.displayName 是规范化值。成功 → wrapper write-through /me 缓存 → 页面 back。
  const submit = form.handleSubmit(async (values) => {
    setErrorToast(null);
    try {
      await update.mutateAsync({ data: { displayName: values.displayName } });
      setPhase('success');
    } catch (e) {
      setErrorToast(nameEditErrorToast(e));
      setPhase('error');
    }
  });

  // error → idle on explicit clear / any input change。
  const clearError = useCallback(() => {
    setErrorToast(null);
    setPhase((prev) => (prev === 'error' ? 'idle' : prev));
  }, []);

  const { isSubmitting } = form.formState;
  const state: NameEditFormState = isSubmitting ? 'submitting' : phase;

  return { form, state, errorToast, submit, clearError };
}
