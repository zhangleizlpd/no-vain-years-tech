// 045 T021 — 抽屉底部用户脚（头像 + 昵称 + 齿轮 → 设置），自 chat/chat-drawer.tsx 抽出。
//
// 两个抽屉逐像素同款（mockup 帧 ⑨ 与 028 frame 1 是同一段），故按「复用频次 ≥2 才抽原语」
// 抽到共用层。落 ~/core 而非 ~/ui：它读 useMe()（业务态），不是纯 presentational 原语。
//
// 🚨 testID 走**前缀派生**（同 ~/ui/app-drawer 的做法）：chat 传 'chat-drawer' → 派生出的
// `chat-drawer-user-name` / `chat-drawer-settings-button` 与抽出前逐字一致，chat 既有 e2e
// 断言路径零改动。
//
// presentational/编排 —— 无 vitest（render 走 Playwright e2e，per mono 测试分层）。
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import Svg, { Circle, Path } from 'react-native-svg';

import { useMe } from '~/core/api/use-me';
import { colors } from '~/theme';

const AVATAR_SIZE = 38;

export interface DrawerUserFooterProps {
  /** testID 前缀：昵称 = `${testIDPrefix}-user-name`，齿轮 = `${testIDPrefix}-settings-button`。 */
  testIDPrefix: string;
  /** 齿轮 a11y 名（调用方 copy）。 */
  settingsLabel: string;
  /** displayName 缺失时的兜底昵称（调用方 copy）。 */
  fallbackName: string;
  /** 跳设置前的副作用（两个抽屉都传关抽屉）。 */
  onNavigate?: () => void;
}

export function DrawerUserFooter({
  testIDPrefix,
  settingsLabel,
  fallbackName,
  onNavigate,
}: DrawerUserFooterProps) {
  const router = useRouter();
  const { data: profile } = useMe();
  const avatarInitial = profile?.displayName ? [...profile.displayName][0] : null;

  return (
    <View className="flex-row items-center gap-sm border-t border-line px-md py-3">
      <View
        className="rounded-full bg-brand-500 items-center justify-center"
        style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
      >
        {avatarInitial ? (
          <Text className="text-base font-semibold text-white">{avatarInitial}</Text>
        ) : (
          <Text className="text-base">👤</Text>
        )}
      </View>
      <View className="flex-1 min-w-0">
        <Text
          className="text-base font-medium text-ink"
          numberOfLines={1}
          ellipsizeMode="tail"
          testID={`${testIDPrefix}-user-name`}
        >
          {profile?.displayName ?? fallbackName}
        </Text>
      </View>
      <Pressable
        className="items-center justify-center rounded-full"
        style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
        onPress={() => {
          onNavigate?.();
          router.push('/(app)/settings');
        }}
        accessibilityRole="button"
        accessibilityLabel={settingsLabel}
        testID={`${testIDPrefix}-settings-button`}
      >
        <GearGlyph />
      </Pressable>
    </View>
  );
}

function GearGlyph() {
  return (
    <Svg
      width={21}
      height={21}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.muted}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Circle cx={12} cy={12} r={3.2} />
      <Path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.5l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
    </Svg>
  );
}
