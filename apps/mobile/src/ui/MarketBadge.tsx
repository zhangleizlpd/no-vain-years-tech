// GOLDEN SAMPLE — UI 列表 / badge（组件 + *.rules.ts 纯函数分离）。索引见 docs/conventions/golden-sample-registry.md。
import { Text, View } from 'react-native';

import { marketBadgeLabel } from './market-badge.rules';

// 市场小标签（mockup MarketBadge：中性描边小块；自 021 target-select 提升共享，
// 013 自选行 / 021 屏4 共用）。标签文案纯函数见 market-badge.rules.ts（vitest）。

export interface MarketBadgeProps {
  code: string;
  /** 缺省 cn（A股按板块段判）；hk→港 / us→美。 */
  market?: string;
}

export function MarketBadge({ code, market = 'cn' }: MarketBadgeProps) {
  return (
    <View className="rounded-sm border border-line bg-surface-sunken px-xs">
      <Text className="text-xs font-semibold text-ink-muted">{marketBadgeLabel(code, market)}</Text>
    </View>
  );
}
