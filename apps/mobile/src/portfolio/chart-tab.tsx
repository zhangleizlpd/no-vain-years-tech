import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  type InstrumentDetailResponse,
  MarketdataControllerBarsAdjust,
  MarketdataControllerBarsPeriod,
  useMarketdataControllerBars,
} from '@nvy/api-client';

import { Button, ErrorRow, Spinner } from '~/ui';
import { KLineChart } from './kline-chart';
import { QuoteHeader } from './quote-header';
import { downsample, parseBars } from './kline-geometry';
import { STOCK_DETAIL_COPY } from './stock-detail-copy';

// 图表 Tab（014 US4 / FR-M04）：报价 header（T008）+ 周期 pill（日/周/月/季/年）+ 复权 segment
// （不/前/后）→ 切换 useMarketdataControllerBars(symbol,{period,adjust}) 重拉 + 纯 SVG K线。
// 015 EP4 直调 client-side（ADR-0048，014 server 不服务行情）。不含分时/逐笔（阶段二）。
// presentational + hook 编排 → Playwright e2e + contract-smoke（per mono 测试分层）。

const CHART = STOCK_DETAIL_COPY.chart;

const PERIODS = [
  { key: MarketdataControllerBarsPeriod.day, label: CHART.periods.day },
  { key: MarketdataControllerBarsPeriod.week, label: CHART.periods.week },
  { key: MarketdataControllerBarsPeriod.month, label: CHART.periods.month },
  { key: MarketdataControllerBarsPeriod.quarter, label: CHART.periods.quarter },
  { key: MarketdataControllerBarsPeriod.year, label: CHART.periods.year },
] as const;

const ADJUSTS = [
  { key: MarketdataControllerBarsAdjust.none, label: CHART.adjusts.none },
  { key: MarketdataControllerBarsAdjust.forward, label: CHART.adjusts.forward },
  { key: MarketdataControllerBarsAdjust.backward, label: CHART.adjusts.backward },
] as const;

// 渲染密度上限（年 K 多年抽样，NFR）。
const MAX_BARS = 120;

export interface ChartTabProps {
  detail: InstrumentDetailResponse;
  symbol: string;
}

export function ChartTab({ detail, symbol }: ChartTabProps) {
  const [period, setPeriod] = useState<MarketdataControllerBarsPeriod>(
    MarketdataControllerBarsPeriod.day,
  );
  const [adjust, setAdjust] = useState<MarketdataControllerBarsAdjust>(
    MarketdataControllerBarsAdjust.none,
  );

  const barsQuery = useMarketdataControllerBars(symbol, { period, adjust });
  const items = barsQuery.data?.data.items;
  const candles = useMemo(() => downsample(parseBars(items ?? []), MAX_BARS), [items]);

  return (
    <View>
      <QuoteHeader detail={detail} />

      {/* 周期 pill（日/周/月/季/年） */}
      <View className="flex-row gap-xs px-md pt-sm">
        {PERIODS.map((p) => (
          <Segment
            key={p.key}
            label={p.label}
            active={p.key === period}
            onPress={() => setPeriod(p.key)}
          />
        ))}
      </View>

      {/* 复权 segment（不/前/后复权） */}
      <View className="flex-row gap-xs px-md py-sm">
        {ADJUSTS.map((a) => (
          <Segment
            key={a.key}
            label={a.label}
            active={a.key === adjust}
            onPress={() => setAdjust(a.key)}
          />
        ))}
      </View>

      {/* K线区（idle/loading/error/success 四态） */}
      {barsQuery.isPending ? (
        <View className="items-center py-2xl">
          <Spinner />
        </View>
      ) : barsQuery.isError ? (
        <View className="items-center gap-md px-md py-2xl">
          <ErrorRow text={CHART.error} />
          <Button label={CHART.retry} onPress={() => void barsQuery.refetch()} />
        </View>
      ) : (
        <View className="px-xs">
          <KLineChart candles={candles} period={period} />
        </View>
      )}
    </View>
  );
}

/** 周期/复权切换按钮（选中 surface-sunken 底 + brand 字；a11y selected）。 */
function Segment({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      className={`rounded-md px-sm py-xs ${active ? 'bg-surface-sunken' : ''}`}
    >
      <Text className={`text-sm ${active ? 'text-brand-500' : 'text-ink-subtle'}`}>{label}</Text>
    </Pressable>
  );
}
