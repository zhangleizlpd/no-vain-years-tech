// 046 T021 — 标的详情屏（上半）。mockup `046-underlying-detail.dc.html` 帧 ①~⑥。
//
// 🚨 **自上而下固定三块**（FR-001，07-29 拍板版式，不可重排）：
//    锚卡 → 个股温度计区块 → 区间时序。
//
// 🚨 **两端点并行合成，各自独立降级、禁整页失败**（plan D2 / state_branch #15）：
//    锚卡+IV 来自 optionsdesk 详情端点，价格序列来自 marketdata bars 端点。
//    任一侧故障只降级它自己那一块 —— **没有整页 error、也没有整页 loading**。
//    唯一的整页分支是「该标的尚未建锚」（FR-011），因为那时锚卡与四区间带都无从谈起，
//    且它要的是**建锚引导**不是报错页。
//
// 🚨 **只读呈现，MUST NOT 提供锚编辑入口**（FR-004；编辑仍在 045 锚表单 / P6）。
//
// ── 047 T031 容器换装（FR-001/005, plan D-UI-1）────────────────────────────────
// 🚨 **全页只留一个纵向滚动容器**：原 `ScrollView` 已整体换成 `SectionList` ——
//    `ListHeaderComponent` = 046 三块（三个组件**一行不改**）· sticky `section.header` =
//    选约区块头 + 表头行 · `section.data` = 腿行（虚拟化的那一层）· `ListFooterComponent` =
//    DTE 两段式提示 + FR-011 常驻页脚。把 `SectionList` 塞回同向 `ScrollView` 会**同时**坏
//    虚拟化（内层无界高度 ⇒ 730 行全渲染）与纵向手势（两个滚动响应者相争），而 RN 只在 dev
//    console 打一条 warning：typecheck 绿、CI 绿、web e2e 也可能绿。**别塞回去。**
// 🚨 **`stickySectionHeadersEnabled` 显式传 `true`** —— 该 prop 只在 iOS 默认为 true，
//    只在 iOS sim / web 上验会漏掉 Android「表头滚走了」。
// 📌 **FR-011 的「常驻」= 区块页脚不可折叠、不随状态消失**，不是屏幕常驻 —— 与 046
//    `thermometer-screen.tsx` 把 FR-019 免责渲在滚动容器**之外**那个范式**不同**。
//
// ── 049 T003 横滑手势层（FR-001/003/004, plan D-SCROLL-2/3）──────────────────────
// 🚨 **手势挂在包住整个 `SectionList` 的那一层** —— 它要同时覆盖表头（`renderSectionHeader`）
//    与所有行（`renderItem`），二者是 `SectionList` 的两个不同槽位。
// 🚨 **`GestureDetector` 的子节点必须是单个带 `collapsable={false}` 的原生 `View`**：传
//    Fragment 或被 view-flattening 压平，手势**静默不生效**；dev console 那两条告警
//    （`Invalid prop 'collapsable' supplied to 'React.Fragment'` / `child may get
//    view-flattened`）是唯一信号，🚫 MUST NOT 用 `LogBox.ignoreLogs` 压掉。
// 🚨 **屏自包裹 `GestureHandlerRootView`** —— 根 `_layout` 不全局挂，漏了是 Render Error。
// 🚨 **可视宽走 `onLayout` 实测，不用 `useWindowDimensions()`** —— 后者假设「表宽 = 窗宽」，
//    将来加左右 padding 或平板分栏会**静默算错 clamp 边界**（右侧列滑不到底，不会红）。
//    变宽时顺手把 `tx` 拉回新域，否则竖→横→竖后卡在越界位置只能反向滑。
// 📌 **手势区覆盖到 `ListHeaderComponent` 的 046 三块是设计意图不是 bug**：在锚卡 / 温度计 /
//    区间时序上横滑也会移动列，那时表在屏外、视觉无感。🚫 MUST NOT 拿触点的 y 坐标
//    （无论取自事件还是事后量元素位置）去「精修」手势区 —— 那是脆逻辑，spec Edge Case ②
//    明令禁止；tasks.md T003 的 verify 用一条 `grep` 逐字列了那几个 API 名并要求本文件
//    **零命中**，故这里蓄意不复写。
// 🚫 **MUST NOT 在外面再包 `ScrollView`** —— `SectionList` 仍是全页唯一纵向滚动容器
//    （同上方 047 T031 那条，RN 只打一条 dev warning，CI 会全绿）。
//
// 判定全在 `underlying-detail.rules.ts`（vitest 覆盖）；本文件与子件只做接线与版面，
// 渲染 / 交互 / a11y 走 Playwright e2e（本仓测试分层：vitest=logic / Playwright=UI）。
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  SectionList,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';
import type { LegResponse } from '@nvy/api-client';

