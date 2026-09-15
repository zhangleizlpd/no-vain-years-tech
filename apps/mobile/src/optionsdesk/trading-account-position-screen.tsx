// 083 T017 — 持仓详情屏（plan §D15）：汇总卡 →「订单」/「本合约订单」段；加载 / 不存在 / 失败 / 重读。
//
// 🚨 视图全走 `resolveDetailView`：404 ⇒「持仓已不存在」且**优先于**已显示数据（FR-020）；其余失败有数据时
//    保留数据 + 顶部刷新失败提示（FR-023），🚫 换错误卡。
// 📌 重读三触发点同持仓分段（T016）：聚焦 / 回前台 hook + `RefreshControl`，依赖只放稳定的 `refetch`。
// 📌 时间只做字符串重排 + 按**响应 `market`** 拼时区标签（深链进入时没有交易账户页的市场选择，Guardrail 8）；
//    🚫 时区换算。金额全精度 `formatFullAmount`（万缩写只用于主列表，FR-022）。
// 📌 订单项点击进订单详情（T018，SC-004）；方向 / 状态走 `tradeSideText` / `orderStatusText` 中文映射。
// 📌 「持仓批次」段归 T019。
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type {
  BrokerPositionDetailResponse,
  BrokerPositionOrderItemResponse,
} from '@nvy/api-client';

import { formatFullAmount } from '~/format/compact-amount';
import { SafeAreaView, Spinner } from '~/ui';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { optionsdeskTradingAccountOrderRoute } from './optionsdesk-routes';
import { DetailStateCard } from './trading-account-detail-state-card';
import {
  formatPlRatio,
  localDateTimeParts,
  marketTzLabel,
  orderStatusText,
  plColorClass,
  positionCodeLine,
  positionDisplayName,
  refetchFailed,
  resolveDetailView,
  tradeSideText,
} from './trading-account-positions.rules';
import { useRefetchOnFocus, useRefetchOnForeground } from './use-refetch-on-foreground';
import {
  useTradingAccountPosition,
  type UseTradingAccountPositionResult,
} from './use-trading-account-position';

const COPY = OPTIONSDESK_COPY.tradingAccountPositions;
const DETAIL_COPY = COPY.positionDetail;
const TEST_ID = 'optionsdesk-trading-account-position';
const NO_VALUE = '--';

export function TradingAccountPositionScreen({ id }: { id: string }) {
  const position = useTradingAccountPosition(id);
  useRefetchOnFocus(position.refetch);
  useRefetchOnForeground(position.refetch);

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      <Stack.Screen options={{ title: DETAIL_COPY.title }} />
      <View className="flex-1 bg-surface-sunken" testID={`${TEST_ID}-screen`}>
        <DetailContent position={position} />
      </View>
    </SafeAreaView>
  );
}

function DetailContent({ position }: { position: UseTradingAccountPositionResult }) {
  const { data } = position;
  const view = resolveDetailView({
    isPending: position.isPending,
    hasData: data !== undefined,
    isError: position.isError,
    notFound: position.notFound,
  });

  if (view === 'loading') {
    return (
      <View className="items-center py-xl" testID={`${TEST_ID}-loading`}>
        <Spinner size={16} tone="muted" />
      </View>
    );
  }
  if (view === 'not-found') {
    return <DetailStateCard testIdPrefix={TEST_ID} view="not-found" copy={DETAIL_COPY} />;
  }
  if (view === 'error' || data === undefined) {
    return (
      <DetailStateCard
        testIdPrefix={TEST_ID}
        view="error"
        copy={DETAIL_COPY}
        onRetry={position.refetch}
      />
    );
  }
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-md pb-lg"
      refreshControl={
        <RefreshControl
          refreshing={position.isRefetching}
          onRefresh={position.refetch}
          testID={`${TEST_ID}-refresh`}
        />
      }
    >
      {refetchFailed({ hasData: true, isError: position.isError }) ? (
        <View className="bg-warn-soft px-md py-sm">
          <Text className="text-xs font-semibold text-ink" testID={`${TEST_ID}-refetch-failed`}>
            {COPY.refetchFailed}
          </Text>
        </View>
      ) : null}
      <SummaryCard data={data} />
      <OrdersSection data={data} />
    </ScrollView>
  );
}

interface SummaryField {
  /** testID 后缀。 */
  key: string;
  label: string;
  value: string;
  tone: string;
}

