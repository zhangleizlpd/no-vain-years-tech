// 083 T014 / T015 — 交易账户页 · 持仓分段（plan §D14）：首次加载 / 四种非列表状态卡 / 分组列表。
//
// 列表自上而下：陈旧条（`stale` 时）→ 同步时刻行（陈旧时不出；重读失败时换成刷新失败提示）→ 未归类提示
// → 列头 → `SectionList`（每组一个 section；≥ 2 行出组头、可折叠，单行组平铺）。
// 📌 维护者 2026-09-15 impl 期裁决（T026）：陈旧与刷新失败同时成立 ⇒ 两条并存、陈旧条在上；
//    「暂无交易账户 / 尚未同步 / 暂无持仓」三张状态卡可下拉重读，「加载失败」卡仍是重试按钮。
//
// 🚨 视图判定全走 `resolvePositionsView`（T013）。它的入参**没有「首次加载中」**——
//    `isPending` 必须在调它之前自己分支（类型上排除，漏判编译不过）。
// 🚨 已有数据时重读失败 🚫 换错误卡（FR-023，Guardrail 10）：`data` 在就按数据出视图。
// 🚨 折叠状态 = **组件内** `useState`（FR-004）：进详情再返回本屏未卸载 ⇒ 保留；离开交易账户页卸载即丢
//    ⇒ 再进全部展开。🚫 放 `trading-account-store`（进程内，离开再进仍折叠）。
// 📌 主列表金额（市值 / 组市值 / 持仓盈亏 / 组盈亏）走 `formatCompactAmount`；数量 / 价格 / 比例不缩写（FR-022）。
// 📌 时间只做字符串重排 + 按所选市场拼时区标签（服务端已换算，Guardrail 8）；🚫 时区换算。
// 📌 重读（T016）：聚焦 / 回前台 / 下拉三个触发点共用 hook 的稳定 `refetch`；已显示数据时重读失败 ⇒
//    同步时刻行换成刷新失败提示（`refetchFailed`），下次成功自然恢复。
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  Text,
  View,
  type SectionListData,
} from 'react-native';
import { useRouter } from 'expo-router';
import type {
  BrokerPositionGroupResponse,
  BrokerPositionListResponse,
  BrokerPositionRowResponse,
} from '@nvy/api-client';

import { formatCompactAmount } from '~/format/compact-amount';
import { Spinner } from '~/ui';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { optionsdeskTradingAccountPositionRoute } from './optionsdesk-routes';
import type { RadarMarket } from './radar.rules';
import {
  formatPlRatio,
  localDateTimeParts,
  marketTzLabel,
  plColorClass,
  positionCodeLine,
  positionDisplayName,
  refetchFailed,
  resolvePositionsView,
  showConnectionLabel,
  showGroupHeader,
  showUnresolvedHint,
  type PositionsView,
} from './trading-account-positions.rules';
import { useRefetchOnFocus, useRefetchOnForeground } from './use-refetch-on-foreground';
import {
  useTradingAccountPositions,
  type UseTradingAccountPositionsResult,
} from './use-trading-account-positions';

const COPY = OPTIONSDESK_COPY.tradingAccountPositions;
const TEST_ID = 'optionsdesk-trading-account-positions';
const NO_VALUE = '--';

/** 列宽（mockup 帧 1：名称弹性 · 市值/数量 88 · 现价/成本 62 · 持仓盈亏 76）；列头与行共用。 */
const COL = {
  name: 'flex-1',
  marketValue: 'w-[88px] items-end',
  price: 'w-[62px] items-end',
  unrealizedPl: 'w-[76px] items-end',
} as const;
const COLUMNS = ['name', 'marketValue', 'price', 'unrealizedPl'] as const;

/** 组头折叠标（几何符号，非 emoji）。 */
const CARET = { expanded: '▾', collapsed: '▸' } as const;

/** 行底色与缩进：组内行浅底 + 缩进（mockup `.row.ing`），单行组平铺。 */
const ROW_TONE = {
  indented: 'bg-surface-alt pl-8 pr-md',
  flat: 'bg-surface px-md',
} as const;

type ToggleGroup = (ticker: string) => void;

export function TradingAccountPositions({ market }: { market: RadarMarket }) {
  const positions = useTradingAccountPositions(market);
  useRefetchOnFocus(positions.refetch);
  useRefetchOnForeground(positions.refetch);
  // 键 =`underlyingTicker`（含市场前缀，跨市场不撞）。O(1) 查询 / 切换。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = useCallback<ToggleGroup>((ticker) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  }, []);

  return (
    <View className="flex-1" testID={TEST_ID}>
      <PositionsBody
        market={market}
        positions={positions}
        collapsed={collapsed}
        onToggleGroup={toggleGroup}
      />
    </View>
  );
}

