// 046 T022 — VIX 半圆表盘（FR-015 / FR-017）：**`react-native-svg` 三段弧 + 指针**。
//
// 🚨 **零新第三方运行时依赖**（SC-007）：不引任何图表 / 仪表盘库。`react-native-svg` 仓内
//    已装（15.12.1）⇒ 不算新依赖，用法同 T021 `price-zone-chart.tsx`。
//
// 🚨 **三段是波动读数、不是涨跌** —— 配色取 `ok / warn / err` 语义档，**禁复用
//    `colors.quote.*`**（那是 A 股红涨绿跌，读者会把绿弧读成「跌」而不是「平静」）。
//    mockup handoff 同款取舍（`--nvy-success` / `--nvy-warning` / `--nvy-danger`）。
//
// 🚨 **FR-017：指数不可得 ⇒ 不画指针**（而不是把指针停在 0）。0 会被读成「极度平静」，
//    那是**错误信息**不是缺失信息。弧本体照画 —— 量程刻度不依赖当期值。
//
// 🚨 **大数字落在轴心下方**（mockup 踩过：大数压在轴心圆上时，轴心圆看着像小数点、
//    指针横穿数字）。这里 SVG 只画到轴心，数字是 SVG **之外**的 RN `<Text>`。
//
// 几何全在 `thermometer.rules.ts`（vitest 覆盖）；渲染走 T024 E2E。
import { Text, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { colors } from '~/theme';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import {
  VIX_GAUGE_ARCS,
  arcPath,
  polarPoint,
  type VixGaugeView,
  type VixTier,
} from './thermometer.rules';

const COPY = OPTIONSDESK_COPY.thermometer.gauge;

const GAUGE_W = 220;
const ARC_R = 88;
const ARC_STROKE = 14;
const CX = GAUGE_W / 2;
const CY = ARC_R + ARC_STROKE / 2;
/** 画布只到轴心下方一点点 —— 大数字在画布之外，绝不与轴心圆重叠。 */
const GAUGE_H = CY + ARC_STROKE / 2 + 2;
const HUB_R = 5;
const POINTER_R = ARC_R - ARC_STROKE;
const POINTER_STROKE = 2.5;

/** 档 → 弧色（`Record` 而非 `Partial<Record>`：漏一档即编译红）。 */
const ARC_COLOR: Record<VixTier, string> = {
  calm: colors.ok.DEFAULT,
  elevated: colors.warn.DEFAULT,
  high: colors.err.DEFAULT,
};

/** 图例点的底色 class，与 {@link ARC_COLOR} 同一组语义档。 */
const LEGEND_TONE: Record<VixTier, { dot: string; text: string }> = {
  calm: { dot: 'bg-ok', text: COPY.legendCalm },
  elevated: { dot: 'bg-warn', text: COPY.legendElevated },
  high: { dot: 'bg-err', text: COPY.legendHigh },
};

const TIER_LABEL: Record<VixTier, string> = {
  calm: COPY.tierCalm,
  elevated: COPY.tierElevated,
  high: COPY.tierHigh,
};

export interface VixGaugeProps {
  view: VixGaugeView;
  testID?: string;
}

export function VixGauge({ view, testID = 'optionsdesk-thermometer-gauge' }: VixGaugeProps) {
  const pointer =
    view.pointerAngle === null ? null : polarPoint(CX, CY, POINTER_R, view.pointerAngle);

  return (
    <View className="items-center gap-xs" testID={`${testID}-${view.tier ?? 'unavailable'}`}>
      <Svg width={GAUGE_W} height={GAUGE_H}>
        {VIX_GAUGE_ARCS.map((arc) => (
          <Path
            key={arc.tier}
            d={arcPath(CX, CY, ARC_R, arc.fromDeg, arc.toDeg)}
            stroke={ARC_COLOR[arc.tier]}
            strokeWidth={ARC_STROKE}
            fill="none"
          />
        ))}
        {/* 🚨 FR-017：不可得 ⇒ 整根指针不存在。 */}
        {pointer === null ? null : (
          <Line
            x1={CX}
            y1={CY}
            x2={pointer.x}
            y2={pointer.y}
            stroke={colors.ink.DEFAULT}
            strokeWidth={POINTER_STROKE}
            strokeLinecap="round"
          />
        )}
        <Circle cx={CX} cy={CY} r={HUB_R} fill={colors.ink.DEFAULT} />
      </Svg>

      {/* 大数字 / 降级句（Guardrail 8：降级字用 `text-ink`，不用最淡档）。 */}
      {view.valueText === null ? (
        <Text className="text-base font-semibold text-ink" testID={`${testID}-degraded`}>
          {view.degradedText}
        </Text>
      ) : (
        <View className="flex-row items-baseline gap-xs">
          <Text className="font-mono text-3xl font-bold text-ink" testID={`${testID}-value`}>
            {view.valueText}
          </Text>
          {view.tier === null ? null : (
            <Text className="text-xs text-ink-muted" testID={`${testID}-tier-${view.tier}`}>
              {TIER_LABEL[view.tier]}
            </Text>
          )}
        </View>
      )}

      {/* 图例：三段各自的读法（阈值与弧同源）。 */}
      <View className="flex-row gap-md">
        {VIX_GAUGE_ARCS.map((arc) => (
          <View key={arc.tier} className="flex-row items-center gap-xs">
            <View className={`h-1.5 w-1.5 rounded-full ${LEGEND_TONE[arc.tier].dot}`} />
            <Text className="text-[10px] text-ink-muted">{LEGEND_TONE[arc.tier].text}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
