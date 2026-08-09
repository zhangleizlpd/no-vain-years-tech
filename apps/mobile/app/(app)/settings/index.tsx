import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform, ScrollView } from 'react-native';

import { isNotificationEnabled, openSystemNotificationSettings } from '~/alert/push-permission';
import { logoutAll } from '~/auth/logout-all';
import { MarketsGate } from '~/core/markets-gate';

import { Card, Divider, Row } from '~/settings/primitives';

const COPY = {
  cards: {
    accountSecurity: '账号与安全',
    customInstruction: '自定义指令',
    general: '通用',
    notifications: '通知',
    notificationPermission: '通知权限',
    stockMarket: '证券市场',
    broker: '券商账户',
    privacy: '隐私与权限',
    about: '关于',
    switchAccount: '切换账号',
    logout: '退出登录',
  },
  logoutConfirm: '确定要退出登录?',
  logoutCancel: '取消',
  logoutOk: '确定',
};

export default function SettingsIndex() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  // 022 T012 — 系统通知权限关闭时的引导行（spec Edge，V1 仅引导不强弹）。
  // web 隐藏（push-permission web stub 恒报 enabled，且 effect 提前 return）。
  const [showNotifGuide, setShowNotifGuide] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    void isNotificationEnabled()
      .then((enabled) => {
        if (!cancelled && !enabled) setShowNotifGuide(true);
      })
      .catch(() => {
        // 检测失败按 enabled 处理 — 引导行是 best-effort 增强
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    if (isLoading) return;
    setIsLoading(true);
    try {
      await logoutAll();
    } catch {
      // logoutAll swallows server errors internally and always clears the
      // local session in finally — so this outer catch is an extra safety net.
    }
    // logoutAll clears the session; AuthGate will redirect to login.
    // The explicit replace here is a belt-and-suspenders guard for timing
    // edge cases on web where AuthGate's redirect may be slightly delayed.
    router.replace('/(auth)/login');
  }

  function confirmLogout() {
    // react-native-web Alert.alert falls back to a single-button window.alert,
    // ignoring the buttons array — onPress never fires on web. Use
    // window.confirm explicitly so the user can actually cancel on web.
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(COPY.logoutConfirm)) {
        void handleLogout();
      }
      return;
    }
    Alert.alert(COPY.logoutConfirm, undefined, [
      { text: COPY.logoutCancel, style: 'cancel' },
      { text: COPY.logoutOk, style: 'destructive', onPress: handleLogout },
    ]);
  }

  return (
    <ScrollView
      className="flex-1 bg-surface-sunken"
      contentContainerClassName="px-md pt-md pb-xl gap-md"
    >
      <Card>
        <Row
          label={COPY.cards.accountSecurity}
          onPress={() => router.push('/(app)/settings/account-security')}
        />
        <Divider />
        {/* 031 — AI 助手自定义指令（chat 账号级偏好，设置页仅作导航入口，屏组件归 ~/chat） */}
        <Row
          label={COPY.cards.customInstruction}
          onPress={() => router.push('/(app)/settings/chat-custom-instructions')}
        />
        <Divider />
        <Row label={COPY.cards.general} disabled />
        <Divider />
        <Row label={COPY.cards.notifications} disabled />
        {showNotifGuide ? (
          <>
            <Divider />
            <Row
              label={COPY.cards.notificationPermission}
              onPress={openSystemNotificationSettings}
            />
          </>
        ) : null}
      </Card>

      {/* 投资设置 Card（011 D5）：证券市场 + 券商账户（012 翻 live，D9）。
          markets off（公开版）→ 整 Card 不渲染（入口隐藏；路由直达由各屏 MarketsRouteGuard 兜底）。 */}
      <MarketsGate>
        <Card>
          <Row
            label={COPY.cards.stockMarket}
            onPress={() => router.push('/(app)/settings/stock-market')}
          />
          <Divider />
          <Row
            label={COPY.cards.broker}
            onPress={() => router.push('/(app)/settings/broker-accounts')}
          />
        </Card>
      </MarketsGate>

      <Card>
        <Row label={COPY.cards.privacy} disabled />
        <Divider />
        <Row label={COPY.cards.about} disabled />
      </Card>

      <Card>
        <Row label={COPY.cards.switchAccount} disabled showChevron={false} align="center" />
        <Divider />
        <Row
          label={COPY.cards.logout}
          destructive
          showChevron={false}
          align="center"
          busy={isLoading}
          onPress={confirmLogout}
        />
      </Card>
    </ScrollView>
  );
}
