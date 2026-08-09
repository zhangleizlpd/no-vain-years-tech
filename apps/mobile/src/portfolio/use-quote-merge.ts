import { useCallback, useMemo } from 'react';
import {
  type QuoteItem,
  type QuoteListResponse,
  useMarketdataControllerQuote,
} from '@nvy/api-client';

// 行情 client-side merge hook（013 FR-M03 / ADR-0048）。**013 server 不服务行情** —— mobile
// 按当前组 items 的 `market:code` 批量直调 **015** `/quote`（typed orval hook），客户端 merge 到
// 行视图。015 无数据 / 失败 → 占位 `--` + 中性灰（不阻塞列表渲染）。涨跌色 = A股 红涨绿跌
// （quote.up/down/flat token，T013）。涨跌幅 / 涨跌额带 +/- 符号 → 色盲友好（FR-M09 色非唯一载体）。
// 纯函数（quoteDirection / quoteColorClass / 格式化 / buildSymbols / indexQuotes）vitest 单测；
// hook 编排走 Playwright + contract-smoke（per mono 测试分层）。

export type QuoteDirection = 'up' | 'down' | 'flat' | 'none';

// market 宽为 string：013 watchlist 行（枚举可赋）与 021 alert 屏（AlertResponse.market
// 为 string）共用；函数体只做 `market:code` 拼接，无枚举依赖。
type SymbolRef = { market: string; code: string };

/** canonical `market:code`（015 /quote 入参词表，cn/hk/us 已对齐 #302，不做映射）。 */
export function symbolOf(ref: SymbolRef): string {
  return `${ref.market}:${ref.code}`;
}

/** 涨跌方向：无 quote / 无数据 / changePct 为 null → 'none'（占位）；否则按符号分 up/down/flat。 */
export function quoteDirection(quote: QuoteItem | undefined): QuoteDirection {
  if (!quote || !quote.hasData || quote.changePct == null) return 'none';
  const n = Number.parseFloat(quote.changePct);
  if (Number.isNaN(n)) return 'none';
  if (n > 0) return 'up';
  if (n < 0) return 'down';
  return 'flat';
}

/** 方向 → NativeWind 文本色 class（A股 红涨绿跌；none=中性灰占位）。 */
export function quoteColorClass(dir: QuoteDirection): string {
  switch (dir) {
    case 'up':
      return 'text-quote-up';
    case 'down':
      return 'text-quote-down';
    case 'flat':
      return 'text-quote-flat';
    default:
      return 'text-ink-subtle';
  }
}

/** 带符号格式化涨跌幅（%）；无数据 → '--'。+/- 符号是 a11y 色盲友好的非色彩信息载体。 */
export function formatPct(quote: QuoteItem | undefined): string {
  if (!quote || !quote.hasData || quote.changePct == null) return '--';
  const n = Number.parseFloat(quote.changePct);
  if (Number.isNaN(n)) return '--';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** 带符号格式化涨跌额；无数据 → '--'。 */
export function formatChange(quote: QuoteItem | undefined): string {
  if (!quote || !quote.hasData || quote.change == null) return '--';
  const n = Number.parseFloat(quote.change);
  if (Number.isNaN(n)) return '--';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

/** 格式化最新价（无符号）；无数据 → '--'。 */
export function formatPrice(quote: QuoteItem | undefined): string {
  if (!quote || !quote.hasData || quote.price == null) return '--';
  const n = Number.parseFloat(quote.price);
  if (Number.isNaN(n)) return '--';
  return n.toFixed(2);
}

/** 去重后的逗号分隔 symbols 串（/quote 入参）。 */
export function buildSymbols(refs: SymbolRef[]): string {
  return [...new Set(refs.map(symbolOf))].join(',');
}

/** 响应 items 按 symbol 建索引（同 symbol 取首条）。 */
export function indexQuotes(resp: QuoteListResponse | undefined): Map<string, QuoteItem> {
  const map = new Map<string, QuoteItem>();
  for (const q of resp?.items ?? []) {
    if (!map.has(q.symbol)) map.set(q.symbol, q);
  }
  return map;
}

export interface QuoteMerge {
  /** 取某标的的 quote（未就位返回 undefined → 格式化器吐 '--'）。 */
  quoteFor: (ref: SymbolRef) => QuoteItem | undefined;
  /** 首屏行情加载中（有 symbol 且未返回）。 */
  isLoading: boolean;
  /** 015 调用失败（列表照常渲染，行情列占位 '--'）。 */
  isError: boolean;
}

export function useQuoteMerge(refs: SymbolRef[]): QuoteMerge {
  const symbols = buildSymbols(refs);
  const query = useMarketdataControllerQuote(
    { symbols },
    // 无 symbol（空组）不发请求；015 失败不抛断列表。
    { query: { enabled: symbols.length > 0 } },
  );
  const index = useMemo(() => indexQuotes(query.data?.data), [query.data]);
  const quoteFor = useCallback((ref: SymbolRef) => index.get(symbolOf(ref)), [index]);

  return {
    quoteFor,
    isLoading: symbols.length > 0 && query.isPending,
    isError: query.isError,
  };
}
