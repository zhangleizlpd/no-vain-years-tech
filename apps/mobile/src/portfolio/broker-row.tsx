import { Text, View } from 'react-native';
import type { BrokerAccountItem } from '@nvy/api-client';

import { maskClientNo } from '~/format/broker';
import { SwipeRow } from '~/ui';
import { BROKER_COPY } from './broker-copy';

// 券商账户列表行（012 US4/US6）：两变体。
//  - 默认账户（isDefault）：◉ 灰 chip + 「默认账户」+ 「系统默认」tag + 副文案；**无左滑删除**（FR-M01）。
//  - 已绑券商：名首字 brand-soft chip（logoAsset V1 为 null，回退占位，FR-M07）+ 券商名 +
//    「已绑定」tag + **脱敏客户号**（前 4 后 4，maskClientNo）+ 左滑出「删除」（FR-M02/M06）。
// 视觉复用 ~/theme token（0 hex，SC-M06）；chip 占位逻辑与 ~/ui BrokerPickerSheet LogoChip 一致。

export interface BrokerRowProps {
  item: BrokerAccountItem;
  /** 已绑行左滑删除回调（默认账户不传 → 无删除入口，FR-M01）。 */
  onRequestDelete?: (item: BrokerAccountItem) => void;
}

function Chip({ isDefault, brokerName }: { isDefault: boolean; brokerName: string }) {
  return (
    <View
      className={`rounded-sm items-center justify-center ${
        isDefault ? 'bg-surface-sunken' : 'bg-brand-soft'
      }`}
      style={{ width: 40, height: 40 }}
    >
      <Text className={`text-base font-bold ${isDefault ? 'text-ink-subtle' : 'text-brand-500'}`}>
        {isDefault ? '◉' : brokerName.slice(0, 1)}
      </Text>
    </View>
  );
}

function Tag({ label, bound }: { label: string; bound: boolean }) {
  return (
    <View className={`rounded-sm px-xs ${bound ? 'bg-ok-soft' : 'bg-surface-sunken'}`}>
      <Text className={`text-xs ${bound ? 'text-ok' : 'text-ink-subtle'}`}>{label}</Text>
    </View>
  );
}

function RowContent({ item }: { item: BrokerAccountItem }) {
  const subtitle = item.isDefault ? BROKER_COPY.list.defaultSubtitle : maskClientNo(item.clientNo);
  return (
    <View className="flex-row items-center gap-md px-md" style={{ minHeight: 64 }}>
      <Chip isDefault={item.isDefault} brokerName={item.brokerName} />
      <View className="flex-1">
        <View className="flex-row items-center gap-xs">
          <Text className="text-base font-medium text-ink" numberOfLines={1}>
            {item.brokerName}
          </Text>
          <Tag
            label={item.isDefault ? BROKER_COPY.list.defaultTag : BROKER_COPY.list.boundTag}
            bound={!item.isDefault}
          />
        </View>
        {subtitle ? (
          <Text className="text-sm text-ink-muted mt-0.5" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function BrokerRow({ item, onRequestDelete }: BrokerRowProps) {
  const a11y = item.isDefault
    ? `${item.brokerName} ${BROKER_COPY.list.defaultTag}`
    : `${item.brokerName} ${BROKER_COPY.list.boundTag} ${maskClientNo(item.clientNo)}`;

  // 默认账户：纯展示行，无左滑删除入口（FR-M01）。
  if (item.isDefault) {
    return (
      <View accessibilityLabel={a11y}>
        <RowContent item={item} />
      </View>
    );
  }

  // 已绑券商：左滑揭示删除块 → 点击交上层二次确认（FR-M06）。
  return (
    <SwipeRow actionLabel={BROKER_COPY.list.delete} onAction={() => onRequestDelete?.(item)}>
      <View accessibilityLabel={a11y}>
        <RowContent item={item} />
      </View>
    </SwipeRow>
  );
}
