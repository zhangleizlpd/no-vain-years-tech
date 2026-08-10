// 045 T022 — 锚表单屏（建锚 mockup 帧 ⑥ / 编辑帧 ⑦⑧）。RHF + zodResolver 4 铁律见
// `use-anchor-form.ts`；本文件只负责布局 + <Controller> 接线 + 三处人工位的即时动作。
//
// 关键取舍（干净上下文读代码时最容易看反的几处）：
//  · **搜票选择器不接受自由文本**（EC-2 / FR-002）—— 见 ticker-search-picker.tsx。
//  · **`confidence` 按 `confidenceSource` 门控**：`model` ⇒ 只读、**压根不渲染输入框**
//    （不是 disabled input，是没有编辑路径）；`manual` ⇒ 正常 Controller。
//  · **三处人工位不是表单字段**：走各自的即时 PATCH（FR-032 ①「显式动作」+ FR-035 ②③
//    「回落同屏立即可见」），见 manual-slot-row.tsx。
//  · **变更痕迹段放表单内**（plan D15，M1 不做独立入口）—— 但 M1 server 只 ship 了 PIT 还原
//    端点、**没有痕迹列表读端**，故这一段是显式「即将可用」而不是伪造行。
import { useEffect, useState } from 'react';
import { Controller } from 'react-hook-form';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import {
  useOptionsdeskControllerGetOne,
  useOptionsdeskControllerList,
  type AnchorResponse,
  type UpdateAnchorRequest,
  type UpdateAnchorRequestLLevelManual,
} from '@nvy/api-client';

import { colors } from '~/theme';
import { ConfirmModal, ErrorRow, SafeAreaView, Spinner, Switch } from '~/ui';
import {
  anchorSubmitErrorToast,
  findAnchorIdByTicker,
  formatPositionCap,
} from './anchor-form.rules';
import { ManualSlotRow } from './manual-slot-row';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { optionsdeskAnchorEditRoute } from './optionsdesk-routes';
import { formatPriceText } from './price-format.rules';
import { useAnchorForm } from './use-anchor-form';
import { useDeleteAnchor, useReviewAnchor, useUpdateAnchor } from './use-anchor-mutations';
import { TickerSearchPicker } from './ticker-search-picker';

const COPY = OPTIONSDESK_COPY.anchorForm;

type ManualSlot = 'v' | 'lLevel' | 'positionCap';

/**
 * 人工位 PATCH body。`null` = 撤销 —— 三处人工位同构，都直接送 `null`，无一处需要 cast
 * （T026 契约冒烟修掉了 `lLevelManual` 缺 `nullable: true` 的 swagger 缺口后，生成的
 * `UpdateAnchorRequestLLevelManual` 本身就含 `null`）。
 */
function manualPatch(slot: ManualSlot, value: string | null): UpdateAnchorRequest {
  if (slot === 'v') return { vManual: value };
  if (slot === 'positionCap') return { positionCapManual: value };
  return { lLevelManual: value as UpdateAnchorRequestLLevelManual };
}

export function AnchorFormScreen({ anchorId }: { anchorId?: string }) {
  const one = useOptionsdeskControllerGetOne(anchorId ?? '', {
    query: { enabled: !!anchorId },
  });

  if (anchorId && one.isLoading) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <View className="flex-1 items-center justify-center bg-surface-sunken">
          <Spinner size={16} tone="muted" />
        </View>
      </SafeAreaView>
    );
  }

  if (anchorId && !one.data) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <View className="flex-1 items-center justify-center bg-surface-sunken px-md">
          <ErrorRow text={COPY.loadFailed} />
        </View>
      </SafeAreaView>
    );
  }

  return <AnchorFormBody anchor={anchorId ? (one.data?.data ?? null) : null} />;
}

