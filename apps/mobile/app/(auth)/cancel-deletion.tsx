// Cancel-deletion screen (FR-C04) — public撤销注销屏, RHF Golden Sample.
// State machine: idle → requesting_sms → sms_sent → submitting → success | error.
// Phone prefills from the `phone` route param (FROZEN-login modal hand-off,
// T034) but is hand-fillable on deep-link. On submit success the wrapper已
// setSession → AuthGate redirects into /(app)/ (this screen does NOT navigate).
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Controller } from 'react-hook-form';
import { Pressable, Text, View } from 'react-native';

import { PHONE_REGEX, useCancelDeletionForm } from '~/auth';
import {
  Button,
  ErrorRow,
  LogoMark,
  PhoneInput,
  SafeAreaView,
  SmsInput,
  Spinner,
  SuccessCheck,
} from '~/ui';

// Success terminal — scale-in check + spinner while AuthGate redirects. The hook
// does NOT clearSession on success, so this frame paints stably before redirect
// (per memory feedback_visual_smoke_unreachable_when_finally_clears_session).
function SuccessOverlay() {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View className="flex-1 bg-surface px-lg pb-lg">
        <View className="flex-row items-center h-11 px-1" />
        <View className="flex-1 items-center justify-center gap-4 pb-20">
          <SuccessCheck />
          <Text className="text-xl font-semibold text-ink mt-2">已撤销注销</Text>
          <View className="flex-row items-center gap-2">
            <Spinner size={12} tone="muted" />
            <Text className="text-sm text-ink-muted">正在恢复你的时间线…</Text>
          </View>
        </View>
        {/* Next screen peeking from the bottom */}
        <View className="absolute left-4 right-4 bottom-2 h-24 rounded-2xl bg-surface-alt p-3.5 opacity-60">
          <View className="h-2.5 w-1/3 rounded-sm bg-line mb-2.5" />
          <View className="h-2.5 w-3/4 rounded-sm bg-line mb-2.5" />
          <View className="h-2.5 w-1/2 rounded-sm bg-line" />
        </View>
      </View>
    </SafeAreaView>
  );
}

export default function CancelDeletionScreen() {
  const router = useRouter();
  const { phone: phoneParam } = useLocalSearchParams<{ phone?: string }>();
  const initialPhone = typeof phoneParam === 'string' ? phoneParam : undefined;

  const { form, state, smsCountdown, errorToast, errorScope, requestSms, submit, clearError } =
    useCancelDeletionForm(initialPhone);
  const { control, formState } = form;

  const requesting = state === 'requesting_sms';
  const submitting = state === 'submitting';
  const isError = state === 'error';
  // Send button enablement reuses the schema's PHONE_REGEX (single source) — the
  // SMS request is gated on a valid phone (server would 422 otherwise).
  const phoneValid = PHONE_REGEX.test(form.watch('phone'));

  const handleClose = () => {
    if (router.canGoBack()) router.back();
  };

  // success → overlay; AuthGate observes isAuthenticated (set by the mutation's
  // onSuccess) and router.replace's into /(app)/.
  if (state === 'success') return <SuccessOverlay />;

  // errorScope routes the red border (+ shared ErrorRow): an SMS-request failure
  // faults the phone field; a submit failure faults the code field.
  const phoneErrored = isError && errorScope === 'sms';
  const smsErrored = isError && errorScope === 'submit';
  const errorMessage = isError ? errorToast : null;

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View className="flex-1 bg-surface px-lg pb-lg">
        {/* TopBar — close (back if history, else noop) */}
        <View className="flex-row items-center h-11 px-1">
          <Pressable
            onPress={handleClose}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="关闭"
          >
            <Text className="text-2xl text-ink leading-none">×</Text>
          </Pressable>
        </View>

        {/* Header */}
        <View className="mt-3 items-center gap-2">
          <LogoMark />
          <Text className="text-3xl font-bold text-ink mt-3.5 tracking-tight text-center">
            撤销注销
          </Text>
          <Text className="text-sm text-ink-muted text-center">在冷静期内，随时可以回来。</Text>
        </View>

        {/* Form — single form; inputs via <Controller> (铁律 1) */}
        <View className="mt-9 gap-3">
          <Controller
            control={control}
            name="phone"
            render={({ field }) => (
              <PhoneInput
                value={field.value.replace(/^\+86/, '')}
                onChangeText={(digits) => {
                  field.onChange(`+86${digits.replace(/\s+/g, '')}`);
                  if (isError) clearError();
                }}
                disabled={submitting || requesting}
                errored={phoneErrored}
              />
            )}
          />
          <Controller
            control={control}
            name="code"
            render={({ field }) => (
              <SmsInput
                value={field.value}
                onChangeText={(text) => {
                  field.onChange(text);
                  if (isError) clearError();
                }}
                requesting={requesting}
                countdown={smsCountdown > 0 ? smsCountdown : null}
                disabled={submitting}
                errored={smsErrored}
                onSend={() => {
                  if (phoneValid) void requestSms();
                }}
              />
            )}
          />
          {errorMessage ? <ErrorRow text={errorMessage} /> : null}
        </View>

        {/* CTA — 撤销注销 → 恢复登录态 */}
        <View className="mt-7">
          <Button
            label={submitting ? '撤销中…' : '撤销注销'}
            loading={submitting}
            disabled={!formState.isValid}
            onPress={() => void submit()}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}
