import { Text, View } from 'react-native';
import type { InstrumentDetailResponse } from '@nvy/api-client';

import {
  detailQuoteDirection,
  formatAsOf,
  formatDetailChange,
  formatDetailChangePct,
  formatDetailPrice,
  formatLargeAmount,
  formatPercentValue,
  formatRatio,
} from './stock-detail.helpers';
import { quoteColorClass } from './use-quote-merge';
import { STOCK_DETAIL_COPY } from './stock-detail-copy';

// 报价 header（014 US3 / FR-M01·M02）。图表 Tab 首屏：最新=收盘大字（mono）+ 涨跌额/幅（涨红跌绿
// + +/- 符号 a11y 色非唯一载体）+ 数据新鲜度小字（asOf · 收盘，D10）+ EOD 字段网格（昨收/PE TTM/
// PB/股息率/总/流通市值，来自 015 EP3 quote + valuation）+ 阶段二盘中字段 dashed 预留区（不重排，
// FR-M02）。缺字段 '--'。涨跌方向→token / 格式化逻辑落 stock-detail.helpers（vitest）；
// presentational 渲染走 Playwright e2e（per mono 测试分层）。

const COPY = STOCK_DETAIL_COPY.quote;

export interface QuoteHeaderProps {
  detail: InstrumentDetailResponse;
}

export function QuoteHeader({ detail }: QuoteHeaderProps) {
  const { quote, valuation } = detail;
  const color = quoteColorClass(detailQuoteDirection(quote));
  const asOf = formatAsOf(quote);

  return (
    <View className="bg-surface px-md py-md gap-sm">
      {/* 最新价 + 涨跌额/幅（涨红跌绿，mono 数字）。 */}
      <View className="flex-row items-end gap-sm">
        <Text className={`text-3xl font-mono font-semibold ${color}`}>
          {formatDetailPrice(quote)}
        </Text>
        <View className="pb-0.5">
          <Text className={`text-base font-mono ${color}`}>{formatDetailChange(quote)}</Text>
          <Text className={`text-base font-mono ${color}`}>{formatDetailChangePct(quote)}</Text>
        </View>
      </View>

      {/* 数据新鲜度（D10）：无 asOf → 不渲染。 */}
      {asOf ? <Text className="text-xs text-ink-subtle">{asOf}</Text> : null}

      {/* EOD 字段三列网格（quote + valuation；估值缺整块 → 逐字段 '--'）。 */}
      <View className="flex-row flex-wrap">
        <QuoteField label={COPY.fields.prevClose} value={formatRatio(quote.prevClose)} />
        <QuoteField label={COPY.fields.peTtm} value={formatRatio(valuation?.peTtm ?? null, 1)} />
        <QuoteField label={COPY.fields.pb} value={formatRatio(valuation?.pb ?? null)} />
        <QuoteField
          label={COPY.fields.dividendYield}
          value={formatPercentValue(valuation?.dividendYield ?? null)}
        />
        <QuoteField
          label={COPY.fields.marketCap}
          value={formatLargeAmount(valuation?.marketCap ?? null)}
        />
        <QuoteField
          label={COPY.fields.circMarketCap}
          value={formatLargeAmount(valuation?.circMarketCap ?? null)}
        />
      </View>

      {/* 阶段二盘中字段 dashed 预留区（不重排，FR-M02）。 */}
      <View className="border border-dashed border-line-soft rounded-md px-sm py-sm">
        <Text className="text-xs text-ink-muted text-center">{COPY.phase2Hint}</Text>
      </View>
    </View>
  );
}

/** 报价网格单字段（label 上 / value 下，三列布局，等宽数字 mono）。 */
function QuoteField({ label, value }: { label: string; value: string }) {
  return (
    <View className="w-1/3 py-xs">
      <Text className="text-xs text-ink-subtle">{label}</Text>
      <Text className="text-sm font-mono text-ink">{value}</Text>
    </View>
  );
}
