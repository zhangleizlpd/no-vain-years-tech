// List-card primitives for the settings shell (006-account-settings-shell).
// App-local by design — kept here until a 2nd module outside settings needs
// the same list-card pattern; see plan.md D4 for the abstraction-deferral.

import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

export function Card({ children }: { children: ReactNode }) {
  return (
    <View className="bg-surface rounded-md border border-line-soft overflow-hidden">
      {children}
    </View>
  );
}

export function Divider() {
  // Left gap matches Row's px-md so the rule lines up with the label edge.
  return (
    <View className="flex-row">
      <View className="w-md" />
      <View className="flex-1 h-px bg-line-soft" />
    </View>
  );
}

export interface RowProps {
  label: string;
  value?: string;
  disabled?: boolean;
  destructive?: boolean;
  showChevron?: boolean;
  align?: 'left' | 'center';
  busy?: boolean;
  // 右侧（chevron 之前）自定义槽 —— 如 009 头像 / 主页背景图行的缩略图。
  accessory?: ReactNode;
  onPress?: () => void;
}

export function Row({
  label,
  value,
  disabled,
  destructive,
  showChevron = true,
  align = 'left',
  busy,
  accessory,
  onPress,
}: RowProps) {
  const isDisabled = !!disabled;
  const isBusy = !!busy;
  const isMuted = isDisabled || isBusy;
  const labelTone = destructive ? 'text-err' : isDisabled ? 'text-ink-muted' : 'text-ink';
  const labelWeight = destructive ? 'font-medium' : 'font-normal';
  return (
    <Pressable
      onPress={isDisabled ? undefined : onPress}
      disabled={isDisabled || isBusy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: isBusy }}
      className={`flex-row items-center px-md ${isMuted ? 'opacity-50' : ''}`}
      style={{ height: 52 }}
    >
      <View className={`flex-1 ${align === 'center' ? 'items-center' : ''}`}>
        <Text className={`text-base ${labelTone} ${labelWeight}`}>{label}</Text>
      </View>
      {value != null ? <Text className="text-sm text-ink-muted mr-xs">{value}</Text> : null}
      {accessory != null ? <View className="mr-xs">{accessory}</View> : null}
      {showChevron && !destructive ? <Text className="text-base text-ink-subtle">›</Text> : null}
    </Pressable>
  );
}
