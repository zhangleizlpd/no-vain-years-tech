import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { zodResolver } from '@hookform/resolvers/zod';
import type {
  AnchorFallbackEntryResponse,
  AnchorSubmissionDetailResponse,
  ApproveAnchorSubmissionResponse,
} from '@nvy/api-client';

import { ErrorRow, SafeAreaView, Spinner } from '~/ui';
import {
  approveChanges,
  approveErrorToast,
  asofEdited,
  asofGateExits,
  detailNotice,
  isAsofSuspectError,
  isHalfCommitted,
} from './anchor-submission-detail.rules';
import { asofBadgeLabel, DISPOSITION_LABEL } from './anchor-submission.rules';
import {
  anchorSubmissionFormSchema,
  type AnchorSubmissionFormValues,
} from './anchor-submission.schema';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { underlyingDisplayName } from './underlying-identity.rules';
import {
  useAnchorSubmissionDetail,
  useApproveAnchorSubmission,
  useRejectAnchorSubmissions,
} from './use-anchor-submissions';

const COPY = OPTIONSDESK_COPY.anchorSubmission;

/**
 * 072 T019 — 审批详情屏（mockup 帧 ⑧⑨⑩ + 口径日闸 ⑪⑫ + 回执 ⑬）。
 *
 * 三条不可退让的判断力（各自有纯函数 + 单测，见 `anchor-submission-detail.rules.ts`）：
 *  1. `refresh` 时**逐条列出**会被冲掉的人工位（sb-10）；
 *  2. `willBeNoop` 时**零警告**（sb-11）—— 什么都不写的操作配最吓人的警告 = 训练人闭眼确认；
 *  3. `asofSuggested === null` 时「改送」出口**不渲染**（sb-6）—— 系统不猜。
 */
export function AnchorSubmissionDetailScreen({ id }: { id: string }) {
  const { detail, status, refetch } = useAnchorSubmissionDetail(id);

  if (status === 'loading') {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <View className="flex-1 items-center justify-center bg-surface-sunken">
          <Spinner size={16} tone="muted" />
        </View>
      </SafeAreaView>
    );
  }

  if (status === 'error' || detail === null) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <View className="flex-1 gap-sm bg-surface-sunken px-md pt-md">
          <ErrorRow text={COPY.detailLoadFailed} />
          <Pressable onPress={refetch} accessibilityRole="button" accessibilityLabel={COPY.retry}>
            <Text className="text-sm text-brand-500">{COPY.retry}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // 数据就绪后再挂表单，保证 useForm defaultValues 拿到提交值（同 name-edit golden sample）。
  return <DetailForm key={detail.id} detail={detail} />;
}

