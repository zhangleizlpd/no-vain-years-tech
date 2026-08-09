import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getBrokerAccountsControllerListQueryKey,
  useBrokerAccountsControllerBind,
  useBrokerAccountsControllerDelete,
  useBrokerAccountsControllerList,
  type BrokerAccountItem,
  type BrokerAccountListResponse,
} from '@nvy/api-client';
import type { AxiosResponse } from 'axios';

import { extractProblemDetail } from '~/core/api/errors';
import { BROKER_COPY } from './broker-copy';

// 券商账户绑定 hook（012 US4/US5/US6）。包 orval list query + bind/delete mutation：
//  - 首屏态机：loading / error(retry) / ready（FR-M01，默认账户由 server 合成置顶）
//  - 绑定（FR-M03）：bindMutation 成功后 invalidate 列表 → 回页 A；失败**抛出**交页 B 行内分流
//    （409 dup→行内红框 / 400 校验 / 网络），分流走纯函数 bindErrorMessage（screen 调用）
//  - 删除（FR-M06）：乐观移除目标行 + 失败回滚原态 + deleteErrorToast；默认账户由 screen 拦
//    （无删除入口），server `DEFAULT_ACCOUNT_NOT_DELETABLE`(400) 为最终兜底
// 逻辑分流（removeAccount / bindErrorMessage / deleteErrorToast 纯函数 + 乐观回滚）走 vitest；
// 渲染 / 手势走 Playwright（per mono 测试分层）。

type List = AxiosResponse<BrokerAccountListResponse>;

/** 乐观移除：返回剔除目标 id 后的新响应（不可变，cache 安全）。 */
export function removeAccount(prev: List, id: string): List {
  return {
    ...prev,
    data: {
      ...prev.data,
      accounts: prev.data.accounts.filter((a) => a.id !== id),
    },
  };
}

/** 绑定失败行内文案（FR-M08）：409 dup → 行内重复 / 400 FORM_VALIDATION → 校验 / 其余 → 网络。 */
export function bindErrorMessage(error: unknown): string {
  const p = extractProblemDetail(error);
  if (p?.code === 'BROKER_ACCOUNT_DUPLICATE') return BROKER_COPY.error.duplicate;
  if (p?.code === 'FORM_VALIDATION') return BROKER_COPY.error.validation;
  const e = error as { isAxiosError?: boolean; response?: { status?: number } };
  if (e?.isAxiosError && e.response?.status === 409) return BROKER_COPY.error.duplicate;
  if (e?.isAxiosError && e.response?.status === 400) return BROKER_COPY.error.validation;
  return BROKER_COPY.error.network;
}

/** 删除失败 toast（FR-M08）：限流单列，其余归删除失败。 */
export function deleteErrorToast(error: unknown): string {
  const p = extractProblemDetail(error);
  if (p?.code === 'RATE_LIMIT_EXCEEDED') return BROKER_COPY.error.network;
  const e = error as { isAxiosError?: boolean; response?: { status?: number } };
  if (e?.isAxiosError && e.response?.status === 429) return BROKER_COPY.error.network;
  return BROKER_COPY.error.deleteFailed;
}

export type BrokerAccountsStatus = 'loading' | 'error' | 'ready';

export function useBrokerAccounts() {
  const queryClient = useQueryClient();
  const queryKey = getBrokerAccountsControllerListQueryKey();
  const query = useBrokerAccountsControllerList();
  const bindMutation = useBrokerAccountsControllerBind();
  const deleteMutation = useBrokerAccountsControllerDelete();

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);

  const accounts: BrokerAccountItem[] = query.data?.data.accounts ?? [];

  // 绑定（FR-M03）：成功 invalidate 列表（回页 A 时已是最新）；失败**抛出**交 screen 行内分流。
  const bind = useCallback(
    async (brokerCode: string, clientNo: string) => {
      await bindMutation.mutateAsync({ data: { brokerCode, clientNo } });
      await queryClient.invalidateQueries({ queryKey });
    },
    [bindMutation, queryClient, queryKey],
  );

  // 删除（FR-M06）：乐观移除 + 失败回滚 + toast。in-flight 防重复点。
  const remove = useCallback(
    async (id: string) => {
      if (deletingId !== null) return;

      const prev = queryClient.getQueryData<List>(queryKey);
      setErrorToast(null);
      setDeletingId(id);

      // 乐观移除（无 cache 时跳过，失败仍以 refetch 为准）。
      if (prev) queryClient.setQueryData(queryKey, removeAccount(prev, id));

      try {
        await deleteMutation.mutateAsync({ id });
      } catch (e) {
        // 回滚原态 + 分流 toast（含默认不可删 400 兜底）。
        if (prev) queryClient.setQueryData(queryKey, prev);
        setErrorToast(deleteErrorToast(e));
      } finally {
        setDeletingId(null);
      }
    },
    [queryClient, queryKey, deleteMutation, deletingId],
  );

  const clearErrorToast = useCallback(() => setErrorToast(null), []);

  const status: BrokerAccountsStatus = query.isPending
    ? 'loading'
    : query.isError
      ? 'error'
      : 'ready';

  return {
    accounts,
    status,
    bind,
    binding: bindMutation.isPending,
    remove,
    deletingId,
    errorToast,
    clearErrorToast,
    refetch: query.refetch,
  };
}