import { ErrorRow, SafeAreaView, Spinner } from '~/ui';
import { AnchorDetailCard } from './anchor-detail-card';
import {
  chainReportDrilldownAsOfNotice,
  chainReportPrefillForm,
  type ChainReportPrefill,
} from './chain-report-drilldown.rules';
import { chainReportAnchorPresence, chainReportEntryVisible } from './chain-report-entry.rules';
import { IvReadoutBlock } from './iv-readout-block';
import { LegColumnScrollbar, clampLegColumnTx, useLegColumnPan } from './leg-column-pane';
import { LegCriteriaSheet } from './leg-criteria-sheet';
import {
  criteriaCountLines,
  criteriaOverrideCount,
  type CriteriaCountLine,
} from './leg-criteria.rules';
import { LEG_TIER_LEGEND, legAsOfLabel } from './leg-picker-copy';
import {
  legCandidateCapLine,
  legEmptyState,
  legGateCountLines,
  legGateCountsQuiet,
  legRowCountLine,
  legTruncationLine,
  rateHeaderFor,
  type LegCandidateCapLine,
  type LegEmptyState,
  type LegGateCountLine,
  type LegPickerNotice,
  type LegPickerTab,
  type LegTruncationLine,
} from './leg-picker.rules';
import { LegPickerTabs } from './leg-picker-tabs';
import { LegMembershipNotice } from './leg-membership-notice';
import { LegRow } from './leg-row';
import { LEG_SCROLL_REGION_WIDTH, LEG_STICKY_COL_WIDTH } from './leg-row.rules';
import { LegTableHeader } from './leg-table-header';
import { LegTierBar } from './leg-tier-bar';
import { legEodRowCount, legQuotePhase, type LegBlockPriceKind } from './leg-tier-bar.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { OPTIONSDESK_ANCHOR_NEW_ROUTE, optionsdeskChainReportRoute } from './optionsdesk-routes';
import { PositionBucketChips } from './position-bucket-chips';
import { PriceZoneChart } from './price-zone-chart';
import {
  parseZoneBounds,
  type FreshnessTier,
  type LegBlockState,
  type LegSection,
} from './underlying-detail.rules';
import { useLegTable } from './use-leg-table';
import { useUnderlyingDetail } from './use-underlying-detail';

const COPY = OPTIONSDESK_COPY.underlyingDetail;
const LEG_COPY = OPTIONSDESK_COPY.legPicker;

export interface UnderlyingDetailScreenProps {
  /** canonical `market:code`（= 锚 ticker，标的身份）。 */
  symbol: string;
  /**
   * 通往 P7 波动温度计整页（FR-012 全景入口）。
   * ⚠️ **由路由层注入** —— 温度计路由常量归 T023 建，本屏不自造路由字符串。
   */
  onPanorama: () => void;
  /**
   * 055 T016 —— 从报表某格下钻带进来的预填（`FR-038` / `FR-039`）；不是下钻 ⇒ `null`。
   * ⚠️ 由**路由层**解析（同 `onPanorama` 的分工）：屏不认识 query 参数长什么样。
   */
  prefill?: ChainReportPrefill | null;
}

