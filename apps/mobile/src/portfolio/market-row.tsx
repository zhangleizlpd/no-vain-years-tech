import { Text, View } from 'react-native';
import type { MarketItem } from '@nvy/api-client';

import { Switch } from '~/ui';
import { MARKET_COPY } from './market-copy';

export interface MarketRowProps {
  item: MarketItem;
  /** 该行 toggle 正在 in-flight（禁重复点）。 */
  busy?: boolean;
  onToggle: (marketCode: string, next: boolean) => void;
}

// 单市场行（011 US3/US6）：左 label `市场名（ISO）` + 右 Switch。海外行（v1Available=false）
// 恒 disabled 置灰 + 「即将支持」副文案 + 点击零副作用（FR-M04）。a11y per FR-M09
// （Switch 自带 switch role + checked/disabled；本行 label numberOfLines=1 防长名溢出）。
export function MarketRow({ item, busy, onToggle }: MarketRowProps) {
  const disabled = !item.v1Available;
  const label = `${item.displayName}（${item.isoCurrency}）`;
  return (
    <View className="flex-row items-center px-md" style={{ minHeight: 52 }}>
      <View className="flex-1">
        <Text className={`text-base ${disabled ? 'text-ink-muted' : 'text-ink'}`} numberOfLines={1}>
          {label}
        </Text>
        {disabled ? (
          <Text className="text-xs text-ink-subtle mt-0.5">{MARKET_COPY.comingSoon}</Text>
        ) : null}
      </View>
      <Switch
        value={item.active}
        disabled={disabled || busy}
        onValueChange={(next) => onToggle(item.marketCode, next)}
        accessibilityLabel={label}
      />
    </View>
  );
}
