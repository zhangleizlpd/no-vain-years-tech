// 074 T007 — 锚搜索浮层（FR-001 / FR-002；plan D6/D7/D10；mockup 帧 ②③）。
//
// 骨架期（T007）：壳（把手 / 标题 + 取消 / 搜索框 + 清空叉）+ 真空白结果区；
// 取数与五态渲染归 T008（判定在 `anchor-search.rules.ts`，这里只 switch）。
//
// 🚨 盖 Tab 栏必用 RN `<Modal transparent>`（playbook §12.2 —— tab 屏内 absolute 够不到
//    同级 Tab 栏）。浮层**不触碰 `useRadar`** ⇒ 关闭后页签 / 筛选 / 滚动位置天然原状（sb-9）。
// 底部 sheet + 搜索框体例抄 `portfolio/add-watchlist-entry.tsx`（学皮不学肉：
// 分组 chips 与「加入自选」动作不属于纯定位通道）。
import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';

import { colors } from '~/theme';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.radar;

export interface AnchorSearchSheetProps {
  visible: boolean;
  onClose: () => void;
}

export function AnchorSearchSheet({ visible, onClose }: AnchorSearchSheetProps) {
  const [query, setQuery] = useState('');

  // 关闭时复位本地态（下次打开干净）—— 同 add-watchlist-entry 体例。
  useEffect(() => {
    if (!visible) setQuery('');
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-modal-overlay">
        <Pressable
          onPress={onClose}
          accessibilityLabel={COPY.searchCancel}
          testID="optionsdesk-anchor-search-backdrop"
          className="absolute inset-0"
        />
        <View
          className="bg-surface rounded-t-lg overflow-hidden"
          style={{ height: '78%' }}
          testID="optionsdesk-anchor-search-sheet"
        >
          {/* 把手（mockup 帧 ②）。 */}
          <View className="items-center pt-sm">
            <View className="h-1 w-10 rounded-full bg-line" />
          </View>

          {/* 标头：「搜索锚」+ 取消。 */}
          <View className="flex-row items-center justify-between px-md py-md border-b border-line-soft">
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={COPY.searchCancel}
              testID="optionsdesk-anchor-search-cancel"
            >
              <Text className="text-base text-brand-500">{COPY.searchCancel}</Text>
            </Pressable>
            <Text className="text-base font-semibold text-ink">{COPY.searchEntry}</Text>
            <View className="w-10" />
          </View>

          {/* 搜索框 + 清空叉。 */}
          <View className="px-md py-sm">
            <View className="flex-row items-center gap-sm bg-surface-sunken rounded-md px-md h-10">
              <Text className="text-base text-ink-subtle">⌕</Text>
              <TextInput
                autoFocus
                value={query}
                onChangeText={setQuery}
                placeholder={COPY.searchPlaceholder}
                placeholderTextColor={colors.ink.subtle}
                accessibilityLabel={COPY.searchEntry}
                testID="optionsdesk-anchor-search-input"
                className="flex-1 text-base text-ink"
              />
              {query.length > 0 ? (
                <Pressable
                  onPress={() => setQuery('')}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.searchClear}
                  testID="optionsdesk-anchor-search-clear"
                >
                  <Text className="text-base text-ink-subtle">✕</Text>
                </Pressable>
              ) : null}
            </View>
          </View>

          {/* 结果区。骨架期恒真空白 = sb-1 的 idle 形态（「没搜过」时空态文案 / spinner
              一个都不许在 —— e2e T007-① 逐个点名断言）。 */}
          <View className="flex-1" testID="optionsdesk-anchor-search-results" />
        </View>
      </View>
    </Modal>
  );
}