interface PositionsBodyProps {
  market: RadarMarket;
  positions: UseTradingAccountPositionsResult;
  collapsed: ReadonlySet<string>;
  onToggleGroup: ToggleGroup;
}

function PositionsBody({ market, positions, collapsed, onToggleGroup }: PositionsBodyProps) {
  if (positions.isPending) {
    return (
      <View className="items-center py-xl" testID={`${TEST_ID}-loading`}>
        <Spinner size={16} tone="muted" />
      </View>
    );
  }

  const { data } = positions;
  if (data === undefined) {
    // 非加载中且无已加载数据 ⇒ 最近一次请求失败（= `resolvePositionsView` 的 hasData:false 分支）。
    return <StateCard view="error" onRetry={positions.refetch} />;
  }

  const view = resolvePositionsView({ hasData: true, isError: positions.isError, data });
  const failed = refetchFailed({ hasData: true, isError: positions.isError });
  if (view === 'list') {
    return (
      <View className="flex-1" testID={`${TEST_ID}-list`}>
        <PositionsMeta market={market} data={data} refetchFailed={failed} />
        <ColumnHeader />
        <PositionsSectionList
          data={data}
          collapsed={collapsed}
          onToggleGroup={onToggleGroup}
          isRefetching={positions.isRefetching}
          onRefresh={positions.refetch}
        />
      </View>
    );
  }
  if (view === 'empty') {
    return (
      <StateRefreshScroll isRefetching={positions.isRefetching} onRefresh={positions.refetch}>
        <PositionsMeta market={market} data={data} refetchFailed={failed} />
        <StateCard view="empty" />
      </StateRefreshScroll>
    );
  }
  return (
    <StateRefreshScroll isRefetching={positions.isRefetching} onRefresh={positions.refetch}>
      <StateCard view={view} />
    </StateRefreshScroll>
  );
}

interface StateRefreshScrollProps {
  isRefetching: boolean;
  /** 下拉重读（FR-008）；引用稳定的 `refetch`。 */
  onRefresh: () => void;
  children: ReactNode;
}

/**
 * 「暂无交易账户 / 尚未同步 / 暂无持仓」的可下拉容器（维护者 2026-09-15 impl 期裁决，T026）。
 * 「加载失败」卡不走这里：无已加载数据时保持重试按钮。
 */
function StateRefreshScroll({ isRefetching, onRefresh, children }: StateRefreshScrollProps) {
  return (
    <ScrollView
      className="flex-1"
      refreshControl={
        <RefreshControl
          refreshing={isRefetching}
          onRefresh={onRefresh}
          testID={`${TEST_ID}-state-refresh`}
        />
      }
    >
      {children}
    </ScrollView>
  );
}

interface StateCardProps {
  view: Exclude<PositionsView, 'list'>;
  /** 只有「无已显示数据时加载失败」传入 ⇒ 渲染重试按钮。 */
  onRetry?: () => void;
}