export function UnderlyingDetailScreen({
  symbol,
  onPanorama,
  prefill = null,
}: UnderlyingDetailScreenProps) {
  const router = useRouter();
  const detail = useUnderlyingDetail(symbol);
  const legTable = useLegTable(symbol);
  const { composition } = detail;
  // 检索条件抽屉的开合（052 T012）。🚨 **不持久化**（FR-014）—— 与条件值一样只活在屏级 state。
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  // 🚨 064 FR-009：**区块级**档位与时点是链级字段 ⇒ 读 `chain`（当前视角那份还在飞时它回退到
  //    已到手的任一视角，MUST NOT 因为换了个视角就把档位条闪成「未就绪」）。
  const blockPriceKind = legTable.chain?.priceKind ?? null;
  // 逐行降级的条数 —— 腿是**视角级**的 ⇒ 读 `table` 不读 `chain`（回退期那份腿属于别的视角）。
  // 📌 记忆化同 `openCriteria`：它进的是 sticky section header，滚动期间每帧都会读到。
  const eodRowCount = useMemo(
    () => legEodRowCount(blockPriceKind, legTable.table?.legs ?? []),
    [blockPriceKind, legTable.table?.legs],
  );
  // 🚫 表还没到手 / 链未就绪时不给入口（`null`）：那时六维全 `null`，抽屉里只有一排空框。
  // 📌 记忆化不是为了性能洁癖 —— 这个回调进的是 sticky section header，滚动期间每帧都会读到它。
  const openCriteria = useMemo(
    () =>
      legTable.block === 'available' && legTable.criteria !== null
        ? () => setCriteriaOpen(true)
        : null,
    [legTable.block, legTable.criteria],
  );
  // 🚨 055 FR-037a：报表入口的可见性与报表屏那道深链闸**共读同一份判据**
  //    （`chain-report-entry.rules.ts`）—— 两处各判一次，改一处另一处照样渲染得出来。
  //    ⚠️ 判据必须在这里算：JSX 里那个 `no_anchor` 三元已经把 `page` 收窄成 `'ready'`，
  //    在分支内部再问一次「是不是 no_anchor」是恒假的（tsc 会红，且读起来像做了判定）。
  const chainReportEntry = chainReportEntryVisible(
    chainReportAnchorPresence({
      anchorMissing: composition.page === 'no_anchor',
      anchorLoaded: composition.anchorCard === 'ready',
    }),
  );
  // ── 055 T016 下钻预填（FR-038 / FR-039）───────────────────────────────────
  //
  // 🚨 预填是**挂载时**的一次性输入 ⇒ 定格在 ref 里：`prefill` 由路由层每帧新建一个对象，
  //    放进 effect 依赖会让下面三个 effect 每帧重跑（有闩不出错，但读起来像在轮询）。
  const prefillRef = useRef(prefill);
  const initialPrefill = prefillRef.current;
  const prefillTabDone = useRef(false);
  const prefillFormDone = useRef(false);
  const prefillScrollDone = useRef(false);
  const listRef = useRef<SectionList<LegResponse, LegSection>>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const { setTab: setLegTab, submitCriteria } = legTable;

  // ① 先落位视角（`FR-039`）。挂载时 `intent` 还未知，`promotePick` 会在契约到手时把它升格 ——
  //    这正是那条机制存在的场景，🚫 别在这里等 `intent`。
  useEffect(() => {
    if (initialPrefill === null || prefillTabDone.current) return;
    prefillTabDone.current = true;
    setLegTab(initialPrefill.tab);
  }, [initialPrefill, setLegTab]);

  // ② 该视角的**系统默认值到手之后**再压条件（🚨 顺序不可换）——
  //    `CriteriaForm` 里空串的契约含义是「覆盖为不限」，拿空表单去提交会把权利金 / 活性 /
  //    价差一并放开，选约表里多出报表那一格根本没数进去的腿，**而表照常渲染**。
  useEffect(() => {
    if (initialPrefill === null || prefillFormDone.current) return;
    if (legTable.tab !== initialPrefill.tab || legTable.criteria === null) return;
    prefillFormDone.current = true;
    submitCriteria(chainReportPrefillForm(legTable.criteria.defaults, initialPrefill));
  }, [initialPrefill, legTable.tab, legTable.criteria, submitCriteria]);

  // ③ 滚到选约区块（`FR-038`「落到该标的选约区块」）—— 预填了却停在锚卡上，用户看不到它。
  //    🚨 等两块都不在 loading 再滚：046 三块的高度随内容落定而变，早滚会停在半空。
  useEffect(() => {
    if (initialPrefill === null || prefillScrollDone.current) return;
    if (headerHeight <= 0) return;
    if (composition.anchorCard === 'loading' || legTable.block === 'loading') return;
    prefillScrollDone.current = true;
    listRef.current?.getScrollResponder()?.scrollTo({ y: headerHeight, animated: false });
  }, [initialPrefill, headerHeight, composition.anchorCard, legTable.block]);

  // 🚨 FR-039a：报表侧与选约侧的业务日不一致 ⇒ 两个时点**各自可见**。零新增契约字段 ——
  //    两边比的都是各自响应里已有的 `asOf`。
  const drilldownAsOf = chainReportDrilldownAsOfNotice(
    initialPrefill?.reportAsOf ?? null,
    legTable.chain?.asOf ?? null,
  );

  // 🚨 表头与每个数据行**共读**这一个横向位移，且**只有这一个来源**（FR-001）。
  //    负值域 `[maxTx, 0]`（translateX），**不是** 047 那个正的 scroll offset。
  const tx = useSharedValue(0);
  // 横滑可视宽 = 容器实测宽 − 首列宽。首帧 0 ⇒ 一帧不可滑，无感。
  const viewportW = useSharedValue(0);
  const pan = useLegColumnPan({ tx, viewportW, contentWidth: LEG_SCROLL_REGION_WIDTH });
  // canonical `market:code` → 展示用 code（解析失败退回原串，不丢信息）。
  const code = symbol.split(':')[1] ?? symbol;

  const handleTableLayout = (event: LayoutChangeEvent) => {
    const nextViewportW = Math.max(0, event.nativeEvent.layout.width - LEG_STICKY_COL_WIDTH);
    viewportW.value = nextViewportW;
    // 🚨 变宽时把位移拉回新合法域（旋转 / 分屏，FR-004）。夹的判据与手势内**同一份**。
    // 📌 JS 线程读 `tx.value` 可能比 UI 线程晚一拍，但这里夹的目标是**边界**：读到旧值只会
    //    让位置跳一下，不会留下越界状态 —— 故不值得为它引一层 `runOnUI`。
    tx.value = clampLegColumnTx(tx.value, nextViewportW, LEG_SCROLL_REGION_WIDTH);
  };

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      <Stack.Screen options={{ title: code }} />

      {/* 🚨 屏自包裹手势根 —— 仓内根 `_layout` 不全局挂（同 `~/ui/SwipeRow` 自包裹范式）。 */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        {composition.page === 'no_anchor' ? (
          // FR-011：显式提示 + 建锚入口。**禁空白页 / 禁报错页**。
          <View className="flex-1 items-center justify-center gap-md px-xl">
            <Text className="text-center text-sm text-ink" testID="optionsdesk-detail-no-anchor">
              {COPY.noAnchor.text}
            </Text>
            <Pressable
              className="rounded-full bg-brand-500 px-lg py-sm"
              accessibilityRole="button"
              accessibilityLabel={COPY.noAnchor.cta}
              testID="optionsdesk-detail-create-anchor"
              onPress={() => router.push(OPTIONSDESK_ANCHOR_NEW_ROUTE)}
            >
              <Text className="text-sm font-semibold text-white">{COPY.noAnchor.cta}</Text>
            </Pressable>
          </View>
        ) : (
          <GestureDetector gesture={pan}>
            {/* 🚨 单个原生 `View` + `collapsable={false}`：传 Fragment 或被 view-flattening
              压平，手势静默不生效（见文件头）。`onLayout` 在这一层测的就是表宽。 */}
            <View className="flex-1" collapsable={false} onLayout={handleTableLayout}>
              <SectionList
                ref={listRef}
                className="flex-1 bg-surface-sunken"
                sections={legTable.sections}
                keyExtractor={(leg) => leg.code}
                // 🚨 Guardrail 9 —— 只在 iOS 默认为 true，MUST 显式传（否则 Android 表头滚走）。
                stickySectionHeadersEnabled={true}
                // 🚨 064 FR-022 下拉刷新：横滑 `Pan` 已配 `failOffsetY([-12, 12])`（纵向超 12px
                //    直接交还本列表）⇒ 两者正交，不抢手势。**不遮罩不置灰** —— 旧表全程可读，
                //    新一批到齐后由 React Query 整体替换。
                //    📌 RN Web 的 `RefreshControl` 无下拉行为 ⇒ 档位条上另有一个可点入口，
                //    两者调的是**同一个** refetch。
                refreshControl={
                  <RefreshControl refreshing={legTable.isRefreshing} onRefresh={legTable.retry} />
                }
                testID="optionsdesk-detail-scroll"
                ListHeaderComponent={
                  // ── 046 三块（FR-001 版式不动，三个组件一行不改）─────────────
                  //    实测高度供 T016 的下钻滚动用（滚到它的下边缘 = 选约区块顶）。
                  <View
                    className="gap-sm px-md py-sm"
                    onLayout={(event) => {
                      const next = event.nativeEvent.layout.height;
                      setHeaderHeight((prev) => (prev === next ? prev : next));
                    }}
                  >
                    {/* ── 块 ① 锚卡 ───────────────────────────────────────── */}
                    {composition.anchorCard === 'loading' ? (
                      <BlockSkeleton testID="optionsdesk-detail-anchor-card-loading" />
                    ) : composition.anchorCard === 'failed' || detail.detail === null ? (
                      <View className="rounded-md border border-line bg-surface px-md py-sm">
                        <ErrorRow text={COPY.anchorCard.loadFailed} />
                      </View>
                    ) : (
                      <AnchorDetailCard anchor={detail.detail.anchor} today={detail.today} />
                    )}

                    {/* ── 块 ② 个股温度计区块 ─────────────────────────────── */}
                    {composition.anchorCard === 'loading' ? (
                      <BlockSkeleton testID="optionsdesk-detail-iv-loading" />
                    ) : detail.detail === null ? null : (
                      <IvReadoutBlock iv={detail.detail.iv} onPanorama={onPanorama} />
                    )}

                    {/* ── 块 ③ 区间时序（四区间带只依赖锚 ⇒ 序列失败时照常画） ── */}
                    <PriceZoneChart
                      bounds={detail.detail ? parseZoneBounds(detail.detail.anchor) : null}
                      items={detail.series}
                      state={composition.series}
                      window={detail.window}
                      onWindowChange={detail.setWindow}
                      onRetry={detail.retrySeries}
                      anchorAsof={detail.detail?.anchor.asof ?? null}
                      today={detail.today}
                      freshnessTier={detail.seriesFreshnessTier}
                    />

                    {/* ── 055 报表入口行（FR-035/036/037a）─────────────────────
                        🚨 位置是判据的一部分：在 046 三块**之后**、选约区块**之前**
                        （报表是选约的上游，入口出现在用户看到选约表之后就失去意义），
                        且落在 `ListHeaderComponent` 里 ⇒ **随页滚走、不进吸顶区**
                        （FR-036；sticky 那一层是 `renderSectionHeader`，别搬过去）。
                        🚨 未建锚时整行不出现（FR-037a）—— 判据与报表屏那道深链闸
                        **同一份**（`chain-report-entry.rules.ts`）。 */}
                    {chainReportEntry ? (
                      <ChainReportEntryRow
                        onPress={() => router.push(optionsdeskChainReportRoute(symbol))}
                      />
                    ) : null}
                  </View>
                }
                renderSectionHeader={() => (
                  // sticky —— asOf + 计数条 / 意图条 + 水位 chip / Tab 栏 + 就地注明 / 12 列表头。
                  // 🚨 四件都在**同一个** section header 里：切 Tab 只换 `section.data`，头不重建。
                  <View>
                    {/* 🚨 FR-021 不动区：警示注**置顶**，且腿数据照常全量（表不隐藏不折叠不置灰）。 */}
                    {legTable.chain?.intent === 'no_new_position' ? (
                      <View
                        className="border-b border-warn bg-warn-soft px-md py-xs"
                        testID="optionsdesk-detail-leg-no-new-position"
                      >
                        <Text className="text-xs text-ink">{LEG_COPY.noNewPositionWarning}</Text>
                      </View>
                    ) : null}
                    {/* 🚨 区块头四个字段全是**链级**的（三视角逐字相等，053 FR-006）⇒ 读
                        `legTable.chain`：当前视角那一份还在飞时它回退到已到手的任一视角，
                        MUST NOT 因为换了个视角就把时点条闪成「无数据时点」。 */}
                    <LegBlockHeader
                      asOf={legTable.chain?.asOf ?? null}
                      // 🚨 064：实时档下这一行说的是**库内快照的归属日**（「快照 X」），
                      //    而不是「数据截至 X · 收盘」—— 后者会与档位条上的时刻同屏对冲。
                      blockPriceKind={blockPriceKind}
                      // 表还没到手就没有可判的东西 —— 显式 UNAVAILABLE，MUST NOT 默认成 CURRENT。
                      freshnessTier={legTable.chain?.asOfFreshnessTier ?? 'UNAVAILABLE'}
                      source={legTable.chain?.source ?? null}
                      // 🚨 053 FR-016：报的是**符合条件的总数**（视角级 ⇒ 读 `table` 不读 `chain`），
                      //    不是渲染出来的行数 —— 后者由非常驻区的截断计数承担（SC-005）。
                      countLine={legRowCountLine(legTable.table)}
                    />
                    <PositionBucketChips
                      symbol={symbol}
                      anchorId={detail.detail?.anchor.id ?? null}
                      table={legTable.chain}
                    />
                    {/* 🚨 就地注明已移出常驻区（051 FR-010a）—— 见 `renderSectionFooter`。 */}
                    {/* 🚨 052：检索条件入口挂在 Tab 行右端，**sticky 栈一层不加**。 */}
                    <LegPickerTabs
                      tab={legTable.tab}
                      onSelect={legTable.setTab}
                      onOpenCriteria={openCriteria}
                      criteriaCount={criteriaOverrideCount(legTable.criteria)}
                    />
                    {/* 🚨 064 档位条：叠在 Tab 行与 12 列表头之间（mockup 帧 ①~⑤）。
                        它与上面那条区块头**各答一个问题**，MUST NOT 合并 —— 详见组件文件头。 */}
                    <LegTierBar
                      priceKind={blockPriceKind}
                      quoteAsOf={legTable.chain?.quoteAsOf ?? null}
                      eodRowCount={eodRowCount}
                      // 🚨 064 T008a：链级降级标原样透传 —— 🚫 MUST NOT 在这里按档位反推，
                      //    「正常休市」与「盘中源挂了」在 `priceKind` 上是同一个值。
                      realtimeDegrade={legTable.chain?.realtimeDegrade ?? null}
                      // 🚨 064 FR-022：首屏走等待态、刷新中保表 —— 两者文案与处置都不同。
                      phase={legQuotePhase(legTable.block, legTable.isRefreshing)}
                      // 📌 刷新 = 重取**当前视角这一份**，与失败重试是同一个操作 ⇒ 复用同一个入口。
                      //    🚫 MUST NOT 为「刷新」另造第二个 refetch —— 两个名字必然长出两个实现。
                      onRefresh={legTable.retry}
                    />
                    {/* 🚨 064 FR-021：成员变化是**瞬时告知**，位置在档位条与表头之间（帧 ⑧）——
                        无变化 / 首屏 / 换视角 / 改条件时**整条不渲染**（判定在 hook 里）。 */}
                    {legTable.membershipChange === null ? null : (
                      <LegMembershipNotice
                        change={legTable.membershipChange}
                        onDismiss={legTable.dismissMembershipChange}
                      />
                    )}
                    <LegTableHeader
                      tx={tx}
                      // 🚨 费率列头即口径本身，取自服务端下发的映射（051 FR-017）——
                      //    契约未到手时退降级标题，MUST NOT 先猜一个口径挂上去。
                      rateHeader={rateHeaderFor(legTable.table?.basis ?? null)}
                      // 🚨 两个时点一并交给列头的单点判定：OI 挂 `oiAsOf`、成交量按档位切口径。
                      //    🚫 MUST NOT 在这里择一传入 —— 「取错了那一个」正是 FR-014 的静默失效面。
                      quotes={{
                        priceKind: blockPriceKind,
                        quoteAsOf: legTable.chain?.quoteAsOf ?? null,
                        oiAsOf: legTable.chain?.oiAsOf ?? null,
                      }}
                    />
                    {/* 🚨 指示条钉在 12 列表头**正下方**（不是表格底部）—— 它描述列的位置，
                        且要跟着 sticky 栈走（FR-005）。几何读同一个 `tx`，无第二个来源。 */}
                    <LegColumnScrollbar
                      tx={tx}
                      viewportW={viewportW}
                      contentWidth={LEG_SCROLL_REGION_WIDTH}
                    />
                  </View>
                )}
                renderItem={({ item }) => (
                  // 🚨 053 起档位与活跃标都在 `item` 自己身上（契约按视角收窄成标量）——
                  //    这里再也没有「取哪一格」这一步，故也传不错。
                  <LegRow leg={item} tx={tx} today={detail.today} blockPriceKind={blockPriceKind} />
                )}
                renderSectionFooter={() => (
                  // 🚨 三样东西同落非常驻区（051 FR-010a）：就地说明 + 两个门槛计数 + 空态解释。
                  //    052 起再追加一类：**仅被用户收窄**的维度各一行计数（FR-029）。
                  //    053 起再追加两类：**截断计数第 3 条**（FR-016）与**候选上限 `K` 的异常位**
                  //    （FR-019c）—— 两者刻意不同款，见各自 rules 函数的注释。
                  <LegBlockNotice
                    state={legTable.block}
                    total={legTable.total}
                    notices={legTable.notices}
                    gates={legGateCountLines(legTable.table?.gateCounts ?? null, legTable.tab)}
                    criteria={criteriaCountLines(legTable.criteria)}
                    // 🚨 两者都读**当前视角自己的**响应（`table`），MUST NOT 读回退到别的视角的
                    //    `chain` —— 截断阈值与 `K` 触及都是视角级的量。
                    truncation={legTruncationLine(legTable.table)}
                    candidateCap={legCandidateCapLine(legTable.table)}
                    // 🚨 空态按**该视角自己的**排除数分支（051 FR-009 / SC-013）；
                    //    条件收窄出来的空是第三支，入口是「复位」而不是换视角（052 Edge Case）。
                    empty={legEmptyState(
                      legTable.table?.gateCounts ?? null,
                      legTable.tab,
                      legTable.criteria,
                    )}
                    onRetry={legTable.retry}
                    // 🚨 053 FR-020：自动重取一次之后三份的业务日仍不一致 ⇒ 显式提示 + 手动刷新。
                    asOfMismatch={legTable.asOfMismatch}
                    // 🚨 055 FR-039a：报表与选约跨了业务日 ⇒ 两个时点各自可见。与上面那条
                    //    （三视角之间不一致）**分开**：一条说的是「表内三份对不齐」、
                    //    另一条说的是「你从报表带过来的那一格是另一天的」。
                    drilldownAsOf={drilldownAsOf}
                    onRefreshAll={legTable.refreshAll}
                    onSelectTab={legTable.setTab}
                    onOpenCriteria={() => setCriteriaOpen(true)}
                    onResetCriteria={legTable.resetCriteria}
                  />
                )}
                ListFooterComponent={<LegBlockFooter />}
              />
            </View>
          </GestureDetector>
        )}

        {/* 🚨 抽屉渲在 RN `Modal` 里（组件内），故挂载位置只决定生命周期不决定层级 ——
            关态不挂载 ⇒ 草稿随开关自然重建，未提交的改动丢弃是定义如此（FR-012）。 */}
        {criteriaOpen ? (
          <LegCriteriaSheet
            tab={legTable.tab}
            defaults={legTable.criteria?.defaults ?? null}
            submitted={legTable.submittedCriteria}
            onSubmit={(form) => {
              legTable.submitCriteria(form);
              setCriteriaOpen(false);
            }}
            onReset={() => {
              legTable.resetCriteria();
              setCriteriaOpen(false);
            }}
            onClose={() => setCriteriaOpen(false)}
          />
        ) : null}
      </GestureHandlerRootView>
    </SafeAreaView>
  );
}

