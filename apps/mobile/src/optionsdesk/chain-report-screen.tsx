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
// ── 055 T014 十字线（`FR-025`/`FR-026`/`FR-030`, Guardrail 8）──────────────────
// 🚨 **长按与横滑的分界是「有没有先按住」，不是触点在哪** —— 落法是
//    `Gesture.Pan().activateAfterLongPress(...)` 与横滑 Pan 组成 `Gesture.Exclusive`：
//    判据是**时间**，🚫 MUST NOT 依据坐标分流（`FR-030`，与选约表横滑同一条纪律）。
// 🚨 **触点 → 行列的换算要两个偏移**：x 减「外边距 + 冻结列 + 横滑位移」，y 减「网格体首行
//    顶缘」。后者由 `onLayout` **实测两级**（曲线高度 / 列头行高都会变），🚫 别拿常量凑。
// ⚠️ **手势竞争的真实手感只有真机能判**（Expo Web 下 `Pan` 需走原始指针事件）⇒ 归 T021。
//
// 📌 **本片仍缺一块**：五种降级态归 T017。
// 判定全在 `chain-report-copy.ts` / `chain-report-grid.rules.ts` / `chain-report-scale.rules.ts`
//（vitest 覆盖）；渲染 / 交互 / a11y 走 T018 Playwright e2e。
import { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue } from 'react-native-reanimated';

import { ErrorRow, SafeAreaView, Spinner, makeHeaderBackOrParent } from '~/ui';
import {
  chainReportGateHint,
  chainReportGateLines,
  chainReportHeaderView,
  chainReportMetricCaption,
  chainReportTitle,
} from './chain-report-copy';
import {
  CHAIN_REPORT_CROSSHAIR_LONG_PRESS_MS,
  chainReportColumnIndexAt,
  chainReportReadout,
  chainReportRowIndexAt,
} from './chain-report-crosshair.rules';
import { ChainReportCurve } from './chain-report-curve';
import { chainReportCellHitAt, chainReportDrilldownParams } from './chain-report-drilldown.rules';
import { chainReportAnchorPresence, chainReportBlocksReport } from './chain-report-entry.rules';
import { ChainReportGrid } from './chain-report-grid';
import { chainReportContentWidth } from './chain-report-grid.rules';
import { ChainReportMetricTabs } from './chain-report-metric-tabs';
import { ChainReportReadout } from './chain-report-readout';
import type { ChainReportMetric } from './chain-report-scale.rules';
import { IvpSegmentBar } from './ivp-segment-bar';
import { clampLegColumnTx, useLegColumnPan } from './leg-column-pane';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import {
  OPTIONSDESK_ANCHOR_NEW_ROUTE,
  OPTIONSDESK_UNDERLYING_PATHNAME,
  optionsdeskUnderlyingRoute,
} from './optionsdesk-routes';
import { useChainReport } from './use-chain-report';

const COPY = OPTIONSDESK_COPY.chainReport;
/** 🚨 建锚引导文案**复用 046 那一份**（`FR-037a` 与它同源）—— 🚫 不在本片另写一份同义串。 */
const NO_ANCHOR_COPY = OPTIONSDESK_COPY.underlyingDetail.noAnchor;

/** 默认格值 = 收租年化（mockup 帧 ① 的默认态）。四选一切换归 T012。 */
const DEFAULT_METRIC: ChainReportMetric = 'rentAnnualized';

export interface ChainReportScreenProps {
  /** canonical `market:code`（= 锚 ticker，标的身份）。 */
  symbol: string;
}

