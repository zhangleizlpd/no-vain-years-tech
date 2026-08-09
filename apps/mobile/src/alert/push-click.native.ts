// 通知点击路由 — native (022 T012, FR-008 / plan D11)。仅监听
// notificationOpened → 消息中心（021 既有屏）。不做 payload 深链 / 冷启动
// launch-intent 解析：华为/小米厂商通道回调不可靠（PoC jpush-react-native
// #958 实证），FR-008 兜底 = 021 未读角标 + 消息中心。
// 调用方：push-init.native 在 JPush.init 后挂（同一惰性 require 路径，
// 未同意 / web / iOS 永不求值）。

import { router } from 'expo-router';

export function initAlertPushClick(): void {
  const JPush = (
    require('jpush-react-native') as { default: typeof import('jpush-react-native').default }
  ).default;
  JPush.addNotificationListener((event) => {
    if (event.notificationEventType === 'notificationOpened') {
      router.push('/(app)/alert/messages');
    }
  });
}
