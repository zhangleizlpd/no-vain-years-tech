// 032 T013 — 创建 ideation 会话标题表单 RHF 状态机。镜像 chat/use-custom-instruction-form
// （标准编辑表单 golden）+ RHF 4 铁律（per mobile-impl-playbook）：
//   ① <Controller> ≠ register（caller 用 <Controller> 包 TextInput）；
//   ② 表单态 ≠ 副作用态分层（create mutation + error latch 不属 RHF submit 生命周期）；
//   ③ isSubmitting 单源（state 由 formState.isSubmitting 派生，不另设 loading bool）；
//   ④ 错误 + a11y 一体（errorToast → 屏上 ErrorRow + a11y）。
//
// 导航不在本 hook（铁律 2）：建会话成功 → 调 onCreated(id)，由屏（CreateOverlay）负责
// router.push 详情路由 + 关浮层。这样 hook 可被 vitest renderHook 直测（不碰 expo-router）。
import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  createSessionFormSchema,
  type CreateSessionFormValues,
} from './create-session-form.schema';
import { createSessionErrorToast } from './ideation-copy';
import { useCreateSession } from './use-session-mutations';

/** 表单 4 态。submitting 由 isSubmitting 派生（铁律 3）；idle/success/error 为 persistent latch。 */
export type CreateSessionFormState = 'idle' | 'submitting' | 'success' | 'error';

export function useCreateSessionForm(onCreated: (sessionId: string) => void) {
  const form = useForm<CreateSessionFormValues>({
    resolver: zodResolver(createSessionFormSchema),
    mode: 'onChange',
    defaultValues: { title: '' },
  });

  // 铁律 2 — 副作用态在 RHF 之外：建会话 mutation + error latch 不属表单 submit 生命周期。
  // useCreateSession（共置 wrapper）已把"成功即失效会话列表"焊进 onSuccess，本 hook 不再手动失效。
  const createSession = useCreateSession();
  const [phase, setPhase] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // 铁律 1 — caller 用 <Controller> 包 TextInput；submit 走 handleSubmit 使
  // formState.isSubmitting 成为唯一 loading 源（铁律 3）。空标题由 zodResolver 先挡（不进
  // 此回调）。成功 → onCreated(id)（屏负责导航 + 关浮层，铁律 2）。
  const submit = form.handleSubmit(async (values) => {
    setErrorToast(null);
    try {
      const res = await createSession.mutateAsync({ data: { title: values.title.trim() } });
      setPhase('success');
      onCreated(res.data.id);
    } catch (e) {
      setErrorToast(createSessionErrorToast(e));
      setPhase('error');
    }
  });

  // error → idle on explicit clear / input change（让用户改标题后重试）。
  const clearError = useCallback(() => {
    setErrorToast(null);
    setPhase((prev) => (prev === 'error' ? 'idle' : prev));
  }, []);

  // 关浮层 / 重开时复位（清标题 + 态），避免上次输入残留。
  const reset = useCallback(() => {
    form.reset({ title: '' });
    setErrorToast(null);
    setPhase('idle');
  }, [form]);

  const { isSubmitting } = form.formState;
  const state: CreateSessionFormState = isSubmitting ? 'submitting' : phase;

  return { form, state, errorToast, submit, clearError, reset, isSubmitting };
}
