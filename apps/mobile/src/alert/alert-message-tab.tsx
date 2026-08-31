import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';

import { ALERT_COPY } from './alert-copy';
import { AlertMessagePanel } from './alert-message-panel';
import { useAlertMessages, useMarkMessagesRead } from './use-alert-messages';

/**
 * 「我的」页消息栏的**内嵌宿主**（072 T017 / FR-011 / FR-012）—— 与全屏
 * `MessageCenterScreen` 并列的第二个宿主：同一份 `AlertMessagePanel`（T014 抽出，
 * 无滚动器、不碰置已读），不同的「何时置已读」。
 *
 * 🚨 **置已读由宿主判定后经 `userActivated` 传进来，本组件不自己猜**。MUST NOT 改回
 * 「挂载即置已读」：App 冷启动落地屏就是「我的」，非管理员的默认栏正是消息栏 ⇒ 挂载即清
 * 等于**开一次 App 就把所有预警清成已读**；admin 更糟 —— 冷启动种子不持久化 `isAdmin`，
 * 首帧按非 admin 渲染，消息栏会短暂挂载一下，未读在他看到任何东西之前就没了。
 * 判据本体在 `~/profile/profile-tabs.rules` 的 `shouldMarkMessagesRead`（有单测）。
 *
 * 同理 MUST NOT 用 `useFocusEffect` —— 路由 focus 与「哪一栏激活」是两件事（FR-012 明禁；
 * 全屏宿主跟 focus 走是对的，因为在那儿两者同义）。
 *
 * 挂载纪律另兑现了合规面：markets off 的公开构建里消息栏不渲染 ⇒ 本组件不挂载 ⇒ 一条
 * alert 请求都不发（markets-OFF e2e 断的正是「零 markets-family 请求」）。
 */
export interface AlertMessageTabProps {
  /** 内嵌宿主的截断条数（透传 `AlertMessagePanel`；不传 = 全量）。 */
  limit?: number;
  /** 用户是否**主动点选**了消息栏 —— 置已读的唯一触发条件（默认落在该栏不算）。 */
  userActivated: boolean;
  /** 「查看全部」→ 全屏消息中心。路由由宿主屏给，本组件不认路由。 */
  onSeeAll: () => void;
}

export function AlertMessageTab({ limit, userActivated, onSeeAll }: AlertMessageTabProps) {
  const { messages, status, refetch } = useAlertMessages();
  const markRead = useMarkMessagesRead();

  // 依赖只有 userActivated + markRead（`useMarkMessagesRead` 内部只解构 mutateAsync ⇒
  // 引用稳定）。把整个 mutation 结果对象放进依赖会自激重入（真机实证 1s 169 发，见该 hook 注释）。
  useEffect(() => {
    if (!userActivated) return;
    void markRead();
  }, [userActivated, markRead]);

  return (
    <View className="pb-md">
      <View className="flex-row items-center justify-between px-md pt-md">
        <Text className="text-base font-semibold text-ink">{ALERT_COPY.messages.panelTitle}</Text>
        <Pressable
          onPress={onSeeAll}
          accessibilityRole="button"
          accessibilityLabel={ALERT_COPY.messages.seeAll}
        >
          <Text className="text-sm text-ink-muted">{`${ALERT_COPY.messages.seeAll} ›`}</Text>
        </Pressable>
      </View>
      <AlertMessagePanel
        messages={messages}
        status={status}
        onRetry={() => void refetch()}
        limit={limit}
      />
    </View>
  );
}
