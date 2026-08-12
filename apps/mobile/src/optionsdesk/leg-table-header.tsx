// 047 T032 — 选约表的表头行（FR-003/005, plan D-UI-1）。
//
// 🚨 **首列渲在横向位移区之外 ⇒ 天然钉住** —— RN 没有 `position: sticky`，mockup 那套
//    web sticky 与本实现**不等价**。首列（88px）是横滑区的兄弟节点，横滑只发生在右侧
//    628px 的 11 列上，所以首列不动是布局的结果而不是特效。
//
// ── 049 T002 横滑范式换代（ADR-0063 方案 E）─────────────────────────────────────
// 🚨 表头与每个数据行不再各挂一个横向滚动容器，改为**共读屏级唯一的 `tx`**（负值域的
//    translateX），由屏级单个 `Gesture.Pan` 驱动 —— 机制与坑的注释单源在
//    `leg-column-pane.tsx` 文件头。本文件只把 `tx` 透传给 `LegColumnPane`。
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import { LegColumnPane } from './leg-column-pane';
import type { LegRateHeader } from './leg-picker.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import {
  LEG_SCROLL_COLUMNS,
  LEG_SCROLL_REGION_WIDTH,
  LEG_STICKY_COL_WIDTH,
  LEG_TABLE_COLUMNS,
  type LegColumnKey,
} from './leg-row.rules';

const COPY = OPTIONSDESK_COPY.legPicker;

/** 表头行高 / 数据行高（mockup 30 / 48）。 */
export const LEG_HEADER_HEIGHT = 30;
export const LEG_ROW_HEIGHT = 48;

const COLUMN_WIDTH = Object.fromEntries(LEG_TABLE_COLUMNS.map((c) => [c.key, c.width])) as Record<
  LegColumnKey,
  number
>;

/** 单列宽度（行组件按列键取，避免两处各写一份宽度）。 */
export function legColumnWidth(key: LegColumnKey): number {
  return COLUMN_WIDTH[key];
}

/** 首列槽位（88px，横滑之外）。表头与数据行共用，保证两边逐像素对齐。 */
export function LegStickyCell({ children, className }: { children: ReactNode; className: string }) {
  return (
    <View className={className} style={{ width: LEG_STICKY_COL_WIDTH }}>
      {children}
    </View>
  );
}

function HeaderCell({ label, sub, width }: { label: string; sub: string | null; width: number }) {
  return (
    <View className="items-center justify-center px-1.5" style={{ width }}>
      <Text className="text-[10px] font-medium text-ink-muted" numberOfLines={1}>
        {label}
      </Text>
      {sub === null ? null : (
        <Text className="text-[8px] text-ink-muted" numberOfLines={1}>
          {sub}
        </Text>
      )}
    </View>
  );
}

export interface LegTableHeaderProps {
  /** 屏级唯一的横向位移（负值域）—— 表头与全部数据行读同一个（FR-001）。 */
  tx: SharedValue<number>;
  /**
   * 费率列头 —— 🚨 **`main` 就是该视角的口径本身**（051 FR-017a：不套「费率」这层通用标题）。
   * 取自服务端下发的 `basisByTab`，由调用方经 `rateHeaderFor` 取好再传（FR-017）。
   */
  rateHeader: LegRateHeader;
  /** 🚨 OI 的**独立归属日**（与区块级 asOf 不是同一天，FR-013）。 */
  oiAsOf: string | null;
}

/** 12 列表头（sticky section header 的下半）。复杂度 O(1)（列数固定）。 */
export function LegTableHeader({ tx, rateHeader, oiAsOf }: LegTableHeaderProps) {
  // 费率列**整个列头**（主标 + 副标）都随口径换，其余 11 列取固定列名。
  const label: Record<LegColumnKey, string> = { ...COPY.columns, rate: rateHeader.main };
  // 穷举而非 `Partial<Record>` —— 加列时漏写副标即编译红，且「哪三列有副标」一眼可审。
  const sub: Record<LegColumnKey, string | null> = {
    strike: null,
    bid: null,
    rate: rateHeader.sub,
    cost: null,
    delta: COPY.columnSubDelta,
    sigma: null,
    // 🚨 OI 的归属日与区块级 asOf 不同天 —— 挂在列头上，别只挂区块头（SC-003）。
    oi: COPY.oiAsOfSub(oiAsOf === null ? COPY.noValue : oiAsOf.slice(5)),
    vol: null,
    turnover: null,
    activity: null,
    mark: null,
    action: null,
  };

  return (
    <View
      className="flex-row border-b border-line bg-surface-alt"
      style={{ height: LEG_HEADER_HEIGHT }}
      testID="optionsdesk-detail-leg-table-header"
    >
      <LegStickyCell className="justify-center border-r border-line px-1.5">
        <Text className="text-[10px] font-medium text-ink-muted" numberOfLines={1}>
          {COPY.columns.strike}
        </Text>
      </LegStickyCell>
      {/* 🚨 testID 一字不改 —— 名字里的 "scroller" 已不准确（这里没有滚动容器了），
          但它是 e2e 的锚点，改锚代价远大于名字不准。 */}
      <LegColumnPane
        tx={tx}
        contentWidth={LEG_SCROLL_REGION_WIDTH}
        testID="optionsdesk-detail-leg-header-scroller"
      >
        {LEG_SCROLL_COLUMNS.map((column) => (
          <HeaderCell
            key={column.key}
            label={label[column.key]}
            sub={sub[column.key]}
            width={column.width}
          />
        ))}
      </LegColumnPane>
    </View>
  );
}
