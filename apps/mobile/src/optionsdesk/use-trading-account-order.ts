// 083 T018 — 订单详情数据源（plan §D11 / §D15）：包生成的订单详情 hook（形态同 `use-trading-account-position.ts`）。
//
// 🚨 对外只给引用稳定的 `refetch`：聚焦 / 回前台 / 下拉重读的依赖只放它（Guardrail 15）。
// 📌 404 = 订单不存在（FR-020），是预期分支不是故障 ⇒ 不重试；其余失败沿用 1 次重试。
// 📌 只读本系统已同步的券商数据，重读不触发券商同步（FR-008）。
import { useCallback } from 'react';
import { useBrokerAccountControllerOrder, type BrokerOrderDetailResponse } from '@nvy/api-client';

import { isDetailNotFound } from './trading-account-positions.rules';

function retryUnlessNotFound(failureCount: number, error: unknown): boolean {
  return !isDetailNotFound(error) && failureCount < 1;
}

export interface UseTradingAccountOrderResult {
  /** 最近一次成功加载的响应；重读失败时仍保留（FR-023）。 */
  data: BrokerOrderDetailResponse | undefined;
  /** 尚无已加载数据且请求进行中（首次加载态）。 */
  isPending: boolean;
  /** 最近一次请求失败。 */
  isError: boolean;
  /** 最近一次请求失败且为 404（订单不存在）。 */
  notFound: boolean;
  isRefetching: boolean;
  refetch: () => void;
}

export function useTradingAccountOrder(id: string): UseTradingAccountOrderResult {
  const query = useBrokerAccountControllerOrder(id, {
    query: { enabled: id.length > 0, retry: retryUnlessNotFound },
  });
  const { refetch: refetchQuery } = query;

  const refetch = useCallback(() => {
    void refetchQuery();
  }, [refetchQuery]);

  return {
    data: query.data?.data,
    isPending: query.isPending,
    isError: query.isError,
    notFound: query.isError && isDetailNotFound(query.error),
    isRefetching: query.isRefetching,
    refetch,
  };
}
