import { useMemo } from 'react';
import { useWatchlistStatusControllerStatus, type WatchlistMembership } from '@nvy/api-client';

import { membershipMap } from './stock-detail.helpers';

// 自选态 hook（014 US6 / FR-M07/M08）。包 014 watchlist-status orval query（EP1）→
//  - inWatchlist（窄义系统「自选」组）：喂底栏加/删按钮文案切换
//  - memberships（所有非持仓组 {groupId,itemId}）：喂编辑分组面板勾选态 + 取消勾时精确删 itemId
// D7 保守兜底：loading / error → inWatchlist=false（不误显「已加」）+ memberships 空。
// 加/删自选 + 编辑分组的增删全复用 013 useWatchlistItems/useWatchlistGroups（本 hook 只读态）。
// hook 编排走 Playwright + contract-smoke；纯派生（membershipMap）vitest（per mono 测试分层）。

export type WatchlistStatusState = 'loading' | 'error' | 'ready';

export interface WatchlistStatus {
  /** 在系统「自选」组（窄义）→ 底栏显「删自选」；否则「加自选」。 */
  inWatchlist: boolean;
  /** 所有非持仓组归属（系统「自选」+ 自定义组）。 */
  memberships: WatchlistMembership[];
  /** groupId → itemId（编辑分组勾选态：has=勾；取消勾拿 itemId 删 013 EP9）。 */
  membershipByGroup: Map<string, string>;
  status: WatchlistStatusState;
  refetch: () => void;
}

export function useWatchlistStatus(market: string, code: string): WatchlistStatus {
  const query = useWatchlistStatusControllerStatus(market, code);
  const data = query.data?.data;

  // D7：error / loading 期 data 为空 → inWatchlist=false（保守，不误显已加）。
  const inWatchlist = data?.inWatchlist ?? false;
  const memberships = useMemo(() => data?.memberships ?? [], [data]);
  const membershipByGroup = useMemo(() => membershipMap(memberships), [memberships]);

  const status: WatchlistStatusState = query.isPending
    ? 'loading'
    : query.isError
      ? 'error'
      : 'ready';

  return {
    inWatchlist,
    memberships,
    membershipByGroup,
    status,
    refetch: () => void query.refetch(),
  };
}