/**
 * 055 报表入口行（`FR-035`–`FR-037`）。版式随 046 三块**同款卡片**，与它们并列在同一个
 * `ListHeaderComponent` 容器里 —— 入口是「上游的一块」不是浮在表上的按钮。
 * 🚨 措辞取 `chainReport.entryTitle`，🚫 MUST NOT 复用温度计那句「全景 ›」（`FR-037`）。
 */
function ChainReportEntryRow({ onPress }: { onPress: () => void }) {
  const copy = OPTIONSDESK_COPY.chainReport;
  return (
    <Pressable
      className="flex-row items-center rounded-md border border-line bg-surface px-md py-sm"
      accessibilityRole="button"
      accessibilityLabel={copy.entryTitle}
      testID="optionsdesk-detail-chain-report-entry"
      onPress={onPress}
    >
      <View className="flex-1 gap-0.5">
        <Text className="text-sm font-semibold text-ink">{copy.entryTitle}</Text>
        <Text className="text-[11px] text-ink-muted">{copy.entrySubtitle}</Text>
      </View>
      <Text className="text-base text-ink-muted">›</Text>
    </Pressable>
  );
}

/** 单块骨架 —— **块级** loading（整页 loading 是本片明禁的形态）。 */
function BlockSkeleton({ testID }: { testID: string }) {
  return (
    <View className="items-center rounded-md border border-line bg-surface py-lg" testID={testID}>
      <Spinner size={16} tone="muted" />
    </View>
  );
}

