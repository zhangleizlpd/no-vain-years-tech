// 083 T014 — 交易账户页 · 持仓分段（plan §D14）：首次加载 / 四种非列表状态卡 / 列表外壳。
//
// 列表外壳自上而下：同步时刻行（陈旧时换成陈旧条）→ 未归类提示 → 列头；分组列表由 T015 在本文件补。
//
// 🚨 视图判定全走 `resolvePositionsView`（T013）。它的入参**没有「首次加载中」**——
//    `isPending` 必须在调它之前自己分支（类型上排除，漏判编译不过）。
// 🚨 已有数据时重读失败 🚫 换错误卡（FR-023，Guardrail 10）：`data` 在就按数据出视图。
// 📌 时间只做字符串重排 + 按所选市场拼时区标签（服务端已换算，Guardrail 8）；🚫 时区换算。
import { Pressable, Text, View } from 'react-native';
import type { BrokerPositionListResponse } from '@nvy/api-client';

import { Spinner } from '~/ui';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import type { RadarMarket } from './radar.rules';
import {
  localDateTimeParts,
  marketTzLabel,
  resolvePositionsView,
  showUnresolvedHint,
  type PositionsView,
} from './trading-account-positions.rules';
import {
  useTradingAccountPositions,
  type UseTradingAccountPositionsResult,
} from './use-trading-account-positions';

const COPY = OPTIONSDESK_COPY.tradingAccountPositions;
const TEST_ID = 'optionsdesk-trading-account-positions';

/** 列宽（mockup 帧 1：名称弹性 · 市值/数量 88 · 现价/成本 62 · 持仓盈亏 76）；列头与行共用。 */
const COL = {
  name: 'flex-1',
  marketValue: 'w-[88px] items-end',
  price: 'w-[62px] items-end',
  unrealizedPl: 'w-[76px] items-end',
} as const;
const COLUMNS = ['name', 'marketValue', 'price', 'unrealizedPl'] as const;

export function TradingAccountPositions({ market }: { market: RadarMarket }) {
  const positions = useTradingAccountPositions(market);
  return (
    <View className="flex-1" testID={TEST_ID}>
      <PositionsBody market={market} positions={positions} />
    </View>
  );
}

interface PositionsBodyProps {
  market: RadarMarket;
  positions: UseTradingAccountPositionsResult;
}

function PositionsBody({ market, positions }: PositionsBodyProps) {
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
  if (view === 'list') {
    return (
      <View className="flex-1" testID={`${TEST_ID}-list`}>
        <PositionsMeta market={market} data={data} />
        <ColumnHeader />
      </View>
    );
  }
  if (view === 'empty') {
    return (
      <View>
        <PositionsMeta market={market} data={data} />
        <StateCard view="empty" />
      </View>
    );
  }
  return <StateCard view={view} />;
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
  return parts === null ? '--' : `${parts.mdHm}${marketTzLabel(market)}`;
}

interface PositionsMetaProps {
  market: RadarMarket;
  data: BrokerPositionListResponse;
}

/** 同步时刻行（陈旧时换成陈旧条，FR-008 / FR-009）+ 未归类提示（FR-011）；空态与列表共用。 */
function PositionsMeta({ market, data }: PositionsMetaProps) {
  const time = syncedTimeLabel(data.syncedAtLocal, market);
  return (
    <View>
      {data.stale ? (
        <View className="bg-warn-soft px-md py-sm">
          <Text className="text-xs font-semibold text-ink" testID={`${TEST_ID}-stale`}>
            {COPY.stale(time)}
          </Text>
        </View>
      ) : (
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
