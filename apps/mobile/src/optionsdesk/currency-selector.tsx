// 085 T009 — 展示币种选择器（收起态 + 右对齐三档浮层；FR-001 / FR-013，plan §D8 / mockup 帧 ⑤）。
//
// 🚨 位置：嵌在「同步于 …」行**右侧**（mockup `margin-left: auto` ⇒ 这里 `ml-auto`），不另占一行。
//    实测该行文本实占 156px / 余量 234px 放得下；「参考汇率」行余量仅 83px、列头行高 31px 都放不下。
//    省掉一整条控件行（57px），列表可用高度 542 → 599px。
// 🚨 **选中的币种不住这里**：它由屏组件 `trading-account-screen.tsx` 持有（plan §D7）——
//    本组件只持有「浮层展开与否」。把币种存进来，切分段 positions↔orders 就会连币种一起丢
//    （`trading-account-screen.tsx` 那两段是条件渲染）。
// 📌 浮层用 RN 内置 `Pressable` + 绝对定位 `View`，🚫 引入新组件库。
// 🚫 用 `<Modal transparent>`：那是给「要盖住底部 Tab 栏」的场景（playbook §12.2），本屏是
//    雷达 push 出来的二级屏，同级 absolute 够得着。
// 🚨 选中态**双通道编码**（底色 + 勾）是刻意的：`react-native-web` 不认 `accessibilityState`，
//    e2e 只能靠样式 / 勾自比较断选中态（同 `radar-market-tabs.tsx` / `trading-account-segments.tsx`
//    的头注释），删一条通道断言就会红。
// 📌 收起态箭头复用 083 组头那套**几何符号**，🚫 emoji。
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { DISPLAY_CURRENCIES, type DisplayCurrency } from './display-currency.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.tradingAccountPositions.displayCurrency;
const TEST_ID = 'optionsdesk-trading-account-currency';

/** 收起态箭头与选中勾（几何符号，非 emoji；箭头同 083 组头的 `CARET.expanded`）。 */
const CARET = '▾';
const TICK = '✓';

export interface CurrencySelectorProps {
  /** 当前展示币种（收起态即显示它，FR-013）。 */
  current: DisplayCurrency;
  onSelect: (currency: DisplayCurrency) => void;
}

export function CurrencySelector({ current, onSelect }: CurrencySelectorProps) {
  const [open, setOpen] = useState(false);

  return (
    <View className="ml-auto">
      <Pressable
        onPress={() => setOpen((prev) => !prev)}
        accessibilityRole="button"
        accessibilityLabel={COPY.selector(COPY.option[current])}
        accessibilityState={{ expanded: open }}
        testID={TEST_ID}
        className="flex-row items-center gap-1 rounded-sm border border-line bg-surface px-2 py-0.5"
      >
        <Text className="text-xs font-semibold text-ink" testID={`${TEST_ID}-current`}>
          {COPY.option[current]}
        </Text>
        <Text className="text-xs text-ink-muted">{CARET}</Text>
      </Pressable>
      {open ? (
        // 右对齐浮于选择器下方，不推挤列表内容（mockup 帧 ⑤）。
        <View
          className="absolute right-0 top-full z-10 mt-1 min-w-[104px] rounded-md border border-line bg-surface p-1 shadow-card"
          testID={`${TEST_ID}-menu`}
        >
          {DISPLAY_CURRENCIES.map((currency) => (
            <CurrencyOption
              key={currency}
              currency={currency}
              selected={currency === current}
              onPress={() => {
                onSelect(currency);
                setOpen(false);
              }}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

interface CurrencyOptionProps {
  currency: DisplayCurrency;
  selected: boolean;
  onPress: () => void;
}

function CurrencyOption({ currency, selected, onPress }: CurrencyOptionProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={COPY.option[currency]}
      testID={`${TEST_ID}-option-${currency}`}
      className={`flex-row items-center justify-between gap-2.5 rounded-sm px-2 py-1.5 ${
        selected ? 'bg-surface-sunken' : ''
      }`}
    >
      <Text className={selected ? 'text-sm font-semibold text-ink' : 'text-sm text-ink'}>
        {COPY.option[currency]}
      </Text>
      {selected ? (
        <Text className="text-xs text-brand-500" testID={`${TEST_ID}-tick`}>
          {TICK}
        </Text>
      ) : null}
    </Pressable>
  );
}
