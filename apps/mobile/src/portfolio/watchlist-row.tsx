import { Text, View } from 'react-native';
import type { QuoteItem, WatchlistItemView } from '@nvy/api-client';

import { MarketBadge } from '~/ui';
import {
  formatChange,
  formatPct,
  formatPrice,
  quoteColorClass,
  quoteDirection,
} from './use-quote-merge';
import { tagDotClass } from './watchlist-palette';
import { WATCHLIST_COPY } from './watchlist-copy';

// 主列表单行（013 屏1 / FR-M02·FR-M03）。左 = 名称主名（015 /quote 返 name，原决策 A
// 「以代码为主名」已翻案；未就位回落代码）+ 板块 badge/代码副行 + 可选色点 + 固顶「顶」
// badge；右 = 最新 / 涨幅 / 涨跌 三列，涨红跌绿（quote.* token）。
// 涨幅 / 涨跌带 +/- 符号 → 色盲友好（FR-M09 色非唯一载体）。015 无数据 → '--' + 中性灰。
// presentational —— 渲染/涨跌色走 Playwright；格式化/方向纯函数走 vitest（per mono 测试分层）。

const COPY = WATCHLIST_COPY.main;
const NUM_COL = 'w-20 text-right text-sm';

export interface WatchlistRowProps {
  item: WatchlistItemView;
  /** 015 client-side merge 行情（未就位 → undefined → '--'）。 */
  quote: QuoteItem | undefined;
}

export function WatchlistRow({ item, quote }: WatchlistRowProps) {
  const colorClass = quoteColorClass(quoteDirection(quote));
  const dot = tagDotClass(item.color);
  return (
    <View className="flex-row items-center px-md bg-surface" style={{ minHeight: 56 }}>
      <View className="flex-1 min-w-0 flex-row items-center gap-xs">
        {dot ? <View className={`w-2 h-2 rounded-full ${dot}`} /> : null}
        <View className="min-w-0">
          <View className="flex-row items-center gap-xs">
            <Text className="text-base font-medium text-ink" numberOfLines={1}>
              {quote?.name ?? item.code}
            </Text>
            {item.pinned ? (
              <Text className="text-xs text-accent border border-accent rounded-sm px-xs">
                {COPY.pinnedBadge}
              </Text>
            ) : null}
          </View>
          <View className="flex-row items-center gap-xs mt-0.5">
            <MarketBadge code={item.code} market={item.market} />
            <Text className="text-xs font-mono text-ink-subtle">{item.code}</Text>
          </View>
        </View>
      </View>
      <Text className={`${NUM_COL} ${colorClass}`}>{formatPrice(quote)}</Text>
      <Text className={`${NUM_COL} ${colorClass}`}>{formatPct(quote)}</Text>
      <Text className={`${NUM_COL} ${colorClass}`}>{formatChange(quote)}</Text>
    </View>
  );
}

/** 列头「名称 ｜ 最新 ｜ 涨幅 ｜ 涨跌」（FR-M02）。 */
export function WatchlistColumnHeader() {
  return (
    <View className="flex-row items-center px-md py-xs bg-surface-sunken">
      <Text className="flex-1 text-xs text-ink-subtle">{COPY.columns.name}</Text>
      <Text className="w-20 text-right text-xs text-ink-subtle">{COPY.columns.last}</Text>
      <Text className="w-20 text-right text-xs text-ink-subtle">{COPY.columns.pct}</Text>
      <Text className="w-20 text-right text-xs text-ink-subtle">{COPY.columns.change}</Text>
    </View>
  );
}