/**
 * 选约区块头（sticky）—— 区块级 `asOf` + 来源 + 计数条。
 *
 * 🚨 **计数条 053 起报的是「符合条件的总数」`matchedCount`**（FR-016，判定在 `legRowCountLine`）
 *    —— 表达层截断之后它与渲染出来的行数不再相等，而「已显示前 D 条」由**非常驻区**的截断计数
 *    承担；两处报同一个数会被读成两个不同的量（`SC-005` 明禁）。
 *    📌 047 那条「分母取 `section.data.length`、MUST NOT 取渲染窗口大小」随之作废 —— 它当年防的是
 *    「拿虚拟化窗口大小冒充总数」，而现在总数由服务端下发，窗口与逻辑集合都不再是它的来源。
 *
 * 🚨 **`asOf` 按 server 下发的 `asOfFreshnessTier` 二分**（T027a，`state_branches` 第 3 条）：
 *    常态平铺、陈旧转醒目。判据 MUST 留在 server —— 「asOf 是不是当期」要查交易日历，客户端
 *    只有设备本地日期，而拿它比美股 EOD **恒显已过时**（境内本地日历领先市场一天）⇒ 永远为真
 *    的告警等于没有告警。**别把判据搬回客户端。** 映射在 `leg-picker-copy.ts` 的 `legAsOfLabel`。
 * 📌 `source` 只在**非 eod** 时出：「一直靠盘前兜底续命」是要看得见的事实，且它是契约给的。
 */
