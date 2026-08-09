import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { InstrumentDetailResponse } from '@nvy/api-client';

import {
  detailQuoteDirection,
  formatAsOf,
  formatDetailChangePct,
  formatDetailPrice,
} from './stock-detail.helpers';
import { quoteColorClass } from './use-quote-merge';
import { STOCK_DETAIL_COPY } from './stock-detail-copy';

// 详情固定顶 nav 行（014 US3 / FR-M01）。展开态：返回 + 名称 + 代码 + market badge；
// condensed 态（切公司/分析 Tab 或图表滚过报价，D5）：内联 名称 + 现价 + 涨跌幅（涨红跌绿）
// + asOf 日期小字（D10）。custom nav（headerShown:false）复用 makeHeaderBackOrParent 兜底逻辑
// （栈空=web 硬刷新 → 回投资 tab，per memory expo-router web refresh loses back button）。
// presentational 无单测 —— 渲染走 Playwright e2e（per mono 测试分层）。

const PARENT_HREF = '/(app)/(tabs)/portfolio' as const;

export interface DetailTopNavProps {
  detail: InstrumentDetailResponse | undefined;
  condensed: boolean;
}

export function DetailTopNav({ detail, condensed }: DetailTopNavProps) {
  const goBack = () => (router.canGoBack() ? router.back() : router.replace(PARENT_HREF));
  const color = quoteColorClass(detailQuoteDirection(detail?.quote));
  const asOf = formatAsOf(detail?.quote);

  return (
    <View className="flex-row items-center gap-sm bg-surface px-md py-sm border-b border-line-soft">
      <Pressable
        onPress={goBack}
        accessibilityRole="button"
        accessibilityLabel={STOCK_DETAIL_COPY.nav.back}
        className="w-8"
      >
        <Text className="text-2xl text-ink">‹</Text>
      </Pressable>

      {condensed && detail ? (
        <View className="flex-1 min-w-0">
          <View className="flex-row items-center gap-xs">
            <Text className="text-base font-semibold text-ink" numberOfLines={1}>
              {detail.name}
            </Text>
            <Text className={`text-sm ${color}`}>{formatDetailPrice(detail.quote)}</Text>
            <Text className={`text-sm ${color}`}>{formatDetailChangePct(detail.quote)}</Text>
          </View>
          {asOf ? <Text className="text-xs text-ink-subtle">{asOf}</Text> : null}
        </View>
      ) : (
        <View className="flex-1 min-w-0 flex-row items-center gap-xs">
          <Text className="text-base font-semibold text-ink" numberOfLines={1}>
            {detail?.name ?? detail?.code ?? '—'}
          </Text>
          {detail ? <Text className="text-sm text-ink-subtle">{detail.code}</Text> : null}
          {detail ? (
            <Text className="text-xs text-ink-muted bg-surface-sunken px-xs rounded-sm">
              {detail.market.toUpperCase()}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}
