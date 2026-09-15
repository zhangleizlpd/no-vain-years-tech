// 083 T017 — 持仓详情数据源（plan §D15）：包生成的详情 hook。
//
// 🚨 对外只给引用稳定的 `refetch`：聚焦 / 回前台 / 下拉重读的依赖只放它（Guardrail 15）。
// 📌 404 = 记录不存在（FR-020），是预期分支不是故障 ⇒ 不重试；其余失败沿用 1 次重试。
// 📌 只读本系统已同步的券商数据，重读不触发券商同步（FR-008）。
import { useCallback } from 'react';
import {
  useBrokerAccountControllerPosition,
  type BrokerPositionDetailResponse,
} from '@nvy/api-client';

import { isDetailNotFound } from './trading-account-positions.rules';

function retryUnlessNotFound(failureCount: number, error: unknown): boolean {
  return !isDetailNotFound(error) && failureCount < 1;
}

export interface UseTradingAccountPositionResult {
  /** 最近一次成功加载的响应；重读失败时仍保留（FR-023）。 */
  data: BrokerPositionDetailResponse | undefined;
  /** 尚无已加载数据且请求进行中（首次加载态）。 */
  isPending: boolean;
  /** 最近一次请求失败。 */
  isError: boolean;
  /** 最近一次请求失败且为 404（持仓已不存在）。 */
  notFound: boolean;
  isRefetching: boolean;
  refetch: () => void;
}

export function useTradingAccountPosition(id: string): UseTradingAccountPositionResult {
  const query = useBrokerAccountControllerPosition(id, {
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
