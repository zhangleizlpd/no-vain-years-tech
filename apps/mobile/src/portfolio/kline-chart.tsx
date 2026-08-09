import { useState } from 'react';
import { type LayoutChangeEvent, Text, View } from 'react-native';
import Svg, { G, Line, Rect, Text as SvgText } from 'react-native-svg';

import { colors } from '~/theme';
import {
  buildChartGeometry,
  type Candle,
  type CandleDirection,
  DEFAULT_CHART_DIMS,
  hitTestIndex,
  ohlcLegend,
} from './kline-geometry';
import { formatLargeAmount } from './stock-detail.helpers';
import { quoteColorClass } from './use-quote-merge';
import { STOCK_DETAIL_COPY } from './stock-detail-copy';

// 纯 SVG 蜡烛图 + 成交量副图 + 十字光标（014 US4 / FR-M04·M11）。port mockup KLineChart.jsx：
// 蜡烛 Rect+影线 Line / 量副图 Rect / 右价格轴 / 底日期轴 / 网格；涨红跌绿复用 quote token
// （SVG fill/stroke 不吃 className → 从 ~/theme colors 取色值，hex 不落组件源，对齐 DeviceIcon 先例 +
// SC-M06）。几何折算全在 kline-geometry（vitest）；本组件只渲染 + 触摸驱动十字光标。
// a11y（FR-M11 C1）：OHLC legend 挂 accessibilityLabel 使现价/涨跌/选中点 OHLCV 屏读可达；
// 涨跌色非唯一载体（legend 文本 开/高/低/收 + changePct 带 +/- 符号）。

const CHART = STOCK_DETAIL_COPY.chart;

// 方向 → SVG 色值（蜡烛实体/影线/量柱；RN Text 涨跌色另走 quoteColorClass className）。
const DIR_FILL: Record<CandleDirection, string> = {
  up: colors.quote.up,
  down: colors.quote.down,
};

export interface KLineChartProps {
  candles: Candle[];
  period: string;
}

