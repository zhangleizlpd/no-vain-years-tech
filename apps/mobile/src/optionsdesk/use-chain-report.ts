// 055 T010 — 报表取数（`FR-040`, plan `D-API-2` / `D-UI-1`）。
//
// 🚨 **一次请求取齐四种格值**（`D-API-2`）—— 🚫 MUST NOT 为切换格值再发请求：拆开发会让切换
//    先空后填，且四发的 `spot` / `asOf` 可能落在不同批报价上 ⇒ **骨架会跳**，而那正是本片
//    唯一不能出错的东西（`SC-002`）。切换在客户端只是换一张已经到手的网格（T012）。
// 🚨 **未建锚 = 预期分支不是故障** ⇒ 不重试（判别复用 046 的 `isNoAnchorError`，同一个 404
//    语义两处各写一份必 drift）。未建锚时报表本就不可达（`FR-037a`），拦截落 T015。
import { useCallback } from 'react';
import { useOptionsdeskControllerChainReport, type ChainReportResponse } from '@nvy/api-client';

import { isNoAnchorError } from './underlying-detail.rules';

/** 报表 query key 稳定前缀（本片只读；锚 mutation 后的失效由写侧登记）。 */
export const CHAIN_REPORT_QUERY_KEY = ['optionsdesk', 'chain-report'] as const;

/** 只读 EOD 面：退 1 次即可，多轮重试只会把降级态往后拖（同 `use-underlying-detail`）。 */
function retryUnlessNoAnchor(failureCount: number, error: unknown): boolean {
  return !isNoAnchorError(error) && failureCount < 1;
}

export interface UseChainReportResult {
  symbol: string;
  /** 尚未到手 ⇒ `null`（🚫 不造一个空报表，那会让「未就绪」与「全被挡下」看起来一样）。 */
  report: ChainReportResponse | null;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  /** 该标的未建锚 —— 报表 MUST 不可达（`FR-037a`），落点归 T015。 */
  isNoAnchor: boolean;
  refetch: () => void;
  isRefetching: boolean;
}

export function useChainReport(symbol: string): UseChainReportResult {
  const query = useOptionsdeskControllerChainReport(symbol, {
    query: { enabled: symbol.length > 0, retry: retryUnlessNoAnchor },
  });

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    symbol,
    report: query.data?.data ?? null,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    isNoAnchor: query.isError && isNoAnchorError(query.error),
    refetch,
    isRefetching: query.isRefetching,
  };
}
