// 083 T014 — 交易账户页 · 持仓分段数据源（plan §D14）：包生成的列表 hook。
//
// 🚨 对外只给引用稳定的 `refetch` 包装：聚焦 / 回前台 / 下拉重读（T016）的依赖只放它，
//    🚫 把整个 `useQuery` 结果对象塞进 `useFocusEffect` / `AppState` 回调依赖（自激请求风暴，Guardrail 15）。
// 📌 重试沿用全局 `retry: 1`（`core/api/query-client.ts`）；🚫 改 react-query 全局 `focusManager`。
// 📌 只读本系统已同步的券商数据，重读不触发券商同步（FR-008）。
import { useCallback } from 'react';
import {
  getBrokerAccountControllerPositionsQueryKey,
  useBrokerAccountControllerPositions,
  type BrokerAccountControllerPositionsMarket,
  type BrokerPositionListResponse,
} from '@nvy/api-client';

/** 列表 query key 稳定前缀（= orval 工厂无参形态；invalidate 走前缀匹配 ⇒ 覆盖全部市场）。 */
export const TRADING_ACCOUNT_POSITIONS_QUERY_KEY = getBrokerAccountControllerPositionsQueryKey();

export interface UseTradingAccountPositionsResult {
  /** 最近一次成功加载的响应；重读失败时仍保留（FR-023）。 */
  data: BrokerPositionListResponse | undefined;
  /** 该市场尚无任何已加载数据且请求进行中（首次加载态）。 */
  isPending: boolean;
  /** 最近一次请求失败（有无数据都可能为真，由视图规则区分）。 */
  isError: boolean;
  isRefetching: boolean;
  refetch: () => void;
}

export function useTradingAccountPositions(
  market: BrokerAccountControllerPositionsMarket,
): UseTradingAccountPositionsResult {
  const query = useBrokerAccountControllerPositions({ market });
  const { refetch: refetchQuery } = query;

  const refetch = useCallback(() => {
    void refetchQuery();
  }, [refetchQuery]);

  return {
    data: query.data?.data,
    isPending: query.isPending,
    isError: query.isError,
    isRefetching: query.isRefetching,
    refetch,
  };
}