function LegBlockHeader({
  asOf,
  blockPriceKind,
  freshnessTier,
  source,
  countLine,
}: {
  asOf: string | null;
  /** 🚨 064：实时档下本行改说「快照 X」—— 报价的时点归档位条，两处报同一个量必 drift。 */
  blockPriceKind: LegBlockPriceKind | null;
  freshnessTier: FreshnessTier;
  source: string | null;
  countLine: string;
}) {
  const asOfLabel = legAsOfLabel(asOf, freshnessTier, blockPriceKind);
  return (
    <View
      className="flex-row items-center justify-between border-b border-line bg-surface-alt px-md py-xs"
      testID="optionsdesk-detail-leg-header"
    >
      <View className="flex-row items-baseline gap-xs">
        <Text className={asOfLabel.className} testID="optionsdesk-detail-leg-asof">
          {asOfLabel.text}
        </Text>
        {source !== null && source !== 'eod' ? (
          <Text className="text-[10px] text-ink-muted" testID="optionsdesk-detail-leg-source">
            {`${LEG_COPY.sourceBackfillPrefix}${source}`}
          </Text>
        ) : null}
      </View>
      <Text className="font-mono text-[10px] text-ink-muted" testID="optionsdesk-detail-leg-count">
        {countLine}
      </Text>
    </View>
  );
}

/**
 * 区块四态的显式呈现。**四态没有一个是「隐藏这一块」** —— 零适格腿也照常显示面板
 * （FR-021：空 Tab 可进入、不隐藏不置灰）。
 * 🚨 `chain_not_ready`（采集还没轮到，是事实）与 `read_failed`（读故障）**MUST NOT 合并**。
 * 📌 T034 接手扩文案（「说明何时会有」）与数据缺口体系，本槽位结构不变。
 */
