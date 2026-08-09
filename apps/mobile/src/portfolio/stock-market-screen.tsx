import { Fragment } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { MarketItem } from '@nvy/api-client';

import { Card, Divider } from '~/settings/primitives';
import { Button, ErrorRow, Spinner } from '~/ui';
import { MARKET_COPY } from './market-copy';
import { MarketRow } from './market-row';
import { useMarketPreferences } from './use-market-preferences';

// 证券市场准入设置屏（011 US3-US6）。分核心/海外两组、9 行固定顺序（顺序来自 server
// 响应，FR-M01）；首屏 loading / GET 失败 retry 态（不渲染错误默认态，Mobile Edge）；
// min-1 客户端预判轻提示 + 切换失败 errorToast。视觉复用 Card/Divider + ~/theme token
// （0 hex 字面量，SC-M06）；导航标题由 settings/_layout 的 Stack.Screen 提供。
function MarketGroup({
  title,
  items,
  togglingMarket,
  onToggle,
}: {
  title: string;
  items: MarketItem[];
  togglingMarket: string | null;
  onToggle: (marketCode: string, next: boolean) => void;
}) {
  return (
    <View className="gap-sm">
      <Text className="text-sm text-ink-muted px-xs" accessibilityRole="header">
        {title}
      </Text>
      <Card>
        {items.map((item, i) => (
          <Fragment key={item.marketCode}>
            {i > 0 ? <Divider /> : null}
            <MarketRow item={item} busy={togglingMarket === item.marketCode} onToggle={onToggle} />
          </Fragment>
        ))}
      </Card>
    </View>
  );
}

export function StockMarketScreen() {
  const { markets, status, toggle, togglingMarket, hint, errorToast, refetch } =
    useMarketPreferences();

  if (status === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-surface-sunken">
        <Spinner />
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View className="flex-1 items-center justify-center gap-md bg-surface-sunken px-md">
        <Text className="text-base text-ink-muted">{MARKET_COPY.load.error}</Text>
        <Button label={MARKET_COPY.load.retry} onPress={() => void refetch()} />
      </View>
    );
  }

  const core = markets.filter((m) => m.group === 'core');
  const overseas = markets.filter((m) => m.group === 'overseas');

  return (
    <ScrollView
      className="flex-1 bg-surface-sunken"
      contentContainerClassName="px-md pt-md pb-xl gap-md"
    >
      {hint ? (
        <View
          className="bg-warn-soft rounded-md px-md py-sm"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          <Text className="text-sm text-ink">{hint}</Text>
        </View>
      ) : null}
      {errorToast ? <ErrorRow text={errorToast} /> : null}
      <MarketGroup
        title={MARKET_COPY.groups.core}
        items={core}
        togglingMarket={togglingMarket}
        onToggle={toggle}
      />
      <MarketGroup
        title={MARKET_COPY.groups.overseas}
        items={overseas}
        togglingMarket={togglingMarket}
        onToggle={toggle}
      />
    </ScrollView>
  );
}
