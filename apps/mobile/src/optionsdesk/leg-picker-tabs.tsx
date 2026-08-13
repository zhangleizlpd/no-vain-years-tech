// 047 T033 — 意图三 Tab 栏（FR-002/017/020, plan D-UI-1）。
// 049 T006 — 视觉换稿 A（049 FR-008/010, plan D-TAB-1）：等分三格 + 选中格 `surface-sunken` 底
//    + 底部 3px×28 短横条，行高约 40px（栈高预算 plan D-TAB-4 就按这个数算）。
//    🚨 选中态**双重编码**（底色 + 横条）是刻意的：`react-native-web` 不认 `accessibilityState`，
//       e2e 只能靠样式自比较断选中态，两条独立通道让那条断言删一半就会红。别为了「简洁」砍。
//    📌 不上提 `~/ui`（plan D-TAB-3）：仓内 `portfolio/detail-tabs.tsx` 已判「等分固定 Tab ≠
//       `~/ui` 的横滑 pill Tab」，本片不新增 consumer ⇒ 统一三家等分 Tab 是独立重构，登记为债。
//
// 🚨 **三个 Tab 共用同一个 `SectionList`** —— 本组件只上报「选了哪个」，切 Tab 的效果全部落在
//    `section.data` 上（`use-leg-table.ts` 里换）。**MUST NOT 每 Tab 挂一个列表实例**：那会同时
//    丢掉滚动位置、重跑虚拟化、并让三个 Tab 的 `asOf` 有机会不一致。
//
// 🚨 **三个 Tab 恒可进入、恒不置灰**（FR-020 空 Tab / FR-017 未选水位两处都要求）——
//    本文件里没有任何 `disabled`，也没有任何按条件不渲染某个 Tab 的分支。空是空态文案的事，
//    不是禁用态的事。
//
// 🚨 **就地注明已不在本组件内**（051 FR-010a）—— 它们原本渲在 Tab 行下方、随 sticky 常驻区
//    每屏占一份高度。051 起与两个门槛计数、空态解释同落**腿列表之后的非常驻区**
//    （`renderSectionFooter`），常驻区高度只降不升（SC-009）。判据仍由 `legPickerNotices` 给。
//
// ── 052 T012 检索条件入口（FR-012, mockup `052-criteria-sheet.dc.html` 帧 A1/A4）──────
// 🚨 **sticky 栈一层不加** —— 六个控件住进 bottom-sheet 抽屉，这里只在 Tab 行右端多一个
//    36px 入口。常驻区高度只降不升那条（051 SC-009）因此仍然成立。
// 📌 徽标数的是**已覆盖维度数**（服务端三态的回执），不是被排除的条数 —— 后者是计数行的事。
import { Pressable, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { colors } from '~/theme';
import { LEG_PICKER_TABS, legTabLabel, type LegPickerTab } from './leg-picker.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const CRITERIA_COPY = OPTIONSDESK_COPY.legPicker.criteria;

export interface LegPickerTabsProps {
  tab: LegPickerTab;
  onSelect: (tab: LegPickerTab) => void;
  /**
   * 检索条件抽屉入口。`null` ⇒ **不渲**该入口 —— 表还没到手 / 链未就绪时六维全 `null`，
   * 开一个全「不限」的抽屉只会让人对着一堆空框点「搜」。
   */
  onOpenCriteria: (() => void) | null;
  /** 已覆盖维度数（0 ⇒ 无徽标）。 */
  criteriaCount: number;
}

export function LegPickerTabs({
  tab,
  onSelect,
  onOpenCriteria,
  criteriaCount,
}: LegPickerTabsProps) {
  return (
    <View className="bg-surface" testID="optionsdesk-detail-leg-tabs">
      <View className="flex-row items-center border-b border-line">
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
              className={`flex-1 items-center py-sm ${on ? 'bg-surface-sunken' : ''}`}
            >
              <Text className={on ? 'text-xs font-semibold text-ink' : 'text-xs text-ink-muted'}>
                {legTabLabel(t)}
              </Text>
              {/* 选中短横条（3px×28 `brand-500`）；未选用**等高透明占位**，否则选中会把行撑高、
                  切 Tab 时整个 sticky 栈跳一下（手法抄 `portfolio/detail-tabs.tsx`）。 */}
              <View className={`mt-[3px] h-[3px] w-7 ${on ? 'bg-brand-500' : ''}`} />
            </Pressable>
          );
        })}
        {onOpenCriteria === null ? null : (
          <Pressable
            onPress={onOpenCriteria}
            // 视觉 36px 内嵌在 40px 的 Tab 行里；`hitSlop` 把有效热区补到 44 以上。
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={
              criteriaCount > 0
                ? `${CRITERIA_COPY.entry} · ${CRITERIA_COPY.entryBadge(criteriaCount)}`
                : CRITERIA_COPY.entry
            }
            testID="optionsdesk-detail-criteria-entry"
            className="h-9 w-9 items-center justify-center"
          >
            <SlidersGlyph active={criteriaCount > 0} />
            {criteriaCount > 0 ? (
              <View
                className="absolute right-0.5 top-1 h-3.5 min-w-3.5 items-center justify-center rounded-full bg-brand-500 px-0.5"
                testID="optionsdesk-detail-criteria-badge"
              >
                <Text className="text-[9px] font-semibold text-white">{criteriaCount}</Text>
              </View>
            ) : null}
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** 三档滑杆 —— 「有几个旋钮可调」这件事本身就是入口的语义（与 ⚙「设置」蓄意不同形）。 */
function SlidersGlyph({ active }: { active: boolean }) {
  const stroke = active ? colors.brand[500] : colors.ink.muted;
  return (
    <Svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={1.8}
      strokeLinecap="round"
    >
      <Path d="M3 7h13M19 7h2M3 17h5M11 17h10M3 12h9M15 12h6" />
      <Circle cx={17.5} cy={7} r={1.8} />
      <Circle cx={9.5} cy={17} r={1.8} />
      <Circle cx={13.5} cy={12} r={1.8} />
    </Svg>
  );
}
