import { useMemo } from 'react';
import { type TradeItem, useTradesControllerList } from '@nvy/api-client';

import { groupTradesByMonth, type TradeMonthGroup } from './holdings.helpers';

// 标的交易历史 hook（025 US3）。EP3 等值 (market, code) 查流水（server 已时序倒序），
// 客户端按月分组（吸顶小标）。symbol null（路由 parseSymbol 失败）→ 不发请求。
// 月份分组纯函数在 holdings.helpers.ts vitest；hook 编排走 Playwright + contract-smoke。

export type TradesStatus = 'loading' | 'error' | 'ready';

export interface Trades {
  items: TradeItem[];
  /** 月份分组视图（保持 server 倒序）。 */
  groups: TradeMonthGroup[];
  status: TradesStatus;
  refetch: () => void;
}

export function useTrades(symbol: { market: string; code: string } | null): Trades {
  const query = useTradesControllerList(
    { market: symbol?.market ?? '', code: symbol?.code ?? '' },
    { query: { enabled: symbol != null } },
  );
  const items = useMemo(() => query.data?.data.items ?? [], [query.data]);
  const groups = useMemo(() => groupTradesByMonth(items), [items]);

  const status: TradesStatus = query.isPending ? 'loading' : query.isError ? 'error' : 'ready';

  return { items, groups, status, refetch: query.refetch };
}
