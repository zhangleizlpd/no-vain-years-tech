import { useCallback } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { MessageItem } from '@nvy/api-client';

import { Button, Spinner } from '~/ui';
import { colors } from '~/theme';
import { ALERT_COPY, formatMessageBody, formatMessageTime } from './alert-copy';
import { AlertIcon } from './alert-icon';
import { AlertTabRow } from './alert-tab-row';
import { useAlertMessages, useMarkMessagesRead } from './use-alert-messages';

// 屏 6 消息通知（021 US3 / FR-M06·M07，mockup MessageCenterScreen 翻 RN）：提醒 tab 默认
// + 待办 disabled 占位（无服务号 / 无右上 icon）；进入即 EP8 mark-read（plan D6 屏级水位线，
// 幂等可重入 → useFocusEffect）。正文/时间格式化纯函数 vitest；渲染/交互走 Playwright。

const COPY = ALERT_COPY.messages;

/** 消息卡片：标题「预警触发」（未读红点变体）+ 正文 + ✓时间戳。 */
function MessageCard({ message }: { message: MessageItem }) {
  return (
    <View className="bg-surface rounded-md shadow-card mx-md mb-sm px-md pt-md pb-sm">
      <View className="flex-row items-center gap-xs mb-xs">
        {message.unread ? <View className="w-2 h-2 rounded-full bg-err" /> : null}
        <Text className="text-base font-semibold text-ink">{COPY.cardTitle}</Text>
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

export function MessageCenterScreen() {
  const { messages, status, refetch } = useAlertMessages();
  const markRead = useMarkMessagesRead();

  // 进入提醒 tab 即置已读（D6）：EP7 角标清零 + EP6 unread 旗翻新；focus 重入幂等。
  useFocusEffect(
    useCallback(() => {
      void markRead();
    }, [markRead]),
  );

  const body =
    status === 'loading' ? (
      <View className="flex-1 items-center justify-center">
        <Spinner />
      </View>
    ) : status === 'error' ? (
      <View className="flex-1 items-center justify-center gap-md px-md">
        <Text className="text-base text-ink-muted">{ALERT_COPY.list.loadError}</Text>
        <Button label={ALERT_COPY.list.retry} onPress={() => void refetch()} />
      </View>
    ) : messages.length === 0 ? (
      <Text className="text-center text-sm text-ink-subtle pt-3xl">
        {ALERT_COPY.list.emptyMessages}
      </Text>
    ) : (
      <ScrollView className="flex-1">
        <View className="pt-md">
          {messages.map((m) => (
            <MessageCard key={m.id} message={m} />
          ))}
        </View>
      </ScrollView>
    );

  return (
    <View className="flex-1 bg-surface-sunken">
      <AlertTabRow
        tabs={[
          { key: 'remind', label: COPY.tabRemind },
          { key: 'todo', label: COPY.tabTodo, disabled: true },
        ]}
        active="remind"
        onChange={() => undefined}
      />
      {body}
    </View>
  );
}
