// 083 T018 — 订单详情屏（plan §D11 / §D15）：九个键值字段（FR-017）+ 组合单各腿；加载 / 不存在 / 失败 / 重读。
//
// 🚨 视图全走 `resolveDetailView`：404 ⇒「订单不存在」且**优先于**已显示数据（FR-020）；其余失败有数据时
//    保留数据 + 顶部刷新失败提示（FR-023），🚫 换错误卡。
// 🚨 只读：🚫 任何撤单 / 改单 / 平仓入口（FR-019）。
// 📌 方向 / 状态走 `tradeSideText` / `orderStatusText`（`Record` 穷举，值域外原样）；订单类型只映射 `NORMAL`。
// 📌 成交三字段 null（未成交）⇒「—」，🚫 显示 0（FR-017）；金额全精度 `formatFullAmount`。
// 📌 下单时间只做字符串重排 + 按**响应 `market`** 拼时区标签（深链进入无市场上下文，Guardrail 8）；🚫 时区换算。
// 📌 重读三触发点同持仓详情（T017）：聚焦 / 回前台 hook + `RefreshControl`，依赖只放稳定的 `refetch`。
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import type { BrokerOrderDetailResponse } from '@nvy/api-client';

import { formatFullAmount } from '~/format/compact-amount';
import { SafeAreaView, Spinner } from '~/ui';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { DetailStateCard } from './trading-account-detail-state-card';
import {
  displayCode,
  localDateTimeParts,
  marketTzLabel,
  orderKind,
  orderStatusText,
  positionCodeLine,
  positionDisplayName,
  refetchFailed,
  resolveDetailView,
  tradeSideText,
} from './trading-account-positions.rules';
import { useRefetchOnFocus, useRefetchOnForeground } from './use-refetch-on-foreground';
import {
  useTradingAccountOrder,
  type UseTradingAccountOrderResult,
} from './use-trading-account-order';

const COPY = OPTIONSDESK_COPY.tradingAccountPositions;
const ORDER_COPY = COPY.orderDetail;
const TEST_ID = 'optionsdesk-trading-account-order';
/** 缺值 / 未成交（FR-017 逐字「—」）。 */
const NO_VALUE = '—';

export function TradingAccountOrderScreen({ id }: { id: string }) {
  const order = useTradingAccountOrder(id);
  useRefetchOnFocus(order.refetch);
  useRefetchOnForeground(order.refetch);

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      <Stack.Screen options={{ title: ORDER_COPY.title }} />
      <View className="flex-1 bg-surface-sunken" testID={`${TEST_ID}-screen`}>
        <OrderContent order={order} />
      </View>
    </SafeAreaView>
  );
}

function OrderContent({ order }: { order: UseTradingAccountOrderResult }) {
  const { data } = order;
  const view = resolveDetailView({
    isPending: order.isPending,
    hasData: data !== undefined,
    isError: order.isError,
    notFound: order.notFound,
  });

  if (view === 'loading') {
    return (
      <View className="items-center py-xl" testID={`${TEST_ID}-loading`}>
        <Spinner size={16} tone="muted" />
      </View>
    );
  }
  if (view === 'not-found') {
    return <DetailStateCard testIdPrefix={TEST_ID} view="not-found" copy={ORDER_COPY} />;
  }
  if (view === 'error' || data === undefined) {
    return (
      <DetailStateCard
        testIdPrefix={TEST_ID}
        view="error"
        copy={ORDER_COPY}
        onRetry={order.refetch}
      />
    );
  }
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-md pb-lg"
      refreshControl={
        <RefreshControl
          refreshing={order.isRefetching}
          onRefresh={order.refetch}
          testID={`${TEST_ID}-refresh`}
        />
      }
    >
      {refetchFailed({ hasData: true, isError: order.isError }) ? (
        <View className="bg-warn-soft px-md py-sm">
          <Text className="text-xs font-semibold text-ink" testID={`${TEST_ID}-refetch-failed`}>
            {COPY.refetchFailed}
          </Text>
        </View>
      ) : null}
      <FieldsCard data={data} />
      {data.comboLegCodes.length > 0 ? <LegsSection legs={data.comboLegCodes} /> : null}
    </ScrollView>
  );
}

