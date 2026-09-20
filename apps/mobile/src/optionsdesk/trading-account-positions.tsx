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
  BrokerPositionListRowResponse,
} from '@nvy/api-client';

import { formatCompactAmount } from '~/format/compact-amount';
import { Spinner } from '~/ui';
import { CurrencySelector } from './currency-selector';
import {
  amountsPending,
  degradedRowLabel,
  fxRateLine,
  groupIncompleteLabel,
  rowAmounts,
  type DisplayCurrency,
} from './display-currency.rules';
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

export interface TradingAccountPositionsProps {
  market: RadarMarket;
  /**
   * 085：展示币种与切档回调都由**屏组件**持有（plan §D7）。🚫 把状态挪进本组件 ——
   * 切分段 positions↔orders 会卸载它，切个分段币种就重置（违反 FR-005「本次停留内保持」）。
   */
  displayCurrency: DisplayCurrency;
  onSelectCurrency: (currency: DisplayCurrency) => void;
}

export function TradingAccountPositions({
  market,
  displayCurrency,
  onSelectCurrency,
}: TradingAccountPositionsProps) {
  const positions = useTradingAccountPositions(market, displayCurrency);
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
        displayCurrency={displayCurrency}
        onSelectCurrency={onSelectCurrency}
      />
    </View>
  );
}

interface PositionsBodyProps {
  market: RadarMarket;
  positions: UseTradingAccountPositionsResult;
  collapsed: ReadonlySet<string>;
  onToggleGroup: ToggleGroup;
  displayCurrency: DisplayCurrency;
  onSelectCurrency: (currency: DisplayCurrency) => void;
}

