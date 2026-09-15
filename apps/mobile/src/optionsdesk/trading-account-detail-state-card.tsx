// 083 T018 — 详情屏（持仓 / 订单）共用的非数据视图卡：「不存在」/「加载失败 + 重试」（FR-020）。
//
// 📌 自 T017 持仓详情屏原样抽出（行为与 testID 不变），订单详情是第二个消费者。持仓列表的四态卡
//    视图与文案不同，不共用。
import { Pressable, Text, View } from 'react-native';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import type { DetailView } from './trading-account-positions.rules';

const COPY = OPTIONSDESK_COPY.tradingAccountPositions;

export type DetailStateView = Extract<DetailView, 'not-found' | 'error'>;

export interface DetailStateCardProps {
  /** 屏的 testID 前缀：卡片 = `<前缀>-<view>`，重试按钮 = `<前缀>-retry`。 */
  testIdPrefix: string;
  view: DetailStateView;
  copy: {
    states: Readonly<Record<DetailStateView, string>>;
    stateBody: Readonly<Record<DetailStateView, string>>;
  };
  /** 只有「无已显示数据时加载失败」传入 ⇒ 渲染重试按钮。 */
  onRetry?: () => void;
}

export function DetailStateCard({ testIdPrefix, view, copy, onRetry }: DetailStateCardProps) {
  return (
    <View className="px-md py-lg">
      <View className="rounded-md border border-line bg-surface" testID={`${testIdPrefix}-${view}`}>
        <View className="items-center gap-2.5 px-lg py-xl">
          <Text className="text-lg font-semibold text-ink">{copy.states[view]}</Text>
          <Text className="max-w-[280px] text-center text-sm text-ink-muted">
            {copy.stateBody[view]}
          </Text>
          {onRetry ? (
            <Pressable
              onPress={onRetry}
              accessibilityRole="button"
              accessibilityLabel={COPY.retry}
              testID={`${testIdPrefix}-retry`}
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
