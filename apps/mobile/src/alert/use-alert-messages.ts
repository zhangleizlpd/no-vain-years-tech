import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getAlertMessagesControllerListQueryKey,
  getAlertMessagesControllerUnreadCountQueryKey,
  useAlertMessagesControllerList,
  useAlertMessagesControllerMarkRead,
  useAlertMessagesControllerUnreadCount,
} from '@nvy/api-client';

// 消息中心 hook（021 T016 / US3）。EP6 列表 + EP7 未读数 + EP8 置已读：
//  - 屏 6 进入提醒 tab 即 markRead（plan D6 屏级水位线）→ EP7 cache 置 0 + 失效 EP6
//    （unread 旗翻新）；服务端单一真相 → 多设备一致（SC-005）
//  - 角标 = EP7 派生（unreadBadgeVisible）；focus refetch 由宿主屏 useFocusEffect(refetch)
//    接线（T020/T021），不轮询
// 纯函数（unreadBadgeVisible）vitest；hook 编排走 Playwright + contract-smoke。

/** 未读角标显隐（FR-M07：未读 >0 红点）。 */
export function unreadBadgeVisible(unread: number | undefined): boolean {
  return (unread ?? 0) > 0;
}

export type MessagesStatus = 'loading' | 'error' | 'ready';

/** EP6 消息列表（triggeredAt 倒序；V1 单页默认 limit，nextCursor 留分页 seam）。 */
export function useAlertMessages() {
  const query = useAlertMessagesControllerList();
  return {
    messages: query.data?.data.messages ?? [],
    status: (query.isPending ? 'loading' : query.isError ? 'error' : 'ready') as MessagesStatus,
    refetch: query.refetch,
  };
}

/** EP7 未读数（角标源；宿主屏 focus refetch 接线）。 */
export function useUnreadCount() {
  const query = useAlertMessagesControllerUnreadCount();
  return {
    unread: query.data?.data.unread,
    badgeVisible: unreadBadgeVisible(query.data?.data.unread),
    refetch: query.refetch,
  };
}

/** EP8 置已读（屏 6 进入即调，D6）：EP7 cache 置 0 + 失效 EP6。幂等可重入。 */
export function useMarkMessagesRead() {
  const queryClient = useQueryClient();
  // 只解构 mutateAsync（react-query 保证引用稳定）：mutation 结果对象每次
  // render 新 identity，若整对象进 useCallback 依赖 → 宿主屏 useFocusEffect
  // 依赖本 callback → mutation 状态翻转自激重入（真机实证 1s 169 发 429 风暴）。
  const { mutateAsync } = useAlertMessagesControllerMarkRead();

  return useCallback(async () => {
    try {
      const res = await mutateAsync();
      queryClient.setQueryData(getAlertMessagesControllerUnreadCountQueryKey(), res);
      void queryClient.invalidateQueries({
        queryKey: getAlertMessagesControllerListQueryKey(),
      });
    } catch {
      // 置已读失败不打断阅读（角标残留，下次进入重试）——读路径静默容错。
    }
  }, [mutateAsync, queryClient]);
}
