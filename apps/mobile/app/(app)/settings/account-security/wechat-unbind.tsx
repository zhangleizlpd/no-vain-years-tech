// 微信解绑验证屏 (010 US4, FR-C)。delete-account.tsx 近拷**去**风险块 + 双勾选
// (解绑可逆: 解绑后随时可重绑, 无 15 天冻结那种不可逆语义)。muscle = useWechatUnbindForm
// (RHF, 铁律 1-4) + Orval。code 录入 + 发码复用 ~/ui SmsInput; 错误用 ~/ui ErrorRow。
// 成功 router.back() —— 解绑保留 session (不像注销 clearSession)。
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Controller } from 'react-hook-form';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { useWechatUnbindForm } from '~/wechat';
import { ErrorRow, SmsInput } from '~/ui';

const COPY = {
  title: '账号解绑',
  subtitle: '您正在申请解除微信绑定，需验证以下身份',
  submit: '确认解绑',
  submitting: '正在解绑…',
} as const;

// 提交 CTA — brand 色 (解绑可逆, 非 delete 的 danger bg-err)。单 consumer 内联
// (nativewind rule #4)。accessibilityLabel 固定为动作 ('确认解绑') 使 locator 稳定。
function SubmitButton({
  disabled,
  busy,
  onPress,
}: {
  disabled: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const enabled = !disabled && !busy;
  const containerCls = enabled
    ? 'bg-brand-500 shadow-cta items-center justify-center rounded-md'
    : 'bg-surface-sunken items-center justify-center rounded-md';
  const labelTone = enabled ? 'text-surface' : 'text-ink-subtle';
  return (
    <Pressable
      accessibilityLabel={COPY.submit}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      className={containerCls}
      style={{ height: 52 }}
    >
      <Text className={`font-semibold tracking-wide text-base ${labelTone}`}>
        {busy ? COPY.submitting : COPY.submit}
      </Text>
    </Pressable>
  );
}

export default function WechatUnbindScreen() {
  const router = useRouter();
  const {
    form,
    state,
    canSendCode,
    hasSentCode,
    smsCountdown,
    errorToast,
    requestSms,
    submit,
    clearError,
  } = useWechatUnbindForm();
  const { control, formState } = form;

  const requesting = state === 'requesting_sms';
  const submitting = state === 'submitting';
  const isError = state === 'error';
  const errorMessage = isError ? errorToast : null;

  // success → 解绑完成, 保留 session, 返回账号与安全页 (行随 /me 刷新翻「绑定」)。
  useEffect(() => {
    if (state === 'success') router.back();
  }, [state, router]);

  const canSubmit = hasSentCode && formState.isValid && !submitting;

  return (
    <ScrollView className="flex-1 bg-surface" contentContainerClassName="px-md pt-md pb-xl gap-md">
      <Text className="text-ink leading-relaxed text-sm">{COPY.subtitle}</Text>

      {/* Controller 包 code 字段 (铁律 1)。SmsInput 含内联发码按钮。 */}
      <Controller
        control={control}
        name="code"
        render={({ field }) => (
          <SmsInput
            value={field.value}
            onChangeText={(t) => {
              field.onChange(t);
              if (isError) clearError();
            }}
            requesting={requesting}
            countdown={smsCountdown > 0 ? smsCountdown : null}
            disabled={submitting}
            errored={isError}
            onSend={() => {
              if (canSendCode) void requestSms();
            }}
          />
        )}
      />
      {errorMessage ? <ErrorRow text={errorMessage} /> : null}

      <View className="mt-sm">
        <SubmitButton disabled={!canSubmit} busy={submitting} onPress={() => void submit()} />
      </View>
    </ScrollView>
  );
}
