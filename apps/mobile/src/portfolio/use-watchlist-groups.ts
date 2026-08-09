import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getWatchlistGroupsControllerListQueryKey,
  type GroupItem,
  type GroupListResponse,
  type ReorderGroupEntry,
  useWatchlistGroupsControllerCreate,
  useWatchlistGroupsControllerDelete,
  useWatchlistGroupsControllerList,
  useWatchlistGroupsControllerReorder,
  useWatchlistGroupsControllerUpdate,
} from '@nvy/api-client';
import type { AxiosResponse } from 'axios';

import { extractProblemDetail } from '~/core/api/errors';
import { WATCHLIST_COPY } from './watchlist-copy';

// 自选分组 CRUD hook（013 US1）。包 orval query + 4 mutation（create/rename/delete/reorder）：
//  - 首屏态机 loading / error / ready
//  - reorder（拖拽序 + 隐藏切换）乐观更新 + 响应对账（server 返**全量**组列覆盖 cache）
//  - 失败回弹原 cache + errorToast 分流（422 系统组保护 / 404 组不存在 / 429 限流 / 网络）
// 纯函数（watchlistGroupErrorToast / applyGroupReorderOptimistic）vitest 单测；编排走 Playwright。

type Groups = AxiosResponse<GroupListResponse>;

/** 分组操作失败 toast 分流（复用 ~/core/api ProblemDetail guard 体例）。 */
export function watchlistGroupErrorToast(error: unknown): string {
  const p = extractProblemDetail(error);
  if (p?.code === 'SYSTEM_GROUP_PROTECTED') return WATCHLIST_COPY.errorToast.systemProtected;
  if (p?.code === 'GROUP_NOT_FOUND') return WATCHLIST_COPY.errorToast.groupNotFound;
  if (p?.code === 'RATE_LIMIT_EXCEEDED') return WATCHLIST_COPY.errorToast.rateLimit;
  const e = error as { isAxiosError?: boolean; response?: { status?: number } };
  if (e?.isAxiosError && e.response?.status === 429) return WATCHLIST_COPY.errorToast.rateLimit;
  return WATCHLIST_COPY.errorToast.network;
}

/** 乐观重排：按 ordered 覆盖各组 order + visible，并按新 order 升序（不可变，cache 安全）。 */
export function applyGroupReorderOptimistic(prev: Groups, ordered: ReorderGroupEntry[]): Groups {
  const patch = new Map(ordered.map((o) => [o.groupId, o]));
  const groups = prev.data.groups
    .map((g) => {
      const p = patch.get(g.id);
      return p ? { ...g, order: p.order, visible: p.visible } : g;
    })
    .sort((a, b) => a.order - b.order);
  return { ...prev, data: { ...prev.data, groups } };
}

export type WatchlistGroupsStatus = 'loading' | 'error' | 'ready';

export function useWatchlistGroups() {
  const queryClient = useQueryClient();
  const queryKey = getWatchlistGroupsControllerListQueryKey();
  const query = useWatchlistGroupsControllerList();
  const createMutation = useWatchlistGroupsControllerCreate();
  const updateMutation = useWatchlistGroupsControllerUpdate();
  const deleteMutation = useWatchlistGroupsControllerDelete();
  const reorderMutation = useWatchlistGroupsControllerReorder();

  const [errorToast, setErrorToast] = useState<string | null>(null);

  const groups: GroupItem[] = query.data?.data.groups ?? [];

  // 全量响应覆盖 cache（server 是最终真相，含多端竞态同步）。
  const reconcile = useCallback(
    (res: Groups) => queryClient.setQueryData(queryKey, res),
    [queryClient, queryKey],
  );

  const createGroup = useCallback(
    async (name: string) => {
      setErrorToast(null);
      try {
        reconcile(await createMutation.mutateAsync({ data: { name } }));
      } catch (e) {
        setErrorToast(watchlistGroupErrorToast(e));
        throw e;
      }
    },
    [createMutation, reconcile],
  );

  const renameGroup = useCallback(
    async (groupId: string, name: string) => {
      setErrorToast(null);
      try {
        reconcile(await updateMutation.mutateAsync({ groupId, data: { name } }));
      } catch (e) {
        setErrorToast(watchlistGroupErrorToast(e));
        throw e;
      }
    },
    [updateMutation, reconcile],
  );

  const deleteGroup = useCallback(
    async (groupId: string) => {
      setErrorToast(null);
      try {
        reconcile(await deleteMutation.mutateAsync({ groupId }));
      } catch (e) {
        setErrorToast(watchlistGroupErrorToast(e));
        throw e;
      }
    },
    [deleteMutation, reconcile],
  );

  const reorderGroups = useCallback(
    async (ordered: ReorderGroupEntry[]) => {
      setErrorToast(null);
      const prev = queryClient.getQueryData<Groups>(queryKey);
      // 乐观更新（拖拽 / 隐藏即时反映；无 cache 时跳过，回弹以 server 为准）。
      if (prev) queryClient.setQueryData(queryKey, applyGroupReorderOptimistic(prev, ordered));
      try {
        reconcile(await reorderMutation.mutateAsync({ data: { ordered } }));
      } catch (e) {
        if (prev) queryClient.setQueryData(queryKey, prev);
        setErrorToast(watchlistGroupErrorToast(e));
        throw e;
      }
    },
    [queryClient, queryKey, reorderMutation, reconcile],
  );

  const clearErrorToast = useCallback(() => setErrorToast(null), []);

  const status: WatchlistGroupsStatus = query.isPending
    ? 'loading'
    : query.isError
      ? 'error'
      : 'ready';

  return {
    groups,
    status,
    createGroup,
    renameGroup,
    deleteGroup,
    reorderGroups,
    errorToast,
    clearErrorToast,
    refetch: query.refetch,
  };
}