function PositionsBody({
  market,
  positions,
  collapsed,
  onToggleGroup,
  displayCurrency,
  onSelectCurrency,
}: PositionsBodyProps) {
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
  // 085：在手数据还是上一档的币种 ⇒ 金额位占位、汇率行显加载态（branch 18）。
  const pending = amountsPending({
    selected: displayCurrency,
    responseCurrency: data.displayCurrency,
  });
  if (view === 'list') {
    return (
      <View className="flex-1" testID={`${TEST_ID}-list`}>
        <PositionsMeta
          market={market}
          data={data}
          refetchFailed={failed}
          displayCurrency={displayCurrency}
          onSelectCurrency={onSelectCurrency}
          pending={pending}
        />
        <ColumnHeader />
        <PositionsSectionList
          data={data}
          collapsed={collapsed}
          onToggleGroup={onToggleGroup}
          isRefetching={positions.isRefetching}
          onRefresh={positions.refetch}
          pending={pending}
        />
      </View>
    );
  }
  if (view === 'empty') {
    return (
      <StateRefreshScroll isRefetching={positions.isRefetching} onRefresh={positions.refetch}>
        <PositionsMeta
          market={market}
          data={data}
          refetchFailed={failed}
          displayCurrency={displayCurrency}
          onSelectCurrency={onSelectCurrency}
          pending={pending}
        />
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
  /** 085：币种选择器嵌在本块的同步时刻行右侧（plan §D8）。 */
  displayCurrency: DisplayCurrency;
  onSelectCurrency: (currency: DisplayCurrency) => void;
  /** 085：在手数据仍是上一档 ⇒ 汇率行显加载态（branch 18）。 */
  pending: boolean;
}

/**
 * 同步时刻行（陈旧时换成陈旧条，FR-008 / FR-009；重读失败时换成刷新失败提示，FR-023）+ 未归类提示（FR-011）；
 * 空态与列表共用。
 */
function PositionsMeta({
  market,
  data,
  refetchFailed: failed,
  displayCurrency,
  onSelectCurrency,
  pending,
}: PositionsMetaProps) {
  const time = syncedTimeLabel(data.syncedAtLocal, market);
  return (
    // 🚨 `z-10` 是币种选择器浮层能被点到的前提（085 T011 实撞）：浮层是本块内的 absolute 子节点，
    //    而 `zIndex` 只在**同级**之间排序 —— 本块与 `PositionsSectionList` 是 `-list` 下的兄弟，
    //    后者在 DOM 里更靠后（且自带 transform 形成层叠上下文）⇒ 不抬本块, 列表就盖在浮层上,
    //    浮层看得见却点不到（Playwright 报 `subtree intercepts pointer events`）。
    //    🚫 改挂浮层自己的 z-index：那一层的排序早被本块的层级决定了。
    <View className="z-10">
      {data.stale ? (
        <View className="bg-warn-soft px-md py-sm">
          <Text className="text-xs font-semibold text-ink" testID={`${TEST_ID}-stale`}>
            {COPY.stale(time)}
          </Text>
        </View>
      ) : null}
      {/*
        085：币种选择器**恒在这一行**（陈旧 / 刷新失败 / 空仓三态下都得能点，branch 20）⇒ 本行
        无条件渲染，只有左侧文案按 083 原三分支走（三个 testID 与各自出现条件逐字未变）。
        陈旧且未失败时左侧留空，只剩右侧选择器 —— 陈旧条已在上方说明了情况。
      */}
      <View
        className={`flex-row items-center px-md py-sm ${failed ? 'bg-warn-soft' : 'bg-surface'}`}
      >
        {failed ? (
          <Text className="text-xs font-semibold text-ink" testID={`${TEST_ID}-refetch-failed`}>
            {COPY.refetchFailed}
          </Text>
        ) : data.stale ? null : (
          <Text className="text-xs text-ink-muted" testID={`${TEST_ID}-synced-at`}>
            {COPY.syncedAt(time)}
          </Text>
        )}
        <CurrencySelector current={displayCurrency} onSelect={onSelectCurrency} />
      </View>
      <FxRateLine
        market={market}
        current={displayCurrency}
        fxRate={data.fxRate}
        pending={pending}
      />
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

/**
 * 参考汇率行（FR-007 / FR-011）：展示币种 = 该市场原币种 ⇒ **整行不存在**（此刻并未折算）。
 * 取数进行中显加载态；全源失败显「取不到」；陈旧**照常显示**并标注时刻（🚫 因陈旧隐藏或清空）。
 * 四态判定全在 `fxRateLine`（vitest 覆盖），这里只渲染。
 */
function FxRateLine({
  market,
  current,
  fxRate,
  pending,
}: {
  market: RadarMarket;
  current: DisplayCurrency;
  fxRate: BrokerPositionListResponse['fxRate'];
  pending: boolean;
}) {
  const line = fxRateLine({ market, current, fxRate, pending });
  if (line.kind === 'hidden') return null;
  return (
    <View className="bg-surface px-md pb-sm">
      <Text className="text-xs text-ink-muted" testID={`${TEST_ID}-fx-rate`}>
        {line.text}
      </Text>
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
  /** 085：在手数据仍是上一档 ⇒ 金额位占位（branch 18）。 */
  pending: boolean;
}

/** 组顺序 / 组内行序由服务端排好（FR-006），这里原样渲染。sections 构造 O(g)。 */
function PositionsSectionList({
  data,
  collapsed,
  onToggleGroup,
  isRefetching,
  onRefresh,
  pending,
}: PositionsSectionListProps) {
  const showConnection = showConnectionLabel(data.brokerCount);
  const sections = useMemo<SectionListData<BrokerPositionListRowResponse, PositionSection>[]>(
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
    <SectionList<BrokerPositionListRowResponse, PositionSection>
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
            pending={pending}
          />
        ) : null
      }
      renderItem={({ item, section }) => (
        <PositionRow
          row={item}
          indented={section.hasHeader}
          showConnection={showConnection}
          pending={pending}
        />
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
  /** 085：在手数据仍是上一档 ⇒ 两个聚合值占位（branch 18）。 */
  pending: boolean;
}

/**
 * 组头：折叠标 + 名称(行数) · 组市值 · 正股现价 · 组持仓盈亏（FR-004 / FR-005）。
 *
 * 🚨 085：组内只要有降级行，**组市值与组持仓盈亏两列各标一次「合计不完整」**（FR-006）——
 *    只标一列会让人以为另一列是完整的。标注挂在**合计值下方**（同列的第二行，`text-xs`），
 *    🚫 挂组头名称列：390px 机身下名称列只剩约 120px，caret + 组名已占满。
 */
function GroupHeader({ group, collapsed, onToggle, pending }: GroupHeaderProps) {
  const id = `${TEST_ID}-group-${group.underlyingTicker}`;
  const title = `${group.underlyingName}(${group.rows.length})`;
  const incomplete = groupIncompleteLabel(group);
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
            {pending ? NO_VALUE : formatCompactAmount(group.groupMarketValue)}
          </Text>
          {incomplete !== null ? (
            <Text className="text-xs text-ink-muted" testID={`${id}-market-value-incomplete`}>
              {incomplete.marketValue}
            </Text>
          ) : null}
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
            {pending ? NO_VALUE : formatCompactAmount(group.groupUnrealizedPl, { signed: true })}
          </Text>
          {incomplete !== null ? (
            <Text className="text-xs text-ink-muted" testID={`${id}-pl-incomplete`}>
              {incomplete.unrealizedPl}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

interface PositionRowProps {
  row: BrokerPositionListRowResponse;
  indented: boolean;
  showConnection: boolean;
  /** 085：在手数据仍是上一档 ⇒ 金额位占位（branch 18）。 */
  pending: boolean;
}

/**
 * 行：名称代码 · 市值 / 数量 · 现价 / 成本 · 持仓盈亏金额 / 比例（FR-007 / FR-012 / FR-021）。
 * 点击 ⇒ 持仓详情（T017，plan D15）；本屏不卸载 ⇒ 返回后折叠状态仍在。
 */
function PositionRow({ row, indented, showConnection, pending }: PositionRowProps) {
  const router = useRouter();
  const id = `${TEST_ID}-row-${row.id}`;
  const name = positionDisplayName(row);
  // 085：降级行的两个金额取 `original*`（server 已把折算口径那两个置 null）；币种标见下。
  const amounts = rowAmounts(row);
  const currencyMark = degradedRowLabel(row);
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
            {/*
              085 降级行的币种标（FR-006 / FR-013）：几何形态照上面 `row.expired` 那枚徽标，
              🚨 但**另定底色** —— `bg-warn-soft` 是警示语义（到期待清算），而「按 HKD 显示 /
              币种未知」只是口径说明，套警示底色会把两件事读成同一类。取 `MarketBadge` 那套中性
              描边小块（`~/ui/MarketBadge.tsx`）。
            */}
            {currencyMark !== null ? (
              <View className="self-start rounded-sm border border-line bg-surface-sunken px-1">
                <Text className="text-xs text-ink-muted" testID={`${id}-currency`}>
                  {currencyMark}
                </Text>
              </View>
            ) : null}
          </View>
          <View className={`${COL.marketValue} gap-0.5`}>
            <Text className="font-mono text-sm text-ink" testID={`${id}-market-value`}>
              {pending ? NO_VALUE : formatCompactAmount(amounts.marketValue)}
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
              className={`font-mono text-sm ${plColorClass(pending ? null : amounts.unrealizedPl)}`}
              testID={`${id}-pl`}
            >
              {pending ? NO_VALUE : formatCompactAmount(amounts.unrealizedPl, { signed: true })}
            </Text>
            <Text
              className={`font-mono text-xs ${plColorClass(pending ? null : row.unrealizedPlRatio)}`}
              testID={`${id}-pl-ratio`}
            >
              {/* 比例虽是无量纲、折算不改，但与盈亏金额同列语义 ⇒ 占位时一并占位（mockup 帧 ④）。 */}
              {pending ? NO_VALUE : formatPlRatio(row.unrealizedPlRatio)}
            </Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}
