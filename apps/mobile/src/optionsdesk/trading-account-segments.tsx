// 081 T004 — 交易账户页二级胶囊分段（持仓 / 订单 / 报表；FR-003 / FR-005, plan §D8, mockup 2b）。
//
// 形态：下沉底 `rounded-full` 轨道 + 三等分段；选中段浮起为 `surface` 底 + `shadow-card`。
//
// 🚨 选中态**双通道编码**（底色 + 字重）是刻意的：`react-native-web` 不认 `accessibilityState`，
//    e2e 只能靠样式自比较断选中态（同 `radar-market-tabs.tsx` 头注释），删一条通道断言就会红。
// 📌 **不上提 `~/ui`**：仓内已登记「统一等分 Tab 是独立重构」（`radar-market-tabs.tsx` 头注释）。
// 🚨 分段值域与顺序取 `TRADING_ACCOUNT_SEGMENTS`，MUST NOT 在此手写数组（FR-003 显示序单点）。
//    本组件只回调 `onSelect(segment)`，不碰市场 —— 切段不得带动市场页签（FR-005）。
import { Pressable, Text, View } from 'react-native';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { TRADING_ACCOUNT_SEGMENTS, type TradingAccountSegment } from './trading-account.rules';

const LABELS = OPTIONSDESK_COPY.tradingAccount.segments;

export interface TradingAccountSegmentsProps {
  segment: TradingAccountSegment;
  onSelect: (segment: TradingAccountSegment) => void;
}

export function TradingAccountSegments({ segment, onSelect }: TradingAccountSegmentsProps) {
  return (
    <View className="border-b border-line bg-surface">
      <View className="px-md py-2.5">
        <View className="flex-row rounded-full bg-surface-sunken p-[3px]">
          {TRADING_ACCOUNT_SEGMENTS.map((s) => {
            const on = s === segment;
            return (
              <Pressable
                key={s}
                onPress={() => onSelect(s)}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={LABELS[s]}
                testID={`optionsdesk-trading-account-segment-${s}`}
                className={`flex-1 rounded-full ${on ? 'bg-surface shadow-card' : ''}`}
              >
                <View className="items-center py-1.5">
                  <Text
                    className={on ? 'text-sm font-semibold text-ink' : 'text-sm text-ink-muted'}
                  >
                    {LABELS[s]}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}
