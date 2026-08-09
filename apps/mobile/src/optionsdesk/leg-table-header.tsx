// 047 T032 — 选约表的表头行 + 横向 offset 同步原语（FR-003/005, plan D-UI-1）。
//
// 🚨 **首列渲在横向滚动之外 ⇒ 天然钉住** —— RN 没有 `position: sticky`，mockup 那套
//    web sticky 与本实现**不等价**。首列（88px）是横滑容器的兄弟节点，横滑只发生在右侧
//    608px 的 11 列上，所以首列不动是布局的结果而不是特效。
//
// 🚨 **表头与每个数据行各挂一个 `Animated.ScrollView horizontal`，共享同一个
//    `useSharedValue` offset**（`useAnimatedRef` + `scrollTo`）。方向正交 ⇒ **与纵向
//    `SectionList` 不争手势**（RN 的同向嵌套禁令只约束同向）。成本 `O(视口行数)`，
//    虚拟化后约 15 个容器，**不随 730 行增长**。
//
// ⚠️ **NativeWind web 两坑（本仓踩过，别踩回去）**：
//    ① `className` 挂在 `Animated.*` 上会被**整串吞掉** ⇒ token 一律下沉到 plain 子 `View`；
//    ② width 挂在 `ScrollView` 上**不约束 frame**（按内容撑开）⇒ 外面必须包一层 `View`。
//    两条都是 **web 侧静默失效**，native 不受影响 —— CI 全绿也不代表对。
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

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

export interface LegColumnScrollerProps {
  /** 表头与所有数据行**共享同一个** offset —— 谁滚都同步给其余所有容器。 */
  offset: SharedValue<number>;
  children: ReactNode;
  testID?: string;
}

/**
 * 右侧 11 列的横滑容器。复杂度：每次滚动 O(视口行数) 次 `scrollTo`（UI 线程 worklet）。
 *
 * 自激回声的处置：容器自己滚 → 写 `offset` → reaction 又回来 `scrollTo` 自己。
 * 用一个本地 `own` 记住自己最后上报的位移，差值小于半像素就跳过 —— 三行换掉一类抖动。
 */
export function LegColumnScroller({ offset, children, testID }: LegColumnScrollerProps) {
  const ref = useAnimatedRef<Animated.ScrollView>();
  const own = useSharedValue(0);

  const onScroll = useAnimatedScrollHandler((event) => {
    own.value = event.contentOffset.x;
    offset.value = event.contentOffset.x;
  });

  useAnimatedReaction(
    () => offset.value,
    (x) => {
      if (Math.abs(x - own.value) < 0.5) return;
      own.value = x;
      scrollTo(ref, x, 0, false);
    },
  );

  return (
    // ⚠️ 坑 ②：外层 wrapper 才约束得住 frame（width 挂 ScrollView 只会按内容撑开）。
    <View className="flex-1 overflow-hidden">
      <Animated.ScrollView
        ref={ref}
        horizontal
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={onScroll}
        testID={testID}
      >
        {/* ⚠️ 坑 ①：token 下沉到 plain 子 View —— 挂 Animated.ScrollView 上会被整串吞。 */}
        <View className="flex-row" style={{ width: LEG_SCROLL_REGION_WIDTH }}>
          {children}
        </View>
      </Animated.ScrollView>
    </View>
  );
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
  offset: SharedValue<number>;
  /**
   * 费率列副标 —— 随 Tab 口径换（收租「年化」/ 建仓「周化 / 折年·参照」/ 全腿「本行口径」）。
   * T033 按 Tab 传；缺省是全腿口径。
   */
  rateSub?: string;
  /** 🚨 OI 的**独立归属日**（与区块级 asOf 不是同一天，FR-013）。 */
  oiAsOf: string | null;
}

/** 12 列表头（sticky section header 的下半）。复杂度 O(1)（列数固定）。 */
export function LegTableHeader({ offset, rateSub, oiAsOf }: LegTableHeaderProps) {
  // 穷举而非 `Partial<Record>` —— 加列时漏写副标即编译红，且「哪三列有副标」一眼可审。
  const sub: Record<LegColumnKey, string | null> = {
    strike: null,
    bid: null,
    rate: rateSub ?? COPY.columnSubRateMixed,
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
      <LegColumnScroller offset={offset} testID="optionsdesk-detail-leg-header-scroller">
        {LEG_SCROLL_COLUMNS.map((column) => (
          <HeaderCell
            key={column.key}
            label={COPY.columns[column.key]}
            sub={sub[column.key]}
            width={column.width}
          />
        ))}
      </LegColumnScroller>
    </View>
  );
}
