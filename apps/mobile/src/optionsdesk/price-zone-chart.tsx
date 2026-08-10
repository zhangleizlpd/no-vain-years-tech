// 046 T021 — 区间时序（FR-006 ~ FR-010）：**`react-native-svg` 折线 + 纯 `View` 四区间背景带**。
//
// 🚨 **零新第三方运行时依赖**（SC-007）：不引任何图表库、不引 `expo-linear-gradient`（未装）。
//    `react-native-svg` 仓内已装（15.12.1，锚点 `~/chat/chat-drawer.tsx`）⇒ 不算新依赖。
//    背景带走纯 `View`（045 `zone-band.tsx` 先例：矩形 + 定位是 RN 原生能力，SVG 在此零收益）。
//
// 🚨 **色带语义单源** = 045 `zone-band.tsx` 导出的 `ZONE_TONE`（那边横向、这边纵向，同一套五区间）。
// 🚨 **FR-010**：切窗口**不改**四区间边界（边界只依赖锚）；窗口内价格穿出带外时**纵轴跟着扩**，
//    绝不裁掉数据 —— 判定全在 `underlying-detail.rules.ts` 的 `chartAxis` / `zoneRects`。
// 🚨 **序列侧独立降级**（state_branch #15）：折线读失败 / 为空时，**四区间带照常渲染**
//    （锚是自产数据，不依赖行情），只在折线区显式降级 —— 禁整页失败、禁整块空白。
//
// 几何在 rules（vitest 覆盖）；渲染 / chip 交互走 T024 E2E。
import { useState } from 'react';
import { LayoutChangeEvent, Pressable, Text, View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import type { DailyBarItem } from '@nvy/api-client';

import { colors } from '~/theme';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { formatPriceText } from './price-format.rules';
import {
  type FreshnessTier,
  chartAxis,
  freshnessOf,
  polylinePoints,
  priceToY,
  seriesAsOf,
  seriesCloses,
  seriesRangeLabel,
  zoneRects,
  type BlockState,
  type ZoneBounds,
} from './underlying-detail.rules';
import { TIME_SERIES_WINDOWS, type TimeSeriesWindow } from './window-granularity.rules';
import { ZONE_TONE } from './zone-band';

const COPY = OPTIONSDESK_COPY.underlyingDetail.series;
const ZONE_LABEL = OPTIONSDESK_COPY.radar.zoneLabels;

const CHART_HEIGHT = 150;
const LINE_WIDTH = 1.6;
const AXIS_LABEL_OFFSET = 11;

export interface PriceZoneChartProps {
  /** 四区间边界（锚缺失 / 退化 ⇒ null，此时只画折线）。 */
  bounds: ZoneBounds | null;
  items: readonly DailyBarItem[];
  /** 序列侧自己的成败（**与锚卡侧互不牵连**）。 */
  state: BlockState;
  window: TimeSeriesWindow;
  onWindowChange: (window: TimeSeriesWindow) => void;
  onRetry: () => void;
  /** 降级时显式说明「另一侧还好着」（mockup 帧⑤）。 */
  anchorAsof: string | null;
  today: string;
  /** 序列 asOf 的新鲜度档 —— 由 bars 端点下发（判据在 server，见 FR-020）。 */
  freshnessTier: FreshnessTier;
  testID?: string;
}

export function PriceZoneChart({
  bounds,
  items,
  state,
  window,
  onWindowChange,
  onRetry,
  anchorAsof,
  today,
  freshnessTier,
  testID = 'optionsdesk-detail-series',
}: PriceZoneChartProps) {
  // 折线要绝对像素宽 ⇒ 量一次。量到之前不画线（画不出正确形状的线不如不画）。
  const [chartWidth, setChartWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setChartWidth(e.nativeEvent.layout.width);

  const ok = state === 'ready';
  const closes = ok ? seriesCloses(items) : [];
  const axis = chartAxis(closes, bounds);
  const points =
    ok && chartWidth > 0 && axis !== null
      ? polylinePoints(closes, axis, chartWidth, CHART_HEIGHT)
      : '';
  const firstTradeDate = ok && items.length > 0 ? (items[0] as DailyBarItem).tradeDate : null;
  const freshness = freshnessOf(ok ? seriesAsOf(items) : null, ok ? freshnessTier : 'UNAVAILABLE');

  return (
    <View className="gap-sm rounded-md border border-line bg-surface px-md py-sm" testID={testID}>
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-semibold text-ink">{COPY.title}</Text>
        {/* 窗口 chip 行（FR-008，四档恒定 ⇒ **不需要横滑容器**，也就绕开了
            「width class 不约束 ScrollView frame」那个 NativeWind web 坑）。 */}
        <View className="flex-row gap-xs">
          {TIME_SERIES_WINDOWS.map((w) => {
            const on = w === window;
            return (
              <Pressable
                key={w}
                onPress={() => onWindowChange(w)}
                accessibilityRole="button"
                accessibilityLabel={w}
                accessibilityState={{ selected: on }}
                testID={`${testID}-window-${w}`}
                className={`rounded-full border px-sm py-0.5 ${
                  on ? 'border-brand-500 bg-brand-soft' : 'border-line bg-surface'
                }`}
              >
                <Text className={`text-xs ${on ? 'text-brand-500' : 'text-ink-muted'}`}>{w}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* 画布：背景带（View）在底、折线（SVG）在上、V/W 界线与标签在最上。 */}
      <View style={{ height: CHART_HEIGHT }} onLayout={onLayout} testID={`${testID}-canvas`}>
        {axis !== null && bounds !== null
          ? zoneRects(bounds, axis, CHART_HEIGHT).map((rect) => (
              <View
                key={rect.zone}
                className={`absolute left-0 right-0 ${ZONE_TONE[rect.zone].className}`}
                style={{
                  top: rect.top,
                  height: rect.height,
                  opacity: ZONE_TONE[rect.zone].opacity,
                }}
                testID={`${testID}-zone-${rect.zone}`}
              >
                <Text className="absolute right-1 top-0.5 text-[9px] text-ink-muted">
                  {ZONE_LABEL[rect.zone]}
                </Text>
              </View>
            ))
          : null}

        {points.length > 0 ? (
          <Svg width={chartWidth} height={CHART_HEIGHT} testID={`${testID}-line`}>
            <Polyline
              points={points}
              fill="none"
              stroke={colors.ink.DEFAULT}
              strokeWidth={LINE_WIDTH}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </Svg>
        ) : null}

        {axis !== null && bounds !== null ? (
          <>
            <AxisLine
              y={priceToY(bounds.v, axis, CHART_HEIGHT)}
              label={`V ${formatPriceText(bounds.v)}`}
              lineClassName="bg-line-strong"
              textClassName="text-ink-muted"
            />
            {/* W = 愿买价锚：红色加粗（与 045 色带的 W 界线同语义）。 */}
            <AxisLine
              y={priceToY(bounds.w, axis, CHART_HEIGHT)}
              label={`W ${formatPriceText(bounds.w)}`}
              lineClassName="bg-err"
              textClassName="text-err font-bold"
            />
          </>
        ) : null}

        {/* 折线区降级 —— 背景带照常，只有这层盖上说明（Guardrail 8：不用最淡档）。 */}
        {state !== 'ready' || closes.length === 0 ? (
          <View className="absolute inset-0 items-center justify-center gap-xs">
            <Text
              className="rounded-sm bg-surface-alt px-sm py-0.5 text-xs text-ink"
              testID={`${testID}-${state === 'failed' ? 'failed' : state === 'loading' ? 'loading' : 'empty'}`}
            >
              {state === 'failed' ? COPY.loadFailed : state === 'loading' ? '…' : COPY.empty}
            </Text>
            {state === 'failed' ? (
              <>
                {anchorAsof ? (
                  <Text className="text-[10px] text-ink-muted">
                    {COPY.anchorStillOk(anchorAsof)}
                  </Text>
                ) : null}
                <Pressable
                  onPress={onRetry}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.retry}
                  testID={`${testID}-retry`}
                  className="rounded-full border border-line px-md py-0.5"
                >
                  <Text className="text-xs text-brand-500">{COPY.retry}</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        ) : null}
      </View>

      <View className="flex-row items-center justify-between">
        <Text className="text-xs text-ink-muted" testID={`${testID}-range`}>
          {seriesRangeLabel(window, firstTradeDate, today)}
        </Text>
        <Text
          className={`text-xs ${freshness.tier === 'CURRENT' ? 'text-ink-subtle' : 'text-ink-muted'}`}
          testID={`${testID}-asof-${freshness.tier}`}
        >
          {freshness.text}
        </Text>
      </View>
      <Text className="text-[10px] text-ink-subtle">{COPY.adjustNote}</Text>
    </View>
  );
}

/** V / W 横界线 + 左侧标值（标签压在线上方 `AXIS_LABEL_OFFSET` 处，不遮线）。 */
function AxisLine({
  y,
  label,
  lineClassName,
  textClassName,
}: {
  y: number;
  label: string;
  lineClassName: string;
  textClassName: string;
}) {
  return (
    <>
      <View className={`absolute left-0 right-0 h-px ${lineClassName}`} style={{ top: y }} />
      <Text
        className={`absolute left-0 font-mono text-[9px] ${textClassName}`}
        style={{ top: y - AXIS_LABEL_OFFSET }}
      >
        {label}
      </Text>
    </>
  );
}
