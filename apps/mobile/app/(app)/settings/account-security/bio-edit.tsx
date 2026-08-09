// 个人简介编辑页（007 US2，active 功能页 —— 非占位）。RHF + zodResolver 4 铁律
// (Golden Sample = login/onboarding)：<Controller> 包 TextInput、表单态≠副作用态、
// isSubmitting 单源、错误 + a11y 一体。进页 GET /me 预填 bio，保存调 PATCH /me/bio
// (typed bio hook) → invalidate /me → router.back()（plan D7）。
import { useEffect } from 'react';
import { Controller } from 'react-hook-form';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import { useMe } from '~/core/api/use-me';
import { ErrorRow, SafeAreaView, Spinner } from '~/ui';
import { colors } from '~/theme';
import { BIO_MAX_CP } from '~/settings/bio-edit-form.schema';
import { useBioEditForm } from '~/settings/use-bio-edit-form';

const COPY = {
  title: '个人简介',
  save: '保存',
  saving: '保存中…',
  placeholder: '介绍自己的投资经验、风格或领域',
  example: '例如：美股研究员/新股专家/量化交易员',
} as const;

export default function BioEditScreen() {
  // 预填依赖 GET /me 的 bio —— 数据就绪后再挂载表单，保证 useForm defaultValues 拿到当前值。
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

  return <BioEditForm initialBio={profile.bio ?? ''} />;
}

function BioEditForm({ initialBio }: { initialBio: string }) {
  const router = useRouter();
  const { form, state, errorToast, submit, clearError } = useBioEditForm(initialBio);
  const { control, formState } = form;

  const submitting = state === 'submitting';
  const isError = state === 'error';
  const saveDisabled = !formState.isValid || submitting;

  // success → 返回账号与安全页（hook 不导航；bio 不入 store，由页面驱动）。
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
          name="bio"
          render={({ field }) => (
            <BioTextArea
              value={field.value}
              onChangeText={(text) => {
                field.onChange(text);
                if (isError) clearError();
              }}
              disabled={submitting}
            />
          )}
        />
        <Text className="text-xs text-ink-subtle">{COPY.example}</Text>
        {errorToast ? <ErrorRow text={errorToast} /> : null}
      </View>
    </SafeAreaView>
  );
}

interface BioTextAreaProps {
  value: string;
  onChangeText: (s: string) => void;
  disabled?: boolean;
}

// 多行简介输入 + 实时码点计数（surrogate-pair emoji 记 1）。maxLength 取 480 UTF-16 单元
// 作粗 DoS 闸，真上限（≤120 码点）交 schema；计数 > 120 标红，与 schema invalid 同步
// （「保存」disabled）。
function BioTextArea({ value, onChangeText, disabled }: BioTextAreaProps) {
  const len = [...value].length;
  const over = len > BIO_MAX_CP;
  return (
    <View className="bg-surface rounded-md border border-line-soft p-md gap-xs">
      <TextInput
        value={value}
        onChangeText={onChangeText}
        editable={!disabled}
        multiline
        autoFocus
        maxLength={480}
        textAlignVertical="top"
        placeholder={COPY.placeholder}
        placeholderTextColor={colors.ink.subtle}
        accessibilityLabel="个人简介"
        accessibilityHint="最多 120 字，可留空"
        className="text-base text-ink h-32"
      />
      <Text className={`text-xs font-mono self-end ${over ? 'text-err' : 'text-ink-subtle'}`}>
        {len}/{BIO_MAX_CP}
      </Text>
    </View>
  );
}