function AnchorFormBody({ anchor }: { anchor: AnchorResponse | null }) {
  const router = useRouter();
  const {
    form,
    state,
    errorToast,
    duplicateTicker,
    confidenceEditable,
    isEdit,
    submit,
    clearError,
  } = useAnchorForm(anchor);
  const { control, formState } = form;

  const [pickedName, setPickedName] = useState('');
  const [sideError, setSideError] = useState<string | null>(null);
  const [busySlot, setBusySlot] = useState<ManualSlot | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 只解构 mutateAsync —— useMutation 返回对象每 render 换 identity（自激风暴防线）。
  const { mutateAsync: updateAnchor } = useUpdateAnchor();
  const { mutateAsync: deleteAnchor, isPending: deleting } = useDeleteAnchor();
  const { mutateAsync: reviewAnchor, isPending: reviewing } = useReviewAnchor();

  // EC-7：409 拿不到结构化 existingAnchorId（ProblemDetail 只透传白名单）⇒ 按刚提交的 ticker
  // 在锚列表里定位既有锚。列表本就是进本屏前的上一屏数据，命中缓存不额外打网络。
  const list = useOptionsdeskControllerList(undefined, {
    query: { enabled: !!duplicateTicker },
  });
  const existingId = findAnchorIdByTicker(list.data?.data.items ?? [], duplicateTicker);

  const submitting = state === 'submitting';
  const saveDisabled = !formState.isValid || submitting;

  useEffect(() => {
    if (state === 'success') router.back();
  }, [state, router]);

  const applyManual = async (slot: ManualSlot, value: string | null) => {
    if (!anchor) return;
    setSideError(null);
    setBusySlot(slot);
    try {
      await updateAnchor({ id: anchor.id, data: manualPatch(slot, value) });
    } catch (e) {
      setSideError(anchorSubmitErrorToast(e));
    } finally {
      setBusySlot(null);
    }
  };

  const doReview = async () => {
    if (!anchor) return;
    setSideError(null);
    try {
      // FR-030：复审周期档策略 SoT 未定义 ⇒ server 不自造默认值，前端同样不造 —— 送表单里
      // 「下次复审」当前的值（空 = 本次不再排下次复审）。
      await reviewAnchor({
        id: anchor.id,
        data: { nextReview: form.getValues('nextReview') || null },
      });
    } catch (e) {
      setSideError(anchorSubmitErrorToast(e));
    }
  };

  const doDelete = async () => {
    if (!anchor) return;
    try {
      await deleteAnchor({ id: anchor.id });
      setConfirmDelete(false);
      router.back();
    } catch (e) {
      setConfirmDelete(false);
      setSideError(anchorSubmitErrorToast(e));
    }
  };

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: anchor ? anchor.ticker : COPY.createTitle,
          headerRight: () => (
            <Pressable
              onPress={() => void submit()}
              disabled={saveDisabled}
              accessibilityRole="button"
              accessibilityLabel={COPY.save}
              accessibilityState={{ disabled: saveDisabled, busy: submitting }}
              testID="optionsdesk-anchor-save"
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

      <ScrollView className="flex-1 bg-surface-sunken" testID="optionsdesk-anchor-form">
        <View className="px-md py-md gap-md">
          {/* ── 段 ① 选择标的（建锚才有；编辑锚的 ticker 不可改 —— 它是采集与跨 ctx 关联的锚点） */}
          {!isEdit ? (
            <Section title={COPY.sectionTicker}>
              <Controller
                control={control}
                name="ticker"
                render={({ field }) => (
                  <TickerSearchPicker
                    picked={field.value ? { symbol: field.value, name: pickedName } : null}
                    disabled={submitting}
                    onPick={(item) => {
                      field.onChange(item?.symbol ?? '');
                      form.setValue('tickerName', item?.name ?? '');
                      setPickedName(item?.name ?? '');
                      clearError();
                    }}
                  />
                )}
              />
            </Section>
          ) : null}

          {/* ── 段 ② 估值输入 */}
          <Section title={COPY.sectionValuation}>
            <Controller
              control={control}
              name="v"
              render={({ field, fieldState }) => (
                <Field
                  label={COPY.vLabel}
                  placeholder={COPY.vPlaceholder}
                  value={field.value}
                  onChangeText={(t) => {
                    field.onChange(t);
                    clearError();
                  }}
                  error={fieldState.error?.message}
                  keyboardType="decimal-pad"
                  disabled={submitting}
                  testID="optionsdesk-field-v"
                />
              )}
            />

            {/* FR-001 来源门控：model ⇒ **无编辑入口**（不渲染输入框）。 */}
            {confidenceEditable ? (
              <Controller
                control={control}
                name="confidence"
                render={({ field, fieldState }) => (
                  <Field
                    label={COPY.confidenceLabel}
                    hint={COPY.confidenceEditable}
                    placeholder={COPY.confidencePlaceholder}
                    value={field.value}
                    onChangeText={(t) => {
                      field.onChange(t);
                      clearError();
                    }}
                    error={fieldState.error?.message}
                    keyboardType="decimal-pad"
                    disabled={submitting}
                    testID="optionsdesk-field-confidence"
                  />
                )}
              />
            ) : (
              <View className="gap-xs" testID="optionsdesk-confidence-readonly">
                <Text className="text-xs text-ink-muted">{COPY.confidenceLabel}</Text>
                <Text className="text-base font-mono text-ink">{anchor?.confidence}</Text>
                <Text className="text-xs text-ink-subtle">{COPY.confidenceReadonly}</Text>
                <Text className="text-xs text-ink-subtle">{COPY.confidenceModelNote}</Text>
              </View>
            )}

            <Controller
              control={control}
              name="method"
              render={({ field, fieldState }) => (
                <Field
                  label={COPY.methodLabel}
                  placeholder={COPY.methodPlaceholder}
                  value={field.value}
                  onChangeText={(t) => {
                    field.onChange(t);
                    clearError();
                  }}
                  error={fieldState.error?.message}
                  disabled={submitting}
                  testID="optionsdesk-field-method"
                />
              )}
            />

            <Controller
              control={control}
              name="asof"
              render={({ field, fieldState }) => (
                <Field
                  label={COPY.asofLabel}
                  placeholder={COPY.asofPlaceholder}
                  value={field.value}
                  onChangeText={(t) => {
                    field.onChange(t);
                    clearError();
                  }}
                  error={fieldState.error?.message}
                  disabled={submitting}
                  testID="optionsdesk-field-asof"
                />
              )}
            />
          </Section>

          {/* ── 段 ③ 派生 · 人工调整位（编辑态才有 —— 派生值由 server 求值，建锚保存后才存在） */}
          {anchor ? (
            <Section title={COPY.sectionDerived}>
              <ManualSlotRow
                slot="v"
                label="V"
                effectiveText={formatPriceText(anchor.v)}
                isManual={anchor.vIsManual}
                derivedLabel={`${COPY.derivedVLabel} ${anchor.vModel}`}
                followsLabel={COPY.followsUpstream(COPY.derivedVLabel)}
                editor="numeric"
                busy={busySlot === 'v'}
                onApply={(value) => void applyManual('v', value)}
              />
              <ReadonlyRow label={COPY.wLabel} value={formatPriceText(anchor.w)} />
              <ReadonlyRow
                label={COPY.zoneLabel}
                value={[anchor.zoneFloor, anchor.w, anchor.v, anchor.zoneCeiling]
                  .map(formatPriceText)
                  .join(' / ')}
              />
              <ManualSlotRow
                slot="lLevel"
                label={COPY.lLevelLabel}
                effectiveText={anchor.lLevelEffective}
                isManual={anchor.lLevelIsManual}
                derivedLabel={`${COPY.derivedLLevelLabel} ${anchor.derivedLLevel}`}
                followsLabel={COPY.followsUpstream('confidence')}
                editor="lLevel"
                busy={busySlot === 'lLevel'}
                onApply={(value) => void applyManual('lLevel', value)}
              />
              <ManualSlotRow
                slot="positionCap"
                label={COPY.positionCapLabel}
                effectiveText={formatPositionCap(anchor.positionCap)}
                isManual={anchor.positionCapIsManual}
                derivedLabel={`${COPY.derivedPositionCapLabel} ${formatPositionCap(anchor.derivedPositionCap)}`}
                followsLabel={COPY.followsUpstream(anchor.lLevelEffective)}
                editor="numeric"
                busy={busySlot === 'positionCap'}
                onApply={(value) => void applyManual('positionCap', value)}
              />
              <ReadonlyRow
                label={COPY.willingSellLabel}
                value={`${COPY.willingSellLongHold} ${anchor.willingSellLongHold} · ${COPY.willingSellRent} ${anchor.willingSellRent}`}
              />
            </Section>
          ) : null}

          {/* ── 段 ④ 复审 */}
          <Section title={COPY.sectionReview}>
            <Controller
              control={control}
              name="nextReview"
              render={({ field, fieldState }) => (
                <Field
                  label={COPY.nextReviewLabel}
                  placeholder={COPY.asofPlaceholder}
                  value={field.value}
                  onChangeText={(t) => {
                    field.onChange(t);
                    clearError();
                  }}
                  error={fieldState.error?.message}
                  disabled={submitting}
                  testID="optionsdesk-field-next-review"
                />
              )}
            />
            {anchor?.overdueAgainstAsof ? (
              <Text className="text-xs text-err" testID="optionsdesk-overdue-against-asof">
                {COPY.overdueAgainstAsof}
              </Text>
            ) : null}
            {anchor ? (
              <>
                <Pressable
                  onPress={() => void doReview()}
                  disabled={reviewing}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.doReview}
                  accessibilityState={{ busy: reviewing }}
                  testID="optionsdesk-anchor-review"
                  className="self-start border border-brand-500 rounded-full px-md py-xs"
                >
                  <Text className="text-sm text-brand-500">{COPY.doReview}</Text>
                </Pressable>
                <Text className="text-xs text-ink-subtle">{COPY.reviewNote}</Text>
              </>
            ) : null}
          </Section>

          {/* ── 段 ⑤ 交易意愿排除（FR-005；采集照常，FR-028） */}
          <Section title={COPY.sectionExclude}>
            <Controller
              control={control}
              name="excluded"
              render={({ field }) => (
                <View className="flex-row items-center justify-between">
                  <Text className="text-sm text-ink">{COPY.excludedLabel}</Text>
                  <Switch
                    value={field.value}
                    onValueChange={(next) => {
                      field.onChange(next);
                      clearError();
                    }}
                    accessibilityLabel={COPY.excludedLabel}
                  />
                </View>
              )}
            />
            <Controller
              control={control}
              name="excludeReason"
              render={({ field, fieldState }) => (
                <Field
                  label={COPY.excludeReasonLabel}
                  placeholder={COPY.excludeReasonPlaceholder}
                  value={field.value}
                  onChangeText={(t) => {
                    field.onChange(t);
                    clearError();
                  }}
                  error={fieldState.error?.message}
                  disabled={submitting}
                  testID="optionsdesk-field-exclude-reason"
                />
              )}
            />
            <Text className="text-xs text-ink-subtle">{COPY.excludeNote}</Text>
          </Section>

          {/* ── 段 ⑥ 变更痕迹（plan D15 展示位；M1 无列表读端 ⇒ 显式「即将可用」，不伪造行） */}
          {anchor ? (
            <Section title={COPY.sectionHistory}>
              <Text className="text-xs text-ink-subtle" testID="optionsdesk-anchor-history">
                {COPY.historyComingSoon}
              </Text>
            </Section>
          ) : null}

          {errorToast ? (
            <View testID="optionsdesk-anchor-error">
              <ErrorRow text={errorToast} />
              {/* EC-7 引导：定位到既有锚去编辑；定位不到就只留文案，不给死链。 */}
              {existingId ? (
                <Pressable
                  onPress={() => router.replace(optionsdeskAnchorEditRoute(existingId))}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.goEditExisting}
                  testID="optionsdesk-anchor-goto-existing"
                >
                  <Text className="text-sm text-brand-500 mt-sm">{COPY.goEditExisting}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {sideError ? <ErrorRow text={sideError} /> : null}

          {anchor ? (
            <Pressable
              onPress={() => setConfirmDelete(true)}
              accessibilityRole="button"
              accessibilityLabel={COPY.delete}
              testID="optionsdesk-anchor-delete"
              className="self-center py-md"
            >
              <Text className="text-sm text-err">{COPY.delete}</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>

      <ConfirmModal
        visible={confirmDelete}
        title={COPY.deleteConfirmTitle}
        message={COPY.deleteConfirmMessage}
        cancelLabel={COPY.cancel}
        confirmLabel={COPY.confirmDelete}
        busy={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void doDelete()}
      />
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="bg-surface rounded-md border border-line-soft p-md gap-sm">
      <Text className="text-sm font-semibold text-ink">{title}</Text>
      {children}
    </View>
  );
}

function ReadonlyRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between py-sm">
      <Text className="text-sm text-ink-muted">{label}</Text>
      <Text className="text-sm font-mono text-ink">{value}</Text>
    </View>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  placeholder?: string;
  value: string;
  onChangeText: (s: string) => void;
  error?: string;
  keyboardType?: 'decimal-pad';
  disabled?: boolean;
  testID: string;
}

// 铁律 4 —— 错误展示 + a11y 一体：label 进 accessibilityLabel，错误经 ErrorRow（role=alert）announce。
function Field({
  label,
  hint,
  placeholder,
  value,
  onChangeText,
  error,
  keyboardType,
  disabled,
  testID,
}: FieldProps) {
  return (
    <View className="gap-xs">
      <Text className="text-xs text-ink-muted">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        editable={!disabled}
        keyboardType={keyboardType}
        placeholder={placeholder}
        placeholderTextColor={colors.ink.subtle}
        accessibilityLabel={label}
        testID={testID}
        className="bg-surface-sunken rounded-md px-md h-11 text-base text-ink"
      />
      {hint ? <Text className="text-xs text-ink-subtle">{hint}</Text> : null}
      {error ? <ErrorRow text={error} /> : null}
    </View>
  );
}