function DetailForm({ detail }: { detail: AnchorSubmissionDetailResponse }) {
  const router = useRouter();
  const approve = useApproveAnchorSubmission(detail.id);
  const reject = useRejectAnchorSubmissions();

  const [gateOpen, setGateOpen] = useState(false);
  const [receipt, setReceipt] = useState<ApproveAnchorSubmissionResponse | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const form = useForm<AnchorSubmissionFormValues>({
    resolver: zodResolver(anchorSubmissionFormSchema),
    mode: 'onChange',
    defaultValues: {
      v: detail.v,
      asof: detail.asof,
      method: detail.method,
      confidence: detail.confidence,
      reviewNote: '',
    },
  });
  const { control, formState, getValues } = form;

  const notice = detailNotice(detail);
  // 审核方改过口径日 ⇒ 本地这份 asofSuggested 是按**提交值**算的，对新日期不作数 ⇒ 按
  // 「解不出建议日」渲染（只剩「按原日期照发」）。这与服务端「不猜」是同一个态度。
  const editedAsof = asofEdited(getValues(), detail);
  const gateSuggested = editedAsof ? null : detail.asofSuggested;

  const runApprove = async (asofAck?: 'shift' | 'accept') => {
    setBusy(true);
    setToast(null);
    try {
      const res = await approve(approveChanges(getValues(), detail, asofAck));
      setGateOpen(false);
      setReceipt(res);
    } catch (err) {
      // 🚨 口径日闸的 409 不是错误提示，是**要人做决定** —— 开三出口对话框。
      if (isAsofSuspectError(err)) setGateOpen(true);
      else {
        setGateOpen(false);
        setToast(approveErrorToast(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const runReject = async () => {
    setBusy(true);
    setToast(null);
    try {
      await reject([detail.id], getValues().reviewNote.trim() || undefined);
      router.back();
    } catch (err) {
      setToast(approveErrorToast(err));
    } finally {
      setBusy(false);
    }
  };

  const approveLabel =
    notice === 'noop'
      ? COPY.approveNoop
      : detail.disposition === 'refresh'
        ? COPY.approveRefresh
        : COPY.approve;

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      <Stack.Screen options={{ title: COPY.detailTitle }} />

      <View className="flex-1 bg-surface-sunken">
        <ScrollView className="flex-1" testID="optionsdesk-submission-detail">
          {/* 题头：名字 → 代号 → 「标的不可修改」（FR-006：不是 disabled 输入框，是没有编辑路径）。 */}
          <View className="gap-xs bg-surface px-md py-md">
            <Text className="text-lg font-semibold text-ink" numberOfLines={1}>
              {underlyingDisplayName({ name: detail.instrumentName, ticker: detail.ticker })}
            </Text>
            <View className="flex-row flex-wrap items-center gap-xs">
              <Text className="text-xs text-ink-muted">{detail.ticker}</Text>
              <View className="rounded-sm border border-line px-xs">
                <Text className="text-xs text-ink-subtle">{COPY.tickerLocked}</Text>
              </View>
              <View
                className={`rounded-sm border px-xs ${
                  detail.disposition === 'refresh'
                    ? 'border-warn bg-warn-soft'
                    : 'border-brand-500 bg-brand-soft'
                }`}
                testID="optionsdesk-submission-detail-disposition"
              >
                <Text
                  className={`text-xs ${
                    detail.disposition === 'refresh' ? 'text-warn' : 'text-brand-500'
                  }`}
                >
                  {DISPOSITION_LABEL[detail.disposition]}
                </Text>
              </View>
            </View>
            <Text className="text-xs text-ink-subtle">{COPY.submittedBy(detail.submitter)}</Text>
          </View>

          {/* 提交方附言 —— 决定采不采纳的唯一定性输入，只读。 */}
          {detail.note ? (
            <View className="mt-sm gap-xs bg-surface px-md py-md">
              <Text className="text-xs text-ink-subtle">{COPY.submitterNote}</Text>
              <Text className="text-sm text-ink">{detail.note}</Text>
            </View>
          ) : null}

          {notice === 'fallback' ? (
            <FallbackWarning entries={detail.fallbackPreview} />
          ) : notice === 'noop' ? (
            <View
              className="mt-sm gap-xs border border-line bg-surface px-md py-md"
              testID="optionsdesk-submission-noop-notice"
            >
              <Text className="text-sm font-semibold text-ink">{COPY.noopTitle}</Text>
              <Text className="text-xs text-ink-muted">{COPY.noopHint}</Text>
            </View>
          ) : null}

          <View className="mt-sm bg-surface px-md py-md gap-md">
            <Text className="text-xs text-ink-subtle">{COPY.editableSection}</Text>
            <Field
              control={control}
              name="v"
              label={COPY.vLabel}
              error={formState.errors.v?.message}
            />
            <Field
              control={control}
              name="asof"
              label={COPY.asofLabel}
              error={formState.errors.asof?.message}
              hint={asofBadgeLabel(detail.asofFlag) ?? undefined}
            />
            <Field
              control={control}
              name="method"
              label={COPY.methodLabel}
              error={formState.errors.method?.message}
            />
            <Field
              control={control}
              name="confidence"
              label={COPY.confidenceLabel}
              unit={COPY.confidenceUnit}
              error={formState.errors.confidence?.message}
            />
            <Field
              control={control}
              name="reviewNote"
              label={COPY.reviewNoteLabel}
              placeholder={COPY.reviewNotePlaceholder}
              error={formState.errors.reviewNote?.message}
              multiline
            />
          </View>

          {toast ? (
            <View className="px-md pt-sm">
              <ErrorRow text={toast} />
            </View>
          ) : null}
        </ScrollView>

        <View className="flex-row items-center gap-sm border-t border-line bg-surface px-md py-sm">
          <Pressable
            onPress={() => void runReject()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={COPY.rejectOne}
            testID="optionsdesk-submission-detail-reject"
            className="rounded-md border border-err px-lg py-sm"
          >
            <Text className="text-sm font-semibold text-err">{COPY.rejectOne}</Text>
          </Pressable>
          <Pressable
            onPress={() => void runApprove()}
            disabled={busy || !formState.isValid}
            accessibilityRole="button"
            accessibilityLabel={approveLabel}
            accessibilityState={{ disabled: busy || !formState.isValid, busy }}
            testID="optionsdesk-submission-detail-approve"
            className={`flex-1 items-center rounded-md py-sm ${
              notice === 'noop' ? 'bg-surface-sunken' : 'bg-brand-500'
            }`}
          >
            <Text
              className={`text-sm font-semibold ${
                notice === 'noop' ? 'text-ink-muted' : 'text-surface'
              }`}
            >
              {approveLabel}
            </Text>
          </Pressable>
        </View>
      </View>

      <AsofGateSheet
        visible={gateOpen}
        detail={detail}
        suggested={gateSuggested}
        busy={busy}
        onExit={(exit) => {
          if (exit === 'cancel') setGateOpen(false);
          else void runApprove(exit);
        }}
      />

      <ApproveReceipt
        receipt={receipt}
        onDone={() => {
          setReceipt(null);
          router.back();
        }}
      />
    </SafeAreaView>
  );
}

/** 🚨 逐条列出会被冲掉的人工位（sb-10）—— 「3 处」这种汇总数字掩盖的正是「哪一处」。 */
function FallbackWarning({ entries }: { entries: AnchorFallbackEntryResponse[] }) {
  return (
    <View
      className="mt-sm gap-xs border border-warn bg-warn-soft px-md py-md"
      testID="optionsdesk-submission-fallback-warning"
    >
      <Text className="text-sm font-semibold text-ink">{COPY.fallbackTitle(entries.length)}</Text>
      <Text className="text-xs text-ink-muted">{COPY.fallbackHint}</Text>
      {entries.map((e) => (
        <View
          key={`${e.ticker}-${e.slot}`}
          className="flex-row items-center gap-xs"
          testID={`optionsdesk-submission-fallback-${e.slot}`}
        >
          <Text className="text-xs text-ink-muted">{e.slot}</Text>
          <Text className="text-xs text-ink">{e.manualValue}</Text>
          <Text className="text-xs text-ink-subtle">→</Text>
          {/* L4 档无上限口径 ⇒ fallbackValue 为 null，屏上给「—」，🚫 不自造一个值。 */}
          <Text className="text-xs text-ink">{e.fallbackValue ?? COPY.fallbackNoValue}</Text>
        </View>
      ))}
      <Text className="text-xs text-ink-muted">{COPY.fallbackConfidenceHint}</Text>
    </View>
  );
}

function AsofGateSheet({
  visible,
  detail,
  suggested,
  busy,
  onExit,
}: {
  visible: boolean;
  detail: AnchorSubmissionDetailResponse;
  suggested: string | null;
  busy: boolean;
  onExit: (exit: 'shift' | 'accept' | 'cancel') => void;
}) {
  const exits = asofGateExits(suggested);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => onExit('cancel')}
    >
      <View className="flex-1 justify-end bg-modal-overlay">
        <View
          className="gap-sm rounded-t-lg bg-surface p-lg"
          testID="optionsdesk-submission-asof-gate"
        >
          <Text className="text-base font-semibold text-ink">
            {detail.asofFlag === 'UNKNOWN' ? COPY.asofGateUnknownTitle : COPY.asofGateTitle}
          </Text>

          {/* 复述闸：把「要改的到底是哪条估值」原样摆回来，人才可能发现自己点错了行。 */}
          <View className="gap-xs rounded-md bg-surface-sunken p-md">
            <RestateRow
              k={COPY.asofGateRestateTicker}
              v={`${detail.instrumentName ?? ''} ${detail.ticker}`.trim()}
            />
            <RestateRow k={COPY.asofLabel} v={detail.asof} tag={asofBadgeLabel(detail.asofFlag)} />
            <RestateRow k={COPY.vLabel} v={detail.v} />
            <RestateRow
              k={COPY.confidenceLabel}
              v={`${detail.confidence} ${COPY.confidenceUnit}`}
            />
          </View>

          <Text className="text-xs text-ink-muted">
            {suggested === null ? COPY.asofGateNoSuggestion : COPY.asofGateWarn}
          </Text>

          {exits.map((exit) => (
            <Pressable
              key={exit}
              onPress={() => onExit(exit)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={
                exit === 'shift'
                  ? COPY.asofExitShift(suggested ?? '')
                  : exit === 'accept'
                    ? COPY.asofExitAccept
                    : COPY.asofExitCancel
              }
              testID={`optionsdesk-submission-asof-exit-${exit}`}
              className={`items-center rounded-md py-md ${
                exit === 'shift'
                  ? 'bg-brand-500'
                  : exit === 'accept'
                    ? 'border border-line bg-surface'
                    : 'bg-surface'
              }`}
            >
              <Text
                className={`text-sm font-semibold ${
                  exit === 'shift' ? 'text-surface' : 'text-ink-muted'
                }`}
              >
                {exit === 'shift'
                  ? COPY.asofExitShift(suggested ?? '')
                  : exit === 'accept'
                    ? COPY.asofExitAccept
                    : COPY.asofExitCancel}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

function RestateRow({ k, v, tag }: { k: string; v: string; tag?: string | null }) {
  return (
    <View className="flex-row items-center gap-sm">
      <Text className="w-16 text-xs text-ink-subtle">{k}</Text>
      <Text className="flex-1 text-sm text-ink">{v}</Text>
      {tag ? <Text className="text-xs text-warn">{tag}</Text> : null}
    </View>
  );
}

function ApproveReceipt({
  receipt,
  onDone,
}: {
  receipt: ApproveAnchorSubmissionResponse | null;
  onDone: () => void;
}) {
  if (receipt === null) return null;
  const actionLabel =
    receipt.action === 'create'
      ? COPY.receiptActionCreate
      : receipt.action === 'update'
        ? COPY.receiptActionUpdate
        : COPY.receiptActionNoop;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDone}>
      <View className="flex-1 justify-center px-lg bg-modal-overlay">
        <View className="gap-sm rounded-lg bg-surface p-lg" testID="optionsdesk-submission-receipt">
          <Text className="text-base font-semibold text-ink">{COPY.receiptWritten}</Text>
          <RestateRow k={COPY.receiptActionLabel} v={actionLabel} />
          <RestateRow k={COPY.receiptAnchorId} v={receipt.anchorId} />
          <RestateRow k={COPY.receiptAppliedAsof} v={receipt.appliedAsof} />
          <RestateRow
            k={COPY.receiptColdStart}
            v={receipt.coldStartExpected ? COPY.receiptColdStartQueued : COPY.receiptColdStartNone}
          />

          {/* 本次**真正**冲掉的人工位（与采纳前预览是两件事：这条是既成事实）。 */}
          {receipt.fallbackEntries.length > 0 ? (
            <Text className="text-xs text-warn" testID="optionsdesk-submission-receipt-fallback">
              {COPY.receiptFallbackTitle(receipt.fallbackEntries.length)}
            </Text>
          ) : null}

          {/* 🚨 半截态：不是失败，且 MUST NOT 重试（会写第二遍锚）。 */}
          {isHalfCommitted(receipt) ? (
            <View
              className="gap-xs rounded-md border border-warn bg-warn-soft p-md"
              testID="optionsdesk-submission-receipt-half"
            >
              <Text className="text-sm font-semibold text-warn">{COPY.receiptHalfTitle}</Text>
              <Text className="text-xs text-ink-muted">{COPY.receiptHalfHint}</Text>
            </View>
          ) : null}

          <Pressable
            onPress={onDone}
            accessibilityRole="button"
            accessibilityLabel={COPY.receiptDone}
            testID="optionsdesk-submission-receipt-done"
            className="items-center rounded-md bg-brand-500 py-sm"
          >
            <Text className="text-sm font-semibold text-surface">{COPY.receiptDone}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Field({
  control,
  name,
  label,
  unit,
  hint,
  placeholder,
  error,
  multiline,
}: {
  control: ReturnType<typeof useForm<AnchorSubmissionFormValues>>['control'];
  name: keyof AnchorSubmissionFormValues;
  label: string;
  unit?: string;
  hint?: string;
  placeholder?: string;
  error?: string;
  multiline?: boolean;
}) {
  return (
    <View className="gap-xs">
      <View className="flex-row items-center gap-xs">
        <Text className="text-xs text-ink-subtle">{label}</Text>
        {hint ? <Text className="text-xs text-warn">{hint}</Text> : null}
      </View>
      {/* 铁律 1 — <Controller> 包 TextInput（非 register）。 */}
      <Controller
        control={control}
        name={name}
        render={({ field }) => (
          <TextInput
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            placeholder={placeholder}
            multiline={multiline}
            accessibilityLabel={label}
            testID={`optionsdesk-submission-field-${name}`}
            className={`rounded-md border px-md py-sm text-base text-ink ${
              error ? 'border-err' : 'border-line'
            }`}
          />
        )}
      />
      {unit ? <Text className="text-xs text-ink-subtle">{unit}</Text> : null}
      {error ? <ErrorRow text={error} /> : null}
    </View>
  );
}
