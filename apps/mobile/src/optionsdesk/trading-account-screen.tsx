// 081 T003 / T004 — 交易账户页骨架（plan §D1 / §D7 / §D8 / §D9 / §D10）。
//
// 自上而下：市场页签（复用雷达 `RadarMarketTabs`）→ 胶囊分段 → 持仓分段（083）/ 下沉底上的「建设中」占位卡。
//
// 🚨 **订单 / 报表分段零数据面**（081 FR-008）：这两段不发请求、没有 loading / error 分支 ——
//    「服务端不可达时骨架照常完整」靠的是结构上根本不发请求，不是靠兜住失败。
//    持仓分段自 083 起接数据面（`TradingAccountPositions`，083 plan §D14）。
// 🚨 选择状态走 `useTradingAccountStore`（进程内），🚫 不用组件 `useState`：push 屏返回即卸载，
//    `useState` 会让 FR-004「同次使用内记住」失效（plan §D5）。
// 🚨 **085 的展示币种恰恰相反，蓄意用屏组件 `useState`**（085 plan §D7）：085 FR-005 要的是
//    「离开交易账户页再进入即复原」——屏级 `useState` 的生命周期恰好等于这个语义（083 e2e 双臂
//    实证：进详情再返回本屏未卸载 ⇒ 保留；返回雷达再进本屏卸载 ⇒ 复原）。放进上面那个 store
//    会让「离开再进入」仍保留上次币种，直接违反 085 FR-005 / SC-005。两者方向不同不是笔误。
// 🚨 币种状态**必须放这里、不能放 `TradingAccountPositions`**：下面 positions↔orders 是条件渲染，
//    放列表组件里切个分段就重置。形状是**每市场一格**（`Record<RadarMarket, DisplayCurrency>`）⇒
//    「两个页签各记各的」由形状本身保证（085 FR-005）。
// 📌 `actionableMarkets={[]}`：本页没有「可动锚」信号，市场页签不渲小圆点（FR-002）。
// 📌 占位只随分段变、与市场无关（plan §D9）；图形块纯 View 几何，不画 SVG、不用 emoji（plan §D9）。
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { Stack } from 'expo-router';

import { SafeAreaView } from '~/ui';
import {
  initialCurrencyState,
  selectCurrency,
  type DisplayCurrency,
  type DisplayCurrencyByMarket,
} from './display-currency.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { RadarMarketTabs } from './radar-market-tabs';
import { TradingAccountPositions } from './trading-account-positions';
import { TradingAccountSegments } from './trading-account-segments';
import { useTradingAccountStore } from './trading-account-store';
import type { TradingAccountSegment } from './trading-account.rules';

const COPY = OPTIONSDESK_COPY.tradingAccount;
const NO_ACTIONABLE_MARKETS: readonly string[] = [];

/** 仍为「建设中」占位的分段。 */
type PlaceholderSegment = Exclude<TradingAccountSegment, 'positions'>;

export function TradingAccountScreen() {
  const market = useTradingAccountStore((s) => s.market);
  const segment = useTradingAccountStore((s) => s.segment);
  const selectMarket = useTradingAccountStore((s) => s.selectMarket);
  const selectSegment = useTradingAccountStore((s) => s.selectSegment);
  // 085：每市场页签一格；切页签只**读**另一格（下面 `currencyByMarket[market]`），不写任何格。
  const [currencyByMarket, setCurrencyByMarket] =
    useState<DisplayCurrencyByMarket>(initialCurrencyState);
  const onSelectCurrency = useCallback(
    (currency: DisplayCurrency) => {
      setCurrencyByMarket((prev) => selectCurrency(prev, market, currency));
    },
    [market],
  );

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      <Stack.Screen options={{ title: COPY.title }} />
      <View className="flex-1 bg-surface-sunken" testID="optionsdesk-trading-account-screen">
        <RadarMarketTabs
          market={market}
          onSelect={selectMarket}
          actionableMarkets={NO_ACTIONABLE_MARKETS}
          testIdPrefix="optionsdesk-trading-account-market"
        />
        <TradingAccountSegments segment={segment} onSelect={selectSegment} />
        {segment === 'positions' ? (
          <TradingAccountPositions
            market={market}
            displayCurrency={currencyByMarket[market]}
            onSelectCurrency={onSelectCurrency}
          />
        ) : (
          <View className="px-md py-lg">
            <PlaceholderCard segment={segment} />
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

function PlaceholderCard({ segment }: { segment: PlaceholderSegment }) {
  const { title, body } = COPY.placeholder[segment];
  return (
    <View className="rounded-md border border-line bg-surface">
      <View className="items-center gap-2.5 px-lg py-xl">
        <View className="h-12 w-12 rounded-sm bg-brand-soft">
          <View className="flex-1 items-center justify-center">
            <PlaceholderGlyph segment={segment} />
          </View>
        </View>
        <Text className="text-lg font-semibold text-ink">{title}</Text>
        <Text className="max-w-[280px] text-center text-sm text-ink-muted">{body}</Text>
      </View>
    </View>
  );
}

/** 订单 = 三条横线；报表 = 三根高低柱（mockup 2b / 3 / 4）。 */
const LINE_WIDTHS: Record<Exclude<PlaceholderSegment, 'reports'>, readonly string[]> = {
  orders: ['w-3.5', 'w-[22px]', 'w-[22px]'],
};
const BAR_HEIGHTS: readonly string[] = ['h-4', 'h-[22px]', 'h-2.5'];

function PlaceholderGlyph({ segment }: { segment: PlaceholderSegment }) {
  if (segment === 'reports') {
    return (
      <View className="flex-row items-end gap-1">
        {BAR_HEIGHTS.map((h, i) => (
          <View key={i} className={`w-1.5 ${h} bg-brand-500`} />
        ))}
      </View>
    );
  }
  return (
    <View className="items-center gap-1">
      {LINE_WIDTHS[segment].map((w, i) => (
        <View key={i} className={`h-[3px] ${w} bg-brand-500`} />
      ))}
    </View>
  );
}
