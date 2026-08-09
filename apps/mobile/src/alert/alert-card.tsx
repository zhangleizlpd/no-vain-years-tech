import { Pressable, Text, View } from 'react-native';
import type { AlertResponse } from '@nvy/api-client';

import { Switch } from '~/ui';
import { colors } from '~/theme';
import { ALERT_COPY, formatConditionLine } from './alert-copy';
import { AlertIcon } from './alert-icon';
import { CheckCircle } from './check-circle';

// 预警卡片（021 屏 1/5 / FR-M01，mockup AlertKit AlertCard 翻 RN）：条件摘要多行 +
// 信息行（频率短称 + 备注||未备注）+ 右侧 编辑笔/toggle（~/ui Switch 复用，0 新 toggle）。
// 无「组合预警」标签（统一预警模型）。多选态（FR-M05）：左 CheckCircle、隐藏右控件、
// 整卡 Pressable 翻选。presentational — 条件格式化纯函数 vitest，渲染走 Playwright。

const COPY = ALERT_COPY.card;

export interface AlertCardProps {
  alert: AlertResponse;
  /** toggle 启停（乐观更新由 T016 hook 承担）。 */
  onToggle?: (next: boolean) => void;
  /** 编辑笔 → 编辑页。 */
  onEdit?: () => void;
  /** 多选删除模式（FR-M05）。 */
  selectMode?: boolean;
  selected?: boolean;
  /** 多选态整卡点按翻选。 */
  onSelectToggle?: () => void;
  divider?: boolean;
}

export function AlertCard({
  alert,
  onToggle,
  onEdit,
  selectMode = false,
  selected = false,
  onSelectToggle,
  divider = true,
}: AlertCardProps) {
  const body = (
    <>
      {selectMode ? <CheckCircle checked={selected} /> : null}
      <View className="flex-1">
        {alert.conditions.map((c) => (
          <Text
            key={`${c.type}:${c.param ?? 0}`}
            className="text-base font-medium text-ink leading-6"
          >
            {formatConditionLine(c)}
          </Text>
        ))}
        <View className="flex-row gap-md mt-sm">
          <Text className="text-xs text-ink-subtle">
            {ALERT_COPY.frequency[alert.frequency].short}
          </Text>
          <Text className="text-xs text-ink-subtle" numberOfLines={1}>
            {alert.note ?? COPY.noNote}
          </Text>
        </View>
      </View>
      {!selectMode ? (
        <View className="flex-row items-center gap-md">
          <Pressable
            onPress={onEdit}
            accessibilityRole="button"
            accessibilityLabel={COPY.editA11y}
            hitSlop={8}
          >
            <AlertIcon name="pen" color={colors.ink.subtle} size={19} />
          </Pressable>
          <Switch
            value={alert.enabled}
            onValueChange={onToggle}
            accessibilityLabel={COPY.toggleA11y}
          />
        </View>
      ) : null}
    </>
  );

  const rowClass = `flex-row items-center gap-sm bg-surface px-md py-md ${
    divider ? 'border-b border-line-soft' : ''
  }`;

  // 多选态整卡可点翻选；常态卡体不可点（编辑/启停走右控件，mockup 行为）。
  if (selectMode) {
    return (
      <Pressable
        className={rowClass}
        onPress={onSelectToggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={COPY.selectA11y}
      >
        {body}
      </Pressable>
    );
  }
  return <View className={rowClass}>{body}</View>;
}
