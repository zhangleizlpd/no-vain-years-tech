import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  type AddWatchlistItemRequest,
  getWatchlistGroupsControllerListItemsQueryKey,
  getWatchlistGroupsControllerListQueryKey,
  type ItemListResponse,
  type UpdateWatchlistItemRequest,
  useWatchlistGroupsControllerAddItem,
  useWatchlistGroupsControllerListItems,
  useWatchlistItemsControllerDelete,
  useWatchlistItemsControllerUpdate,
  type WatchlistItemView,
} from '@nvy/api-client';
import type { AxiosResponse } from 'axios';

import { extractProblemDetail } from '~/core/api/errors';
import { WATCHLIST_COPY } from './watchlist-copy';

// 自选项 CRUD hook（013 US2）。包 orval listItems query + 3 mutation（add/update/delete）：
//  - 排序优先级 = 固顶区常驻顶 > 非固顶区，各区 order 升序（FR-S05，客户端镜像 server rules）
//  - 改字段（固顶/颜色/笔记）乐观更新 + 响应对账（server 返**全量**组 items 覆盖 cache）
//  - 改归属组涉源 + 目标两组 → 对账后失效目标组 items + 组列（itemCount 变）
//  - 失败回弹 + errorToast 分流（422 持仓只读 / 404 项不存在 / 429 限流 / 网络）
// 纯函数（watchlistItemErrorToast / sortItemsPinFirst / applyItemPatchOptimistic）vitest 单测。

type Items = AxiosResponse<ItemListResponse>;

/** 自选项操作失败 toast 分流。 */
export function watchlistItemErrorToast(error: unknown): string {
  const p = extractProblemDetail(error);
  if (p?.code === 'HOLDINGS_GROUP_READONLY') return WATCHLIST_COPY.errorToast.holdingsReadonly;
  if (p?.code === 'WATCHLIST_ITEM_NOT_FOUND') return WATCHLIST_COPY.errorToast.itemNotFound;
  if (p?.code === 'RATE_LIMIT_EXCEEDED') return WATCHLIST_COPY.errorToast.rateLimit;
  const e = error as { isAxiosError?: boolean; response?: { status?: number } };
  if (e?.isAxiosError && e.response?.status === 429) return WATCHLIST_COPY.errorToast.rateLimit;
  return WATCHLIST_COPY.errorToast.network;
}

/** 固顶区在前 + 各区 order 升序（FR-S05）。稳定不可变排序。 */
export function sortItemsPinFirst(items: WatchlistItemView[]): WatchlistItemView[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.order - b.order;
  });
}

/**
 * 乐观局部 patch（固顶/颜色/笔记原地改）+ 按固顶优先重排（不可变，cache 安全）。
 * patch 取 view 形（color/noteRef 可 null → 表达清除）；hook 传入的 request data
 * （color/noteRef 为 string|undefined）结构兼容。
 */
export function applyItemPatchOptimistic(
  prev: Items,
  itemId: string,
  patch: Partial<Pick<WatchlistItemView, 'pinned' | 'color' | 'noteRef'>>,
): Items {
  const items = prev.data.items.map((it) =>
    it.id === itemId
      ? {
          ...it,
          ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
          ...(patch.color !== undefined ? { color: patch.color } : {}),
          ...(patch.noteRef !== undefined ? { noteRef: patch.noteRef } : {}),
        }
      : it,
  );
  return { ...prev, data: { ...prev.data, items: sortItemsPinFirst(items) } };
}

export type WatchlistItemsStatus = 'loading' | 'error' | 'ready';

export function useWatchlistItems(groupId: string | null) {
  const queryClient = useQueryClient();
  const itemsKey = getWatchlistGroupsControllerListItemsQueryKey(groupId ?? '');
  const groupListKey = getWatchlistGroupsControllerListQueryKey();
  const query = useWatchlistGroupsControllerListItems(groupId ?? '', {
    query: { enabled: groupId != null },
  });
  const addMutation = useWatchlistGroupsControllerAddItem();
  const updateMutation = useWatchlistItemsControllerUpdate();
  const deleteMutation = useWatchlistItemsControllerDelete();

  const [errorToast, setErrorToast] = useState<string | null>(null);

  const items = useMemo(
    () => (groupId == null ? [] : sortItemsPinFirst(query.data?.data.items ?? [])),
    [groupId, query.data],
  );

  // server 返当前组全量 items 覆盖 cache + 失效组列（itemCount 变）。
  const reconcile = useCallback(
    (res: Items) => {
      queryClient.setQueryData(itemsKey, res);
      void queryClient.invalidateQueries({ queryKey: groupListKey });
    },
    [queryClient, itemsKey, groupListKey],
  );

  const addItem = useCallback(
    async (targetGroupId: string, data: AddWatchlistItemRequest) => {
      setErrorToast(null);
      try {
        const res = await addMutation.mutateAsync({ groupId: targetGroupId, data });
        // 加入的组不一定是当前组（V1 默认落「自选」）→ 失效该组 items + 组列。
        queryClient.setQueryData(getWatchlistGroupsControllerListItemsQueryKey(targetGroupId), res);
        void queryClient.invalidateQueries({ queryKey: groupListKey });
      } catch (e) {
        setErrorToast(watchlistItemErrorToast(e));
        throw e;
      }
    },
    [addMutation, queryClient, groupListKey],
  );

  const updateItem = useCallback(
    async (itemId: string, data: UpdateWatchlistItemRequest) => {
      setErrorToast(null);
      const prev = queryClient.getQueryData<Items>(itemsKey);
      // 固顶/颜色/笔记 → 乐观局部 patch（改组不乐观，等响应对账避免误显）。
      const optimistic = data.targetGroupId === undefined && data.move === undefined;
      if (optimistic && prev) {
        queryClient.setQueryData(itemsKey, applyItemPatchOptimistic(prev, itemId, data));
      }
      try {
        const res = await updateMutation.mutateAsync({ itemId, data });
        reconcile(res);
        // 改归属组：源组已对账，再失效目标组 items（其列表也变了）。
        if (data.targetGroupId) {
          void queryClient.invalidateQueries({
            queryKey: getWatchlistGroupsControllerListItemsQueryKey(data.targetGroupId),
          });
        }
      } catch (e) {
        if (optimistic && prev) queryClient.setQueryData(itemsKey, prev);
        setErrorToast(watchlistItemErrorToast(e));
        throw e;
      }
    },
    [updateMutation, queryClient, itemsKey, reconcile],
  );

  const deleteItem = useCallback(
    async (itemId: string) => {
      setErrorToast(null);
      try {
        reconcile(await deleteMutation.mutateAsync({ itemId }));
      } catch (e) {
        setErrorToast(watchlistItemErrorToast(e));
        throw e;
      }
    },
    [deleteMutation, reconcile],
  );

  const clearErrorToast = useCallback(() => setErrorToast(null), []);

  const status: WatchlistItemsStatus = query.isPending
    ? 'loading'
    : query.isError
      ? 'error'
      : 'ready';

  return {
    items,
    status,
    addItem,
    updateItem,
    deleteItem,
    errorToast,
    clearErrorToast,
    refetch: query.refetch,
  };
}
