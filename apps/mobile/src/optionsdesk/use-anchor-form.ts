// 045 T022 — 锚表单 RHF 状态机（建锚 / 改锚共用一份）。逻辑权威样板 = ~/auth use-login-form.ts，
// 屏布局样板 = app/(app)/settings/account-security/name-edit.tsx（4 铁律见 mobile-impl-playbook § 1）。
//
// 铁律 1 <Controller> ≠ register（调用方包 TextInput）／铁律 2 表单态 ≠ 副作用态（错误 toast、
// EC-7 的重复 ticker 都在 RHF 之外）／铁律 3 `formState.isSubmitting` 单源／铁律 4 错误 + a11y
// 由屏侧的 ErrorRow + accessibilityLabel 落地。
//
// 🚨 三处人工位（V / L 层 / 单票上限）**不在这个表单里**：人工调整是显式动作（FR-032 ①），
//    且改 L 层会沿两级链冲掉单票上限、需要「同屏立即可见」（FR-035 ②③）—— 走各自的即时 PATCH
//    再读回 server 求值结果，比在本地表单态里猜回落更可靠。见 anchor-form-screen 的 ManualSlotRow。
import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { AnchorResponse } from '@nvy/api-client';

import { anchorFormSchema, type AnchorFormValues } from './anchor-form.schema';
import {
  anchorSubmitErrorToast,
  isConfidenceEditable,
  isDuplicateAnchorError,
  toCreateRequest,
  toUpdateRequest,
} from './anchor-form.rules';
import { useCreateAnchor, useUpdateAnchor } from './use-anchor-mutations';

export type AnchorFormState = 'idle' | 'submitting' | 'success' | 'error';

/**
 * 预填。V 取**基准值** `vModel`（表单里的 V 输入编辑的是基准列 `v`，人工位是另一条路径）；
 * 老数据 / 极简 stub 无 `vModel` 时回落到生效值。
 */
function toFormValues(anchor?: AnchorResponse | null): AnchorFormValues {
  return {
    ticker: anchor?.ticker ?? '',
    tickerName: '',
    v: anchor?.vModel ?? anchor?.v ?? '',
    asof: anchor?.asof ?? '',
    method: anchor?.method ?? '',
    confidence: anchor?.confidence ?? '',
    nextReview: anchor?.nextReview ?? '',
    excluded: anchor?.excluded ?? false,
    excludeReason: anchor?.excludeReason ?? '',
  };
}

export function useAnchorForm(anchor?: AnchorResponse | null) {
  const isEdit = !!anchor;
  // FR-001 来源门控：`model` ⇒ confidence 只读、界面**无编辑入口**。建锚恒为手工锚（manual）。
  const confidenceEditable = isConfidenceEditable(anchor?.confidenceSource ?? 'manual');

  const form = useForm<AnchorFormValues>({
    resolver: zodResolver(anchorFormSchema),
    mode: 'onChange',
    defaultValues: toFormValues(anchor),
  });

  // 铁律 2 —— 副作用态在 RHF 之外。只解构 `mutateAsync`：useMutation 返回对象每 render 换
  // identity，整个对象进依赖数组 = 自激风暴（memory `react_query_mutation_identity_usecallback_trap`）。
  const { mutateAsync: createAnchor } = useCreateAnchor();
  const { mutateAsync: updateAnchor } = useUpdateAnchor();

  const [phase, setPhase] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorToast, setErrorToast] = useState<string | null>(null);
  /** EC-7：撞 409 时记下刚提交的 ticker，屏侧据此在锚列表里定位既有锚给「去编辑」。 */
  const [duplicateTicker, setDuplicateTicker] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const submit = form.handleSubmit(async (values) => {
    setErrorToast(null);
    setDuplicateTicker(null);
    try {
      if (anchor) {
        await updateAnchor({
          id: anchor.id,
          data: toUpdateRequest(values, { confidenceEditable }),
        });
      } else {
        const created = await createAnchor({ data: toCreateRequest(values) });
        setCreatedId(created.data.id);
      }
      setPhase('success');
    } catch (e) {
      if (isDuplicateAnchorError(e)) setDuplicateTicker(values.ticker);
      setErrorToast(anchorSubmitErrorToast(e));
      setPhase('error');
    }
  });

  const clearError = useCallback(() => {
    setErrorToast(null);
    setDuplicateTicker(null);
    setPhase((prev) => (prev === 'error' ? 'idle' : prev));
  }, []);

  // 铁律 3 —— submitting 由 formState 派生，不另设 loading bool。
  const { isSubmitting } = form.formState;
  const state: AnchorFormState = isSubmitting ? 'submitting' : phase;

  return {
    form,
    state,
    errorToast,
    duplicateTicker,
    createdId,
    confidenceEditable,
    isEdit,
    submit,
    clearError,
  };
}
