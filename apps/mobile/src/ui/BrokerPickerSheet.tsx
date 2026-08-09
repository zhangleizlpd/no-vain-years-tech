import { useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import { AlphaIndex } from './AlphaIndex';
import { SearchBar } from './SearchBar';

// 券商选择底部 sheet（012 页 C）。RN Modal slide 弹层（非全屏，顶部留 scrim 条点击关闭）：
// drag handle + 标题「选择券商」+ 返回 + 内嵌 SearchBar（按名 / 简拼过滤）+ 分组列表
// （按 initial 分组、A-Z 索引跳转）+ 搜索无结果空态。logo = 名首字 brand-soft chip 占位
// （真品牌 logo 后续 FR-M07）。搜索 query 为 sheet 内部 UI 态。无「开户」按钮 / 无能力标签
// （mockup DO-NOT）。presentational 无单测 —— 走 Playwright e2e。

export interface BrokerPickerItem {
  code: string;
  name: string;
  /** 分组首字母 A-Z（来自 pinyinInitials 首字母大写）。 */
  initial: string;
  /** 简拼搜索串（小写匹配，如 'htzq'）。 */
  pinyin: string;
}

export interface BrokerPickerSheetProps {
  visible: boolean;
  items: BrokerPickerItem[];
  onSelect: (code: string) => void;
  onClose: () => void;
}

interface BrokerGroup {
  letter: string;
  items: BrokerPickerItem[];
}

/** 按 query 过滤（名含 / 简拼含）后按 initial 分组、组内按名排序（纯展示派生）。 */
function groupItems(items: BrokerPickerItem[], query: string): BrokerGroup[] {
  const trimmed = query.trim();
  const q = trimmed.toLowerCase();
  const filtered = trimmed
    ? items.filter((b) => b.name.includes(trimmed) || b.pinyin.includes(q))
    : items;
  const map = new Map<string, BrokerPickerItem[]>();
  for (const b of filtered) {
    const arr = map.get(b.initial) ?? [];
    arr.push(b);
    map.set(b.initial, arr);
  }
  return [...map.keys()].sort().map((letter) => ({
    letter,
    items: [...(map.get(letter) ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh')),
  }));
}

function LogoChip({ name }: { name: string }) {
  return (
    <View
      className="bg-brand-soft rounded-sm items-center justify-center"
      style={{ width: 32, height: 32 }}
    >
      <Text className="text-sm font-bold text-brand-500">{name.slice(0, 1)}</Text>
    </View>
  );
}

export function BrokerPickerSheet({ visible, items, onSelect, onClose }: BrokerPickerSheetProps) {
  const [query, setQuery] = useState('');
  const scrollRef = useRef<ScrollView>(null);
  const offsets = useRef<Record<string, number>>({});

  const groups = useMemo(() => groupItems(items, query), [items, query]);
  const letters = groups.map((g) => g.letter);

  const jumpTo = (letter: string) => {
    const y = offsets.current[letter];
    if (y != null) scrollRef.current?.scrollTo({ y, animated: true });
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 bg-modal-overlay">
        <Pressable onPress={onClose} accessibilityLabel="关闭" style={{ height: 40 }} />
        <View
          className="flex-1 bg-surface shadow-sheet"
          style={{ borderTopLeftRadius: 16, borderTopRightRadius: 16 }}
        >
          {/* drag handle */}
          <View className="items-center pt-sm">
            <View className="rounded-full bg-line-strong" style={{ width: 38, height: 5 }} />
          </View>

          {/* header: ‹ 返回 + 标题居中 */}
          <View className="flex-row items-center px-sm pt-sm">
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="返回"
              style={{ width: 56 }}
            >
              <Text className="text-2xl text-brand-500">‹</Text>
            </Pressable>
            <Text className="flex-1 text-base font-semibold text-ink text-center">选择券商</Text>
            <View style={{ width: 56 }} />
          </View>

          {/* 搜索 */}
          <View className="px-md py-sm">
            <SearchBar
              value={query}
              onChangeText={setQuery}
              onClear={() => setQuery('')}
              placeholder="搜索券商名称 / 简拼"
            />
          </View>

          {/* 列表 / 空态 */}
          {groups.length === 0 ? (
            <View className="flex-1 items-center justify-center gap-xs px-xl">
              <Text className="text-base font-medium text-ink">未找到相关券商</Text>
              <Text className="text-sm text-ink-subtle">试试其他名称或简拼</Text>
            </View>
          ) : (
            <View className="flex-1">
              <ScrollView
                ref={scrollRef}
                className="flex-1"
                contentContainerClassName="pb-lg pr-lg"
              >
                {groups.map((group) => (
                  <View
                    key={group.letter}
                    onLayout={(e) => {
                      offsets.current[group.letter] = e.nativeEvent.layout.y;
                    }}
                  >
                    <Text className="text-xs font-semibold text-ink-subtle bg-surface-alt px-lg py-xs">
                      {group.letter}
                    </Text>
                    {group.items.map((item) => (
                      <Pressable
                        key={item.code}
                        onPress={() => onSelect(item.code)}
                        accessibilityRole="button"
                        accessibilityLabel={item.name}
                        className="flex-row items-center gap-md px-lg border-b border-line-soft"
                        style={{ minHeight: 52 }}
                      >
                        <LogoChip name={item.name} />
                        <Text className="text-base text-ink">{item.name}</Text>
                      </Pressable>
                    ))}
                  </View>
                ))}
              </ScrollView>
              <AlphaIndex letters={letters} onJump={jumpTo} />
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}
