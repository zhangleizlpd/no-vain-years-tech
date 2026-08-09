import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { colors } from '~/theme';

export interface PhoneInputProps {
  value: string;
  onChangeText: (s: string) => void;
  disabled?: boolean;
  errored?: boolean;
}

// +86 prefix + ▾ chevron (静态，不绑定下拉行为；M1.2 大陆唯一，留扩展位).
export function PhoneInput({ value, onChangeText, disabled, errored }: PhoneInputProps) {
  const [focused, setFocused] = useState(false);
  const borderTone = errored ? 'border-err' : focused ? 'border-brand-500' : 'border-line';
  return (
    <View
      className={`flex-row items-center h-12 border-b ${borderTone} ${disabled ? 'opacity-60' : ''}`}
    >
      <View className="flex-row items-center gap-1 pr-2">
        <Text className="text-base font-medium text-ink">+86</Text>
        <Text className="text-xs text-ink-subtle">▾</Text>
      </View>
      <View className="w-px h-4 bg-line mr-3" />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        editable={!disabled}
        placeholder="请输入手机号"
        placeholderTextColor={colors.ink.subtle}
        keyboardType="phone-pad"
        accessibilityLabel="手机号"
        className="flex-1 text-base text-ink font-sans tracking-wide"
      />
    </View>
  );
}
