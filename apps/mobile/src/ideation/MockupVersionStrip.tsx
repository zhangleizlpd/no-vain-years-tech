// 037 T014 [US2] — 多版切换条 + 屏标签行（append-only 倒序，latest 默认选中带交付日期）。
//
// 两段（mockup 帧①/⑤）：
//   ① 版本条：横滑 chips（倒序，latest 在前；选中态高亮 brand-500，未选 surface-sunken 描边）。
//      点历史 chip → emit onSelect(id) → 屏切 MockupRenderer uri 重渲该版（FR-006 + Clarification Q1）。
//   ② 屏标签行：渲**当前选中版**的 screens[]（逐屏标签字符串，FR-010 + Clarification Q2）。
//
// presentational（无 vitest）：倒序 / 默认 latest / 日期格式化 / 版本标签纯逻辑在 mockup-version.rules.ts
// （vitest 覆盖）；切换重渲 + 标签渲染走 T015 Playwright Web e2e。chip 视觉范式承 MarketBadge
// （描边小块）；横滑容器范式承 ~/ui Tabs（无 width class 上 ScrollView，per memory）。
import { Pressable, ScrollView, Text, View } from 'react-native';

import { prepareVersionStrip } from './mockup-version.rules';
import type { SessionMockupResponse } from './use-session-mockups';

export interface MockupVersionStripProps {
  /** 该 session 全部交付版（读列表 items，倒序前已含；本组件内再防御排序）。 */
  items: readonly SessionMockupResponse[];
  /** 当前选中版 id（屏管理选中态，默认 latest）。 */
  selectedId: string | null;
  /** 点 chip → 切选中版（屏据此换 renderer uri + 标签行）。 */
  onSelect: (id: string) => void;
  /** 当前选中版的逐屏标签（屏据 selectedId 解析后传入；空 → 不渲标签行）。 */
  screens: readonly string[];
}

export function MockupVersionStrip({
  items,
  selectedId,
  onSelect,
  screens,
}: MockupVersionStripProps) {
  const chips = prepareVersionStrip(items);
  // 单版无需切换条（只一枚），但仍渲屏标签行（含哪些状态屏，FR-010）。
  return (
    <View className="gap-sm py-sm" testID="ideation-mockup-version-strip">
      {chips.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-sm px-xl"
        >
          {chips.map((chip) => {
            const selected = chip.id === selectedId;
            return (
              <Pressable
                key={chip.id}
                onPress={() => onSelect(chip.id)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`${chip.label}${chip.deliveredAt ? ` · ${chip.deliveredAt}` : ''}`}
                testID={`ideation-mockup-version-chip-${chip.versionRank}`}
                className={
                  selected
                    ? 'rounded-full bg-brand-500 px-md py-xs'
                    : 'rounded-full border border-line bg-surface-sunken px-md py-xs'
                }
              >
                <Text
                  className={
                    selected
                      ? 'text-sm font-semibold text-white'
                      : 'text-sm font-semibold text-ink-muted'
                  }
                >
                  {chip.label}
                </Text>
                {chip.deliveredAt ? (
                  <Text
                    className={selected ? 'text-xs text-white-soft' : 'text-xs text-ink-subtle'}
                  >
                    {chip.deliveredAt}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {/* 屏标签行：当前选中版含哪些状态屏（逐屏标签字符串，FR-010 + Clarification Q2）。 */}
      {screens.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-xs px-xl"
          testID="ideation-mockup-screen-labels"
        >
          {screens.map((label, i) => (
            <View
              key={`${label}-${i}`}
              testID={`ideation-mockup-screen-label-${i}`}
              className="rounded-sm border border-line bg-surface-sunken px-xs"
            >
              <Text className="text-xs text-ink-muted">{label}</Text>
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}
