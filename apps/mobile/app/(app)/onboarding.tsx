// Onboarding screen — ported from the legacy app (Strangler-Fig), RHF Golden Sample.
// State machine: idle → submitting → success | error. Skin reuses ~/theme + ~/ui;
// the form engine is RHF + zodResolver via useOnboardingForm. Forced gate (FR-035):
// no close ×, Android hardware back is a noop. The hook does NOT navigate — on
// success it writes store.displayName and AuthGate redirects to (tabs)/profile.
import { useEffect } from 'react';
import { Controller } from 'react-hook-form';
import { BackHandler, Platform, Text, View } from 'react-native';

import { useOnboardingForm } from '~/auth';
import {
  Button,
  DisplayNameInput,
  ErrorRow,
  LogoMark,
  SafeAreaView,
  Spinner,
  SuccessCheck,
} from '~/ui';

const COPY = {
  title: '完善个人资料',
  subtitle: '起一个昵称，随时可在设置里修改。',
  submit: '提交',
  submitting: '提交中…',
  successTitle: '完成！',
  successHint: '正在进入今日时间线…',
  footer: '昵称可在「设置」中随时修改',
} as const;

// success terminal — scale-in check + spinner while AuthGate redirects. The hook
// does not clear anything on success, so this frame paints stably before the
// redirect (per memory feedback_visual_smoke_unreachable_when_finally_clears_session).
function SuccessOverlay() {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View className="flex-1 bg-surface px-lg pb-lg">
        <View className="flex-row items-center h-11" />
        <View className="flex-1 items-center justify-center gap-4 pb-20">
          <SuccessCheck />
          <Text className="text-xl font-semibold text-ink mt-2">{COPY.successTitle}</Text>
          <View className="flex-row items-center gap-2">
            <Spinner size={12} tone="muted" />
            <Text className="text-sm text-ink-muted">{COPY.successHint}</Text>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

export default function OnboardingScreen() {
  const { form, state, errorToast, submit, clearError } = useOnboardingForm();
  const { control, formState } = form;

  const submitting = state === 'submitting';
  const isError = state === 'error';

  // FR-035: hardware back must noop on this page (forced gate; Android only —
  // iOS has no hardware back, web BackHandler is already a noop).
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  // success → overlay; AuthGate observes store.displayName (set by the mutation's
  // onSuccess) and router.replace's into /(app)/(tabs)/profile.
  if (state === 'success') return <SuccessOverlay />;

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View className="flex-1 bg-surface px-lg pb-lg">
        {/* TopBar spacer — no close × (FR-035 forced gate) */}
        <View className="flex-row items-center h-11" />

        {/* Header */}
        <View className="mt-3 items-center gap-2">
          <LogoMark />
          <Text className="text-3xl font-bold text-ink mt-3.5 tracking-tight text-center">
            {COPY.title}
          </Text>
          <Text className="text-sm text-ink-muted text-center">{COPY.subtitle}</Text>
        </View>

        {/* Form — single field via <Controller> (铁律 1) */}
        <View className="mt-9 gap-3">
          <Controller
            control={control}
            name="displayName"
            render={({ field }) => (
              <DisplayNameInput
                value={field.value}
                onChangeText={(text) => {
                  field.onChange(text);
                  if (isError) clearError();
                }}
                disabled={submitting}
                errored={isError}
                onSubmitEditing={() => void submit()}
              />
            )}
          />
          {errorToast ? <ErrorRow text={errorToast} /> : null}
        </View>

        {/* CTA */}
        <View className="mt-7">
          <Button
            label={submitting ? COPY.submitting : COPY.submit}
            loading={submitting}
            disabled={!formState.isValid}
            onPress={() => void submit()}
          />
        </View>

        <View className="flex-1" />

        <Text className="text-center text-xs text-ink-subtle mb-2">{COPY.footer}</Text>
      </View>
    </SafeAreaView>
  );
}
