import { SectionList, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import type { TradeItem, TradeItemCategory } from '@nvy/api-client';

import { Button, Spinner } from '~/ui';
import { formatAmount, formatQty, formatSignedAmount, pnlDirection } from './holdings.helpers';
import { quoteColorClass } from './use-quote-merge';
import { useHoldings } from './use-holdings';
import { useTrades } from './use-trades';
import { HOLDINGS_COPY } from './holdings-copy';

// 标的交易历史屏（025 US3，mockup HoldingsKit 屏2 baseline）。nav = 股票名+代码（名称取
// holding/closed 快照，回落流水行/代码）；有持仓时摘要条（持有·成本·累计盈亏，React Query
// 与持仓屏同 key 走缓存）；倒序流水 + 月份吸顶小标（SectionList sticky）+ 尾「已经到底了」。
// 买红/卖绿圆 badge；息税等非交易事件中性灰（不与买卖点混淆）+ XD 原始名保留。
// 资金行（code null）server 侧天然不命中本屏查询。

const COPY = HOLDINGS_COPY.trades;
const SCREEN_COPY = HOLDINGS_COPY.screen;

const TRADE_CATEGORIES: ReadonlySet<TradeItemCategory> = new Set(['buy', 'sell']);

// 类别 badge 静态 class 映射（NativeWind 静态提取，禁动态拼 class）。
const BADGE_STYLES = {
  buy: { box: 'border-quote-up bg-err-soft', text: 'text-quote-up' },
  sell: { box: 'border-quote-down bg-ok-soft', text: 'text-quote-down' },
  neutral: { box: 'border-line-strong bg-surface-sunken', text: 'text-ink-muted' },
} as const;

/** 类别圆 badge（买红描边 / 卖绿描边 / 其余中性灰）。 */
function CategoryBadge({ category }: { category: TradeItemCategory }) {
  const style =
    category === 'buy'
      ? BADGE_STYLES.buy
      : category === 'sell'
        ? BADGE_STYLES.sell
        : BADGE_STYLES.neutral;
  return (
    <View
      className={`w-8 h-8 rounded-full border items-center justify-center shrink-0 ${style.box}`}
    >
      <Text className={`text-sm font-semibold ${style.text}`}>{COPY.category[category].badge}</Text>
    </View>
  );
}

function FlowRow({ item }: { item: TradeItem }) {
  const isTrade = TRADE_CATEGORIES.has(item.category);
  const when = `${item.tradeDate}${item.tradeTime ? ` ${item.tradeTime}` : ''}`;
  return (
    <View className="flex-row items-center gap-sm bg-surface px-md py-sm border-b border-line-soft">
      <CategoryBadge category={item.category} />
      <View className="flex-1 min-w-0">
        {isTrade ? (
          <>
            <Text className="text-sm font-mono text-ink" numberOfLines={1}>
              {when}
            </Text>
            <Text className="text-xs font-mono text-ink-subtle mt-0.5" numberOfLines={1}>
              {formatAmount(item.price, 2)} × {formatQty(item.qty)} {SCREEN_COPY.sub.qtyUnit}
            </Text>
          </>
        ) : (
          <>
            <Text className="text-sm font-medium text-ink" numberOfLines={1}>
              {COPY.category[item.category].label}
            </Text>
            {/* XD 原始名保留不清洗（mockup DO-NOT）。 */}
            <Text className="text-xs font-mono text-ink-subtle mt-0.5" numberOfLines={1}>
              {item.name ? `${item.name} · ` : ''}
              {item.tradeDate}
            </Text>
          </>
        )}
      </View>
      <View className="items-end shrink-0">
        <Text className={`text-sm font-semibold ${isTrade ? 'text-ink' : 'text-ink-muted'}`}>
          {isTrade ? formatAmount(item.turnover) : formatSignedAmount(item.amount)}
        </Text>
        {isTrade ? (
          <Text className="text-xs text-ink-subtle mt-0.5">
            {COPY.feePrefix} {formatAmount(item.fee)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export interface TradeHistoryScreenProps {
  market: string;
  code: string;
}

export function TradeHistoryScreen({ market, code }: TradeHistoryScreenProps) {
  const trades = useTrades({ market, code });
  // 与持仓屏同 query key 走缓存：当前持仓摘要条 + nav 名称来源。
  const holdings = useHoldings();
  const holding = holdings.current.find((h) => h.market === market && h.code === code);
  const closed = holdings.closed.find((c) => c.market === market && c.code === code);

  const name = holding?.name ?? closed?.name ?? trades.items[0]?.name ?? code;
  const title = `${name} ${code}`;
  const cumPnlClass = quoteColorClass(pnlDirection(holding?.cumPnl ?? null));

  if (trades.status === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-surface">
        <Stack.Screen options={{ title }} />
        <Spinner />
      </View>
    );
  }

  if (trades.status === 'error') {
    return (
      <View className="flex-1 items-center justify-center gap-md bg-surface px-md">
        <Stack.Screen options={{ title }} />
        <Text className="text-base text-ink-muted">{COPY.load.error}</Text>
        <Button label={COPY.load.retry} onPress={() => trades.refetch()} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-surface-sunken">
      <Stack.Screen options={{ title }} />
      {holding ? (
        <View className="flex-row flex-wrap items-center gap-x-sm bg-surface-sunken px-md py-sm border-b border-line-soft">
          <Text className="text-xs text-ink-muted">
            {COPY.summary.hold}{' '}
            <Text className="text-xs font-semibold text-ink">{formatQty(holding.qty)}</Text>{' '}
            {SCREEN_COPY.sub.qtyUnit}
          </Text>
          <Text className="text-xs text-ink-subtle">·</Text>
          <Text className="text-xs text-ink-muted">
            {COPY.summary.cost}{' '}
            <Text className="text-xs text-ink">{formatAmount(holding.unitCost, 3)}</Text>
          </Text>
          <Text className="text-xs text-ink-subtle">·</Text>
          <Text className="text-xs text-ink-muted">
            {COPY.summary.cumPnl}{' '}
            <Text className={`text-xs font-semibold ${cumPnlClass}`}>
              {formatSignedAmount(holding.cumPnl)}
            </Text>
          </Text>
        </View>
      ) : null}
      <SectionList
        sections={trades.groups.map((g) => ({ title: g.month, data: g.items }))}
        keyExtractor={(it) => it.id}
        renderItem={({ item }) => <FlowRow item={item} />}
        renderSectionHeader={({ section }) => (
          <Text className="text-xs font-mono text-ink-subtle bg-surface-sunken px-md py-xs border-b border-line-soft">
            {section.title}
          </Text>
        )}
        stickySectionHeadersEnabled
        className="flex-1"
        ListEmptyComponent={
          <View className="items-center px-xl py-2xl">
            <Text className="text-base font-medium text-ink-muted">{COPY.empty.title}</Text>
          </View>
        }
        ListFooterComponent={
          trades.items.length > 0 ? (
            <Text className="text-sm text-ink-subtle text-center py-lg">{COPY.end}</Text>
          ) : null
        }
      />
    </View>
  );
}
