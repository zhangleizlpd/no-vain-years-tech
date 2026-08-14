// 047 T032 — 腿行（12 列 716px；FR-003/005, plan D-UI-1）。
//
// 🚨 **首列（行权价/到期，88px）渲在横向位移区之外 ⇒ 天然钉住**；右侧 11 列进
//    `LegColumnPane`，与表头共读屏级唯一的 `tx`（横向机制的注释单源在 `leg-column-pane.tsx`）。
//
// 🚨 **费率列随行口径切换主数字、Δ 恒读 `absDelta`** —— 判定全在 `leg-row.rules.ts`
//    （vitest 覆盖），本文件只做接线与版面。
//
// 🚫 **FR-012：本片无「选腿 → 创建许愿单」入口** —— 行**不可点**：本组件树内零 `Pressable`、
//    零 `onPress`、零 `accessibilityRole="button"`、零选中态。动作列是**建议标签不是按钮**。
//
// ── 047 T034 档位着色 / 动作四态 / 财报 chip（FR-003/006/007/010/012）────────────────
// 🚨 **只着 bid 单元格** —— 整行着色会糊；行级唯一的着色是**死档的灰底沉底**（FR-006），
//    那是「已出局」的中性灰，不属于四档色阶。判定与 class 全在 `leg-picker-copy.ts`。
// 🚨 **四档是费率质量档不是涨跌** ⇒ 本文件零处 `quote-*`。
// 🚫 **动作列是建议标签不是按钮** —— 中性 tag，无 `onPress`、无选中态（见上方 FR-012 段）。
import { Text, View } from 'react-native';
import type { LegResponse } from '@nvy/api-client';
import type { SharedValue } from 'react-native-reanimated';

import { LegColumnPane } from './leg-column-pane';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { formatPriceText } from './price-format.rules';
import {
  LEG_ACTION_TAG_CLASS,
  LEG_STICKY_BADGE_BASE,
  LEG_STICKY_BADGE_BORDER,
  legActionLabel,
  legActionTextClass,
  legBidTone,
  legEarningsChip,
  legRateCell,
  legRowToneClass,
} from './leg-picker-copy';
import { LEG_ROW_HEIGHT, LegStickyCell, legColumnWidth } from './leg-table-header';
import {
  LEG_SCROLL_REGION_WIDTH,
  costCell,
  deltaCell,
  expiryLabel,
  formatContractPremium,
  formatCount,
  formatQuoteSize,
  formatRelativeSpread,
  strikeLabel,
  type StackedCell,
} from './leg-row.rules';

const COPY = OPTIONSDESK_COPY.legPicker;

export interface LegRowProps {
  leg: LegResponse;
  /** 屏级唯一的横向位移（负值域）—— 表头与全部行读同一个（FR-001）。 */
  tx: SharedValue<number>;
  /** 设备本地日历日 —— **只用于判到期日要不要补年份**，不参与任何新鲜度判断。 */
  today: string;
}

/**
 * 单腿一行。复杂度 O(1)（列数固定）。
 *
 * 🚨 **053 起档位与活跃标直接读 `leg` 自己的字段** —— 一次请求只作答一个视角，契约把这两个
 *    量从 by-tab 映射收窄成**本次视角**的标量 ⇒ 原本靠 `tab` prop「取哪一格」的两个入参随之
 *    退役，调用方少两个可以传错的东西。
 */
