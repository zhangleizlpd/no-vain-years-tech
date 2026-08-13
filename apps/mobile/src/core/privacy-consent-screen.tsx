// Full-screen privacy-policy consent screen (022 FR-011 / US3-AS4). Rendered
// by ConsentGate (app/_layout.tsx) on native first boot, BEFORE AuthGate and
// any data-collecting component initializes. Self-contained: consent writes
// to consent-store, decline exits the app (Android; BackHandler.exitApp is a
// no-op on other platforms — the gate only fires on native and ios ships
// later, per plan D7).

import { BackHandler, Linking, Pressable, Text, View } from 'react-native';

import { SafeAreaView, Button } from '~/ui';

import { useConsentStore } from './consent-store';

// TODO(合规): 占位 URL — 全仓尚无隐私政策页面（settings 的「隐私与权限」行是
// disabled 占位）。真实页面是独立合规项（spec § 合规清单），上架审核前必须落地;
// 届时若路径有变只改这一处。2026-06-07 user 拍板域名。
export const PRIVACY_POLICY_URL = 'https://shintongtech.com/privacy';

const COPY = {
  title: '隐私政策',
  summary:
    '「不负光阴」尊重并保护您的个人信息。为向您送达预警通知，应用将在您同意本隐私政策后初始化推送服务组件（极光推送），并收集设备推送标识（Registration ID）用于向本设备推送通知。同意前，应用不会初始化任何数据采集组件。您可随时通过系统设置管理通知权限。',
  policyLink: '查看《隐私政策》全文',
  agree: '同意并继续',
  decline: '不同意并退出',
};

export function PrivacyConsentScreen() {
  const grantConsent = useConsentStore((s) => s.grantConsent);

  return (
    <SafeAreaView className="flex-1 bg-surface">
      <View className="flex-1 justify-center gap-lg px-lg">
        <Text className="text-2xl font-semibold text-ink">{COPY.title}</Text>
        <Text className="text-base leading-6 text-ink-muted">{COPY.summary}</Text>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={COPY.policyLink}
          onPress={() =>
            void Linking.openURL(PRIVACY_POLICY_URL).catch(() => {
              // 打开外部浏览器失败（无浏览器/被拦截）不阻塞同意流程 — 摘要已含关键披露
            })
          }
        >
          <Text className="text-base text-brand-500">{COPY.policyLink}</Text>
        </Pressable>
      </View>
      <View className="gap-md px-lg pb-xl">
        <Button label={COPY.agree} onPress={grantConsent} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={COPY.decline}
          className="h-12 items-center justify-center"
          onPress={() => BackHandler.exitApp()}
        >
          <Text className="text-base text-ink-muted">{COPY.decline}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
