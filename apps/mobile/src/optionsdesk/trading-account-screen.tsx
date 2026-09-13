// 081 T003 — 交易账户页骨架（plan §D1 / §D7 / §D10）。
//
// 自上而下：市场页签（复用雷达 `RadarMarketTabs`）→ 分段 + 占位（T004 接入）。
//
// 🚨 **FR-008 零数据面**：本屏 MUST NOT import `@nvy/api-client`，也没有 loading / error 分支
//    —— 「服务端不可达时骨架照常完整」靠的是结构上根本不发请求，不是靠兜住失败。
// 🚨 选择状态走 `useTradingAccountStore`（进程内），🚫 不用组件 `useState`：push 屏返回即卸载，
//    `useState` 会让 FR-004「同次使用内记住」失效（plan §D5）。
// 📌 `actionableMarkets={[]}`：本页没有「可动锚」信号，市场页签不渲小圆点（FR-002）。
import { View } from 'react-native';
import { Stack } from 'expo-router';

import { SafeAreaView } from '~/ui';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { RadarMarketTabs } from './radar-market-tabs';
import { useTradingAccountStore } from './trading-account-store';

const COPY = OPTIONSDESK_COPY.tradingAccount;
const NO_ACTIONABLE_MARKETS: readonly string[] = [];

export function TradingAccountScreen() {
  const market = useTradingAccountStore((s) => s.market);
  const selectMarket = useTradingAccountStore((s) => s.selectMarket);

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
      </View>
    </SafeAreaView>
  );
}
