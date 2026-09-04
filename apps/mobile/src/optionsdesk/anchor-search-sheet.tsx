// 074 T007/T008 — 锚搜索浮层（FR-001~FR-010；plan D6/D7/D8/D10；mockup 帧 ②~⑥）。
//
// 结果区五态判定单点在 `anchor-search.rules.ts`（searchSheetState），这里只 switch 渲染；
// 250ms 防抖 + orval hook `enabled` 门（空输入零请求）体例同 `ticker-search-picker.tsx`。
//
// 🚨 盖 Tab 栏必用 RN `<Modal transparent>`（playbook §12.2 —— tab 屏内 absolute 够不到
//    同级 Tab 栏）。浮层**不触碰 `useRadar`** ⇒ 关闭后页签 / 筛选 / 滚动位置天然原状（sb-9）。
// 🚨 hook 依赖铁律（playbook §12.4）：query 结果对象每 render 新 identity，**禁**把它整个
//    放进 useCallback / useEffect 依赖 —— 本组件全部在 render 期解构消费，零 effect 吃它。
// 底部 sheet + 搜索框体例抄 `portfolio/add-watchlist-entry.tsx`（学皮不学肉：
// 分组 chips 与「加入自选」动作不属于纯定位通道）。
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useOptionsdeskControllerSearch, type AnchorSearchItem } from '@nvy/api-client';

import { colors } from '~/theme';
import { Spinner } from '~/ui';
import { searchSheetState, type SearchSheetState } from './anchor-search.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { optionsdeskUnderlyingRoute } from './optionsdesk-routes';
import { L_LEVEL_BADGE } from './radar.rules';

const COPY = OPTIONSDESK_COPY.radar;

export interface AnchorSearchSheetProps {
  visible: boolean;
  onClose: () => void;
}

export function AnchorSearchSheet({ visible, onClose }: AnchorSearchSheetProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  // 关闭时复位本地态（下次打开干净）—— 同 add-watchlist-entry 体例。
  useEffect(() => {
    if (!visible) {
      setQuery('');
      setDebounced('');
    }
  }, [visible]);

  // 250ms 防抖（sb-2：窗口内连续输入只有最后一次生效）。
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // 空输入零请求（sb-1 的取数半边）—— `enabled` 是那道门，摘掉它 = 开浮层即打 /search。
  const search = useOptionsdeskControllerSearch(
    { q: debounced },
    { query: { enabled: debounced.length > 0 } },
  );
  const items = search.data?.data.items ?? [];
  const state = searchSheetState({
    debouncedQ: debounced,
    isFetching: search.isFetching,
    isError: search.isError,
    itemCount: items.length,
  });

  // sb-8：关浮层 + 直达详情（与雷达行同目的地；冒号转义在路由函数内）。
  const openItem = (item: AnchorSearchItem) => {
    onClose();
    router.push(optionsdeskUnderlyingRoute(item.ticker));
  };

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

          {/* 结果区：五态互斥 switch（idle = 真空白，sb-1 —— e2e T007-① 逐个点名断言）。 */}
          <View className="flex-1" testID="optionsdesk-anchor-search-results">
            <ResultsBody
              state={state}
              items={items}
              onRetry={() => void search.refetch()}
              onOpen={openItem}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

interface ResultsBodyProps {
  state: SearchSheetState;
  items: readonly AnchorSearchItem[];
  onRetry: () => void;
  onOpen: (item: AnchorSearchItem) => void;
}

function ResultsBody({ state, items, onRetry, onOpen }: ResultsBodyProps) {
  switch (state) {
    // sb-1：没搜过 ≠ 搜不到 —— 空输入下这里**什么都不渲**。
    case 'idle':
      return null;
    case 'loading':
      return (
        <View
          className="flex-row items-center justify-center gap-sm py-xl"
          testID="optionsdesk-anchor-search-loading"
        >
          <Spinner size={14} tone="muted" />
          <Text className="text-sm text-ink-muted">{COPY.searchLoading}</Text>
        </View>
      );
    // sb-7：浮层内提示 + 重试（refetch），不关浮层、不整屏报错。
    case 'error':
      return (
        <View className="items-center gap-sm py-xl" testID="optionsdesk-anchor-search-error">
          <Text className="text-sm text-err">{COPY.searchFailed}</Text>
          <Pressable
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel={COPY.searchRetry}
            testID="optionsdesk-anchor-search-retry"
          >
            <Text className="text-sm text-brand-500">{COPY.searchRetry}</Text>
          </Pressable>
        </View>
      );
    // sb-4：显式空态主副两行，**零 CTA**（不提供建锚等旁路，FR-004）。
    case 'empty':
      return (
        <View className="items-center gap-xs px-lg py-xl" testID="optionsdesk-anchor-search-empty">
          <Text className="text-sm text-ink-muted">{COPY.searchEmptyTitle}</Text>
          <Text className="text-xs text-ink-subtle">{COPY.searchEmptyHint}</Text>
        </View>
      );
    case 'hits':
      return (
        <ScrollView keyboardShouldPersistTaps="handled">
          {items.map((item) => (
            <Pressable
              key={item.ticker}
              onPress={() => onOpen(item)}
              accessibilityRole="button"
              accessibilityLabel={item.name}
              testID={`optionsdesk-anchor-search-row-${item.ticker}`}
              className="flex-row items-center gap-sm px-md py-sm border-b border-line-soft"
            >
              {/* 三字段：名主位 / mono canonical ticker / L 徽标靠右（mockup 帧 ④）。
                  🚨 无行情数值、无 quote 色（FR-006 —— 定位通道只答「是哪只」）。 */}
              <Text className="shrink text-base text-ink" numberOfLines={1}>
                {item.name}
              </Text>
              <Text className="flex-1 font-mono text-xs text-ink-subtle" numberOfLines={1}>
                {item.ticker}
              </Text>
              <View className={`rounded-full px-sm py-0.5 ${L_LEVEL_BADGE[item.lLevelEffective]}`}>
                <Text className="text-xs font-semibold text-white">{item.lLevelEffective}</Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      );
  }
}
