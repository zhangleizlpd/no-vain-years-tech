// 045 T021 — 全局抽屉（FR-023 / FR-024 / FR-025, plan D11）。
//
// 三件套，成对使用：
//   ① `AppShellDrawerProvider` —— 挂在 **tabs layout 层**（app/(app)/(tabs)/_layout.tsx）：
//      持 open 态 + 接 AppState（EC-16）+ 渲染抽屉本体。
//   ② `useAppShellDrawer()` —— 一级 tab 屏取开关。
//   ③ `DrawerMenuButton` —— 题头左上汉堡；渲不渲由 `headerLeadingFor` 单点判定（EC-17）。
//
// 抽屉内容 = 品牌头 + 菜单区 + 用户脚。**菜单区本片只有「灵感」一项**（FR-025，user
// 2026-08-01 收窄：品牌头与用户脚是结构性组成、不计入「菜单入口」）。mockup 帧 ⑨ 下方那块
// 虚线「菜单结构后续统一规划」是**声明不是控件**，不实装。
//
// 首页（chat）例外：其汉堡维持开 chat 会话抽屉（user 2026-08-01 裁决方案 C），灵感入口以
// 同一个 `IdeationDrawerEntry` 落在 chat 抽屉里 —— 见该组件注释。
//
// 骨架（Modal root 层盖住 Tab 栏 / backdrop tap 关 / 82% 滑入 / swipe-left / 硬件返回 /
// 关态 unmount）全在 ~/ui/app-drawer（T018 抽出）。0 新第三方依赖（SC-009）。
// presentational/编排 —— 无 vitest；纯判定在 app-drawer.rules.ts，render 走 T025 e2e。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { useSegments } from 'expo-router';
import Svg, { Line } from 'react-native-svg';

import { IdeationDrawerEntry } from '~/ideation';
import { colors } from '~/theme';
import { AppDrawer } from '~/ui';
import { headerLeadingFor, nextDrawerOpenOnAppState } from './app-drawer.rules';
import { DrawerUserFooter } from './drawer-user-footer';

export const APP_DRAWER_COPY = {
  /** 抽屉根容器 a11y 名。 */
  drawerLabel: '全局菜单抽屉',
  /** 遮罩 a11y 名（tap 关）。 */
  drawerBackdrop: '关闭抽屉',
  /** 题头汉堡 a11y 名（与 chat 顶栏同名，两处语义一致）。 */
  menu: '菜单',
  /** 品牌头。 */
  brandName: '不虚此生',
  brandSubtitle: 'no-vain-years',
  /** 用户脚齿轮。 */
  settings: '设置',
  /** displayName 缺失兜底。 */
  userFallbackName: '我',
} as const;

const HAMBURGER_SIZE = 18;

interface AppShellDrawerValue {
  open: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
}

const AppShellDrawerContext = createContext<AppShellDrawerValue | null>(null);

/** 一级 tab 屏取抽屉开关。必须在 `AppShellDrawerProvider`（tabs layout 层）之下调用。 */
export function useAppShellDrawer(): AppShellDrawerValue {
  const value = useContext(AppShellDrawerContext);
  if (!value) throw new Error('useAppShellDrawer 必须在 AppShellDrawerProvider 之下使用');
  return value;
}

export function AppShellDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const closeDrawer = useCallback(() => setOpen(false), []);
  const openDrawer = useCallback(() => setOpen(true), []);

  // EC-16：切后台即关（判定在 app-drawer.rules，vitest 覆盖）。回前台恒为关，无半开残留。
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      setOpen((prev) => nextDrawerOpenOnAppState(prev, next));
    });
    return () => sub.remove();
  }, []);

  const value = useMemo(() => ({ open, openDrawer, closeDrawer }), [open, openDrawer, closeDrawer]);

  return (
    <AppShellDrawerContext.Provider value={value}>
      {children}
      <AppShellDrawer open={open} onClose={closeDrawer} />
    </AppShellDrawerContext.Provider>
  );
}

/**
 * 题头左上汉堡（FR-023）。**只在一级 tab 屏渲染** —— 二级页与灵感全屏子屏返回 null，
 * 返回箭头交给 navigator header（FR-024 / EC-17）。判定单点在 `headerLeadingFor`。
 */
export function DrawerMenuButton({ testID, color }: { testID: string; color?: string }) {
  const segments = useSegments();
  const { openDrawer } = useAppShellDrawer();

  if (headerLeadingFor(segments) !== 'hamburger') return null;

  return (
    <Pressable
      className="w-10 h-10 items-center justify-center rounded-full"
      onPress={openDrawer}
      accessibilityRole="button"
      accessibilityLabel={APP_DRAWER_COPY.menu}
      testID={testID}
    >
      <HamburgerGlyph color={color ?? colors.ink.DEFAULT} />
    </Pressable>
  );
}

function AppShellDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <AppDrawer
      open={open}
      onClose={onClose}
      testID="app-drawer"
      accessibilityLabel={APP_DRAWER_COPY.drawerLabel}
      backdropAccessibilityLabel={APP_DRAWER_COPY.drawerBackdrop}
    >
      {/* 品牌头（pt-2xl 在安全区之下留设计间距，同 chat 抽屉顶段体例）。 */}
      <View className="border-b border-line px-md pb-md pt-2xl">
        <Text className="text-xl font-bold text-ink">{APP_DRAWER_COPY.brandName}</Text>
        <Text className="mt-0.5 text-xs text-ink-subtle">{APP_DRAWER_COPY.brandSubtitle}</Text>
      </View>

      {/* 菜单区：本片仅「灵感」一项（FR-025）。 */}
      <View className="flex-1">
        <IdeationDrawerEntry testID="app-drawer-ideation-entry" onNavigate={onClose} />
      </View>

      {/* 用户脚（头像 + 昵称 + 齿轮 → 设置）。 */}
      <DrawerUserFooter
        testIDPrefix="app-drawer"
        settingsLabel={APP_DRAWER_COPY.settings}
        fallbackName={APP_DRAWER_COPY.userFallbackName}
        onNavigate={onClose}
      />
    </AppDrawer>
  );
}

function HamburgerGlyph({ color }: { color: string }) {
  return (
    <Svg width={HAMBURGER_SIZE} height={HAMBURGER_SIZE} viewBox="0 0 24 24">
      <Line x1={3} y1={6} x2={21} y2={6} stroke={color} strokeWidth={2} strokeLinecap="round" />
      <Line x1={3} y1={12} x2={21} y2={12} stroke={color} strokeWidth={2} strokeLinecap="round" />
      <Line x1={3} y1={18} x2={21} y2={18} stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}
