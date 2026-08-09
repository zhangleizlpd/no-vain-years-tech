import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { colors } from '~/theme';

export interface DisplayNameInputProps {
  value: string;
  onChangeText: (s: string) => void;
  disabled?: boolean;
  errored?: boolean;
  onSubmitEditing?: () => void;
}

// onboarding 昵称输入：单行 + code-point 计数（surrogate-pair emoji 记 1）。maxLength
// 取 64 UTF-16 单元，保证 32 个码点（含全 astral emoji）永不被硬截，真校验交 schema。
// 计数 > 32 标红，与 schema invalid 同步（提交按钮 disabled）。
export function DisplayNameInput({
  value,
  onChangeText,
  disabled,
  errored,
  onSubmitEditing,
}: DisplayNameInputProps) {
  const [focused, setFocused] = useState(false);
  const borderTone = errored ? 'border-err' : focused ? 'border-brand-500' : 'border-line';
  const len = [...value].length;
  return (
    <View
      className={`flex-row items-center h-12 border-b ${borderTone} ${disabled ? 'opacity-60' : ''}`}
    >
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        editable={!disabled}
        maxLength={64}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={onSubmitEditing}
        placeholder="给自己起个昵称"
        placeholderTextColor={colors.ink.subtle}
        accessibilityLabel="昵称"
        accessibilityHint="1 至 32 字符，支持中文、字母、数字、emoji"
        className="flex-1 text-base text-ink font-sans"
      />
      <Text className={`text-xs font-mono pl-2 ${len > 32 ? 'text-err' : 'text-ink-subtle'}`}>
        {len}/32
      </Text>
    </View>
  );
}
