// 065 T10 — 雷达市场页签（FR-001 / FR-016, plan D7）。
//
// 视觉体例**逐字抄同目录的 `leg-picker-tabs.tsx`**（049 T006 视觉换稿 A 定的那套）：等分格 +
// 选中格 `surface-sunken` 底 + 底部 3px×28 短横条，行高约 40px。
//
// 🚨 选中态**双重编码**（底色 + 横条）是刻意的：`react-native-web` 不认 `accessibilityState`，
//    e2e 只能靠样式自比较断选中态，两条独立通道让那条断言删一半就会红。别为了「简洁」砍。
// 📌 **不上提 `~/ui`**：仓内已登记「统一这几家等分 Tab（本组件 / `leg-picker-tabs` /
//    `chain-report-metric-tabs` / `portfolio/detail-tabs`）是独立重构」，本片不新增 consumer。
// 🚫 **MUST NOT import `~/alert/alert-tab-row`** —— `apps/mobile/src/optionsdesk/*` 今天只
//    import `~/core` `~/format` `~/theme` `~/ui`，全仓跨 feature 边只有 infra/shell 三条，
//    从无 sibling 的展示组件；且它没有 `testID`，而 `react-native-web` 丢弃
//    `accessibilityState` ⇒ 选中态断言不了、反向断言还是**假绿**。
//
// 🚨 **市场集合取 `RADAR_MARKETS`（从契约派生），MUST NOT 在此写 `['us', 'hk']`** ——
//    理由见 `radar.rules.ts` 该常量的注释（FR-015 双双漏报）。
//
// ── FR-016 小圆点 ────────────────────────────────────────────────────────────
// 🚫 **不带数量**：市场页签上的数字会被读成「该市场有 N 只锚」而不是「N 只可动」。
// 🚨 圆点位**恒占位、只变色**，有点时才挂 `testID`：占位让切页签时标签不横跳，条件 `testID`
//    让 e2e 能同时断「出现」与「不出现」（若改成条件渲染整个圆点，标签会左右跳 6px；若改成
//    恒挂 testID，反向断言就永远绿）。
import { Pressable, Text, View } from 'react-native';

import { RADAR_MARKETS, type RadarMarket } from './radar.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const LABELS = OPTIONSDESK_COPY.radar.marketTabs;

export interface RadarMarketTabsProps {
  /** 当前作用域。 */
  market: RadarMarket;
  onSelect: (market: RadarMarket) => void;
  /**
   * 有「可动锚」的市场集合（server `marketCounts` 里 `actionableTotal > 0` 的那些）。
   * 当前页签自己**不渲**圆点 —— 它的内容就在眼前，圆点是给**别的**页签用的信号。
   */
  actionableMarkets: readonly string[];
}

export function RadarMarketTabs({ market, onSelect, actionableMarkets }: RadarMarketTabsProps) {
  return (
    <View className="bg-surface" testID="optionsdesk-radar-market-tabs">
      <View className="flex-row items-center border-b border-line">
        {RADAR_MARKETS.map((m) => {
          const on = m === market;
          const dot = !on && actionableMarkets.includes(m);
          return (
            <Pressable
              key={m}
              onPress={() => onSelect(m)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={LABELS[m]}
              testID={`optionsdesk-radar-market-tab-${m}`}
              className={`flex-1 items-center py-sm ${on ? 'bg-surface-sunken' : ''}`}
            >
              <View className="flex-row items-center gap-1">
                <Text className={on ? 'text-xs font-semibold text-ink' : 'text-xs text-ink-muted'}>
                  {LABELS[m]}
                </Text>
                <View
                  className={`h-1.5 w-1.5 rounded-full ${dot ? 'bg-brand-500' : ''}`}
                  testID={dot ? `optionsdesk-radar-market-dot-${m}` : undefined}
                />
              </View>
              {/* 选中短横条；未选用**等高透明占位**，否则选中会把行撑高、切页签时整栏跳一下。 */}
              <View className={`mt-[3px] h-[3px] w-7 ${on ? 'bg-brand-500' : ''}`} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
