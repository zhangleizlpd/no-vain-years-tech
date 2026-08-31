import { Text, View } from 'react-native';
import type { MessageItem } from '@nvy/api-client';

import { Button, Spinner } from '~/ui';
import { colors } from '~/theme';
import { ALERT_COPY, formatMessageBody, formatMessageTime } from './alert-copy';
import { AlertIcon } from './alert-icon';
import type { MessagesStatus } from './use-alert-messages';

/**
 * 预警消息卡片列表 —— **无滚动器**的纯呈现件（072 T014 自 `message-center-screen.tsx` 抽出）。
 *
 * 🚨 **本组件 MUST NOT 自带 `ScrollView` / `FlatList` / `flex-1`**：它有两个宿主，其中一个
 * （「我的」页的消息栏）本身就在一个 `stickyHeaderIndices` 的父 `ScrollView` 里面，嵌套纵向
 * 滚动器会同时毁掉两边的滚动手感。滚动一律由宿主负责。
 *
 * 🚨 **本组件不碰置已读**：置已读是**副作用**，其触发时机在两个宿主里根本不同 —— 全屏是
 * 「进入这块屏」，内嵌是「消息栏成为当前激活栏」（停在审批栏时不该清零）。副作用留给宿主，
 * 本组件只画。判据见 072 FR-012。
 */
export interface AlertMessagePanelProps {
  messages: readonly MessageItem[];
  status: MessagesStatus;
  onRetry: () => void;
  /** 内嵌宿主的截断条数；不传 = 全量（全屏宿主）。 */
  limit?: number;
}

/** 消息卡片：标题「预警触发」（未读红点变体）+ 正文 + ✓时间戳。 */
function MessageCard({ message }: { message: MessageItem }) {
  return (
    <View className="bg-surface rounded-md shadow-card mx-md mb-sm px-md pt-md pb-sm">
      <View className="flex-row items-center gap-xs mb-xs">
        {message.unread ? <View className="w-2 h-2 rounded-full bg-err" /> : null}
        <Text className="text-base font-semibold text-ink">{ALERT_COPY.messages.cardTitle}</Text>
      </View>
      <Text className="text-sm text-ink-muted leading-6">{formatMessageBody(message)}</Text>
      <View className="flex-row items-center gap-xs mt-sm">
        <AlertIcon name="badgeCheck" color={colors.line.strong} size={15} />
        <Text className="text-xs font-mono text-ink-subtle">
          {formatMessageTime(message.triggeredAt)}
        </Text>
      </View>
    </View>
  );
}

export function AlertMessagePanel({ messages, status, onRetry, limit }: AlertMessagePanelProps) {
  if (status === 'loading') {
    return (
      <View className="items-center justify-center py-2xl">
        <Spinner />
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View className="items-center justify-center gap-md px-md py-2xl">
        <Text className="text-base text-ink-muted">{ALERT_COPY.list.loadError}</Text>
        <Button label={ALERT_COPY.list.retry} onPress={onRetry} />
      </View>
    );
  }

  if (messages.length === 0) {
    return (
      <Text className="text-center text-sm text-ink-subtle pt-3xl">
        {ALERT_COPY.list.emptyMessages}
      </Text>
    );
  }

  const shown = limit === undefined ? messages : messages.slice(0, limit);
  return (
    <View className="pt-md">
      {shown.map((m) => (
        <MessageCard key={m.id} message={m} />
      ))}
    </View>
  );
}
