import { Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { colors } from '~/theme';
import { percentileZone } from './stock-detail.helpers';
import { STOCK_DETAIL_COPY } from './stock-detail-copy';

// 估值分位条（014 US5 / FR-M05，理杏仁招牌）。渐变轨（低估→高估，brand-soft→brand-300）+ 白心
// brand 描边位置点 + 偏低/适中/偏高 档位（<30/30-70/>70）。pct=null（港美股薄/无历史）→ 灰轨空态 `--`。
// SVG 渐变（RN 无 CSS gradient + 不引 expo-linear-gradient，复用已装 react-native-svg；色值从
// ~/theme 取，hex 不落组件源 per SC-M06）；位置点 left 动态计算 → 走 style（per nativewind 规则
// 「动态计算位移」例外）。presentational → Playwright e2e。

const COPY = STOCK_DETAIL_COPY.company.percentile;

export interface PercentileBarProps {
  /** 唯一标签（同时作 SVG gradient id 去重，多条同屏防 id 碰撞）。 */
  label: string;
  /** 百分位 0-100；null → 空态。 */
  pct: number | null;
  gradientId: string;
}

export function PercentileBar({ label, pct, gradientId }: PercentileBarProps) {
  return (
    <View className="mb-md">
      <View className="flex-row items-baseline justify-between mb-sm">
        <Text className="text-xs text-ink-muted">{label}</Text>
        {pct == null ? (
          <Text className="text-xs text-ink-subtle font-mono">--</Text>
        ) : (
          <Text className="text-xs">
            <Text className="text-sm font-mono font-semibold text-ink">{pct.toFixed(1)}%</Text>
            <Text className="text-ink-subtle"> · {percentileZone(pct)}</Text>
          </Text>
        )}
      </View>

      {pct == null ? (
        <View className="h-2 rounded-full bg-surface-sunken" />
      ) : (
        <View className="relative h-2">
          <Svg width="100%" height={8}>
            <Defs>
              <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={colors.brand.soft} />
                <Stop offset="1" stopColor={colors.brand[300]} />
              </LinearGradient>
            </Defs>
            <Rect x={0} y={0} width="100%" height={8} rx={4} fill={`url(#${gradientId})`} />
          </Svg>
          {/* 位置点：left=pct%，translateX -7 居中（动态位移，style 例外）。 */}
          <View
            className="absolute w-3.5 h-3.5 rounded-full bg-surface border-2 border-brand-500"
            style={{ left: `${pct}%`, top: -3, transform: [{ translateX: -7 }] }}
          />
        </View>
      )}

      <View className="flex-row justify-between mt-xs">
        <Text className="text-xs text-ink-subtle">{COPY.low}</Text>
        <Text className="text-xs text-ink-subtle">{COPY.high}</Text>
      </View>
    </View>
  );
}
