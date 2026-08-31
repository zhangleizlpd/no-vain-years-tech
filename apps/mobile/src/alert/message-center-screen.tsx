import { useCallback } from 'react';
import { ScrollView, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { AlertMessagePanel } from './alert-message-panel';
import { useAlertMessages, useMarkMessagesRead } from './use-alert-messages';

// 屏 6 消息通知（021 US3 / FR-M06·M07，mockup MessageCenterScreen 翻 RN）：进入即 EP8
// mark-read（plan D6 屏级水位线，幂等可重入 → useFocusEffect）。
//
// 🔁 **072 T014 删掉了顶部 tab 行**：原本是「提醒」+ disabled 的「待办」两栏占位。「待办」整栏
// 退役（072 FR-011，后续细化成「审核的审核 / 做任务的任务」时重新设计信息架构，不被今天这个
// 占位绑手脚）；剩一栏之后那行 tab 是个 `onChange` 恒 `undefined` 的空控件 —— 一个点不动的
// 控件比没有控件更糟，故一并移除。
//
// 卡片列表已抽去 `alert-message-panel.tsx`（内嵌宿主「我的」页的消息栏共用同一份呈现）；
// 本屏只剩「滚动容器 + 置已读副作用」两件事。
export function MessageCenterScreen() {
  const { messages, status, refetch } = useAlertMessages();
  const markRead = useMarkMessagesRead();

  // 进入即置已读（D6）：EP7 角标清零 + EP6 unread 旗翻新；focus 重入幂等。
  useFocusEffect(
    useCallback(() => {
      void markRead();
    }, [markRead]),
  );

  return (
    <View className="flex-1 bg-surface-sunken">
      <ScrollView className="flex-1">
        <AlertMessagePanel messages={messages} status={status} onRetry={() => void refetch()} />
      </ScrollView>
    </View>
  );
}