function LegBlockNotice({
  state,
  total,
  notices,
  gates,
  criteria,
  truncation,
  candidateCap,
  empty,
  onRetry,
  asOfMismatch,
  drilldownAsOf,
  onRefreshAll,
  onSelectTab,
  onOpenCriteria,
  onResetCriteria,
}: {
  state: LegBlockState;
  total: number;
  notices: readonly LegPickerNotice[];
  gates: readonly LegGateCountLine[];
  criteria: readonly CriteriaCountLine[];
  /** 截断计数第 3 条（053 FR-016）。`null` ⇒ **未触发截断，整条不渲染**（FR-018）。 */
  truncation: LegTruncationLine | null;
  /** 候选上限 `K` 的异常位（053 FR-019c）。`null` ⇒ 未触及，**整块不出现**（SC-016）。 */
  candidateCap: LegCandidateCapLine | null;
  empty: LegEmptyState;
  onRetry: () => void;
  asOfMismatch: boolean;
  /** 055 FR-039a：报表侧与本表业务日不一致时的那一句（含**两个**时点）；一致 / 非下钻 ⇒ `null`。 */
  drilldownAsOf: string | null;
  onRefreshAll: () => void;
  onSelectTab: (tab: LegPickerTab) => void;
  onOpenCriteria: () => void;
  onResetCriteria: () => void;
}) {
  const quiet = legGateCountsQuiet(gates);
  if (state === 'loading') {
    return <BlockSkeleton testID="optionsdesk-detail-leg-loading" />;
  }
  if (state === 'read_failed') {
    return (
      <View
        className="items-start gap-xs bg-surface px-md py-sm"
        testID="optionsdesk-detail-leg-read_failed"
      >
        <ErrorRow text={LEG_COPY.readFailed} />
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={LEG_COPY.retry}
          testID="optionsdesk-detail-leg-retry"
          className="rounded-full border border-line px-md py-0.5"
        >
          <Text className="text-xs text-brand-500">{LEG_COPY.retry}</Text>
        </Pressable>
      </View>
    );
  }
  // 🚨 **数据缺口体系**（虚线 + `surface-sunken`）—— 与红标（错误）体系蓄意区隔：
  //    「还没采到」与「读挂了」是两件事，`read_failed` 上面那支才配红标。
  if (state === 'chain_not_ready') {
    return (
      <View className={GAP_NOTICE_CLASS} testID="optionsdesk-detail-leg-chain_not_ready">
        <Text className="text-xs text-ink-muted">{LEG_COPY.chainNotReady}</Text>
      </View>
    );
  }
  return (
    <View>
      {/* 🚨 053 FR-020：三个视角是三次独立请求 —— 自动重取一次之后业务日仍不一致时**说出来**。
          🚫 MUST NOT 静默并排呈现来自不同交易日的读数（每个数字都对，只是不属于同一天）；
          🚫 也 MUST NOT 继续重取（布尔闩已置，处置权交回用户 ⇒ 这里给的是手动入口）。
          📌 走数据缺口体系（虚线 + 沉底底色）而非红标：它是「口径可能对不齐」不是读挂了。 */}
      {asOfMismatch ? (
        <View className={GAP_NOTICE_CLASS} testID="optionsdesk-detail-leg-asof-mismatch">
          <Text className="text-xs text-ink-muted">{LEG_COPY.asOfMismatch}</Text>
          <Pressable
            onPress={onRefreshAll}
            accessibilityRole="button"
            accessibilityLabel={LEG_COPY.asOfMismatchCta}
            testID="optionsdesk-detail-leg-asof-mismatch-refresh"
            className="mt-xs self-start"
          >
            <Text className="text-xs font-medium text-brand-500">{`${LEG_COPY.asOfMismatchCta} ›`}</Text>
          </Pressable>
        </View>
      ) : null}

      {/* 🚨 055 FR-039a：从报表某格下钻过来、而两侧业务日不同 ⇒ **两个时点都说出来**。
          那时「报表说 5 条、进去只有 3 条」是**数据真的变了**不是缺陷，但一个字都不说它就
          变成了缺陷。同走数据缺口体系（虚线 + 沉底底色）—— 它不是错误。 */}
      {drilldownAsOf === null ? null : (
        <View className={GAP_NOTICE_CLASS} testID="optionsdesk-detail-leg-drilldown-asof">
          <Text className="text-xs text-ink-muted">{drilldownAsOf}</Text>
        </View>
      )}

      {total === 0 ? (
        <LegEmptyBlock empty={empty} onSelectTab={onSelectTab} onReset={onResetCriteria} />
      ) : null}

      {/* 数据缺口 / 口径说明体系：`surface-alt` 底，**与红标体系区隔** —— 它不是错误。 */}
      {notices.map((notice) => (
        <View
          key={notice.key}
          className="border-b border-line-soft bg-surface-alt px-md py-xs"
          testID={`optionsdesk-detail-leg-notice-${notice.key}`}
        >
          {/* ⚠️ 降级状态字禁用最淡档 `text-ink-subtle`（白底实测 2.85:1，不达标）。 */}
          <Text className="text-[10px] text-ink-muted">{notice.text}</Text>
        </View>
      ))}

      {/* ── 两个门槛计数（FR-006/007/007a）+ 两数皆 0 时降权（FR-008）────── */}
      <View className="gap-[3px] bg-surface px-md py-xs" testID="optionsdesk-detail-leg-gates">
        {gates.map((gate) => (
          <LegGateLine key={gate.key} gate={gate} quiet={quiet} onSelectTab={onSelectTab} />
        ))}
        {/* 🚨 052：**仅被用户收窄**的维度各一行（FR-029）—— 与上面两条同体例、同结构，
            但入口指向抽屉：这一刀是用户自己切的，能改回去的地方就是那几个控件。
            🚫 放宽与未覆盖不出行（判据在 `criteriaCountLines`，放宽不产生排除）。 */}
        {criteria.map((line) => (
          <Pressable
            key={line.key}
            onPress={onOpenCriteria}
            accessibilityRole="button"
            accessibilityLabel={line.text}
            testID={`optionsdesk-detail-leg-criteria-${line.key}`}
          >
            <Text className="text-[10px] font-medium text-brand-500">
              {`${line.text}${LEG_COPY.criteria.countGoNote}`}
            </Text>
          </Pressable>
        ))}
        {/* 🚨 053 FR-016 第 3 条：**与「权利金移出」同款** —— `text-ink-muted` 纯文字、无雪佛龙。
            🚫 MUST NOT 用告警色（Guardrail 6）：截断是**正常的呈现约定**不是异常，告警色会让人
               以为数据坏了；真正的异常位是下面那块 `K` 熔断提示，两者刻意不同款。
            🚫 MUST NOT 在这里再报一次「符合条件 N 条」—— 那个数在 sticky 区块头（SC-005）。 */}
        {truncation === null ? null : (
          <Text className="text-[10px] text-ink-muted" testID="optionsdesk-detail-leg-truncated">
            {truncation.text}
          </Text>
        )}
      </View>

      {/* 🚨 053 FR-019c：候选上限 `K` 触及 ⇒ **另起异常位**（Guardrail 14）。走数据缺口体系
          （虚线 + 沉底底色）而非上面那排纯文字计数 —— `K` 是给下游限流的保险丝，处置是**调容量**；
          截断是正常呈现约定，处置是**调展示**。同款呈现会让前者被读成后者。
          🚫 也不走红标体系：读没挂，只是「上面的数可能少报」。 */}
      {candidateCap === null ? null : (
        <View className={GAP_NOTICE_CLASS} testID="optionsdesk-detail-leg-candidate-cap">
          <Text className="text-xs text-ink-muted">{candidateCap.text}</Text>
        </View>
      )}
    </View>
  );
}

