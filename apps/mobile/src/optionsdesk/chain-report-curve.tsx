// 055 T013 — IV 期限结构曲线（`FR-020`–`FR-023`, `SC-005`, plan `D-UI-3`）。
//
// 🚨 **与网格列区挂在同一个 `LegColumnPane` 位移下**（Guardrail 9）—— 原点同源因此是**结构性**的：
//    曲线的 x 空间就是 track 局部坐标，横滑时两者同进同退。🚫 MUST NOT 把它挪到 pane 之外
//    再「按 track 宽对齐一次」：那是上一轮 mockup 实撞的形态（第 n 点不在第 n 列上），
//    而六项探测对此完全失明。
// 🚨 **`react-native-svg` 已装**（`price-zone-chart.tsx` / `leg-picker-tabs.tsx` 在用）——
//    `FR-042` 🚫 本片不引任何新的第三方运行时依赖。
// 🚨 **断点只画点、不连线**（`FR-023`）—— 分段由 `chainReportCurveView` 切好，本文件照画。
//
// 几何全在 `chain-report-curve.rules.ts`（vitest 覆盖）；渲染走 T018 Playwright e2e。
import { useMemo } from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';
import type { SharedValue } from 'react-native-reanimated';
import type { ChainReportColumnResponse } from '@nvy/api-client';

import { colors } from '~/theme';
import { chainReportCurveView } from './chain-report-curve.rules';
import { CHAIN_REPORT_LABEL_WIDTH } from './chain-report-grid.rules';
import { LegColumnPane } from './leg-column-pane';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.chainReport;

const STROKE_WIDTH = 1.5;
const POINT_RADIUS = 2.5;

export interface ChainReportCurveProps {
  columns: ChainReportColumnResponse[];
  /** 与网格**同一个**位移（横滑时逐列跟随）。 */
  tx: SharedValue<number>;
}

export function ChainReportCurve({ columns, tx }: ChainReportCurveProps) {
  const view = useMemo(() => chainReportCurveView(columns), [columns]);

  return (
    <View className="mt-sm px-md" testID="chain-report-curve">
      <View className="flex-row items-baseline justify-between">
        <Text className="text-[10px] text-ink-muted">{COPY.curveTitle}</Text>
        {/* `FR-021` 的可见交代 —— 横轴是列序不是时间，读图的人有权知道。 */}
        <Text className="text-[10px] text-ink-muted">{COPY.curveAxisNote}</Text>
      </View>

      <View className="flex-row">
        <View style={{ width: CHAIN_REPORT_LABEL_WIDTH }} />
        <LegColumnPane tx={tx} contentWidth={view.width} testID="chain-report-curve-track">
          <Svg width={view.width} height={view.height}>
            {view.segments.map((segment) =>
              segment.length < 2 ? null : (
                <Polyline
                  key={`seg-${segment[0]?.columnIndex}`}
                  points={segment.map((p) => `${p.x},${p.y ?? 0}`).join(' ')}
                  fill="none"
                  stroke={colors.brand[500]}
                  strokeWidth={STROKE_WIDTH}
                />
              ),
            )}
            {view.points.map((point) =>
              point.y === null ? null : (
                <Circle
                  key={`pt-${point.columnIndex}`}
                  cx={point.x}
                  cy={point.y}
                  r={POINT_RADIUS}
                  fill={colors.brand[500]}
                />
              ),
            )}
          </Svg>
        </LegColumnPane>
      </View>
    </View>
  );
}
