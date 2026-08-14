// 055 T011 — 网格本体：冻结行标列 + 横滑列区 + 列头 + 两条召回段范围框
//（`FR-004` / `FR-007` / `FR-009` / `FR-009a`, `state_branch` 3/10, plan `D-UI-2`）。
//
// 🚨 **横滑整套复用 ADR-0063（049 那一套）**：单个 `Gesture.Pan` 写一个共享位移 `tx`，
//    三个列区（列头 / 范围框 / 网格体）各自 `translateX` 读它，**零滚动容器、零回写路径**。
//    `FR-004` 明写 🚫 MUST NOT 另立第二套 —— 手势与 clamp 由屏级持有（见 `chain-report-screen`），
//    本文件只摆版面。
// 🚨 **冻结列是兄弟节点不是 counter-translate** —— 行标列压根不在被位移的那棵子树里，
//    所以它「冻结」是结构性的，不靠每帧反向补偿。
// 🚨 **段外列的主信号是列头 chip**（Guardrail 7）—— 灰底 `surface-sunken` 与「无合约」的纯白
//    只差约 4% 亮度，40×32 的格子上读起来一样（本片 mockup 第 2 轮实撞）。🚫 别把 chip 去掉。
// 🚨 **范围框恒显两段**（`FR-009`），🚫 不随当前格值变；重叠列**两框并存**。图例只给颜色与
//    段名，🚫 **不复述 DTE 天数** —— 那两个区间是 server 的召回常量（`leg-recall.rules.ts`），
//    抄到客户端就是第二份阈值（052 FR-011 / `check-optionsdesk-rule-constants` 扫的正是这个）。
//
// 判定全在 `chain-report-grid.rules.ts`（vitest 覆盖）；渲染 / 交互走 T018 Playwright e2e。
import { useMemo } from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import type {
  ChainReportCellResponse,
  ChainReportColumnResponse,
  ChainReportRowResponse,
} from '@nvy/api-client';

import {
  CHAIN_REPORT_CELL_HEIGHT,
  CHAIN_REPORT_COLUMN_WIDTH,
  CHAIN_REPORT_LABEL_WIDTH,
  chainReportColumnView,
  chainReportContentWidth,
  chainReportGridView,
  chainReportHasColumnOverflow,
  chainReportRowLabel,
  type ChainReportColumnView,
} from './chain-report-grid.rules';
import type { ChainReportMetric } from './chain-report-scale.rules';
import { LegColumnPane, LegColumnScrollbar } from './leg-column-pane';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.chainReport;

export interface ChainReportGridProps {
  metric: ChainReportMetric;
  rows: ChainReportRowResponse[];
  columns: ChainReportColumnResponse[];
  /** **当前格值**那一张网格（`rows × columns`，逐格对应）。 */
  cells: ChainReportCellResponse[][];
  /** 屏级持有的唯一位移（负值域）。 */
  tx: SharedValue<number>;
  /** 屏级持有的可视宽（worklet 侧 clamp 用）。 */
  viewportW: SharedValue<number>;
  /** 同一个可视宽的 JS 侧副本 —— 只用来决定**指示条渲不渲染**（worklet 读不回 JS）。 */
  trackWidth: number;
  onTrackLayout: (event: LayoutChangeEvent) => void;
}

