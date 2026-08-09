import { Pressable, Text, View } from 'react-native';
import type { ClosedPositionItem, HoldingItem, QuoteItem } from '@nvy/api-client';

import { MarketBadge } from '~/ui';
import {
  floatPnl,
  floatPnlPct,
  formatAmount,
  formatQty,
  formatRatioPct,
  formatSignedAmount,
  marketValue,
  pnlDirection,
} from './holdings.helpers';
import { formatPrice, quoteColorClass } from './use-quote-merge';
import { HOLDINGS_COPY } from './holdings-copy';

// 持仓行 + 已清仓行（025 US2，mockup HoldingsKit baseline）。名称区沿 013 范式（名称主行 +
// MarketBadge/code 副行）。持仓行 4 列：名称 / 市值·数量 / 现价·成本 / 盈亏（红绿）；
// 行情合成列（市值/现价/浮动盈亏）降级行（quotable=false）显 `--` + 「无行情」角标，
// 快照字段（仓位/天数/累计盈亏）正常。已清仓行：日期区间 + 总盈亏（红绿）+ 战绩次级条。
// presentational —— 渲染/涨跌色走 Playwright；合成/格式化纯函数走 vitest（mono 测试分层）。

const COPY = HOLDINGS_COPY.screen;

/** 数值双行单元（主行 + 灰副行，右对齐）。 */
function NumCell({
  main,
  sub,
  mainClass = 'text-ink',
  subClass = 'text-ink-subtle',
}: {
  main: string;
  sub: string;
  mainClass?: string;
  subClass?: string;
}) {
  return (
    <View className="flex-1 min-w-0 items-end">
      <Text className={`text-sm font-semibold ${mainClass}`} numberOfLines={1}>
        {main}
      </Text>
      <Text className={`text-xs mt-0.5 ${subClass}`} numberOfLines={1}>
        {sub}
      </Text>
    </View>
  );
}

/** 名称区（名称主行 + MarketBadge/code 副行，013 列表行范式）。 */
function NameCell({ name, market, code }: { name: string; market: string; code: string }) {
  return (
    <View className="w-24 shrink-0">
      <Text className="text-base font-medium text-ink" numberOfLines={1}>
        {name}
      </Text>
      <View className="flex-row items-center gap-xs mt-0.5">
        <MarketBadge code={code} market={market} />
        <Text className="text-xs font-mono text-ink-subtle">{code}</Text>
      </View>
    </View>
  );
}

/** 次级信息条分隔点。 */
function Dot() {
  return <Text className="text-xs text-ink-subtle">·</Text>;
}

export interface HoldingRowProps {
  item: HoldingItem;
  /** 015 client-side merge 行情（降级行/未就位 → undefined → 合成列 '--'）。 */
  quote: QuoteItem | undefined;
  onPress: () => void;
}

export function HoldingRow({ item, quote, onPress }: HoldingRowProps) {
  const pnl = floatPnl(quote, item);
  const pnlClass = quoteColorClass(pnlDirection(pnl));
  const cumPnlClass = quoteColorClass(pnlDirection(item.cumPnl));
  const degraded = !item.quotable;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.name} ${item.code}`}
      className="bg-surface px-md py-sm border-b border-line-soft"
    >
      <View className="flex-row items-start gap-sm">
        <NameCell name={item.name} market={item.market} code={item.code} />
        <NumCell
          main={formatAmount(marketValue(quote, item))}
          sub={`${formatQty(item.qty)} ${COPY.sub.qtyUnit}`}
          mainClass={degraded ? 'text-ink-subtle' : 'text-ink'}
        />
        <NumCell
          main={degraded ? '--' : formatPrice(quote)}
          sub={formatAmount(item.unitCost, 3)}
          mainClass={degraded ? 'text-ink-subtle' : 'text-ink'}
        />
        <NumCell
          main={degraded ? '--' : formatSignedAmount(pnl)}
          sub={degraded ? '--' : formatRatioPct(floatPnlPct(quote, item), true)}
          mainClass={degraded ? 'text-ink-subtle' : pnlClass}
          subClass={degraded ? 'text-ink-subtle' : pnlClass}
        />
      </View>
      <View className="flex-row flex-wrap items-center gap-x-sm mt-xs">
        <Text className="text-xs text-ink-subtle">
          {COPY.sub.weight} {formatRatioPct(item.weightPct)}
        </Text>
        <Dot />
        <Text className="text-xs text-ink-subtle">
          {COPY.sub.days} {item.holdDays ?? '--'} {COPY.sub.daysUnit}
        </Text>
        <Dot />
        <Text className="text-xs text-ink-subtle">
          {COPY.sub.cumPnl}{' '}
          <Text className={`text-xs ${cumPnlClass}`}>{formatSignedAmount(item.cumPnl)}</Text>
        </Text>
        {degraded ? (
          <Text className="text-xs text-ink-subtle bg-surface-sunken rounded-sm px-xs">
            {COPY.noQuote}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export interface ClosedRowProps {
  item: ClosedPositionItem;
  onPress: () => void;
}

export function ClosedRow({ item, onPress }: ClosedRowProps) {
  const pnlClass = quoteColorClass(pnlDirection(item.totalPnl));
  const vsIndexClass = quoteColorClass(pnlDirection(item.vsIndexPct));
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.name} ${item.code}`}
      className="bg-surface px-md py-sm border-b border-line-soft"
    >
      <View className="flex-row items-start gap-sm">
        <NameCell name={item.name} market={item.market} code={item.code} />
        <View className="flex-1 min-w-0">
          <Text className="text-xs font-mono text-ink-muted" numberOfLines={1}>
            {item.openDate} → {item.closeDate}
          </Text>
          <Text className="text-xs text-ink-subtle mt-0.5">{COPY.sub.openToClose}</Text>
        </View>
        <View className="items-end shrink-0">
          <Text className={`text-base font-bold ${pnlClass}`}>
            {formatSignedAmount(item.totalPnl)}
          </Text>
          <Text className={`text-xs mt-0.5 ${pnlClass}`}>
            {formatRatioPct(item.totalPnlPct, true)}
          </Text>
        </View>
      </View>
      <View className="flex-row flex-wrap items-center gap-x-sm mt-xs">
        <Text className="text-xs text-ink-subtle">
          {COPY.sub.buyAvg} {formatAmount(item.buyAvg)}
        </Text>
        <Dot />
        <Text className="text-xs text-ink-subtle">
          {COPY.sub.sellAvg} {formatAmount(item.sellAvg)}
        </Text>
        <Dot />
        <Text className="text-xs text-ink-subtle">
          {COPY.sub.vsIndex}{' '}
          <Text className={`text-xs ${vsIndexClass}`}>{formatRatioPct(item.vsIndexPct, true)}</Text>
        </Text>
        <Dot />
        <Text className="text-xs text-ink-subtle">
          {COPY.sub.fee} {formatAmount(item.fee)}
        </Text>
      </View>
    </Pressable>
  );
}
