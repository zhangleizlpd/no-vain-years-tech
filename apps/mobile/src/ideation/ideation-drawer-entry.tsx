// 045 T021 — 抽屉里的「灵感」入口（FR-025）。
//
// 🚨 **两个抽屉共用本组件**，不许各写一份：
//   - 全局抽屉（~/core/app-shell-drawer，期权台 / 投资 / 我的 三个一级 tab 页的汉堡开它）
//   - chat 会话抽屉（~/chat/chat-drawer，首页汉堡开它 —— 首页汉堡维持开 chat 抽屉不动，
//     user 2026-08-01 裁决方案 C：满足「所有一级页汉堡 → 侧滑抽屉 → 能进灵感」且 chat 既有
//     e2e 零回归；代价「灵感入口两处各一份」为已接受项，spec 说的完整菜单结构统一规划时合并）
// 共用的落点 = 同一份 copy（IDEATION_COPY.drawerEntry）+ 同一个图标 + 同一套导航语义；
// 只有 testID 由调用方按抽屉前缀给（`app-drawer-ideation-entry` / `chat-drawer-ideation-entry`）。
//
// presentational/编排 —— 无 vitest（render 走 T025 Playwright e2e，per mono 测试分层）。
import { Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';

import { colors } from '~/theme';
import { TabBarIcon } from '~/ui';
import { IDEATION_COPY } from './ideation-copy';
import { IDEATION_LIST_ROUTE } from './ideation-routes';

const ICON_SIZE = 22;

export interface IdeationDrawerEntryProps {
  /** 本入口的 testID（调用方按抽屉前缀给，T025 两处各断言一次）。 */
  testID: string;
  /** 导航前的副作用（两个抽屉都传关抽屉）。 */
  onNavigate?: () => void;
}

export function IdeationDrawerEntry({ testID, onNavigate }: IdeationDrawerEntryProps) {
  const router = useRouter();

  return (
    <Pressable
      className="flex-row items-center gap-3 px-md py-3.5"
      onPress={() => {
        onNavigate?.();
        router.push(IDEATION_LIST_ROUTE);
      }}
      accessibilityRole="button"
      accessibilityLabel={IDEATION_COPY.drawerEntry}
      testID={testID}
    >
      {/* 沿用灵感退位前的 tab 图标（brain），零新增图标资产。 */}
      <TabBarIcon name="brain" focused={false} color={colors.ink.muted} size={ICON_SIZE} />
      <Text className="text-base text-ink">{IDEATION_COPY.drawerEntry}</Text>
    </Pressable>
  );
}
