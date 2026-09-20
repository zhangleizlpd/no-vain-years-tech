// 083 T014 — 交易账户页 · 持仓分段数据源（plan §D14）：包生成的列表 hook。
//
// 🚨 对外只给引用稳定的 `refetch` 包装：聚焦 / 回前台 / 下拉重读（T016）的依赖只放它，
//    🚫 把整个 `useQuery` 结果对象塞进 `useFocusEffect` / `AppState` 回调依赖（自激请求风暴，Guardrail 15）。
// 📌 重试沿用全局 `retry: 1`（`core/api/query-client.ts`）；🚫 改 react-query 全局 `focusManager`。
// 📌 只读本系统已同步的券商数据，重读不触发券商同步（FR-008）。
//
// ── 085 T009：展示币种进 query 维度（plan §D1） ──────────────────────────────
// 🚨 `displayCurrency` 必须进请求参数 ⇒ orval 的 key 工厂是 `[url, ...(params ? [params] : [])]`，
//    参数进去了 key 才带上币种维度：**每档各一份缓存**，切回已取过的档直接命中（SC-004 靠这个，
//    不靠额外优化）。少了这一维不会红 —— 切档照样发请求、照样重绘，只是两档共用一份缓存，
//    切回去命中的是另一档的数字，而两份都长得一样合理。
// 🚨 **`market` 必须排在 `displayCurrency` 之前**：axios 按对象键序拼查询串，而 083 既有 e2e 的
//    URL glob 是 `'**/api/v1/optionsdesk/broker-positions?market=*'`
//    （`e2e/optionsdesk-trading-account.spec.ts:69`）—— 掉个个儿那条 mock 直接不再命中。
//    由 `use-trading-account-positions.spec.ts` 臂 ③ 钉住。
import { useCallback } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import {
  getBrokerAccountControllerPositionsQueryKey,
  useBrokerAccountControllerPositions,
  type BrokerAccountControllerPositionsMarket,
  type BrokerPositionListResponse,
} from '@nvy/api-client';

import type { DisplayCurrency } from './display-currency.rules';

/**
 * 列表 query key 稳定前缀（= orval 工厂无参形态；invalidate 走前缀匹配 ⇒ 覆盖全部市场）。
 * 📌 085 加了币种维度后前缀**不变**：维度都在 params 那一段，前缀匹配照样覆盖全部市场 × 全部币种。
 */
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
  displayCurrency: DisplayCurrency,
): UseTradingAccountPositionsResult {
  // 🚨 `placeholderData: keepPreviousData`：切档换 key 的那一拍，上一档的行留在屏上而不是整屏
  //    塌成 spinner（mockup 帧 ④ 要的是「行还在、金额位占位」）。留下的数字属于**上一个币种**
  //    ⇒ 呈现层据 `amountsPending` 把金额位换成占位，🚫 让未折算数字先上屏再跳变（branch 18）。
  //    体例同本 feature 的 `use-leg-table.ts`（那里摘掉它会整块屏炸，理由另述）。
  const query = useBrokerAccountControllerPositions(
    { market, displayCurrency },
    { query: { placeholderData: keepPreviousData } },
  );
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
