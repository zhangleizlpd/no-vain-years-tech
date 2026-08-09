import { Pressable, Text, View } from 'react-native';

import { STOCK_DETAIL_COPY } from './stock-detail-copy';

// 详情固定 3-Tab 分段控件（014 US3 / FR-M01）。富途式：紧贴 nav 下、在报价上方，默认图表。
// 形态不符 013 ~/ui Tabs（横滑 pill + 管理入口）→ 本地建，不污染 ~/ui（D6）。
// accessibilityRole='tab'（Playwright getByRole('tab') 收窄）；选中 surface-sunken 底 + brand 下划线。
// presentational 无单测 —— 渲染/交互走 Playwright e2e（per mono 测试分层）。

export type DetailTab = 'chart' | 'analysis' | 'company';

const TABS: { id: DetailTab; name: string }[] = [
  { id: 'chart', name: STOCK_DETAIL_COPY.tabs.chart },
  { id: 'analysis', name: STOCK_DETAIL_COPY.tabs.analysis },
  { id: 'company', name: STOCK_DETAIL_COPY.tabs.company },
];

export interface DetailTabsProps {
  active: DetailTab;
  onSelect: (tab: DetailTab) => void;
}

export function DetailTabs({ active, onSelect }: DetailTabsProps) {
  return (
    <View className="flex-row bg-surface border-b border-line-soft">
      {TABS.map((t) => {
        const on = t.id === active;
        return (
          <Pressable
            key={t.id}
            onPress={() => onSelect(t.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={t.name}
            className={`flex-1 items-center py-sm ${on ? 'bg-surface-sunken' : ''}`}
          >
            <Text
              className={
                on ? 'text-sm font-semibold text-ink' : 'text-sm font-medium text-ink-muted'
              }
            >
              {t.name}
            </Text>
            {/* 选中下划线（4px brand）；未选用等高透明占位，避免行高跳动。 */}
            <View className={`mt-xs h-1 w-8 ${on ? 'bg-brand-500' : ''}`} />
          </Pressable>
        );
      })}
    </View>
  );
}