/** 汇总卡：名称代码 + 两列键值（数量 / 市值 / 现价 / 平均成本 / 持仓盈亏 / 开仓时间）。O(1)。 */
function SummaryCard({ data }: { data: BrokerPositionDetailResponse }) {
  const opened = localDateTimeParts(data.openedAtLocal);
  const fields: SummaryField[] = [
    {
      key: 'qty',
      label: DETAIL_COPY.fields.qty,
      value: `${data.qty} ${DETAIL_COPY.qtyUnit[data.kind]}`,
      tone: 'text-ink',
    },
    {
      key: 'market-value',
      label: DETAIL_COPY.marketValueLabel(data.currency),
      value: formatFullAmount(data.marketValue),
      tone: 'text-ink',
    },
    {
      key: 'price',
      label: DETAIL_COPY.fields.currentPrice,
      value: data.currentPrice ?? NO_VALUE,
      tone: 'text-ink',
    },
    {
      key: 'cost',
      label: DETAIL_COPY.fields.averageCost,
      value: data.averageCost ?? NO_VALUE,
      tone: 'text-ink',
    },
    {
      key: 'pl',
      label: DETAIL_COPY.fields.unrealizedPl,
      value: `${formatFullAmount(data.unrealizedPl, { signed: true })} / ${formatPlRatio(data.unrealizedPlRatio)}`,
      tone: plColorClass(data.unrealizedPl),
    },
    {
      key: 'opened-at',
      label: `${DETAIL_COPY.fields.openedAt}${marketTzLabel(data.market)}`,
      value: opened === null ? NO_VALUE : opened.mdHm,
      tone: 'text-ink',
    },
  ];

  return (
    <View className="bg-surface px-md py-md" testID={`${TEST_ID}-summary`}>
      <View className="gap-0.5 pb-sm">
        <Text className="text-lg font-semibold text-ink" testID={`${TEST_ID}-name`}>
          {positionDisplayName(data)}
        </Text>
        <Text className="font-mono text-xs text-ink-muted" testID={`${TEST_ID}-code-line`}>
          {`${positionCodeLine(data)} · ${DETAIL_COPY.marketName[data.market]}`}
        </Text>
      </View>
      <View className="flex-row flex-wrap">
        {fields.map((field) => (
          <View key={field.key} className="w-1/2 gap-0.5 py-1.5">
            <Text className="text-xs text-ink-muted" testID={`${TEST_ID}-${field.key}-label`}>
              {field.label}
            </Text>
            <Text className={`font-mono text-sm ${field.tone}`} testID={`${TEST_ID}-${field.key}`}>
              {field.value}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** 订单段：正股「订单」/ 期权「本合约订单」；顺序 = 服务端已排好的下单时间倒序（FR-016）。O(n)。 */
function OrdersSection({ data }: { data: BrokerPositionDetailResponse }) {
  const unit = DETAIL_COPY.qtyUnit[data.kind];
  const tz = marketTzLabel(data.market);
  return (
    <View className="bg-surface">
      <View className="border-b border-line-soft px-md py-sm">
        <Text className="text-sm font-semibold text-ink" testID={`${TEST_ID}-orders-title`}>
          {DETAIL_COPY.ordersTitle[data.kind]}
        </Text>
      </View>
      {data.orders.length === 0 ? (
        <Text className="px-md py-md text-sm text-ink-muted" testID={`${TEST_ID}-orders-empty`}>
          {DETAIL_COPY.ordersEmpty}
        </Text>
      ) : (
        data.orders.map((item) => <OrderRow key={item.id} order={item} unit={unit} tz={tz} />)
      )}
    </View>
  );
}

interface OrderRowProps {
  order: BrokerPositionOrderItemResponse;
  unit: string;
  tz: string;
}

/**
 * 订单项：下单时间（交易所当地 + 时区）· 方向 数量 @ 价格 · 状态标（已撤单 / 失败照常列出，FR-016）。
 * 点击 ⇒ 订单详情（T018；持仓列表起第 2 次点击，SC-004）。
 */
function OrderRow({ order, unit, tz }: OrderRowProps) {
  const router = useRouter();
  const id = `${TEST_ID}-order-${order.id}`;
  const time = order.createdAtLocal === null ? null : localDateTimeParts(order.createdAtLocal);
  const summary = `${tradeSideText(order.side)} ${order.qty} ${unit} @ ${order.price ?? NO_VALUE}`;
  return (
    <Pressable
      onPress={() => router.push(optionsdeskTradingAccountOrderRoute(order.id))}
      accessibilityRole="button"
      accessibilityLabel={summary}
      className="border-b border-line-soft px-md py-2.5"
      testID={id}
    >
      <View className="flex-row items-center gap-sm">
        <View className="flex-1 gap-0.5">
          <Text className="font-mono text-xs text-ink-muted" testID={`${id}-time`}>
            {time === null ? NO_VALUE : `${time.mdHm}${tz}`}
          </Text>
          <Text className="font-mono text-sm text-ink" testID={`${id}-summary`}>
            {summary}
          </Text>
        </View>
        <View className="rounded-sm bg-surface-alt px-1.5">
          <Text className="text-xs text-ink-muted" testID={`${id}-status`}>
            {orderStatusText(order.status)}
          </Text>
        </View>
        <Text className="text-base text-ink-muted">›</Text>
      </View>
    </Pressable>
  );
}