export function ChainReportGrid({
  metric,
  rows,
  columns,
  cells,
  tx,
  viewportW,
  trackWidth,
  onTrackLayout,
}: ChainReportGridProps) {
  const columnViews = useMemo(
    () => columns.map((column) => chainReportColumnView(column, metric)),
    [columns, metric],
  );
  // 🚨 逐格呈现走**同一个**纯函数入口（`chainReportGridView`）—— 组件不再自己排一遍，
  //    `SC-002`「切换只换格态、不换位置」的断言才验的是屏上真渲染的那份。
  const cellViews = useMemo(
    () => chainReportGridView(metric, rows, columnViews, cells),
    [metric, rows, columnViews, cells],
  );
  const contentWidth = chainReportContentWidth(columns.length);
  const hasOverflow = chainReportHasColumnOverflow(columns.length, trackWidth);

  return (
    <View className="mt-sm px-md" testID="chain-report-grid">
      {/* ── 列头 ────────────────────────────────────────────────── */}
      <View className="flex-row">
        <View style={{ width: CHAIN_REPORT_LABEL_WIDTH }} />
        <View className="flex-1" onLayout={onTrackLayout}>
          <LegColumnPane tx={tx} contentWidth={contentWidth} testID="chain-report-colhead">
            {columnViews.map((view, index) => (
              <ColumnHead key={columns[index]?.expiryDate ?? index} view={view} />
            ))}
          </LegColumnPane>
        </View>
      </View>

      {/* ── 两条召回段范围框（恒显；重叠列两框并存） ─────────────── */}
      <View className="flex-row">
        <View style={{ width: CHAIN_REPORT_LABEL_WIDTH }} />
        <LegColumnPane tx={tx} contentWidth={contentWidth} testID="chain-report-bands">
          {columnViews.map((view, index) => (
            <View
              key={columns[index]?.expiryDate ?? index}
              style={{ width: CHAIN_REPORT_COLUMN_WIDTH, height: 14 }}
            >
              {view.inBuildBand ? (
                <View className="absolute inset-x-0 top-0 h-1 rounded-sm bg-brand-300" />
              ) : null}
              {view.inRentBand ? (
                <View className="absolute inset-x-0 bottom-0 h-1 rounded-sm bg-tag-teal" />
              ) : null}
            </View>
          ))}
        </LegColumnPane>
      </View>

      <View className="flex-row gap-md" style={{ paddingLeft: CHAIN_REPORT_LABEL_WIDTH }}>
        <BandKey className="bg-brand-300" label={COPY.bandKeyBuild} />
        <BandKey className="bg-tag-teal" label={COPY.bandKeyRent} />
      </View>

      {/* ── 网格体：冻结行标列 + 横滑列区 ───────────────────────── */}
      <View className="flex-row">
        <View className="border-r border-line" style={{ width: CHAIN_REPORT_LABEL_WIDTH }}>
          {rows.map((row) => (
            <View
              key={row.index}
              className="items-end justify-center border-b border-line-soft pr-1"
              style={{ height: CHAIN_REPORT_CELL_HEIGHT }}
            >
              <Text className="text-[9px] text-ink-muted">{chainReportRowLabel(row, metric)}</Text>
            </View>
          ))}
        </View>

        <LegColumnPane tx={tx} contentWidth={contentWidth} testID="chain-report-cells">
          <View style={{ width: contentWidth }}>
            {rows.map((row, rowIndex) => (
              <View key={row.index} className="flex-row">
                {columns.map((column, colIndex) => {
                  const view = cellViews[rowIndex]?.[colIndex];
                  if (view === undefined) return null;
                  return (
                    <View
                      key={column.expiryDate}
                      className={`items-center justify-center ${view.container}`}
                      style={{
                        width: CHAIN_REPORT_COLUMN_WIDTH,
                        height: CHAIN_REPORT_CELL_HEIGHT,
                      }}
                      testID={`chain-report-cell-${row.index}-${colIndex}-${view.code}`}
                    >
                      {view.glyph === null ? null : (
                        <Text className={`text-[13px] ${view.ink}`}>{view.glyph}</Text>
                      )}
                      {view.valueText === null ? null : (
                        <Text className={`text-[11px] font-semibold ${view.ink}`}>
                          {view.valueText}
                        </Text>
                      )}
                      {/* 🚨 FR-007：角标与值**同色**，只靠字号分主次。 */}
                      {view.countText === null ? null : (
                        <Text className={`absolute bottom-0 right-0.5 text-[8px] ${view.ink}`}>
                          {view.countText}
                        </Text>
                      )}
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
        </LegColumnPane>
      </View>

      {/* 🚨 单到期日链 ⇒ 整条不渲染（`state_branch` 10）——「能滑」是个承诺，不能白给。 */}
      {hasOverflow ? (
        <LegColumnScrollbar
          tx={tx}
          viewportW={viewportW}
          contentWidth={contentWidth}
          stickyWidth={CHAIN_REPORT_LABEL_WIDTH}
          testID="chain-report-scrollbar"
        />
      ) : null}
    </View>
  );
}

function ColumnHead({ view }: { view: ChainReportColumnView }) {
  return (
    <View className="items-center py-0.5" style={{ width: CHAIN_REPORT_COLUMN_WIDTH }}>
      <Text className={`text-[9px] ${view.isOutOfBand ? 'text-ink-muted' : 'text-ink'}`}>
        {view.expiryText}
      </Text>
      <Text className="text-[9px] text-ink-muted">{view.dteText}</Text>
      <View className="h-2.5 flex-row items-center gap-0.5">
        {view.isMonthly ? (
          <Text className="rounded-sm border border-brand-500 px-0.5 text-[8px] text-brand-500">
            {COPY.monthlyChip}
          </Text>
        ) : null}
        {/* 🚨 段外的**主信号**（Guardrail 7）——灰底只是辅。 */}
        {view.isOutOfBand ? (
          <Text
            className="rounded-sm border border-line-strong px-0.5 text-[8px] text-ink-muted"
            testID="chain-report-out-of-band-chip"
          >
            {COPY.outOfBandChip}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function BandKey({ className, label }: { className: string; label: string }) {
  return (
    <View className="flex-row items-center gap-1">
      <View className={`h-1 w-2.5 rounded-sm ${className}`} />
      <Text className="text-[9px] text-ink-muted">{label}</Text>
    </View>
  );
}