function StateCard({ view, onRetry }: StateCardProps) {
  return (
    <View className="px-md py-lg">
      <View className="rounded-md border border-line bg-surface" testID={`${TEST_ID}-${view}`}>
        <View className="items-center gap-2.5 px-lg py-xl">
          <Text className="text-lg font-semibold text-ink">{COPY.states[view]}</Text>
          <Text className="max-w-[280px] text-center text-sm text-ink-muted">
            {COPY.stateBody[view]}
          </Text>
          {onRetry ? (
            <Pressable
              onPress={onRetry}
              accessibilityRole="button"
              accessibilityLabel={COPY.retry}
              testID={`${TEST_ID}-retry`}
              className="rounded-full bg-brand-500 px-lg py-sm"
            >
              <Text className="text-sm font-semibold text-white">{COPY.retry}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** `MM-DD HH:mm（时区）`；时间串缺失或形态不合法 ⇒ `--`（🚫 猜时区）。O(1)。 */
function syncedTimeLabel(local: string | null, market: RadarMarket): string {
  const parts = local === null ? null : localDateTimeParts(local);
  return parts === null ? NO_VALUE : `${parts.mdHm}${marketTzLabel(market)}`;
}

interface PositionsMetaProps {
  market: RadarMarket;
  data: BrokerPositionListResponse;
  /** 已显示数据时最近一次重读失败（FR-023）。 */
  refetchFailed: boolean;
}

/**
 * 同步时刻行（陈旧时换成陈旧条，FR-008 / FR-009；重读失败时换成刷新失败提示，FR-023）+ 未归类提示（FR-011）；
 * 空态与列表共用。
 */
function PositionsMeta({ market, data, refetchFailed: failed }: PositionsMetaProps) {
  const time = syncedTimeLabel(data.syncedAtLocal, market);
  return (
    <View>
      {data.stale ? (
        <View className="bg-warn-soft px-md py-sm">
          <Text className="text-xs font-semibold text-ink" testID={`${TEST_ID}-stale`}>
            {COPY.stale(time)}
          </Text>
        </View>
      ) : null}
      {failed ? (
        <View className="bg-warn-soft px-md py-sm">
          <Text className="text-xs font-semibold text-ink" testID={`${TEST_ID}-refetch-failed`}>
            {COPY.refetchFailed}
          </Text>
        </View>
      ) : data.stale ? null : (
        <View className="bg-surface px-md py-sm">
          <Text className="text-xs text-ink-muted" testID={`${TEST_ID}-synced-at`}>
            {COPY.syncedAt(time)}
          </Text>
        </View>
      )}
      {showUnresolvedHint(data.unresolvedCount) ? (
        <View className="bg-surface-alt px-md py-1.5">
          <Text className="text-xs text-ink-muted" testID={`${TEST_ID}-unresolved`}>
            {COPY.unresolved(data.unresolvedCount)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function ColumnHeader() {
  return (
    <View className="border-y border-line bg-surface" testID={`${TEST_ID}-column-header`}>
      <View className="flex-row gap-1 px-md py-1.5">
        {COLUMNS.map((column) => (
          <View key={column} className={COL[column]}>
            <Text className="text-xs text-ink-muted">{COPY.columns[column]}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

interface PositionSection {
  key: string;
  group: BrokerPositionGroupResponse;
  /** 组头可见（≥ 2 行，FR-004）；单行组无组头、行不缩进、不可折叠。 */
  hasHeader: boolean;
}

interface PositionsSectionListProps {
  data: BrokerPositionListResponse;
  collapsed: ReadonlySet<string>;
  onToggleGroup: ToggleGroup;
  isRefetching: boolean;
  /** 下拉重读（FR-008）；引用稳定的 `refetch`。 */
  onRefresh: () => void;
}

/** 组顺序 / 组内行序由服务端排好（FR-006），这里原样渲染。sections 构造 O(g)。 */
function PositionsSectionList({
  data,
  collapsed,
  onToggleGroup,
  isRefetching,
  onRefresh,
}: PositionsSectionListProps) {
  const showConnection = showConnectionLabel(data.brokerCount);
  const sections = useMemo<SectionListData<BrokerPositionRowResponse, PositionSection>[]>(
    () =>
      data.groups.map((group) => {
        const hasHeader = showGroupHeader(group);
        const isCollapsed = hasHeader && collapsed.has(group.underlyingTicker);
        // 折叠 ⇒ data = []，只留组头。
        return {
          key: group.underlyingTicker,
          group,
          hasHeader,
          data: isCollapsed ? [] : group.rows,
        };
      }),
    [data.groups, collapsed],
  );

  return (
    <SectionList<BrokerPositionRowResponse, PositionSection>
      testID={`${TEST_ID}-section-list`}
      sections={sections}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching}
          onRefresh={onRefresh}
          testID={`${TEST_ID}-refresh`}
        />
      }
      keyExtractor={(row) => row.id}
      renderSectionHeader={({ section }) =>
        section.hasHeader ? (
          <GroupHeader
            group={section.group}
            collapsed={section.data.length === 0}
            onToggle={onToggleGroup}
          />
        ) : null
      }
      renderItem={({ item, section }) => (
        <PositionRow row={item} indented={section.hasHeader} showConnection={showConnection} />
      )}
      stickySectionHeadersEnabled={false}
      className="flex-1"
    />
  );
}

interface GroupHeaderProps {
  group: BrokerPositionGroupResponse;
  collapsed: boolean;
  onToggle: ToggleGroup;
}

/** 组头：折叠标 + 名称(行数) · 组市值 · 正股现价 · 组持仓盈亏（FR-004 / FR-005）。 */
function GroupHeader({ group, collapsed, onToggle }: GroupHeaderProps) {
  const id = `${TEST_ID}-group-${group.underlyingTicker}`;
  const title = `${group.underlyingName}(${group.rows.length})`;
  return (
    <Pressable
      onPress={() => onToggle(group.underlyingTicker)}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ expanded: !collapsed }}
      testID={id}
      className="border-b border-line-soft bg-surface-alt px-md"
    >
      <View className="flex-row items-center gap-1 py-2.5">
        <View className={`${COL.name} flex-row items-center gap-1.5`}>
          <Text className="text-xs text-ink-muted">
            {collapsed ? CARET.collapsed : CARET.expanded}
          </Text>
          <Text className="text-sm font-semibold text-ink" testID={`${id}-title`}>
            {title}
          </Text>
        </View>
        <View className={COL.marketValue}>
          <Text className="font-mono text-sm font-semibold text-ink" testID={`${id}-market-value`}>
            {formatCompactAmount(group.groupMarketValue)}
          </Text>
        </View>
        <View className={COL.price}>
          <Text className="font-mono text-sm font-semibold text-ink" testID={`${id}-price`}>
            {group.underlyingPrice ?? NO_VALUE}
          </Text>
        </View>
        <View className={COL.unrealizedPl}>
          <Text
            className={`font-mono text-sm font-semibold ${plColorClass(group.groupUnrealizedPl)}`}
            testID={`${id}-pl`}
          >
            {formatCompactAmount(group.groupUnrealizedPl, { signed: true })}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

interface PositionRowProps {
  row: BrokerPositionRowResponse;
  indented: boolean;
  showConnection: boolean;
}

/**
 * 行：名称代码 · 市值 / 数量 · 现价 / 成本 · 持仓盈亏金额 / 比例（FR-007 / FR-012 / FR-021）。
 * 点击 ⇒ 持仓详情（T017，plan D15）；本屏不卸载 ⇒ 返回后折叠状态仍在。
 */
function PositionRow({ row, indented, showConnection }: PositionRowProps) {
  const router = useRouter();
  const id = `${TEST_ID}-row-${row.id}`;
  const name = positionDisplayName(row);
  return (
    <Pressable
      onPress={() => router.push(optionsdeskTradingAccountPositionRoute(row.id))}
      accessibilityRole="button"
      accessibilityLabel={name}
      className="border-b border-line-soft"
      testID={id}
    >
      <View className={indented ? ROW_TONE.indented : ROW_TONE.flat}>
        <View className="flex-row items-start gap-1 py-2.5">
          <View className={`${COL.name} gap-0.5`}>
            <Text className="text-sm font-medium text-ink" testID={`${id}-name`}>
              {name}
            </Text>
            <Text className="font-mono text-xs text-ink-muted" testID={`${id}-sub`}>
              {positionCodeLine(row)}
            </Text>
            {showConnection ? (
              <Text className="text-xs text-ink-muted" testID={`${id}-connection`}>
                {row.connectionLabel}
              </Text>
            ) : null}
            {row.expired ? (
              <View className="self-start rounded-sm bg-warn-soft px-1">
                <Text className="text-xs text-ink" testID={`${id}-expired`}>
                  {COPY.expired}
                </Text>
              </View>
            ) : null}
          </View>
          <View className={`${COL.marketValue} gap-0.5`}>
            <Text className="font-mono text-sm text-ink" testID={`${id}-market-value`}>
              {formatCompactAmount(row.marketValue)}
            </Text>
            <Text className="font-mono text-xs text-ink-muted" testID={`${id}-qty`}>
              {row.qty}
            </Text>
          </View>
          <View className={`${COL.price} gap-0.5`}>
            <Text className="font-mono text-sm text-ink" testID={`${id}-price`}>
              {row.currentPrice ?? NO_VALUE}
            </Text>
            <Text className="font-mono text-xs text-ink-muted" testID={`${id}-cost`}>
              {row.averageCost ?? NO_VALUE}
            </Text>
          </View>
          <View className={`${COL.unrealizedPl} gap-0.5`}>
            <Text
              className={`font-mono text-sm ${plColorClass(row.unrealizedPl)}`}
              testID={`${id}-pl`}
            >
              {formatCompactAmount(row.unrealizedPl, { signed: true })}
            </Text>
            <Text
              className={`font-mono text-xs ${plColorClass(row.unrealizedPlRatio)}`}
              testID={`${id}-pl-ratio`}
            >
              {formatPlRatio(row.unrealizedPlRatio)}
            </Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}
