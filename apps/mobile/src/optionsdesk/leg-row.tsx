// 047 T032 — 腿行（12 列 696px；FR-003/005, plan D-UI-1）。
//
// 🚨 **首列（行权价/到期，88px）渲在横向滚动之外 ⇒ 天然钉住**；右侧 11 列进
//    `LegColumnScroller`，与表头共享同一个 offset（横向机制的注释单源在 `leg-table-header.tsx`）。
//
// 🚨 **费率列随行口径切换主数字、Δ 与 σ 距同有同无** —— 判定全在 `leg-row.rules.ts`
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
import type { LegActivityResponse, LegResponse } from '@nvy/api-client';
import type { SharedValue } from 'react-native-reanimated';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import {
  LEG_ACTION_TAG_CLASS,
  legActionLabel,
  legActionTextClass,
  legBidTone,
  legEarningsChip,
  legRateCell,
  legRowToneClass,
} from './leg-picker-copy';
import {
  LEG_ROW_HEIGHT,
  LegColumnScroller,
  LegStickyCell,
  legColumnWidth,
} from './leg-table-header';
import {
  costCell,
  deltaCell,
  expiryLabel,
  formatCount,
  formatTurnover,
  sigmaCell,
  strikeLabel,
  type StackedCell,
} from './leg-row.rules';

const COPY = OPTIONSDESK_COPY.legPicker;

const BASIS_BADGE: Record<LegResponse['basis'], string> = {
  weekly: COPY.basisWeekly,
  annualized: COPY.basisAnnualized,
};

/**
 * 腿族徽标的描边色（mockup 段 3）。🚨 两者**只作族别标识、不承载好坏语义** ——
 * 故蓄意避开 ok / warn / err 三档，用 tag 调色板里的 teal / purple。
 */
const BASIS_BADGE_BORDER: Record<LegResponse['basis'], string> = {
  weekly: 'border-tag-teal',
  annualized: 'border-tag-purple',
};

export interface LegRowProps {
  leg: LegResponse;
  /** 表头与所有行共享的横向位移。 */
  offset: SharedValue<number>;
  /** 设备本地日历日 —— **只用于判到期日要不要补年份**，不参与任何新鲜度判断。 */
  today: string;
  /**
   * 当前 Tab 的活跃度标记。**三 Tab 各一套**（排名是候选集内的相对量，换 Tab 归属就变）⇒
   * 由调用方从 `activityByTab[tab]` 取好再传，行组件不自己选 Tab。
   */
  activity: LegActivityResponse | null;
  /** 全腿 Tab 每行标腿族口径徽标（FR-019）；单口径 Tab 不标。 */
  showBasisBadge?: boolean;
}

/** 单腿一行。复杂度 O(1)（列数固定）。 */
export function LegRow({ leg, offset, today, activity, showBasisBadge = true }: LegRowProps) {
  const rate = legRateCell(leg);
  const cost = costCell(leg);
  const bidTone = legBidTone(leg);
  const earnings = legEarningsChip(leg.earningsMark);

  return (
    <View
      className={`flex-row border-b border-line-soft ${legRowToneClass(leg)}`}
      style={{ height: LEG_ROW_HEIGHT }}
      testID={`optionsdesk-detail-leg-row-${leg.code}`}
    >
      {/* ── 首列：行权价 / 到期（横滑之外 ⇒ 钉住）───────────────────────── */}
      <LegStickyCell className="justify-center border-r border-line px-1.5">
        <View className="flex-row items-center gap-1">
          <Text className="font-mono text-xs font-semibold text-ink" numberOfLines={1}>
            {strikeLabel(leg)}
          </Text>
          {showBasisBadge ? (
            <Text
              className={`rounded-sm border px-0.5 text-[8px] text-ink-muted ${BASIS_BADGE_BORDER[leg.basis]}`}
              testID={`optionsdesk-detail-leg-basis-${leg.code}`}
            >
              {BASIS_BADGE[leg.basis]}
            </Text>
          ) : null}
        </View>
        <Text className="font-mono text-[8px] text-ink-muted" numberOfLines={1}>
          {expiryLabel(leg, today)}
        </Text>
      </LegStickyCell>

      {/* ── 右侧 11 列（与表头同 offset）──────────────────────────────── */}
      <LegColumnScroller offset={offset} testID={`optionsdesk-detail-leg-scroller-${leg.code}`}>
        {/* 🚨 bid/ask 合并一列：**档位色只着这一格**；ask 小字常显（不参与判档）。 */}
        <NumCell
          columnKey="bid"
          className={bidTone.container}
          testID={`optionsdesk-detail-leg-bid-${leg.code}`}
        >
          <Text className={`font-mono text-[11px] font-semibold ${bidTone.text}`}>
            {leg.bid ?? COPY.noValue}
          </Text>
          <Text className="font-mono text-[8px] text-ink-muted">{leg.ask ?? COPY.noValue}</Text>
        </NumCell>

        {/* 🚨 费率：收租行主显年化 / 建仓行主显周化；**薄档行副标换成 `ask` 口径值**。 */}
        <StackedNumCell
          columnKey="rate"
          cell={rate}
          testID={`optionsdesk-detail-leg-rate-${leg.code}`}
        />
        <StackedNumCell columnKey="cost" cell={cost} />

        {/* 🚨 Δ 与 σ 距同源同有同无（列头副标「带判据」）。 */}
        <NumCell columnKey="delta" testID={`optionsdesk-detail-leg-delta-${leg.code}`}>
          <Text className="font-mono text-[11px] text-ink">{deltaCell(leg)}</Text>
        </NumCell>
        <NumCell columnKey="sigma" testID={`optionsdesk-detail-leg-sigma-${leg.code}`}>
          <Text className="font-mono text-[11px] text-ink">{sigmaCell(leg)}</Text>
        </NumCell>

        {/* 🚨 OI 归属 oiAsOf 那一天（列头已标），与本行其余读数不同天。 */}
        <NumCell columnKey="oi">
          <Text className="font-mono text-[11px] text-ink">{formatCount(leg.openInterest)}</Text>
        </NumCell>
        <NumCell columnKey="vol">
          <Text className="font-mono text-[11px] text-ink">{formatCount(leg.volume)}</Text>
        </NumCell>
        <NumCell columnKey="turnover">
          <Text className="font-mono text-[11px] text-ink">{formatTurnover(leg.turnover)}</Text>
        </NumCell>

        {/* 活跃度：server 下发的相对档标签（换 Tab 归属就变），无标 ⇒ 占位，不伪造默认档。 */}
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
          label={legActionLabel(leg)}
          container={LEG_ACTION_TAG_CLASS}
          textClass={legActionTextClass(leg)}
          testID={`optionsdesk-detail-leg-action-${leg.code}`}
        />
      </LegColumnScroller>
    </View>
  );
}

/** 数值列（右对齐 + 等宽字体）。`className` 是档位底色的挂点（**只有 bid 列会传**）。 */
function NumCell({
  columnKey,
  className,
  testID,
  children,
}: {
  columnKey: Parameters<typeof legColumnWidth>[0];
  className?: string;
  testID?: string;
  children: React.ReactNode;
}) {
  return (
    <View
      className={`items-end justify-center px-1.5 ${className ?? ''}`}
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
