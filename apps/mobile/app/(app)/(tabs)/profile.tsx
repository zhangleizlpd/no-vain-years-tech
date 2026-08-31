// US5 profile screen — per spec FR-016 / FR-017 / FR-018 / FR-019 / FR-020 /
// FR-027 / FR-030 + CL-005 sticky tabs.
//
// Sticky paradigm (T036, CL-005 (b)): single ScrollView + stickyHeaderIndices=[1].
// Hero scrolls off; SlideTabs sticks under the absolute TopNav overlay; content
// scrolls beneath. TopNav switches from transparent-over-Hero to opaque-surface
// once scrollY crosses STICKY_THRESHOLD. Swipe gesture is NOT implemented this
// batch (CL-005 fallback — tap-only); animated underline indicator omitted per
// FR-022 / ADR-0017 (占位 UI 禁自定义动画).
//
// FR-029: no PNG/SVG image assets — avatar uses 👤 emoji fallback, background
// uses SVG gradient stand-in for the blurred photo (M2 mockup swaps real).
//
// 🔁 072 T016（FR-011 / SC-005 / US6）：三栏由「笔记 / 图谱 / 知识库」改版为
// 「审批 / 消息 / 知识库」。可见性判定不在本屏 —— 它是 markets 合规位 × isAdmin 的四象限，
// 收在 `~/profile/profile-tabs.rules`（那里有四象限单测；散在这里的 && 验不了「markets off
// ∧ admin」那格）。本屏只做两件事：把判定结果喂给 SlideTabs、按激活栏分发内容。

