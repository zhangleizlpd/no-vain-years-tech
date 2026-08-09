// 047 T033 — 意图三 Tab 栏（FR-002/017/020, plan D-UI-1）。
//
// 🚨 **三个 Tab 共用同一个 `SectionList`** —— 本组件只上报「选了哪个」，切 Tab 的效果全部落在
//    `section.data` 上（`use-leg-table.ts` 里换）。**MUST NOT 每 Tab 挂一个列表实例**：那会同时
//    丢掉滚动位置、重跑虚拟化、并让三个 Tab 的 `asOf` 有机会不一致。
//
// 🚨 **三个 Tab 恒可进入、恒不置灰**（FR-020 空 Tab / FR-017 未选水位两处都要求）——
//    本文件里没有任何 `disabled`，也没有任何按条件不渲染某个 Tab 的分支。空是空态文案的事，
//    不是禁用态的事。
//
// 📌 未选水位的两条就地注明由 `legPickerNotices` 给（判据在 server，客户端负责把它说出来），
//    渲在 Tab 行下方 —— 与 Tab 同属 sticky section header，滚到哪都跟着。
import { Pressable, Text, View } from 'react-native';

import {
  LEG_PICKER_TABS,
  legTabLabel,
  type LegPickerNotice,
  type LegPickerTab,
} from './leg-picker.rules';

export interface LegPickerTabsProps {
  tab: LegPickerTab;
  onSelect: (tab: LegPickerTab) => void;
  /** 就地注明（未选水位时 1~2 条；已选时空数组）。 */
  notices: readonly LegPickerNotice[];
}

export function LegPickerTabs({ tab, onSelect, notices }: LegPickerTabsProps) {
  return (
    <View className="bg-surface" testID="optionsdesk-detail-leg-tabs">
      <View className="flex-row gap-md border-b border-line px-md">
        {LEG_PICKER_TABS.map((t) => {
          const on = t === tab;
          return (
            <Pressable
              key={t}
              onPress={() => onSelect(t)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={legTabLabel(t)}
              testID={`optionsdesk-detail-leg-tab-${t}`}
              className={`border-b-2 py-xs ${on ? 'border-brand-500' : 'border-transparent'}`}
            >
              <Text className={on ? 'text-xs font-semibold text-ink' : 'text-xs text-ink-muted'}>
                {legTabLabel(t)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {notices.map((notice) => (
        // 数据缺口 / 口径说明体系：`surface-sunken` 底，**与红标体系区隔** —— 它不是错误。
        <View
          key={notice.key}
          className="border-b border-line-soft bg-surface-sunken px-md py-xs"
          testID={`optionsdesk-detail-leg-notice-${notice.key}`}
        >
          {/* ⚠️ 降级状态字禁用最淡档 `text-ink-subtle`（白底实测 2.85:1，不达标）。 */}
          <Text className="text-[10px] text-ink-muted">{notice.text}</Text>
        </View>
      ))}
    </View>
  );
}