export function LegRow({ leg, tx, today }: LegRowProps) {
  // 🚨 档位在本行有**四个消费点**（bid 底色 / 行底 / 动作两处 / 费率副标）⇒ 这里取一次，
  //    四处共用同一个值（同源，不会 drift）。
  const tier = leg.tier;
  // 活跃度是**该视角候选集内**的相对排名（D-SOT-5）—— 换视角就是换一份响应，标随之而变。
  const activity = leg.activity;
  const rate = legRateCell(leg, tier);
  const cost = costCell(leg);
  const bidTone = legBidTone(tier);
  const earnings = legEarningsChip(leg.earningsMark);

  return (
    <View
      className={`flex-row border-b border-line-soft ${legRowToneClass(tier)}`}
      style={{ height: LEG_ROW_HEIGHT }}
      testID={`optionsdesk-detail-leg-row-${leg.code}`}
    >
      {/* ── 首列：行权价 / 到期（横滑之外 ⇒ 钉住）───────────────────────── */}
      {/* 🚨 两个标各贴各的量（FR-014a）：「贴合」贴行权价、「月」贴到期日 —— 月度链是**到期日**
          的属性，贴错行会读成「这个行权价是月度的」。两者同载体、只在描边色上分权重（FR-014b）。 */}
      <LegStickyCell
        className="justify-center border-r border-line px-1.5"
        testID={`optionsdesk-detail-leg-sticky-${leg.code}`}
      >
        <View className="flex-row items-center gap-1">
          <Text className="font-mono text-xs font-semibold text-ink" numberOfLines={1}>
            {strikeLabel(leg)}
          </Text>
          {/* 🚨 取值一律来自服务端（FR-011）—— 同一条腿在三个视角**同值**，客户端不自判；
              greeks 缺失恒 false，但那条腿照常在表内、照常在其所属视角内（FR-013）。 */}
          {leg.isRecommended ? (
            <Text
              className={`${LEG_STICKY_BADGE_BASE} ${LEG_STICKY_BADGE_BORDER.fit}`}
              testID={`optionsdesk-detail-leg-fit-${leg.code}`}
            >
              {COPY.fitBadge}
            </Text>
          ) : null}
        </View>
        <View className="flex-row items-center gap-1">
          <Text className="font-mono text-[8px] text-ink-muted" numberOfLines={1}>
            {expiryLabel(leg, today)}
          </Text>
          {/* 🚫 判据是 server 的「该月第三个周五（非交易日前移）」—— MUST NOT 在这里简化成
              「是不是周五」（FR-014）。 */}
          {leg.isMonthlyChain ? (
            <Text
              className={`${LEG_STICKY_BADGE_BASE} ${LEG_STICKY_BADGE_BORDER.monthly}`}
              testID={`optionsdesk-detail-leg-monthly-${leg.code}`}
            >
              {COPY.monthlyBadge}
            </Text>
          ) : null}
        </View>
      </LegStickyCell>

      {/* ── 右侧 11 列（与表头同 `tx`）─────────────────────────────────── */}
      {/* 🚨 testID 一字不改 —— "scroller" 已不准确（这里没有滚动容器了），但它是 e2e 的锚点。 */}
      <LegColumnPane
        tx={tx}
        contentWidth={LEG_SCROLL_REGION_WIDTH}
        testID={`optionsdesk-detail-leg-scroller-${leg.code}`}
      >
        {/* 🚨 bid/ask 合并一列：**档位色只着这一格**；ask 小字常显（不参与判档）。 */}
        {/* 🚨 格内是**两个子列**（买侧 / 卖侧），各自「价上量下」并左对齐 —— 上下两行的左边缘
            必须咬齐，否则 `0.40` 与 `×311` 宽度不同会各自飘。子列定宽而非靠 gap 撑，
            这样整张表逐行的两侧位置也一致（行与行之间不会因数字位数不同而错位）。 */}
        <NumCell
          columnKey="bid"
          className={bidTone.container}
          align="start"
          testID={`optionsdesk-detail-leg-bid-${leg.code}`}
        >
          <View className="flex-row gap-1">
            <QuoteSide
              price={leg.bid === null ? COPY.noValue : formatPriceText(leg.bid)}
              size={formatQuoteSize(leg.bidSize)}
              // 🚨 档位色**只上买侧的价**；卖侧与两个量一律 muted，染上会被读成「它们也参与判档」。
              priceClass={`font-semibold ${bidTone.text}`}
            />
            <QuoteSide
              price={leg.ask === null ? COPY.noValue : formatPriceText(leg.ask)}
              size={formatQuoteSize(leg.askSize)}
              priceClass="text-ink-muted"
            />
          </View>
        </NumCell>

        {/* 🚨 费率：收租行主显年化 / 建仓行主显周化；**薄档行副标换成 `ask` 口径值**。 */}
        <StackedNumCell
          columnKey="rate"
          cell={rate}
          testID={`optionsdesk-detail-leg-rate-${leg.code}`}
        />
        {/* 🚫 权利金与价差**都读服务端下发的字段**（FR-032）——本文件零处乘合约乘数、
            零处由 bid/ask 现算价差；客户端再算一遍就是同一判据两处各写一份。 */}
        <NumCell columnKey="premium" testID={`optionsdesk-detail-leg-premium-${leg.code}`}>
          <Text className="font-mono text-[11px] text-ink">
            {formatContractPremium(leg.contractPremium)}
          </Text>
        </NumCell>

        {/* 🚨 OI 归属 oiAsOf 那一天（列头已标），与本行其余读数不同天。 */}
        <NumCell columnKey="oi">
          <Text className="font-mono text-[11px] text-ink">{formatCount(leg.openInterest)}</Text>
        </NumCell>
        <NumCell columnKey="spread" testID={`optionsdesk-detail-leg-spread-${leg.code}`}>
          <Text className="font-mono text-[11px] text-ink">
            {formatRelativeSpread(leg.relativeSpread)}
          </Text>
        </NumCell>
        <StackedNumCell columnKey="cost" cell={cost} />

        {/* 🚨 Δ 恒读 `absDelta`（列头副标「带判据」）—— σ 距列已随 053 列改版退场。 */}
        <NumCell columnKey="delta" testID={`optionsdesk-detail-leg-delta-${leg.code}`}>
          <Text className="font-mono text-[11px] text-ink">{deltaCell(leg)}</Text>
        </NumCell>
        <NumCell columnKey="vol">
          <Text className="font-mono text-[11px] text-ink">{formatCount(leg.volume)}</Text>
        </NumCell>

        {/* 活跃度：server 下发的相对档标签（换视角归属就变），无标 ⇒ 占位，不伪造默认档。 */}
        <TextCell columnKey="activity" testID={`optionsdesk-detail-leg-activity-${leg.code}`}>
          {activity?.label ?? COPY.noValue}
        </TextCell>

        {/* 🚨 标注：财报 chip 五形态 + 建仓腿 `null`。**死档行照常打标**（判据是 mark 不是档位）。 */}
        <TagCell
          columnKey="mark"
          label={earnings.label}
          container={earnings.container}
          textClass={earnings.textClass}
          testID={`optionsdesk-detail-leg-mark-${leg.code}`}
        />
        {/* 🚫 动作：四态梯度的**建议标签**，中性 tag —— 不是按钮、无入口（FR-010/011/012）。 */}
        <TagCell
          columnKey="action"
          label={legActionLabel(tier)}
          container={LEG_ACTION_TAG_CLASS}
          textClass={legActionTextClass(tier)}
          testID={`optionsdesk-detail-leg-action-${leg.code}`}
        />
      </LegColumnPane>
    </View>
  );
}