import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import Svg, { Circle, Defs, G, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { DrawerMenuButton } from '~/core/app-shell-drawer';
import { useMe } from '~/core/api/use-me';
import { FEATURE_MARKETS_ENABLED } from '~/core/feature-flags';
import { ossThumbCacheKey, ossThumbUrl } from '~/profile-image/oss-image';
import { useProfileImageEditor } from '~/profile-image/use-profile-image-editor';
import {
  resolveActiveProfileTab,
  visibleProfileTabs,
  type ProfileTabKey,
} from '~/profile/profile-tabs.rules';
import { tokens } from '~/theme';

const AVATAR_THUMB = { width: 200, height: 200 };
const HERO_BG_THUMB = { width: 1080, height: 720 };

const COPY = {
  unnamed: '未命名',
  follow: '关注',
  fans: '粉丝',
  topNavSearchLabel: '搜索',
  topNavSettingsLabel: '设置',
  // `satisfies Record<ProfileTabKey, string>` —— 加栏漏文案当场编译红
  // （体例同 optionsdesk-copy.ts 的市场文案表）。
  tabs: { review: '审批', messages: '消息', kb: '知识库' } satisfies Record<ProfileTabKey, string>,
  tabPlaceholderSuffix: '内容即将推出',
};

const FOLLOWING_COUNT = 5;
const FOLLOWERS_COUNT = 12;

const HERO_HEIGHT = 280;
// Trigger sticky-on-blur swap when Hero is mostly off-screen, leaving a
// nav-height buffer (~56px) so the transition lines up with TopNav opacity.
const STICKY_THRESHOLD = HERO_HEIGHT - 56;

const stroke = (c: string, w = 2) =>
  ({
    stroke: c,
    strokeWidth: w,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    fill: 'none',
  }) as const;

function IconSearch({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <G {...stroke(color, 2)}>
        <Circle cx={11} cy={11} r={7} />
        <Path d="M20 20 L16 16" />
      </G>
    </Svg>
  );
}

function IconGear({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <G {...stroke(color, 1.6)}>
        <Circle cx={12} cy={12} r={3} />
        <Path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </G>
    </Svg>
  );
}

// SVG gradient stand-in for blurred photo (FR-029 占位资源 — 不引图片）。
// M2+ swap to <ImageBackground source={...} blurRadius={20}>.
function HeroBlurBackdrop() {
  return (
    <Svg width="100%" height="100%" viewBox="0 0 360 320" preserveAspectRatio="xMidYMid slice">
      <Defs>
        <LinearGradient id="heroBg" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0%" stopColor="#3B5BD9" />
          <Stop offset="55%" stopColor="#7B5BC9" />
          <Stop offset="100%" stopColor="#D98A6B" />
        </LinearGradient>
        <LinearGradient id="heroBlobs" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.16" />
          <Stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </LinearGradient>
      </Defs>
      <Rect width="360" height="320" fill="url(#heroBg)" />
      <Circle cx="80" cy="60" r="90" fill="url(#heroBlobs)" />
      <Circle cx="290" cy="40" r="70" fill="url(#heroBlobs)" />
      <Circle cx="220" cy="160" r="120" fill="url(#heroBlobs)" />
      <Circle cx="60" cy="220" r="80" fill="url(#heroBlobs)" />
    </Svg>
  );
}

function AvatarPlaceholder({
  displayName,
  avatarUrl,
  onPress,
}: {
  displayName: string | null | undefined;
  avatarUrl: string | null;
  onPress: () => void;
}) {
  const initial = displayName ? [...displayName][0] : null;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="imagebutton"
      accessibilityLabel="头像"
      accessibilityHint="点击更换"
      className="w-[72px] h-[72px] rounded-full bg-surface p-[3px] shadow-hero-ring"
    >
      <View className="flex-1 rounded-full bg-brand-500 items-center justify-center overflow-hidden">
        {/* 真实头像（OSS 缩略派生）→ 名首字母 → 👤；null 回落 002 占位（FR-C06，不回归） */}
        {avatarUrl ? (
          <Image
            source={{
              uri: ossThumbUrl(avatarUrl, AVATAR_THUMB),
              cacheKey: ossThumbCacheKey(avatarUrl, AVATAR_THUMB),
            }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            accessibilityLabel="头像图片"
          />
        ) : initial ? (
          <Text className="text-surface text-2xl font-semibold tracking-tight">{initial}</Text>
        ) : (
          <Text className="text-2xl">👤</Text>
        )}
      </View>
    </Pressable>
  );
}

function TopNav({ onBlur, onSettingsPress }: { onBlur: boolean; onSettingsPress: () => void }) {
  // onBlur=true: transparent overlay above Hero (icons read as white for
  // legibility against the SVG backdrop). onBlur=false: opaque surface bar
  // with bottom border, dark icons — kicks in once SlideTabs becomes sticky.
  const iconColor = onBlur ? tokens.colors.surface.DEFAULT : tokens.colors.ink.DEFAULT;
  return (
    <View
      className={
        onBlur
          ? 'flex-row items-center justify-between h-12 px-md bg-transparent'
          : 'flex-row items-center justify-between h-12 px-md bg-surface border-b border-line-soft'
      }
    >
      {/* 045 FR-023：一级 tab 页题头左上汉堡 → 全局抽屉（原 002 占位 disabled 菜单按钮转真入口）。
          图标色随 Hero/sticky 两态切（iconColor），故显式透传。 */}
      <DrawerMenuButton testID="profile-menu-button" color={iconColor} />
      <View className="flex-1" />
      <View className="flex-row items-center gap-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={COPY.topNavSearchLabel}
          accessibilityState={{ disabled: true }}
          className="w-10 h-10 items-center justify-center"
        >
          <IconSearch color={iconColor} />
        </Pressable>
        <Pressable
          onPress={onSettingsPress}
          accessibilityRole="button"
          accessibilityLabel={COPY.topNavSettingsLabel}
          className="w-10 h-10 items-center justify-center"
        >
          <IconGear color={iconColor} />
        </Pressable>
      </View>
    </View>
  );
}

function SlideTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: readonly ProfileTabKey[];
  active: ProfileTabKey;
  onChange: (k: ProfileTabKey) => void;
}) {
  // Tap-only state machine (CL-005 fallback — swipe gesture deferred to a
  // future spec batch once mockup decides indicator + gesture treatment).
  // No animated indicator per FR-022 / ADR-0017 (占位 UI 禁自定义动画) —
  // active state communicated through bold + ink color shift only.
  //
  // 🚨 072 plan §D8：可见性过滤发生在**本组件内部**。父 ScrollView 的
  // `stickyHeaderIndices={[1]}` 按**位置索引**取 sticky 头 —— 把整行条件渲染掉会让
  // sticky 静默落到内容块上（不报错、只是行为错），故 tab 行恒渲染、只是栏数变。
  return (
    <View className="bg-surface border-b border-line-soft">
      <View className="flex-row self-center pt-2">
        {tabs.map((key) => {
          const on = key === active;
          const label = COPY.tabs[key];
          return (
            <Pressable
              key={key}
              onPress={() => onChange(key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={label}
              className="w-[88px] items-center pb-3"
            >
              <Text
                className={
                  on ? 'text-base font-semibold text-ink' : 'text-base font-medium text-ink-muted'
                }
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function TabPlaceholder({ tab }: { tab: ProfileTabKey }) {
  const copy = `${COPY.tabs[tab]}${COPY.tabPlaceholderSuffix}`;
  return (
    <View className="flex-1 items-center justify-center py-2xl gap-3">
      <View className="w-14 h-14 rounded-full bg-surface-sunken items-center justify-center">
        <View className="w-6 h-6 rounded-full bg-line-strong" />
      </View>
      <Text className="text-sm text-ink-muted">{copy}</Text>
    </View>
  );
}

function Hero({
  displayName,
  avatarUrl,
  backgroundImageUrl,
  onAvatarPress,
  onBackgroundPress,
}: {
  displayName: string | null | undefined;
  avatarUrl: string | null;
  backgroundImageUrl: string | null;
  onAvatarPress: () => void;
  onBackgroundPress: () => void;
}) {
  return (
    <View style={{ height: HERO_HEIGHT }} className="relative overflow-hidden">
      {/* 真实背景图（OSS 派生）→ null 回落 002 SVG 渐变占位（FR-C06，不回归） */}
      <View className="absolute inset-0">
        {backgroundImageUrl ? (
          <Image
            source={{
              uri: ossThumbUrl(backgroundImageUrl, HERO_BG_THUMB),
              cacheKey: ossThumbCacheKey(backgroundImageUrl, HERO_BG_THUMB),
            }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            accessibilityLabel="背景图片"
          />
        ) : (
          <HeroBlurBackdrop />
        )}
      </View>
      <View className="absolute inset-0 bg-hero-overlay" />
      <Pressable
        onPress={onBackgroundPress}
        accessibilityRole="imagebutton"
        accessibilityLabel="背景图"
        accessibilityHint="点击更换"
        className="absolute inset-0"
      />
      <View className="flex-1 items-center justify-end pb-8 px-md">
        <AvatarPlaceholder
          displayName={displayName}
          avatarUrl={avatarUrl}
          onPress={onAvatarPress}
        />
        <Text
          className="text-[22px] font-bold text-white-strong mt-3 tracking-tight"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {displayName ?? COPY.unnamed}
        </Text>
        <View className="flex-row items-center gap-md mt-2">
          <View className="flex-row items-center gap-1">
            <Text className="text-sm font-semibold text-white-strong">{FOLLOWING_COUNT}</Text>
            <Text className="text-xs text-white-soft">{COPY.follow}</Text>
          </View>
          <View className="w-px h-3 bg-white-soft" />
          <View className="flex-row items-center gap-1">
            <Text className="text-sm font-semibold text-white-strong">{FOLLOWERS_COUNT}</Text>
            <Text className="text-xs text-white-soft">{COPY.fans}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

export default function ProfileScreen() {
  const router = useRouter();
  // Read displayName from the /me query — the single source of truth. The auth
  // store no longer exposes it for display (it's a write-only cold-start seed).
  const { data: profile } = useMe();
  const displayName = profile?.displayName ?? null;
  const avatarUrl = profile?.avatarUrl ?? null;
  const backgroundImageUrl = profile?.backgroundImageUrl ?? null;
  // 三栏可见性 = markets 合规位 × isAdmin 四象限（判定在 ~/profile/profile-tabs.rules）。
  // `selectedTab` 存的是**用户点过什么**，不是「当前渲什么」—— 后者每帧从可见集合重新派生：
  // /me 落地那一刻 isAdmin 会从冷启动种子翻真值（反向亦然），用 useEffect 纠偏会先把不该
  // 渲的面渲出去一帧再收回。
  const visibleTabs = visibleProfileTabs({
    marketsEnabled: FEATURE_MARKETS_ENABLED,
    isAdmin: profile?.isAdmin,
  });
  const [selectedTab, setSelectedTab] = useState<ProfileTabKey | null>(null);
  const activeTab = resolveActiveProfileTab(selectedTab, visibleTabs);
  const [scrollY, setScrollY] = useState(0);
  const isSticky = scrollY >= STICKY_THRESHOLD;
  // 浮动顶栏吃 top inset（edge-to-edge Android：绝对定位浮层不受 SafeAreaView
  // 父 padding 下推，top:0 落在状态栏后；须把 inset 直接加到浮层自身）。
  const insets = useSafeAreaInsets();

  // 009：头像 / 主页背景图换图 + 查看大图（tap hero → action sheet）。
  const avatarEditor = useProfileImageEditor('avatar', avatarUrl);
  const backgroundEditor = useProfileImageEditor('background', backgroundImageUrl);

  // FR-017: settings stack at /(app)/settings — route now built (006-account-settings-shell).
  const pushSettings = () => router.push('/(app)/settings');

  return (
    <View style={{ flex: 1, backgroundColor: tokens.colors.surface.DEFAULT }}>
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <ScrollView
          stickyHeaderIndices={[1]}
          scrollEventThrottle={16}
          onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) =>
            setScrollY(e.nativeEvent.contentOffset.y)
          }
        >
          <Hero
            displayName={displayName}
            avatarUrl={avatarUrl}
            backgroundImageUrl={backgroundImageUrl}
            onAvatarPress={avatarEditor.open}
            onBackgroundPress={backgroundEditor.open}
          />
          <SlideTabs tabs={visibleTabs} active={activeTab} onChange={setSelectedTab} />
          {/* 🚨 ScrollView 恒三子节点（Hero / SlideTabs / 内容）—— stickyHeaderIndices 按位置
              索引，任何一个子节点被条件渲染掉都会让 sticky 头静默移位。内容分发在这层之内。 */}
          <View className="bg-surface min-h-[260px]">
            <TabPlaceholder tab={activeTab} />
          </View>
        </ScrollView>
      </SafeAreaView>
      {/* 浮动顶栏：移出 SafeAreaView 的 padding，显式吃 top inset，保证设置按钮
          在 edge-to-edge Android 下始终落在状态栏下方、可见可点。 */}
      <View className="absolute top-0 left-0 right-0" style={{ paddingTop: insets.top }}>
        <TopNav onBlur={!isSticky} onSettingsPress={pushSettings} />
      </View>
      {avatarEditor.overlay}
      {backgroundEditor.overlay}
    </View>
  );
}
