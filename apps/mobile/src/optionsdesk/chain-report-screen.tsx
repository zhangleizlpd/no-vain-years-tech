// 055 T010 — 标的链分析报表屏（骨架 + 页头）。mockup `055-chain-report-states.dc.html` 帧 ①。
//
// 🚨 **零纵向滚动**（`FR-041`）—— 整屏是一个 `flex` 列容器，**没有 `ScrollView`**。越线时的
//    压缩顺序是**先曲线、再页头**，🚫 网格 MUST NOT 纵向滚（一滚，报表就退化成了另一张
//    逐条阅读的表，而那正是本片要替代的东西）。⚠️ 余量判定 MUST 用**真机**读数（T021）——
//    049 实测 web 185 vs 真机 161dp，用 web 那组会误判一屏余量。
// 🚨 **合规门控自动继承**（`SC-009` / plan `D-UI-1`）—— 本屏落 `app/(app)/optionsdesk/` 二级页
//    栈，`_layout.tsx` 的 `MarketsRouteGuard` 一层管到底，🚫 MUST NOT 在屏内另写一份判定。
// 🚨 **页头的 IV 分位整份复用 046**（`FR-031`）：读数走 `chainReportHeaderView` → `ivReadoutView`，
//    分段条直接用 `IvpSegmentBar`（复用频次 ≥ 2 的既有件），🚫 不新造读数、不新画一条。
//
// ── 055 T011 横滑层（`FR-004`, plan `D-UI-2`）────────────────────────────────
// 🚨 **整套复用 ADR-0063（049 那一套）**：屏级持有唯一位移 `tx` + 唯一 `Gesture.Pan`，
//    三个列区各自 `translateX` 读它 —— 零滚动容器、零回写路径。🚫 MUST NOT 另立第二套。
// 🚨 **`GestureDetector` 的子节点必须是单个带 `collapsable={false}` 的原生 `View`**：传
//    Fragment 或被 view-flattening 压平，手势**静默不生效**（049 实撞）。
// 🚨 **屏自包裹 `GestureHandlerRootView`** —— 根 `_layout` 不全局挂，漏了是 Render Error。
// 🚨 **可视宽走 `onLayout` 实测**，不用 `useWindowDimensions()`（后者假设「表宽 = 窗宽」，
//    将来加边距或平板分栏会**静默算错 clamp 边界**，右侧列滑不到底且不会红）；变宽时顺手把
//    `tx` 拉回新域，否则竖→横→竖后卡在越界位置只能反向滑。
//
// 📌 **本片仍缺三块**：格值四选一与页脚三计数归 T012、IV 期限结构曲线归 T013、
//    五种降级态归 T017。下面的空位是给它们留的，不是漏了。
// 判定全在 `chain-report-copy.ts` / `chain-report-grid.rules.ts` / `chain-report-scale.rules.ts`
//（vitest 覆盖）；渲染 / 交互 / a11y 走 T018 Playwright e2e。
import { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import { Stack } from 'expo-router';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';

import { ErrorRow, SafeAreaView, Spinner, makeHeaderBackOrParent } from '~/ui';
import {
  chainReportGateHint,
  chainReportGateLines,
  chainReportHeaderView,
  chainReportMetricCaption,
  chainReportTitle,
} from './chain-report-copy';
import { ChainReportGrid } from './chain-report-grid';
import { chainReportContentWidth } from './chain-report-grid.rules';
import { ChainReportMetricTabs } from './chain-report-metric-tabs';
import type { ChainReportMetric } from './chain-report-scale.rules';
import { IvpSegmentBar } from './ivp-segment-bar';
import { clampLegColumnTx, useLegColumnPan } from './leg-column-pane';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { optionsdeskUnderlyingRoute } from './optionsdesk-routes';
import { useChainReport } from './use-chain-report';

const COPY = OPTIONSDESK_COPY.chainReport;

/** 默认格值 = 收租年化（mockup 帧 ① 的默认态）。四选一切换归 T012。 */
const DEFAULT_METRIC: ChainReportMetric = 'rentAnnualized';

export interface ChainReportScreenProps {
  /** canonical `market:code`（= 锚 ticker，标的身份）。 */
  symbol: string;
}

export function ChainReportScreen({ symbol }: ChainReportScreenProps) {
  const { report, isPending, isError, refetch } = useChainReport(symbol);
  const header = useMemo(() => (report === null ? null : chainReportHeaderView(report)), [report]);
  // 🚨 切换只换「读哪一张网格」—— 四张一次返齐，🚫 不为切换再发请求（`SC-002`）。
  const [metric, setMetric] = useState<ChainReportMetric>(DEFAULT_METRIC);

  const columnCount = report?.columns.length ?? 0;
  const contentWidth = chainReportContentWidth(columnCount);
  const tx = useSharedValue(0);
  const viewportW = useSharedValue(0);
  const [trackWidth, setTrackWidth] = useState(0);

  const onTrackLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const width = event.nativeEvent.layout.width;
      viewportW.value = width;
      // 变宽时把 `tx` 拉回新合法域 —— 两处夹的必须是同一套判据（049 Guardrail 5）。
      tx.value = clampLegColumnTx(tx.value, width, contentWidth);
      setTrackWidth((prev) => (prev === width ? prev : width));
    },
    [contentWidth, tx, viewportW],
  );

  const pan = useLegColumnPan({ tx, viewportW, contentWidth });

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      {/* web 硬刷新时栈底为空 ⇒ 回落到**该标的详情**（报表入口就在那儿，FR-035）。 */}
      <Stack.Screen
        options={{
          title: chainReportTitle(symbol),
          headerLeft: makeHeaderBackOrParent(optionsdeskUnderlyingRoute(symbol)),
        }}
      />

      <View className="flex-1 bg-surface-sunken">
        {header === null ? null : (
          <View className="gap-1 bg-surface px-md py-sm" testID="chain-report-header">
            <View className="flex-row items-baseline gap-1.5">
              <Text className="text-xs text-ink-muted">{COPY.ivpLabel}</Text>
              {header.iv.ivpText === null ? (
                <Text className="text-sm text-ink">{header.iv.degradedText}</Text>
              ) : (
                <>
                  <Text className="text-xl text-ink">{header.iv.ivpText}</Text>
                  <Text className="text-xs text-ink-muted">{COPY.ivpUnit}</Text>
                </>
              )}
              <View className="flex-1" />
              <Text className="text-sm text-ink">{header.spotText ?? COPY.noValue}</Text>
            </View>

            {/* 🚨 无分位时段带照常画、只是没有标记 —— 绝不落在 0 处（`state_branch` 18）。 */}
            <IvpSegmentBar ivPercentile={header.iv.ivPercentile} testID="chain-report-ivp-bar" />

            {/* 🚨 FR-033：三个时点**各自成句**，🚫 不合并成一个「数据截至」。 */}
            <View className="flex-row gap-md" testID="chain-report-stamps">
              {header.stamps.map((s) => (
                <View
                  key={s.key}
                  className="flex-row gap-0.5"
                  testID={`chain-report-stamp-${s.key}`}
                >
                  <Text className="text-[10px] text-ink-subtle">{s.label}</Text>
                  <Text className="text-[10px] text-ink-muted">{s.value}</Text>
                </View>
              ))}
            </View>

            {header.excludedNotice === null ? null : (
              <Text className="text-[10px] text-warn" testID="chain-report-excluded">
                {header.excludedNotice}
              </Text>
            )}
          </View>
        )}

        {report === null ? null : (
          <>
            <ChainReportMetricTabs metric={metric} onSelect={setMetric} />

            <GestureHandlerRootView>
              <GestureDetector gesture={pan}>
                {/* 🚨 单个原生 `View` + `collapsable={false}`：Fragment 或被压平 ⇒ 手势静默失效。 */}
                <View collapsable={false}>
                  <ChainReportGrid
                    metric={metric}
                    rows={report.rows}
                    columns={report.columns}
                    cells={report.cells[metric]}
                    tx={tx}
                    viewportW={viewportW}
                    trackWidth={trackWidth}
                    onTrackLayout={onTrackLayout}
                  />
                </View>
              </GestureDetector>
            </GestureHandlerRootView>

            {/* 当前格值的读法一行 —— 活跃度那条的时点跟 `oiAsOf`（FR-014）。 */}
            <Text className="px-md pt-0.5 text-[9px] text-ink-muted" testID="chain-report-caption">
              {chainReportMetricCaption(metric, report)}
            </Text>

            {/* 🚨 FR-034 页脚三个互斥计数，各带各的分母，🚫 不合并成一个总数。 */}
            <View
              className="mt-auto gap-0.5 border-t border-line-soft px-md pb-md pt-sm"
              testID="chain-report-footer"
            >
              {chainReportGateLines(report.gateCounts).map((line) => (
                <View
                  key={line.key}
                  className="flex-row items-baseline gap-1"
                  testID={`chain-report-gate-${line.key}`}
                >
                  <Text className="w-24 text-[11px] text-ink-muted">{line.label}</Text>
                  <Text className="text-[11px] text-ink">{line.count}</Text>
                  <Text className="text-[11px] text-ink-muted">{line.denominatorText}</Text>
                </View>
              ))}
              {/* 恒等式对不上账时整句不显示 —— 🚫 不用界面替错数背书（`SC-006`）。 */}
              {chainReportGateHint(report.gateCounts) === null ? null : (
                <Text className="text-[10px] text-ink-subtle" testID="chain-report-gate-hint">
                  {chainReportGateHint(report.gateCounts)}
                </Text>
              )}
            </View>
          </>
        )}

        {isPending ? (
          <View className="items-center py-lg" testID="chain-report-loading">
            <Spinner size={16} tone="muted" />
          </View>
        ) : null}

        {isError ? (
          <View className="gap-sm px-md py-sm" testID="chain-report-error">
            <ErrorRow text={COPY.loadFailed} />
            <Pressable
              onPress={refetch}
              accessibilityRole="button"
              accessibilityLabel={COPY.retry}
              testID="chain-report-retry"
              className="self-center rounded-full border border-line px-md py-0.5"
            >
              <Text className="text-xs text-brand-500">{COPY.retry}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}
