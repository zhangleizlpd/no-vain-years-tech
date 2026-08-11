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
// 判定全在 `underlying-detail.rules.ts`（vitest 覆盖）；本文件与子件只做接线与版面，
// 渲染 / 交互 / a11y 走 Playwright e2e（本仓测试分层：vitest=logic / Playwright=UI）。
import { Pressable, SectionList, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSharedValue } from 'react-native-reanimated';

import { ErrorRow, SafeAreaView, Spinner } from '~/ui';
import { AnchorDetailCard } from './anchor-detail-card';
import { IvReadoutBlock } from './iv-readout-block';
import { LEG_TIER_LEGEND, legAsOfLabel } from './leg-picker-copy';
import { legActivityForTab, rateSubForTab, showsBasisBadge } from './leg-picker.rules';
import { LegPickerTabs } from './leg-picker-tabs';
import { LegRow } from './leg-row';
import { LegTableHeader } from './leg-table-header';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { OPTIONSDESK_ANCHOR_NEW_ROUTE } from './optionsdesk-routes';
import { PositionBucketChips } from './position-bucket-chips';
import { PriceZoneChart } from './price-zone-chart';
import { parseZoneBounds, type FreshnessTier, type LegBlockState } from './underlying-detail.rules';
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
}

export function UnderlyingDetailScreen({ symbol, onPanorama }: UnderlyingDetailScreenProps) {
  const router = useRouter();
  const detail = useUnderlyingDetail(symbol);
  const legTable = useLegTable(symbol);
  const { composition } = detail;
  // 表头与每个数据行**共享**这一个横向位移（方向正交 ⇒ 与纵向 SectionList 不争手势）。
  const columnOffset = useSharedValue(0);
  // canonical `market:code` → 展示用 code（解析失败退回原串，不丢信息）。
  const code = symbol.split(':')[1] ?? symbol;

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      <Stack.Screen options={{ title: code }} />

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
        <SectionList
          className="flex-1 bg-surface-sunken"
          sections={legTable.sections}
          keyExtractor={(leg) => leg.code}
          // 🚨 Guardrail 9 —— 只在 iOS 默认为 true，MUST 显式传（否则 Android 表头滚走）。
          stickySectionHeadersEnabled={true}
          testID="optionsdesk-detail-scroll"
          ListHeaderComponent={
            // ── 046 三块（FR-001 版式不动，三个组件一行不改）─────────────
            <View className="gap-sm px-md py-sm">
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
            </View>
          }
          renderSectionHeader={() => (
            // sticky —— asOf + 计数条 / 意图条 + 水位 chip / Tab 栏 + 就地注明 / 12 列表头。
            // 🚨 四件都在**同一个** section header 里：切 Tab 只换 `section.data`，头不重建。
            <View>
              {/* 🚨 FR-021 不动区：警示注**置顶**，且腿数据照常全量（表不隐藏不折叠不置灰）。 */}
              {legTable.table?.intent === 'no_new_position' ? (
                <View
                  className="border-b border-warn bg-warn-soft px-md py-xs"
                  testID="optionsdesk-detail-leg-no-new-position"
                >
                  <Text className="text-xs text-ink">{LEG_COPY.noNewPositionWarning}</Text>
                </View>
              ) : null}
              <LegBlockHeader
                asOf={legTable.table?.asOf ?? null}
                // 表还没到手就没有可判的东西 —— 显式 UNAVAILABLE，MUST NOT 默认成 CURRENT。
                freshnessTier={legTable.table?.asOfFreshnessTier ?? 'UNAVAILABLE'}
                source={legTable.table?.source ?? null}
                total={legTable.total}
              />
              <PositionBucketChips
                symbol={symbol}
                anchorId={detail.detail?.anchor.id ?? null}
                table={legTable.table}
              />
              <LegPickerTabs
                tab={legTable.tab}
                onSelect={legTable.setTab}
                notices={legTable.notices}
              />
              <LegTableHeader
                tx={columnOffset}
                rateSub={rateSubForTab(legTable.tab)}
                oiAsOf={legTable.table?.oiAsOf ?? null}
              />
            </View>
          )}
          renderItem={({ item }) => (
            <LegRow
              leg={item}
              tx={columnOffset}
              today={detail.today}
              // 🚨 活跃度是**当前 Tab 候选集内**的相对排名 —— 换 Tab 归属就变，故按 Tab 取。
              activity={legActivityForTab(item, legTable.tab)}
              // 全腿 Tab 混排 ⇒ 每行标腿族口径；单口径 Tab 关掉（FR-019）。
              showBasisBadge={showsBasisBadge(legTable.tab)}
            />
          )}
          renderSectionFooter={() => (
            <LegBlockNotice
              state={legTable.block}
              total={legTable.total}
              onRetry={legTable.retry}
            />
          )}
          ListFooterComponent={<LegBlockFooter />}
        />
      )}
    </SafeAreaView>
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
 * 🚨 计数条分母恒取**逻辑集合**长度（`section.data.length`），**MUST NOT 取渲染窗口大小** ——
 *    这是 SC-012「滚动条长度 = 逻辑总行数」的可读判据（plan D-UI-2 ③）。
 *
 * 🚨 **`asOf` 按 server 下发的 `asOfFreshnessTier` 二分**（T027a，`state_branches` 第 3 条）：
 *    常态平铺、陈旧转醒目。判据 MUST 留在 server —— 「asOf 是不是当期」要查交易日历，客户端
 *    只有设备本地日期，而拿它比美股 EOD **恒显已过时**（境内本地日历领先市场一天）⇒ 永远为真
 *    的告警等于没有告警。**别把判据搬回客户端。** 映射在 `leg-picker-copy.ts` 的 `legAsOfLabel`。
 * 📌 `source` 只在**非 eod** 时出：「一直靠盘前兜底续命」是要看得见的事实，且它是契约给的。
 */
function LegBlockHeader({
  asOf,
  freshnessTier,
  source,
  total,
}: {
  asOf: string | null;
  freshnessTier: FreshnessTier;
  source: string | null;
  total: number;
}) {
  const asOfLabel = legAsOfLabel(asOf, freshnessTier);
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
        {LEG_COPY.rowTotal(total)}
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
  onRetry,
}: {
  state: LegBlockState;
  total: number;
  onRetry: () => void;
}) {
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
  if (total === 0) {
    return (
      <View className={GAP_NOTICE_CLASS} testID="optionsdesk-detail-leg-empty">
        <Text className="text-xs text-ink-muted">{LEG_COPY.empty}</Text>
      </View>
    );
  }
  return null;
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
