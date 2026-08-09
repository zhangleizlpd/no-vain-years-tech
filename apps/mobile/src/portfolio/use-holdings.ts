import { useMemo } from 'react';
import {
  type ClosedPositionItem,
  type HoldingItem,
  useHoldingsControllerList,
} from '@nvy/api-client';

import { type HoldingsSummary, summarizeHoldings } from './holdings.helpers';
import { type QuoteMerge, useQuoteMerge } from './use-quote-merge';

// 持仓列表 hook（025 US2）。EP2 一次取 current+closed 双数组（plan D6）；current 中
// quotable 行二次 `use-quote-merge` 合成现价/浮动盈亏（ADR-0048，013 先例，禁 detail N+1）。
// 降级行（quotable=false）不进 quote 请求，行情列由格式化器吐 `--`。
// 纯逻辑（summarizeHoldings 等）在 holdings.helpers.ts vitest；hook 编排走
// Playwright + contract-smoke（per mono 测试分层）。

export type HoldingsStatus = 'loading' | 'error' | 'ready';

export interface Holdings {
  /** 快照日 YYYY-MM-DD；未导入过为 null（空态）。 */
  asOf: string | null;
  current: HoldingItem[];
  closed: ClosedPositionItem[];
  /** 汇总条聚合（总市值实时合成 + 总累计盈亏快照）。 */
  summary: HoldingsSummary;
  quotes: QuoteMerge;
  status: HoldingsStatus;
  refetch: () => void;
}

export function useHoldings(): Holdings {
  const query = useHoldingsControllerList();
  const data = query.data?.data;
  const current = useMemo(() => data?.current ?? [], [data]);

  const refs = useMemo(
    () => current.filter((h) => h.quotable).map((h) => ({ market: h.market, code: h.code })),
    [current],
  );
  const quotes = useQuoteMerge(refs);

  const summary = useMemo(
    () => summarizeHoldings(current, quotes.quoteFor),
    [current, quotes.quoteFor],
  );

  const status: HoldingsStatus = query.isPending ? 'loading' : query.isError ? 'error' : 'ready';

  return {
    asOf: data?.asOf ?? null,
    current,
    closed: data?.closed ?? [],
    summary,
    quotes,
    status,
    refetch: query.refetch,
  };
}
