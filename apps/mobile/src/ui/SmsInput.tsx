import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { colors } from '~/theme';
import { Spinner } from './Spinner';

export interface SmsInputProps {
  value: string;
  onChangeText: (s: string) => void;
  /** Visual error tint on border (errorScope === 'submit'); ErrorRow 由 caller 端在外面渲染 */
  errored?: boolean;
  /** state === 'requesting_sms'：右侧显示 "发送中…" + Spinner */
  requesting?: boolean;
  /** > 0 时右侧显示 "{N}s 后重发"；0/null 时显示 "获取验证码" */
  countdown: number | null;
  disabled?: boolean;
  onSend?: () => void;
}

// SmsInput 自身不渲染 ErrorRow（caller 端按 errorScope 决定在 PhoneInput 旁还是 SmsInput 旁）。
// 三态 inline send button: 发送中 / {N}s 后重发 / 获取验证码.
export function SmsInput({
  value,
  onChangeText,
  errored,
  requesting,
  countdown,
  disabled,
  onSend,
}: SmsInputProps) {
  const [focused, setFocused] = useState(false);
  const ticking = countdown !== null && countdown > 0;
  const borderTone = errored ? 'border-err' : focused ? 'border-brand-500' : 'border-line';
  const sendDisabled = ticking || requesting || disabled;

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
        placeholder="请输入 6 位验证码"
        placeholderTextColor={colors.ink.subtle}
        maxLength={6}
        keyboardType="number-pad"
        accessibilityLabel="验证码"
        className="flex-1 text-base text-ink font-sans tracking-widest"
      />
      <Pressable
        disabled={sendDisabled}
        onPress={onSend}
        className="flex-row items-center gap-2 pl-2"
        accessibilityRole="button"
        accessibilityLabel={
          requesting ? '发送中' : ticking ? `${countdown ?? 0}秒后可重新发送` : '获取验证码'
        }
      >
        {requesting ? (
          <>
            <Spinner size={11} tone="muted" />
            <Text className="text-sm text-ink-subtle font-medium">发送中…</Text>
          </>
        ) : ticking ? (
          <Text className="text-sm text-ink-subtle font-medium font-mono">{countdown}s 后重发</Text>
        ) : (
          <Text className="text-sm text-brand-500 font-medium">获取验证码</Text>
        )}
      </Pressable>
    </View>
  );
}
