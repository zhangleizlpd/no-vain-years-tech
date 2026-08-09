import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { GroupItemSystemKind, type GroupItem, type WatchlistItemView } from '@nvy/api-client';

import { TAG_COLORS } from './watchlist-palette';
import { WATCHLIST_COPY } from './watchlist-copy';

// 屏2 长按菜单内容（013 US4 / FR-M04）。渲染进 ~/ui LongPressMenu 的 bottom sheet
// （由调用方 renderMenu(close) 注入；本组件不含 Modal/scrim/抓手，那是 LongPressMenu）。
// 6 项操作 grid：删除 / 固顶（toggle）/ 移到最前 / 移到最后 / 分组·颜色 / 笔记。
//  - 持仓组标的「删除」灰显 disabled（份额>0 事实驱动；其余可用，FR-M04）。
//  - 「分组·颜色」内联展开子面板：归属组 chips（改 targetGroupId）+ 颜色 swatches（改 color）。
//  - 「笔记」为外部特性，V1 仅留入口 → 触发占位提示（spec Out of Scope）。
// 操作即调即关（apply-then-close），乐观更新 + 失败回弹由 use-watchlist-items 承担。
// presentational —— 渲染 / 交互走 Playwright e2e（per mono vitest 测试分层）。

const COPY = WATCHLIST_COPY.menu;

export interface WatchlistItemMenuProps {
  item: WatchlistItemView;
  /** 当前所在组（判定持仓组 → 删除 disabled）。 */
  group: GroupItem;
  /** 可改归属的目标组（调用方已排除持仓组）。 */
  reassignTargets: GroupItem[];
  onDelete: () => void;
  onTogglePin: () => void;
  onMove: (dir: 'front' | 'back') => void;
  onReassign: (groupId: string) => void;
  onRecolor: (color: string | null) => void;
  onNote: () => void;
  /** 关闭 sheet（LongPressMenu 注入）。 */
  close: () => void;
}

interface Action {
  key: string;
  label: string;
  glyph: string;
  danger?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

export function WatchlistItemMenu({
  item,
  group,
  reassignTargets,
  onDelete,
  onTogglePin,
  onMove,
  onReassign,
  onRecolor,
  onNote,
  close,
}: WatchlistItemMenuProps) {
  const [colorPanel, setColorPanel] = useState(false);
  const isHoldings = group.systemKind === GroupItemSystemKind.holdings;

  const run = (fn: () => void) => () => {
    fn();
    close();
  };

  const actions: Action[] = [
    {
      key: 'delete',
      label: COPY.delete,
      glyph: '✕',
      danger: true,
      disabled: isHoldings,
      onPress: run(onDelete),
    },
    {
      key: 'pin',
      label: item.pinned ? COPY.unpin : COPY.pin,
      glyph: '▲',
      onPress: run(onTogglePin),
    },
    { key: 'front', label: COPY.moveFront, glyph: '↑', onPress: run(() => onMove('front')) },
    { key: 'back', label: COPY.moveBack, glyph: '↓', onPress: run(() => onMove('back')) },
    // 「分组·颜色」展开内联子面板（不关 sheet）。
    { key: 'color', label: COPY.colorGroup, glyph: '●', onPress: () => setColorPanel((v) => !v) },
    { key: 'note', label: COPY.note, glyph: '✎', onPress: run(onNote) },
  ];

  return (
    <View>
      {/* 标的标头：V1 以 market+code 为主名（无 name 来源，per 行名称来源决策 A）。 */}
      <View className="flex-row items-center gap-sm px-lg pt-md pb-xs">
        <Text className="text-base font-semibold text-ink">{item.code}</Text>
        <Text className="text-xs text-ink-subtle">{item.market}</Text>
      </View>

      {/* 6 项操作 grid（3 列）。 */}
      <View className="flex-row flex-wrap px-sm pb-xs">
        {actions.map((a) => {
          const tone = a.disabled ? 'text-ink-subtle' : a.danger ? 'text-err' : 'text-ink';
          return (
            <Pressable
              key={a.key}
              disabled={a.disabled}
              onPress={a.onPress}
              accessibilityRole="button"
              accessibilityLabel={a.label}
              accessibilityState={{ disabled: !!a.disabled }}
              className={`items-center gap-xs py-md ${a.disabled ? 'opacity-50' : ''}`}
              style={{ width: '33.33%' }}
            >
              <View className="w-11 h-11 rounded-md bg-surface-sunken items-center justify-center">
                <Text className={`text-lg ${tone}`}>{a.glyph}</Text>
              </View>
              <Text className={`text-xs ${a.disabled ? 'text-ink-subtle' : 'text-ink-muted'}`}>
                {a.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {colorPanel ? (
        <View className="border-t border-line-soft mt-xs pt-md px-lg">
          {/* 归属分组 chips。 */}
          <Text className="text-xs text-ink-subtle mb-sm">{COPY.sectionGroup}</Text>
          <View className="flex-row flex-wrap gap-sm mb-lg">
            {reassignTargets.map((g) => {
              const on = g.id === item.groupId;
              return (
                <Pressable
                  key={g.id}
                  onPress={run(() => onReassign(g.id))}
                  accessibilityRole="button"
                  accessibilityLabel={g.name}
                  accessibilityState={{ selected: on }}
                  className={`rounded-full px-md py-xs border ${
                    on ? 'border-brand-500 bg-brand-soft' : 'border-line'
                  }`}
                >
                  <Text className={`text-sm ${on ? 'text-brand-500' : 'text-ink'}`}>{g.name}</Text>
                </Pressable>
              );
            })}
          </View>

          {/* 颜色 swatches + 清除。 */}
          <Text className="text-xs text-ink-subtle mb-sm">{COPY.sectionColor}</Text>
          <View className="flex-row items-center gap-md pb-md">
            {TAG_COLORS.map((t) => {
              const on = item.color === t.key;
              return (
                <Pressable
                  key={t.key}
                  onPress={run(() => onRecolor(t.key))}
                  accessibilityRole="button"
                  accessibilityLabel={t.name}
                  accessibilityState={{ selected: on }}
                  className={`w-7 h-7 rounded-full items-center justify-center ${
                    on ? 'border-2 border-ink' : ''
                  }`}
                >
                  <View className={`w-5 h-5 rounded-full ${t.dotClass}`} />
                </Pressable>
              );
            })}
            <Pressable
              onPress={run(() => onRecolor(null))}
              accessibilityRole="button"
              accessibilityLabel={COPY.clearColor}
              className="w-7 h-7 rounded-full border border-line items-center justify-center"
            >
              <Text className="text-sm text-ink-subtle">✕</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}
