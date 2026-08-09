import { Pressable, ScrollView, Text, View } from 'react-native';

// 自选分组横滑 Tab 条（013 屏1 主列表）。水平可滚动 pill tab + 末尾固定「管理」(☰) 入口。
// accessibilityRole='tab' + selected 态（FR-M09 a11y；Playwright 用 getByRole('tab') 收窄，
// per memory playwright_expo_stacked_screen_locator_collision）。受控（activeId + 回调）。
// presentational 无单测 —— 渲染/交互走 Playwright e2e（per mono vitest 测试分层）。

export interface TabItem {
  id: string;
  name: string;
}

export interface TabsProps {
  tabs: TabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  /** 末尾 ☰ 管理入口（进分组管理屏）。省略则不渲染。 */
  onManage?: () => void;
  /** 管理入口 a11y 文案（默认「管理分组」）。 */
  manageLabel?: string;
}

export function Tabs({ tabs, activeId, onSelect, onManage, manageLabel = '管理分组' }: TabsProps) {
  return (
    <View className="flex-row items-stretch bg-surface border-b border-line-soft">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="items-center gap-xs px-sm py-sm"
      >
        {tabs.map((t) => {
          const on = t.id === activeId;
          return (
            <Pressable
              key={t.id}
              onPress={() => onSelect(t.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={t.name}
              className={`rounded-full px-md py-xs ${on ? 'bg-surface-sunken' : ''}`}
            >
              <Text
                className={
                  on ? 'text-sm font-semibold text-ink' : 'text-sm font-medium text-ink-muted'
                }
              >
                {t.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {onManage ? (
        <Pressable
          onPress={onManage}
          accessibilityRole="button"
          accessibilityLabel={manageLabel}
          className="w-11 items-center justify-center border-l border-line-soft"
        >
          <Text className="text-lg text-ink-muted">☰</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
