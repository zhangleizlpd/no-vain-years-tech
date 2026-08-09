// 自定义指令编辑屏（031 US1/US2/US3）。功能域归 chat（数据 + 行为 chat-owned），设置页仅作
// 导航入口（plan D8）。RHF + zodResolver 4 铁律（Golden Sample = settings/name-edit）：
// <Controller> 包 TextInput、表单态≠副作用态、isSubmitting 单源、错误 + a11y 一体。
// 进屏 GET /chat/preferences 预填回显，保存调 PUT（typed upsert hook）→ invalidate GET →
// router.back()（hook 不导航）。复用 ~/ui + ~/theme，0 新 token。
import { useEffect } from 'react';
import { Controller } from 'react-hook-form';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useChatPreferenceControllerGet } from '@nvy/api-client';

import { ErrorRow, SafeAreaView, Spinner } from '~/ui';
import { colors } from '~/theme';
import { CUSTOM_INSTRUCTION_MAX } from './custom-instruction-form.schema';
import { useCustomInstructionForm } from './use-custom-instruction-form';

const COPY = {
  title: '自定义指令',
  save: '保存',
  saving: '保存中…',
  placeholder: '你希望 AI 助手如何回答？例如：回答尽量简洁、用要点列出、面向投资新手解释。',
  hint: '此指令对你的所有对话生效；留空则恢复默认。',
} as const;

export default function CustomInstructionScreen() {
  // 预填依赖 GET /chat/preferences —— 数据就绪后再挂载表单，保证 useForm defaultValues
  // 拿到当前值。未设置 / 已清空 → 空串（U1：行不存在与空串两态等价）。
  const { data, isLoading } = useChatPreferenceControllerGet();

  if (isLoading || !data) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <View className="flex-1 items-center justify-center bg-surface-sunken">
          <Spinner size={16} tone="muted" />
        </View>
      </SafeAreaView>
    );
  }

  return <CustomInstructionForm initialInstruction={data.data.customInstruction} />;
}

function CustomInstructionForm({ initialInstruction }: { initialInstruction: string }) {
  const router = useRouter();
  const { form, state, errorToast, submit, clearError } =
    useCustomInstructionForm(initialInstruction);
  const { control, formState } = form;

  const submitting = state === 'submitting';
  const isError = state === 'error';
  const saveDisabled = !formState.isValid || submitting;

  // success → 返回设置页（hook 不导航；偏好不入 store，由页面驱动 back）。
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
          name="customInstruction"
          render={({ field }) => (
            <CustomInstructionTextArea
              value={field.value}
              onChangeText={(text) => {
                field.onChange(text);
                if (isError) clearError();
              }}
              disabled={submitting}
            />
          )}
        />
        <Text className="text-xs text-ink-subtle">{COPY.hint}</Text>
        {errorToast ? <ErrorRow text={errorToast} /> : null}
      </View>
    </SafeAreaView>
  );
}

interface CustomInstructionTextAreaProps {
  value: string;
  onChangeText: (s: string) => void;
  disabled?: boolean;
}

// 多行自定义指令输入 + 实时字符计数（length = JS string .length，与 server @MaxLength 同口径）。
// 超 2000 标红，与 schema invalid 同步（「保存」disabled）；TextInput maxLength 取 2000 作硬闸。
function CustomInstructionTextArea({
  value,
  onChangeText,
  disabled,
}: CustomInstructionTextAreaProps) {
  const len = value.length;
  const over = len > CUSTOM_INSTRUCTION_MAX;
  return (
    <View className="bg-surface rounded-md border border-line-soft p-md gap-xs">
      <TextInput
        value={value}
        onChangeText={onChangeText}
        editable={!disabled}
        multiline
        autoFocus
        maxLength={CUSTOM_INSTRUCTION_MAX}
        textAlignVertical="top"
        placeholder={COPY.placeholder}
        placeholderTextColor={colors.ink.subtle}
        accessibilityLabel="自定义指令"
        accessibilityHint="最多 2000 字，可留空以恢复默认"
        className="text-base text-ink h-48"
      />
      <Text className={`text-xs font-mono self-end ${over ? 'text-err' : 'text-ink-subtle'}`}>
        {len}/{CUSTOM_INSTRUCTION_MAX}
      </Text>
    </View>
  );
}