interface OrderField {
  /** testID 后缀。 */
  key: string;
  label: string;
  value: string;
  /** 值下方的第二行（名称代码的代码行、下单时间的时分秒 + 时区）。 */
  sub?: string;
}

/** 九个字段，顺序同 FR-017。O(1)。 */
function orderFields(data: BrokerOrderDetailResponse): OrderField[] {
  const labels = ORDER_COPY.fields;
  const unit = COPY.positionDetail.qtyUnit[orderKind(data)];
  const created = data.createdAtLocal === null ? null : localDateTimeParts(data.createdAtLocal);
  const dealtQty = data.dealtQty === null ? NO_VALUE : `${data.dealtQty} ${unit}`;
  const amount =
    data.amount === null
      ? NO_VALUE
      : `${formatFullAmount(data.amount)}${data.currency === null ? '' : ` ${data.currency}`}`;

  return [
    { key: 'side', label: labels.side, value: tradeSideText(data.side) },
    { key: 'status', label: labels.status, value: orderStatusText(data.status) },
    {
      key: 'name',
      label: labels.name,
      value: positionDisplayName(data),
      sub: positionCodeLine(data),
    },
    {
      key: 'qty-price',
      label: labels.qtyPrice,
      value: `${data.qty} ${unit} / ${data.price ?? NO_VALUE}`,
    },
    { key: 'amount', label: labels.amount, value: amount },
    {
      key: 'dealt-qty-price',
      label: labels.dealtQtyPrice,
      value: `${dealtQty} / ${data.dealtAvgPrice ?? NO_VALUE}`,
    },
    {
      key: 'dealt-amount',
      label: labels.dealtAmount,
      value: data.dealtAmount === null ? NO_VALUE : formatFullAmount(data.dealtAmount),
    },
    {
      key: 'created-at',
      label: labels.createdAt,
      value: created === null ? NO_VALUE : created.ymd,
      sub: created === null ? undefined : `${created.hms}${marketTzLabel(data.market)}`,
    },
    {
      key: 'order-type',
      label: labels.orderType,
      value: data.orderType === null ? NO_VALUE : COPY.orderTypeLabel(data.orderType),
    },
  ];
}

/** 键值卡：左标签、右值（可带第二行）。O(1)。 */
function FieldsCard({ data }: { data: BrokerOrderDetailResponse }) {
  return (
    <View className="bg-surface px-md" testID={`${TEST_ID}-fields`}>
      {orderFields(data).map((field) => (
        <View key={field.key} className="border-b border-line-soft py-2.5">
          <View className="flex-row items-start gap-sm">
            <Text className="flex-1 text-sm text-ink-muted">{field.label}</Text>
            <View className="items-end gap-0.5">
              <Text className="font-mono text-sm text-ink" testID={`${TEST_ID}-${field.key}`}>
                {field.value}
              </Text>
              {field.sub === undefined ? null : (
                <Text
                  className="font-mono text-xs text-ink-muted"
                  testID={`${TEST_ID}-${field.key}-sub`}
                >
                  {field.sub}
                </Text>
              )}
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

/** 组合单各腿券商代码（去市场前缀）。O(n)。 */
function LegsSection({ legs }: { legs: string[] }) {
  return (
    <View className="bg-surface" testID={`${TEST_ID}-legs`}>
      <View className="border-b border-line-soft px-md py-sm">
        <Text className="text-sm font-semibold text-ink">{ORDER_COPY.legsTitle}</Text>
      </View>
      {legs.map((code, index) => (
        <View key={`${index}-${code}`} className="border-b border-line-soft px-md py-2.5">
          <Text className="font-mono text-sm text-ink" testID={`${TEST_ID}-leg-${index}`}>
            {displayCode(code)}
          </Text>
        </View>
      ))}
    </View>
  );
}
