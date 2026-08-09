// GOLDEN SAMPLE — mobile 最小标准编辑表单屏（默认 copy）。新「单字段编辑保存」屏起手对照
// 此文件：无 modal / overlay / 状态机噪声，纯 RHF + zodResolver 4 铁律落地。RHF 逻辑权威 =
// ~/auth use-login-form.ts hook；复杂表单参照 = (auth)/login.tsx。分层见
// docs/conventions/mobile-impl-playbook.md § 1。
// 设置昵称编辑页（008 US2，active 功能页 —— 非占位）。RHF + zodResolver 4 铁律：
// <Controller> 包 TextInput、表单态≠副作用态、isSubmitting 单源、错误 + a11y 一体。
// 进页 GET /me 预填 displayName，保存复用 002
// PATCH /me {displayName}（useUpdateDisplayName 内部同步 store）→ invalidate /me →
// router.back()。昵称校验沿用 002（1–32 码点、不可空），复用 ~/auth displayNameSchema。
import { useEffect } from 'react';
import { Controller } from 'react-hook-form';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import { useMe } from '~/core/api/use-me';
import { ErrorRow, SafeAreaView, Spinner } from '~/ui';
import { colors } from '~/theme';
import { DISPLAY_NAME_MAX_CP } from '~/auth/onboarding-form.schema';
import { useNameEditForm } from '~/settings/use-name-edit-form';

const COPY = {
  title: '设置昵称',
  save: '保存',
  saving: '保存中…',
  placeholder: '起一个名字',
  clear: '清空',
} as const;

export default function NameEditScreen() {
  // 预填依赖 GET /me 的 displayName —— 数据就绪后再挂载表单，保证 useForm defaultValues 拿到当前值。
  const { data: profile, isLoading } = useMe();

  if (isLoading || !profile) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <View className="flex-1 items-center justify-center bg-surface-sunken">
          <Spinner size={16} tone="muted" />
        </View>
      </SafeAreaView>
    );
  }

  return <NameEditForm initialName={profile.displayName ?? ''} />;
}

function NameEditForm({ initialName }: { initialName: string }) {
  const router = useRouter();
  const { form, state, errorToast, submit, clearError } = useNameEditForm(initialName);
  const { control, formState } = form;

  const submitting = state === 'submitting';
  const isError = state === 'error';
  const saveDisabled = !formState.isValid || submitting;

  // success → 返回账号与安全页（hook 不导航；store 由 wrapper 同步，页面驱动 back）。
  useEffect(() => {
    if (state === 'success') router.back();
  }, [state, router]);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: COPY.title,
          headerRight: () => (
            <Pressable
              onPress={() => void submit()}
              disabled={saveDisabled}
              accessibilityRole="button"
              accessibilityLabel={COPY.save}
              accessibilityState={{ disabled: saveDisabled, busy: submitting }}
            >
              <Text
                className={`text-base px-md ${saveDisabled ? 'text-ink-subtle' : 'text-brand-500'}`}
              >
                {submitting ? COPY.saving : COPY.save}
              </Text>
            </Pressable>
          ),
        }}
      />
      <View className="flex-1 bg-surface-sunken px-md pt-md gap-sm">
        {/* 铁律 1 — <Controller> 包 TextInput（非 register） */}
        <Controller
          control={control}
          name="displayName"
          render={({ field }) => (
            <NameTextField
              value={field.value}
              onChangeText={(text) => {
                field.onChange(text);
                if (isError) clearError();
              }}
              onClear={() => {
                field.onChange('');
                if (isError) clearError();
              }}
              disabled={submitting}
            />
          )}
        />
        {errorToast ? <ErrorRow text={errorToast} /> : null}
      </View>
    </SafeAreaView>
  );
}

interface NameTextFieldProps {
  value: string;
  onChangeText: (s: string) => void;
  onClear: () => void;
  disabled?: boolean;
}

// 单行昵称输入 + 实时码点计数（surrogate-pair emoji 记 1）+ 右侧「×」清空（非空时显示）。
// maxLength 取 64 UTF-16 单元作粗 DoS 闸，真上限（≤32 码点）交 schema；计数 > 32 标红，
// 与 schema invalid 同步（「保存」disabled）。
function NameTextField({ value, onChangeText, onClear, disabled }: NameTextFieldProps) {
  const len = [...value].length;
  const over = len > DISPLAY_NAME_MAX_CP;
  return (
    <View className="bg-surface rounded-md border border-line-soft px-md flex-row items-center gap-sm">
      <TextInput
        value={value}
        onChangeText={onChangeText}
        editable={!disabled}
        autoFocus
        maxLength={64}
        placeholder={COPY.placeholder}
        placeholderTextColor={colors.ink.subtle}
        accessibilityLabel="昵称"
        accessibilityHint="1 至 32 字符，支持中文、字母、数字、emoji"
        className="flex-1 text-base text-ink h-12"
      />
      <Text className={`text-xs font-mono ${over ? 'text-err' : 'text-ink-subtle'}`}>
        {len}/{DISPLAY_NAME_MAX_CP}
      </Text>
      {len > 0 ? (
        <Pressable onPress={onClear} accessibilityRole="button" accessibilityLabel={COPY.clear}>
          <Text className="text-base text-ink-subtle">✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