export function ChainReportScreen({ symbol }: ChainReportScreenProps) {
  const router = useRouter();
  const { report, isPending, isError, isNoAnchor, refetch } = useChainReport(symbol);
  // 🚨 FR-037a 后半：未建锚 ⇒ 拦下、改呈建锚引导。判据与详情屏那道入口闸**同一份**，
  //    且只在**确知**无锚时拦（还在飞 / 读挂了照常走下面的 loading / 失败两支）。
  const blocked = chainReportBlocksReport(
    chainReportAnchorPresence({ anchorMissing: isNoAnchor, anchorLoaded: report !== null }),
  );
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

  const columnPan = useLegColumnPan({ tx, viewportW, contentWidth });

  // ── 十字线：落点 + 两级纵向偏移（曲线高度与列头行高都会变，故实测不凑常量） ──
  const [crosshair, setCrosshair] = useState<{ columnIndex: number; rowIndex: number } | null>(
    null,
  );
  const [gridTop, setGridTop] = useState(0);
  const [bodyTop, setBodyTop] = useState(0);
  const rowCount = report?.rows.length ?? 0;

  const moveCrosshair = useCallback(
    (x: number, y: number, txValue: number) => {
      const columnIndex = chainReportColumnIndexAt(x, txValue, columnCount);
      const rowIndex = chainReportRowIndexAt(y - gridTop - bodyTop, rowCount);
      setCrosshair((prev) =>
        prev?.columnIndex === columnIndex && prev.rowIndex === rowIndex
          ? prev
          : { columnIndex, rowIndex },
      );
    },
    [bodyTop, columnCount, gridTop, rowCount],
  );

  const clearCrosshair = useCallback(() => setCrosshair(null), []);

  const crosshairPan = useMemo(
    () =>
      Gesture.Pan()
        // 🚨 唯一的分界：**按住够久**才归十字线（`FR-030`，🚫 不看坐标）。
        .activateAfterLongPress(CHAIN_REPORT_CROSSHAIR_LONG_PRESS_MS)
        .onStart((event) => {
          runOnJS(moveCrosshair)(event.x, event.y, tx.value);
        })
        .onUpdate((event) => {
          runOnJS(moveCrosshair)(event.x, event.y, tx.value);
        })
        // 松手退出（`FR-025`）—— 取消 / 打断也走这里，🚫 不留一条画在屏上的孤线。
        .onFinalize(() => {
          runOnJS(clearCrosshair)();
        }),
    [clearCrosshair, moveCrosshair, tx],
  );

  // ── 下钻：点有值的格 → 落该标的选约区块（`FR-038` / `FR-039`, T016）────────────
  //
  // 🚨 **命中换算与十字线共用同两个函数** —— 「十字线读的是这一格」与「点下去跳的是这一格」
  //    必须是同一格；各算一份就会出现读 A 跳 B，而两边都跳得出去。
  // 🚨 **点空格 MUST NOT 跳转**（`FR-038`）—— 判据在 `chainReportDrilldownParams`（它问的是
  //    格的呈现码，与「格子上看起来有没有值」同源），这里只负责「返 `null` 就什么都不做」。
  const pressCell = useCallback(
    (x: number, y: number, txValue: number) => {
      if (report === null) return;
      // 🚨 落在网格体之外（曲线 / 列头 / 行标列 / 右侧空白）⇒ 什么都不做。十字线那两个函数
      //    会把界外触点**钳到边界格**，拿它去跳转就是「点在曲线上跳进了第一行的格」。
      const hit = chainReportCellHitAt(x, y - gridTop - bodyTop, txValue, columnCount, rowCount);
      if (hit === null) return;
      const { rowIndex, columnIndex } = hit;
      const row = report.rows[rowIndex];
      const column = report.columns[columnIndex];
      const cell = report.cells[metric][rowIndex]?.[columnIndex];
      if (row === undefined || column === undefined || cell === undefined) return;
      const params = chainReportDrilldownParams({
        metric,
        row,
        column,
        cell,
        isOutOfBand: !column.inRecallBand[metric],
        reportAsOf: report.asOf ?? '',
      });
      if (params === null) return;
      router.push({ pathname: OPTIONSDESK_UNDERLYING_PATHNAME, params: { symbol, ...params } });
    },
    [bodyTop, columnCount, gridTop, metric, report, rowCount, router, symbol],
  );

  const cellTap = useMemo(
    () =>
      Gesture.Tap().onEnd((event, success) => {
        if (success) runOnJS(pressCell)(event.x, event.y, tx.value);
      }),
    [pressCell, tx],
  );

  // 🚨 `Exclusive` 而不是 `Simultaneous`：同一根手指要么在移列、要么在读格，两者不并存。
  //    轻点排在最后 —— 前两者一个要**按住够久**、一个要**移动够远**，都不会被一次轻点激活。
  const gesture = useMemo(
    () => Gesture.Exclusive(crosshairPan, columnPan, cellTap),
    [cellTap, columnPan, crosshairPan],
  );

  const readout = useMemo(() => {
    if (report === null || crosshair === null) return null;
    const row = report.rows[crosshair.rowIndex];
    const column = report.columns[crosshair.columnIndex];
    if (row === undefined || column === undefined) return null;
    const cell = report.cells[metric][crosshair.rowIndex]?.[crosshair.columnIndex] ?? {
      state: 'absent' as const,
      best: null,
      runnerUp: null,
      legCount: 0,
    };
    return chainReportReadout(metric, row, column, cell, !column.inRecallBand[metric]);
  }, [crosshair, metric, report]);

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
        {/* 🚨 FR-037a：未建锚 ⇒ **建锚引导**，🚫 MUST NOT 渲染一张缺一角的报表、也不是报错页
            （与 046 详情屏「未建锚 → 整页引导」同源取舍）。文案复用 046 那一份，不另写。 */}
        {blocked ? (
          <View className="flex-1 items-center justify-center gap-md px-xl">
            <Text className="text-center text-sm text-ink" testID="chain-report-no-anchor">
              {NO_ANCHOR_COPY.text}
            </Text>
            <Pressable
              className="rounded-full bg-brand-500 px-lg py-sm"
              accessibilityRole="button"
              accessibilityLabel={NO_ANCHOR_COPY.cta}
              testID="chain-report-create-anchor"
              onPress={() => router.push(OPTIONSDESK_ANCHOR_NEW_ROUTE)}
            >
              <Text className="text-sm font-semibold text-white">{NO_ANCHOR_COPY.cta}</Text>
            </Pressable>
          </View>
        ) : null}

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
              <GestureDetector gesture={gesture}>
                {/* 🚨 单个原生 `View` + `collapsable={false}`：Fragment 或被压平 ⇒ 手势静默失效。
                    曲线与网格**同在这一层之下** —— 同一个 `tx`、同一个手势区（Guardrail 9）。 */}
                <View collapsable={false}>
                  <ChainReportCurve
                    columns={report.columns}
                    tx={tx}
                    activeColumnIndex={crosshair?.columnIndex ?? null}
                  />
                  <View onLayout={(event) => setGridTop(event.nativeEvent.layout.y)}>
                    <ChainReportGrid
                      metric={metric}
                      rows={report.rows}
                      columns={report.columns}
                      cells={report.cells[metric]}
                      tx={tx}
                      viewportW={viewportW}
                      trackWidth={trackWidth}
                      onTrackLayout={onTrackLayout}
                      crosshair={crosshair}
                      onBodyLayout={setBodyTop}
                    />
                  </View>
                </View>
              </GestureDetector>
            </GestureHandlerRootView>

            {/* 十字线激活时读法行与恒等式让位给读数面板（mockup 帧 ⑤；`FR-041` 一屏预算）。 */}
            {readout === null ? (
              <Text
                className="px-md pt-0.5 text-[9px] text-ink-muted"
                testID="chain-report-caption"
              >
                {chainReportMetricCaption(metric, report)}
              </Text>
            ) : (
              <ChainReportReadout view={readout} />
            )}

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
              {readout !== null || chainReportGateHint(report.gateCounts) === null ? null : (
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

        {/* 🚨 未建锚是**预期分支不是故障** ⇒ 拦下时不再叠一句「加载失败」（那会让用户去点重试，
            而重试一百次也还是 404）。 */}
        {isError && !blocked ? (
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