export function KLineChart({ candles, period }: KLineChartProps) {
  const [width, setWidth] = useState(DEFAULT_CHART_DIMS.width);
  const [hover, setHover] = useState<number | null>(null);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const n = candles.length;
  if (n === 0) {
    return (
      <View className="items-center py-2xl" onLayout={onLayout}>
        <Text className="text-sm text-ink-subtle">{CHART.empty}</Text>
      </View>
    );
  }

  const dims = { ...DEFAULT_CHART_DIMS, width };
  const geo = buildChartGeometry(candles, period, dims);
  const totalH = dims.mainH + dims.gap + dims.volH + dims.padB;
  const plotW = width - dims.padR;

  // hover=null → 默认末根（最新），保证 legend/e2e 有稳定 frame（非确定的拖拽不参与单测，
  // per memory playwright rngh longpress drivable）。
  const legend = ohlcLegend(candles, hover ?? n - 1);
  const hoverGeo = hover != null ? geo.candles[hover] : undefined;

  const onTouch = (locationX: number) => {
    const i = hitTestIndex(locationX, dims, n);
    if (i >= 0) setHover(i);
  };

  return (
    <View onLayout={onLayout}>
      {/* OHLC legend（a11y：选中/最新蜡烛关键数值屏读可达，FR-M11）。 */}
      <OhlcLegend legend={legend} />

      <Svg
        width={width}
        height={totalH}
        onTouchStart={(e) => onTouch(e.nativeEvent.locationX)}
        onTouchMove={(e) => onTouch(e.nativeEvent.locationX)}
      >
        {/* 网格 + 右价格轴 */}
        {geo.priceTicks.map((t, i) => (
          <G key={`p${i}`}>
            <Line x1={0} x2={plotW} y1={t.y} y2={t.y} stroke={colors.line.soft} strokeWidth={1} />
            <SvgText
              x={width - 2}
              y={t.y + 3.5}
              textAnchor="end"
              fontSize={9.5}
              fill={colors.ink.subtle}
            >
              {t.value.toFixed(0)}
            </SvgText>
          </G>
        ))}

        {/* 量副图基线 */}
        <Line
          x1={0}
          x2={plotW}
          y1={geo.baselineY}
          y2={geo.baselineY}
          stroke={colors.line.soft}
          strokeWidth={1}
        />

        {/* 蜡烛（影线 + 实体）+ 量柱 */}
        {geo.candles.map((c) => {
          const fill = DIR_FILL[c.direction];
          return (
            <G key={c.index}>
              <Line x1={c.x} x2={c.x} y1={c.wickY1} y2={c.wickY2} stroke={fill} strokeWidth={1} />
              <Rect x={c.bodyX} y={c.bodyY} width={c.bodyW} height={c.bodyH} fill={fill} />
              <Rect
                x={c.bodyX}
                y={c.volY}
                width={c.bodyW}
                height={c.volBarH}
                fill={fill}
                opacity={0.85}
              />
            </G>
          );
        })}

        {/* 底日期轴 */}
        {geo.dateTicks.map((t) => (
          <SvgText
            key={`d${t.index}`}
            x={Math.min(plotW - 14, Math.max(14, t.x))}
            y={totalH - 4}
            textAnchor="middle"
            fontSize={9.5}
            fill={colors.ink.subtle}
          >
            {t.label}
          </SvgText>
        ))}

        {/* 十字光标（触摸驱动；hover 命中蜡烛 → 竖/横虚线 + 价格标） */}
        {hoverGeo ? (
          <G>
            <Line
              x1={hoverGeo.x}
              x2={hoverGeo.x}
              y1={0}
              y2={geo.baselineY}
              stroke={colors.ink.subtle}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <Line
              x1={0}
              x2={plotW}
              y1={hoverGeo.bodyY}
              y2={hoverGeo.bodyY}
              stroke={colors.ink.subtle}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          </G>
        ) : null}
      </Svg>

      {/* 成交量 legend（选中/最新蜡烛量） */}
      {legend ? (
        <View className="flex-row gap-xs px-xs pt-xs">
          <Text className="text-xs text-ink-subtle">{CHART.volume}</Text>
          <Text className={`text-xs font-mono ${quoteColorClass(legend.direction)}`}>
            {formatLargeAmount(String(legend.candle.volume))}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** OHLC legend 行（日期 + 开/高/低/收 + 涨跌；高恒红低恒绿，开/收/涨跌随方向）。 */
function OhlcLegend({ legend }: { legend: ReturnType<typeof ohlcLegend> }) {
  if (!legend) return null;
  const dirClass = quoteColorClass(legend.direction);
  return (
    <View
      className="flex-row flex-wrap items-center gap-sm px-xs pb-sm"
      accessibilityLabel={ohlcA11yLabel(legend)}
    >
      <Text className="text-xs text-ink-muted font-mono">{legend.candle.tradeDate}</Text>
      <LegendItem label={CHART.legend.open} value={legend.candle.open} colorClass={dirClass} />
      <LegendItem label={CHART.legend.high} value={legend.candle.high} colorClass="text-quote-up" />
      <LegendItem label={CHART.legend.low} value={legend.candle.low} colorClass="text-quote-down" />
      <LegendItem label={CHART.legend.close} value={legend.candle.close} colorClass={dirClass} />
      <View className="flex-row gap-xs">
        <Text className="text-xs text-ink-subtle">{CHART.legend.change}</Text>
        <Text className={`text-xs font-mono ${dirClass}`}>{formatSignedPct(legend.changePct)}</Text>
      </View>
    </View>
  );
}

/** legend 单项（label 灰 + value mono 涨跌色）。 */
function LegendItem({
  label,
  value,
  colorClass,
}: {
  label: string;
  value: number;
  colorClass: string;
}) {
  return (
    <View className="flex-row gap-xs">
      <Text className="text-xs text-ink-subtle">{label}</Text>
      <Text className={`text-xs font-mono ${colorClass}`}>{value.toFixed(2)}</Text>
    </View>
  );
}

/** 带符号涨跌幅 %（color 非唯一载体，a11y）。 */
function formatSignedPct(pct: number): string {
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/** OHLC 屏读标签：「2026-06-01 开 100.00 高 110.00 低 95.00 收 105.00 涨跌 +5.00%」。 */
function ohlcA11yLabel(legend: NonNullable<ReturnType<typeof ohlcLegend>>): string {
  const { candle, changePct } = legend;
  const L = CHART.legend;
  return [
    candle.tradeDate,
    `${L.open} ${candle.open.toFixed(2)}`,
    `${L.high} ${candle.high.toFixed(2)}`,
    `${L.low} ${candle.low.toFixed(2)}`,
    `${L.close} ${candle.close.toFixed(2)}`,
    `${L.change} ${formatSignedPct(changePct)}`,
  ].join(' ');
}
