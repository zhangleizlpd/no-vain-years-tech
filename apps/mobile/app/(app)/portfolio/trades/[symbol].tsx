import { Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { HOLDINGS_COPY, parseSymbol, TradeHistoryScreen } from '~/portfolio';
import { Button, SafeAreaView } from '~/ui';

// 标的交易历史动态路由（025 US3）。param `symbol` = canonical `cn:603915`（014 体例）→
// 解析 market/code；非法 symbol → 占位 + 返回（014 [symbol] 兜底同款）。屏体在 ~/portfolio。
export default function TradeHistoryRoute() {
  const router = useRouter();
  const { symbol } = useLocalSearchParams<{ symbol: string }>();
  const parsed = typeof symbol === 'string' ? parseSymbol(symbol) : null;

  if (!parsed) {
    return (
      <SafeAreaView
        edges={['top']}
        className="flex-1 items-center justify-center gap-md bg-surface px-xl"
      >
        <Text className="text-base font-medium text-ink-muted">
          {HOLDINGS_COPY.trades.invalid.title}
        </Text>
        <Button label={HOLDINGS_COPY.trades.invalid.back} onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  return <TradeHistoryScreen market={parsed.market} code={parsed.code} />;
}