/**
 * bid/ask 格内的一侧：价在上、挂牌量在下，**左对齐且定宽** —— 定宽是为了逐行两侧位置一致，
 * 不随数字位数抖动。宽度按最宽真实内容取（价 `10.90` 5 字符、量 `×311` 4 字符 @ 11px 等宽）。
 */
function QuoteSide({
  price,
  size,
  priceClass,
}: {
  price: string;
  size: string;
  priceClass: string;
}) {
  return (
    <View className="w-9 items-start">
      <Text className={`font-mono text-[11px] ${priceClass}`}>{price}</Text>
      <Text className="font-mono text-[8px] text-ink-muted">{size}</Text>
    </View>
  );
}

/**
 * 数值列（默认右对齐 + 等宽字体）。`className` 是档位底色的挂点（**只有 bid 列会传**）。
 *
 * 📌 `align="start"` 供 bid/ask 那种**格内还有子列**的单元格用：格内两侧各自「价上量下」，
 * 只有左对齐才能让上下两行的左边缘咬齐；右对齐会让 `0.40` 与 `×311` 各自贴右、上下错开。
 * 其余单列数值一律保持右对齐（同量纲数字比大小靠右边缘）。
 */
function NumCell({
  columnKey,
  className,
  align = 'end',
  testID,
  children,
}: {
  columnKey: Parameters<typeof legColumnWidth>[0];
  className?: string;
  align?: 'start' | 'end';
  testID?: string;
  children: React.ReactNode;
}) {
  return (
    <View
      className={`${align === 'start' ? 'items-start' : 'items-end'} justify-center px-1.5 ${className ?? ''}`}
      style={{ width: legColumnWidth(columnKey) }}
      testID={testID}
    >
      {children}
    </View>
  );
}

/**
 * 标签列（财报 chip / 动作建议）。`container` 为空串 ⇒ **无 chip 纯文字**（「不跨」那一形态）。
 * 🚫 是 `Text` 不是 `Pressable` —— 本组件树零 `onPress`、零 `accessibilityRole="button"`（FR-012）。
 */
function TagCell({
  columnKey,
  label,
  container,
  textClass,
  testID,
}: {
  columnKey: Parameters<typeof legColumnWidth>[0];
  label: string;
  container: string;
  textClass: string;
  testID: string;
}) {
  return (
    <View
      className="justify-center px-1.5"
      style={{ width: legColumnWidth(columnKey) }}
      testID={testID}
    >
      <Text className={`self-start text-[9px] ${container} ${textClass}`} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** 主数字 + 小字副标的数值列（费率 / 成本）。副标缺席时不留空行。 */
function StackedNumCell({
  columnKey,
  cell,
  testID,
}: {
  columnKey: Parameters<typeof legColumnWidth>[0];
  cell: StackedCell;
  testID?: string;
}) {
  return (
    <NumCell columnKey={columnKey} testID={testID}>
      <Text className="font-mono text-[11px] text-ink">{cell.primary}</Text>
      {cell.secondary === null ? null : (
        <Text className="font-mono text-[8px] text-ink-muted">{cell.secondary}</Text>
      )}
    </NumCell>
  );
}

/** 文字列（左对齐，非数值）。 */
function TextCell({
  columnKey,
  testID,
  children,
}: {
  columnKey: Parameters<typeof legColumnWidth>[0];
  testID?: string;
  children: React.ReactNode;
}) {
  return (
    <View
      className="justify-center px-1.5"
      style={{ width: legColumnWidth(columnKey) }}
      testID={testID}
    >
      <Text className="text-[10px] text-ink-muted" numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}