/**
 * 空态。两分支**一眼可分**（FR-009）：带入口那支是「去看被挡下的那些」，无入口那支是
 * 「换一只票」—— 用户据此该做的事完全不同，所以入口的有无不是装饰。
 */
function LegEmptyBlock({
  empty,
  onSelectTab,
  onReset,
}: {
  empty: LegEmptyState;
  onSelectTab: (tab: LegPickerTab) => void;
  onReset: () => void;
}) {
  const cta = empty.cta;
  return (
    <View className={GAP_NOTICE_CLASS} testID="optionsdesk-detail-leg-empty">
      {empty.title === null ? null : (
        <Text className="text-xs font-semibold text-ink">{empty.title}</Text>
      )}
      <Text className="text-xs text-ink-muted">{empty.text}</Text>
      {cta === null ? null : (
        <Pressable
          onPress={() => onSelectTab(cta.tab)}
          accessibilityRole="button"
          accessibilityLabel={cta.label}
          testID="optionsdesk-detail-leg-empty-cta"
          className="mt-xs self-start"
        >
          <Text className="text-xs font-medium text-brand-500">{`${cta.label} ›`}</Text>
        </Pressable>
      )}
      {/* 052 第三支：空是用户自己收窄出来的 ⇒ 给的入口是**复位**（换视角在这里帮不上忙）。 */}
      {empty.reset === null ? null : (
        <Pressable
          onPress={onReset}
          accessibilityRole="button"
          accessibilityLabel={empty.reset}
          testID="optionsdesk-detail-leg-empty-reset"
          className="mt-xs self-start"
        >
          <Text className="text-xs font-medium text-brand-500">{`${empty.reset} ›`}</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * 计数区的一行。🚨 **可点与否由数据说了算**（`goTab`）—— 权利金那条恒无入口，
 * 给它一个「去看看」是空承诺：那些腿根本不在响应里（FR-007a）。
 */
function LegGateLine({
  gate,
  quiet,
  onSelectTab,
}: {
  gate: LegGateCountLine;
  quiet: boolean;
  onSelectTab: (tab: LegPickerTab) => void;
}) {
  const testID = `optionsdesk-detail-leg-gate-${gate.key}`;
  // ⚠️ 降权 = **去掉主色 + 缩字号**，字色仍是 `ink-muted`（5.7:1）——
  //    🚫 MUST NOT 换 `ink-subtle`（2.85:1）：那是「看不清」不是「不抢眼」。
  const quietClass = 'text-[9px] text-ink-muted';
  if (gate.goTab === null) {
    return (
      <Text className={quiet ? quietClass : 'text-[10px] text-ink-muted'} testID={testID}>
        {gate.text}
      </Text>
    );
  }
  const goTab = gate.goTab;
  return (
    <Pressable
      onPress={() => onSelectTab(goTab)}
      accessibilityRole="button"
      accessibilityLabel={gate.text}
      testID={testID}
    >
      <Text
        className={quiet ? quietClass : 'text-[10px] font-medium text-brand-500'}
      >{`${gate.text} ›`}</Text>
    </Pressable>
  );
}

/** 数据缺口体系的块级样式（虚线 + 沉底底色）。⚠️ 降级字用 `text-ink-muted`，非最淡档。 */
const GAP_NOTICE_CLASS =
  'border border-dashed border-line-strong bg-surface-sunken mx-md my-sm px-md py-sm';

/**
 * 🚨 **FR-011 常驻页脚** —— 「常驻」= 区块页脚**不可折叠、不随状态消失**（四态都在），
 * 不是屏幕常驻：mockup 帧 ①–④ 的页脚就在表格下方随表滚动。**别照抄 046 把它挪到
 * 滚动容器之外**（那条是 FR-019 免责的形态，两者要求不同）。
 * 📌 四档图例在这里 —— 色标与 bid 单元格**同一份** `TIER_TONE`（`leg-picker-copy.ts`），不手抄。
 */
function LegBlockFooter() {
  return (
    <View className="gap-xs bg-surface px-md py-sm" testID="optionsdesk-detail-leg-footer">
      {/* ── 四档图例（色标 + 两族边界同屏；跨族 MUST NOT 比数值）───────────── */}
      <Text className="text-[10px] text-ink-muted">{LEG_COPY.legendTitle}</Text>
      <View className="flex-row flex-wrap gap-xs" testID="optionsdesk-detail-leg-legend">
        {LEG_TIER_LEGEND.map((row) => (
          <View key={row.tier} className="flex-row items-center gap-1">
            <View className={`h-2.5 w-2.5 rounded-sm ${row.tone.container}`} />
            <Text className="text-[9px] text-ink-muted">{`${row.label} ${row.bounds}`}</Text>
          </View>
        ))}
      </View>
      <Text className="text-[10px] text-ink-muted">{LEG_COPY.legendUnjudgeable}</Text>
      <Text className="text-[10px] text-ink-muted">{LEG_COPY.legendBuildNoEarnings}</Text>

      {/* ── DTE 两段式 + FR-011 常驻免责 ──────────────────────────────────── */}
      <Text className="text-[10px] text-ink-muted">{LEG_COPY.dteTip}</Text>
      <Text className="text-[10px] text-ink-muted">{LEG_COPY.dteTipAnnualNote}</Text>
      <Text className="text-xs text-ink" testID="optionsdesk-detail-leg-disclaimer">
        {LEG_COPY.disclaimer}
      </Text>
    </View>
  );
}
