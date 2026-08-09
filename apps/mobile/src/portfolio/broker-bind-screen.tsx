import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Card, Divider } from '~/settings/primitives';
import { BrokerPickerSheet, Button, ErrorRow } from '~/ui';
import { colors } from '~/theme';
import { BROKER_COPY } from './broker-copy';
import { BROKER_PICKER_ITEMS, brokerNameOf } from './broker-catalog';
import { brokerBindFormSchema, type BrokerBindFormValues } from './broker-bind-form.schema';
import { bindErrorMessage, useBrokerAccounts } from './use-broker-accounts';

// 绑定券商表单屏（012 页 B/页 C，US5）。RHF + zodResolver 4 铁律（Golden Sample = ~/auth
// use-login-form）：① <Controller> 包客户号 TextInput；② 副作用态（提交错误 / sheet 开合）
// 在 RHF 外；③ isSubmitting 单源驱动按钮；④ 错误 + a11y 一体。券商经页 C BrokerPickerSheet
// 选中回填 brokerCode（setValue + 触发校验）。提交成功 → 回页 A；409 dup → 行内红框
// （bindErrorMessage 分流）。无货币单位行（mockup DO-NOT）。视觉 0 hex（SC-M06）。
export function BrokerBindScreen() {
  const router = useRouter();
  const { bind } = useBrokerAccounts();

  const form = useForm<BrokerBindFormValues>({
    resolver: zodResolver(brokerBindFormSchema),
    mode: 'onChange',
    defaultValues: { brokerCode: '', clientNo: '' },
  });
  const { control, handleSubmit, setValue, watch, formState } = form;

  // 铁律 2 — 副作用态在 RHF 外：sheet 开合 + 提交错误。
  const [pickerVisible, setPickerVisible] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const brokerCode = watch('brokerCode');

  const onSelectBroker = (code: string) => {
    setValue('brokerCode', code, { shouldValidate: true });
    setPickerVisible(false);
    setSubmitError(null);
  };

  // 铁律 1/3 — submit 走 handleSubmit，isSubmitting 单源。成功 invalidate 列表后回页 A；
  // 409 dup / 400 校验 / 网络 → 行内分流（bindErrorMessage）。
  const submit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await bind(values.brokerCode, values.clientNo.trim());
      router.back();
    } catch (e) {
      setSubmitError(bindErrorMessage(e));
    }
  });

  const submitDisabled = !formState.isValid || formState.isSubmitting;

  return (
    <View className="flex-1 bg-surface-sunken">
      <View className="px-md pt-md gap-md">
        <Card>
          {/* 行 1 — 选择券商（→ 页 C）；选中后 logo + 名内联显示。 */}
          <Pressable
            onPress={() => setPickerVisible(true)}
            accessibilityRole="button"
            accessibilityLabel={BROKER_COPY.bind.selectBroker}
            className="flex-row items-center px-md"
            style={{ height: 56 }}
          >
            <Text className="text-base text-ink flex-1">{BROKER_COPY.bind.selectBroker}</Text>
            {brokerCode ? (
              <View className="flex-row items-center gap-sm">
                <View
                  className="rounded-sm bg-brand-soft items-center justify-center"
                  style={{ width: 28, height: 28 }}
                >
                  <Text className="text-xs font-bold text-brand-500">
                    {brokerNameOf(brokerCode).slice(0, 1)}
                  </Text>
                </View>
                <Text className="text-base text-ink">{brokerNameOf(brokerCode)}</Text>
              </View>
            ) : (
              <Text className="text-base text-ink-subtle">
                {BROKER_COPY.bind.selectBrokerPlaceholder}
              </Text>
            )}
            <Text className="text-base text-ink-subtle ml-sm">›</Text>
          </Pressable>

          <Divider />

          {/* 行 2 — 客户号文本输入（右对齐 mono）。铁律 1 — <Controller> 包 TextInput。 */}
          <View className="flex-row items-center px-md" style={{ height: 56 }}>
            <Text className="text-base text-ink flex-1">{BROKER_COPY.bind.clientNoLabel}</Text>
            <Controller
              control={control}
              name="clientNo"
              render={({ field }) => (
                <TextInput
                  value={field.value}
                  onChangeText={(text) => {
                    field.onChange(text);
                    if (submitError) setSubmitError(null);
                  }}
                  onBlur={field.onBlur}
                  placeholder={BROKER_COPY.bind.clientNoPlaceholder}
                  placeholderTextColor={colors.ink.subtle}
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="text-base text-ink text-right font-mono flex-1"
                  accessibilityLabel={BROKER_COPY.bind.clientNoLabel}
                />
              )}
            />
          </View>
        </Card>

        {submitError ? <ErrorRow text={submitError} /> : null}

        <Button
          label={BROKER_COPY.bind.submit}
          onPress={() => void submit()}
          disabled={submitDisabled}
          loading={formState.isSubmitting}
        />
      </View>

      <BrokerPickerSheet
        visible={pickerVisible}
        items={[...BROKER_PICKER_ITEMS]}
        onSelect={onSelectBroker}
        onClose={() => setPickerVisible(false)}
      />
    </View>
  );
}
