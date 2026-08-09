import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccountProfileControllerUpdateGender } from '@nvy/api-client';
import { useAuthStore } from '~/auth';
import { meQueryKey } from '~/core/api/me-query-key';
import type { Gender } from './gender';

// 性别编辑状态机（**非 RHF** —— tap-to-select，无文本输入 / 无表单校验，plan D6）。
// 点选即调 PATCH /me/gender → invalidate /me → success；in-flight 防重复点；失败 latch 错误
// 文案（页面留屏显错、不返回，analyze F2）。submitting 由 mutation.isPending 派生（单源）。
export type GenderEditState = 'idle' | 'submitting' | 'success' | 'error';

const TOAST = {
  invalid: '性别设置失败，请重试',
  rateLimit: '请求过于频繁，请稍后再试',
  network: '网络异常，请重试',
  unknown: '保存失败，请稍后重试',
} as const;

// 错误映射，镜像 bioEditErrorToast：400 → 不合法；429 → 限流；无 response / 5xx → 网络；
// 其余（含 401，api-client 拦截器透明 refresh，落到这里属边缘）→ 未知。
export function genderEditErrorToast(error: unknown): string {
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

export function useGenderEdit() {
  const update = useAccountProfileControllerUpdateGender();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // 点任一选项即持久化。in-flight 防重复点（幂等：同值再存 200，但避免并发 PATCH）。
  // 成功 invalidate /me（资料卡「性别」行随 useMe 刷新）→ success（页面驱动 router.back()）。
  const select = useCallback(
    async (gender: Gender) => {
      if (update.isPending) return;
      setErrorToast(null);
      try {
        await update.mutateAsync({ data: { gender } });
        await queryClient.invalidateQueries({
          queryKey: meQueryKey(useAuthStore.getState().accountId),
        });
        setPhase('success');
      } catch (e) {
        setErrorToast(genderEditErrorToast(e));
        setPhase('error');
      }
    },
    [update, queryClient],
  );

  const state: GenderEditState = update.isPending ? 'submitting' : phase;
  return { select, state, errorToast };
}
