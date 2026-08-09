// 系统通知权限检测 + 引导 — native (022 T012, spec Edge「同意隐私但系统通知
// 关闭」)。V1 仅引导不强弹：设置页据 isNotificationEnabled 显示「通知权限」
// 引导行，点击跳系统设置。走 expo-notifications（T011 已引入）而非 JPush
// 自带检测 — 不依赖 JPush.init 时序。

import * as Notifications from 'expo-notifications';
import { Linking } from 'react-native';

export async function isNotificationEnabled(): Promise<boolean> {
  const { granted } = await Notifications.getPermissionsAsync();
  return granted;
}

export function openSystemNotificationSettings(): void {
  void Linking.openSettings();
}
