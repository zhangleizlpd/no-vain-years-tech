import { Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { canDrillDown, parseSymbol, StockDetailScreen, STOCK_DETAIL_COPY } from '~/portfolio';
import { Button, SafeAreaView } from '~/ui';

// 股票详情动态路由（014 US3）。param `symbol` = canonical `cn:600519` → 解析 market/code。
// us gate（D9）/ 非法 symbol → 占位「美股即将上线」（016 未同步 us，进去全 `--`）。
// 屏体在 ~/portfolio（per fe-directory-structure：app/ 仅薄 route）；详情正文 T007 接 StockDetailScreen。
export default function StockDetailRoute() {
  const router = useRouter();
  const { symbol } = useLocalSearchParams<{ symbol: string }>();
  const parsed = typeof symbol === 'string' ? parseSymbol(symbol) : null;

  if (!parsed || !canDrillDown(parsed.market)) {
    return (
      <SafeAreaView
        edges={['top']}
        className="flex-1 items-center justify-center gap-md bg-surface px-xl"
      >
        <Text className="text-base font-medium text-ink-muted">
          {STOCK_DETAIL_COPY.usGate.title}
        </Text>
        <Text className="text-sm text-ink-subtle text-center">{STOCK_DETAIL_COPY.usGate.sub}</Text>
        <Button label={STOCK_DETAIL_COPY.usGate.back} onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  return <StockDetailScreen market={parsed.market} code={parsed.code} />;
}
