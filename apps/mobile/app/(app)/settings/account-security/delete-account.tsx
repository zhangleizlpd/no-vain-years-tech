// Account-deletion initiation screen (004 US10 / B3, FR-C01/C02). Strangler-fig
// port of the old app's delete-account.tsx: skin reused (~/theme tokens via
// className), muscle rewritten onto useDeleteAccountForm (RHF, 铁律 1-4) +
// Orval wrappers. Presentational sub-components are inline by design (single
// consumer). Code entry + send-code reuse the shared ~/ui SmsInput; errors use
// ~/ui ErrorRow.
//
// 3 sections: ① RISK warning block ② CONFIRM two checkboxes ③ VERIFY SMS.
// On success the wrapper已 clearSession (account frozen → local session void);
// this screen router.replace's to /(auth)/login (AuthGate also routes).
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Controller } from 'react-hook-form';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { useDeleteAccountForm } from '~/auth';
import { ErrorRow, SmsInput } from '~/ui';

const COPY = {
  warning1Tag: '可撤销',
  warning1: '注销后账号进入 15 天冻结期，期间可登录撤销恢复',
  warning2Tag: '不可逆',
  warning2: '冻结期满后账号数据将永久匿名化，不可恢复',
  confirm1: '我已知晓 15 天冻结期可撤销',
  confirm2: '我已知晓期满后数据匿名化不可逆',
  submit: '确认注销',
  submitting: '正在注销…',
  submitFootnote: '点击「确认注销」即表示同意进入 15 天冻结期',
} as const;

function SectionLabel({ num, children }: { num: string; children: string }) {
  return (
    <View className="flex-row items-center gap-sm">
      <Text className="font-mono font-semibold text-ink-subtle tracking-widest text-xs">{num}</Text>
      <Text className="font-mono text-ink-muted tracking-wider text-xs">{children}</Text>
    </View>
  );
}

// ≥2 行风险提示 + 可撤销/不可逆 tag (FR-C02). accessibilityRole="alert" so the
// e2e (and screen readers) surface the risk copy.
function WarningBlock() {
  return (
    <View className="rounded-md bg-err-soft px-md py-md gap-sm" accessibilityRole="alert">
      <View className="flex-row items-start gap-sm">
        <View className="rounded-full bg-warn mt-1.5" style={{ width: 6, height: 6 }} />
        <View className="flex-1 flex-row flex-wrap items-baseline gap-sm">
          <Text className="font-semibold text-warn text-sm">{COPY.warning1Tag}</Text>
          <Text className="text-ink leading-relaxed text-sm">{COPY.warning1}</Text>
        </View>
      </View>
      <View className="flex-row items-start gap-sm">
        <View className="rounded-full bg-err mt-1.5" style={{ width: 6, height: 6 }} />
        <View className="flex-1 flex-row flex-wrap items-baseline gap-sm">
          <Text className="font-semibold text-err text-sm">{COPY.warning2Tag}</Text>
          <Text className="text-ink leading-relaxed text-sm">{COPY.warning2}</Text>
        </View>
      </View>
    </View>
  );
}

function CheckboxRow({
  checked,
  label,
  onPress,
}: {
  checked: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      className="flex-row items-center gap-sm py-sm"
    >
      <View
        className={
          checked
            ? 'rounded-xs bg-brand-500 items-center justify-center'
            : 'rounded-xs border border-line-strong bg-surface'
        }
        style={{ width: 18, height: 18 }}
      >
        {checked ? <Text className="font-bold text-surface text-xs">✓</Text> : null}
      </View>
      <Text className="flex-1 text-ink text-sm">{label}</Text>
    </Pressable>
  );
}

// Destructive CTA — bg-err (danger), not the brand-colored ~/ui Button. Single
// consumer, so inline per nativewind rule #4. accessibilityLabel is the fixed
// action ('确认注销') so locators stay stable while the visible label flips to
// the busy text.
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
    ? 'bg-err shadow-cta items-center justify-center rounded-md'
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

export default function DeleteAccountScreen() {
  const router = useRouter();
  const {
    form,
    state,
    confirm1,
    confirm2,
    toggleConfirm1,
    toggleConfirm2,
    bothChecked,
    canSendCode,
    hasSentCode,
    smsCountdown,
    errorToast,
    requestSms,
    submit,
    clearError,
  } = useDeleteAccountForm();
  const { control, formState } = form;

  const requesting = state === 'requesting_sms';
  const submitting = state === 'submitting';
  const isError = state === 'error';
  const errorMessage = isError ? errorToast : null;

  // success → wrapper已 clearSession; replace to login. AuthGate also observes
  // isAuthenticated=false, but the explicit replace gives an immediate exit.
  useEffect(() => {
    if (state === 'success') router.replace('/(auth)/login');
  }, [state, router]);

  const canSubmit = hasSentCode && formState.isValid && !submitting;

  return (
    <ScrollView className="flex-1 bg-surface" contentContainerClassName="px-md pt-md pb-xl gap-md">
      <SectionLabel num="01">RISK · 风险告知</SectionLabel>
      <WarningBlock />

      <SectionLabel num="02">CONFIRM · 双重知晓确认</SectionLabel>
      <View className="rounded-md border border-line-soft bg-surface-alt px-sm">
        <CheckboxRow checked={confirm1} label={COPY.confirm1} onPress={toggleConfirm1} />
        <View className="bg-line-soft" style={{ height: 1, marginLeft: 26 }} />
        <CheckboxRow checked={confirm2} label={COPY.confirm2} onPress={toggleConfirm2} />
      </View>

      <SectionLabel num="03">VERIFY · 短信验证</SectionLabel>
      {/* Controller wraps the code field (铁律 1). SmsInput bundles the inline
          send button; gating the whole input on bothChecked disables the send
          button until both confirmations are checked (US10 Independent Test). */}
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
            disabled={!bothChecked || submitting}
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
      <Text className="text-center text-ink-subtle text-xs">{COPY.submitFootnote}</Text>
    </ScrollView>
  );
}
