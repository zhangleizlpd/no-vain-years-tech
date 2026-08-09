import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { AlertInstrumentEntryMarket } from '@nvy/api-client';

import { ErrorRow, Spinner } from '~/ui';
import { colors } from '~/theme';
import { ALERT_COPY, conditionName, conditionValueLabel } from './alert-copy';
import { AlertIcon } from './alert-icon';
import { FrequencySheet } from './frequency-sheet';
import { InstrumentQuoteStrip } from './instrument-quote-strip';
import {
  type DraftCondition,
  draftSubmittable,
  MAX_CONDITIONS,
  multiSelectQuota,
  toConditionEntries,
  useAlertDraft,
} from './use-alert-draft';
import {
  NOTE_MAX_CODE_POINTS,
  noteCodePointCount,
  useAlertMutations,
  useAllAlerts,
} from './use-alerts';
import { ValueInputSheet } from './value-input-sheet';

// 屏 2 编辑/新建预警（021 US1 / FR-M02，mockup AlertEditScreen 翻 RN）。本地草稿态
// （use-alert-draft，屏 3 共享）：条件区（动态橙 N + 行 名称/参数框/删除）+ 添加附加条件
// + 配置区（推送方式只读无 chevron / 频率 sheet / 备注 n/22）+ 编辑态「删除预警」。
// 完成一次提交：编辑 → EP4 全量替换；新建 → EP3 批量（单只=1 元素）。批量新建（屏 4 多选）
// 无单一行情条 → FR-M09 灰字提示行。编辑目标从 EP2 cache/query 取（深链硬刷新可达）。

const COPY = ALERT_COPY.editScreen;

export interface AlertEditScreenProps {
  /** 编辑目标（与 instruments 互斥；优先生效）。 */
  alertId?: string;
  /** 新建标的（屏 1 单只 / 屏 4 批量）。 */
  instruments?: { market: string; code: string }[];
}

export function AlertEditScreen({ alertId, instruments }: AlertEditScreenProps) {
  const router = useRouter();
  const draft = useAlertDraft();
  const { createAlerts, updateAlert, deleteAlerts, errorToast } = useAlertMutations();
  // 编辑态数据源：EP2 全账号列表（列表入口已有 cache；深链时发查询）。
  const { alerts, status, isFetching } = useAllAlerts();
  const [submitting, setSubmitting] = useState(false);
  const [freqSheetOpen, setFreqSheetOpen] = useState(false);
  /** 参数框再编辑目标（含原 param 以便改 param 时删旧加新；null = 关）。 */
  const [editing, setEditing] = useState<DraftCondition | null>(null);

  const isEdit = alertId != null;
  const editTarget = isEdit ? alerts.find((a) => a.id === alertId) : undefined;
  const initKey = isEdit
    ? `edit:${alertId}`
    : `new:${(instruments ?? []).map((i) => `${i.market}:${i.code}`).join(',')}`;

  // 防重入 init：编辑等 EP2 数据就位**且 refetch 落定**（提交是 conditions 全量
  // 替换——seed 到陈旧基线会把它整体写回 server，多设备/刚失效场景静默回滚，
  // 022 真机走查 21000 漂移实证）；新建立即。返屏（屏 3 back）不重置草稿。
  useEffect(() => {
    if (draft.initKey === initKey) return;
    if (isEdit) {
      if (editTarget && !isFetching) draft.startEdit(initKey, editTarget);
    } else if (instruments && instruments.length > 0) {
      draft.startNew(initKey, instruments);
    }
  }, [draft, initKey, isEdit, editTarget, instruments, isFetching]);

  // 离开编辑流程（屏 pop unmount）即弃草稿（use-alert-draft「离开流程即弃」语义；
  // 此前仅提交/删除 reset，头部返回退出会让草稿带 initKey 残留，下次进同一
  // alert 命中防重入跳过 re-seed → 渲染陈旧草稿）。屏 2↔3 为 stack push，屏 2
  // 不 unmount，跨屏草稿不受影响；提交/删除路径的 reset 幂等叠加。
  useEffect(() => () => useAlertDraft.getState().reset(), []);

  const inited = draft.initKey === initKey;
  const submittable = inited && draftSubmittable(draft.conditions, draft.note);
  const single = draft.instruments.length === 1 ? draft.instruments[0] : null;

  // 026 多选编辑 seed：再开 sheet 时预勾选草稿内同 type 全部已存 param（FR-009）。memo 稳引用
  // 避免每渲染重置 sheet 选中集。提交走 reconcile（全兄弟已预勾选 → 不误删）。
  const editingParams = useMemo(
    () =>
      editing != null
        ? draft.conditions.filter((c) => c.type === editing.type).map((c) => c.param)
        : [],
    [editing, draft.conditions],
  );
  const editingQuotaMax =
    editing != null ? multiSelectQuota(draft.conditions, editing.type).max : MAX_CONDITIONS;

  const onDone = async () => {
    if (!submittable || submitting) return;
    setSubmitting(true);
    const payload = {
      conditions: toConditionEntries(draft.conditions),
      frequency: draft.frequency,
      note: draft.note.trim() === '' ? null : draft.note,
    };
    try {
      if (isEdit && editTarget) {
        await updateAlert(
          { id: editTarget.id, market: editTarget.market, code: editTarget.code },
          payload,
        );
      } else {
        await createAlerts({
          instruments: draft.instruments.map((i) => ({
            market: i.market as AlertInstrumentEntryMarket,
            code: i.code,
          })),
          ...payload,
        });
      }
      draft.reset();
      router.back();
    } catch {
      // errorToast 已由 useAlertMutations 分流展示，留在本屏供修正。
    } finally {
      setSubmitting(false);
    }
  };

  const onDeleteAlert = async () => {
    if (!editTarget || submitting) return;
    setSubmitting(true);
    try {
      await deleteAlerts([editTarget.id], [editTarget]);
      draft.reset();
      router.back();
    } catch {
      // 同上。
    } finally {
      setSubmitting(false);
    }
  };

  const headerRight = (
    <Pressable
      onPress={() => void onDone()}
      disabled={!submittable || submitting}
      accessibilityRole="button"
      accessibilityLabel={COPY.done}
      accessibilityState={{ disabled: !submittable || submitting }}
    >
      <Text
        className={`text-base ${submittable && !submitting ? 'text-brand-500' : 'text-ink-subtle'}`}
      >
        {COPY.done}
      </Text>
    </Pressable>
  );

  // 编辑深链 EP2 尚未就位 → spinner（错误走列表同款 errorToast 面）。
  const pendingEdit = isEdit && !inited && status === 'loading';

  return (
    <View className="flex-1 bg-surface-sunken">
      <Stack.Screen
        options={{
          title: isEdit ? COPY.titleEdit : COPY.titleNew,
          headerRight: () => headerRight,
        }}
      />
      {single ? (
        <InstrumentQuoteStrip market={single.market} code={single.code} />
      ) : (
        <View className="bg-surface px-md py-sm border-b border-line-soft">
          <Text className="text-sm text-ink-subtle">
            {COPY.batchHint}（{draft.instruments.length}）
          </Text>
        </View>
      )}
      {pendingEdit ? (
        <View className="flex-1 items-center justify-center">
          <Spinner />
        </View>
      ) : (
        <ScrollView className="flex-1">
          {errorToast ? (
            <View className="px-md py-sm">
              <ErrorRow text={errorToast} />
            </View>
          ) : null}

          {/* 预警条件区 */}
          <View className="bg-surface mt-sm">
            <View className="flex-row items-baseline justify-between px-md pt-md pb-xs">
              <Text className="text-base font-semibold text-ink">{COPY.sectionTitle}</Text>
              <Text className="text-xs text-ink-subtle">
                {COPY.metBefore}
                <Text className="font-mono font-semibold text-accent">
                  {draft.conditions.length}
                </Text>
                {COPY.metAfter}
              </Text>
            </View>
            {draft.conditions.map((c) => {
              // 含参摘要走 T014 值-only 渲染；无参类型（none kind）空串 → 不渲染可点值 chip。
              const valueLabel = conditionValueLabel(c);
              return (
                <View
                  key={`${c.type}:${c.param}`}
                  className="flex-row items-center gap-md px-md py-sm"
                >
                  <Text className="text-base text-ink w-20">{conditionName(c.type)}</Text>
                  <View className="flex-1 flex-row justify-end">
                    {valueLabel ? (
                      <Pressable
                        onPress={() => setEditing(c)}
                        accessibilityRole="button"
                        accessibilityLabel={`${conditionName(c.type)}参数`}
                        className="bg-surface-sunken rounded-md px-md py-sm min-w-24 items-center"
                      >
                        <Text className="text-base font-mono text-ink">{valueLabel}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <Pressable
                    onPress={() => draft.remove(c.type, c.param)}
                    accessibilityRole="button"
                    accessibilityLabel={`${COPY.removeCondition}${conditionName(c.type)}`}
                    className="border border-err rounded-md px-md py-xs"
                  >
                    <Text className="text-sm text-err">{COPY.removeCondition}</Text>
                  </Pressable>
                </View>
              );
            })}
            <View className="items-center py-md">
              <Pressable
                onPress={() => router.push('/(app)/alert/add-condition')}
                disabled={draft.conditions.length >= MAX_CONDITIONS}
                accessibilityRole="button"
                accessibilityLabel={COPY.addCondition}
                className={`flex-row items-center gap-xs ${
                  draft.conditions.length >= MAX_CONDITIONS ? 'opacity-40' : ''
                }`}
              >
                <AlertIcon name="plusCircle" color={colors.brand[500]} size={20} />
                <Text className="text-sm font-medium text-brand-500">{COPY.addCondition}</Text>
              </Pressable>
            </View>
          </View>

          {/* 配置区 */}
          <View className="bg-surface mt-sm">
            <View className="flex-row items-center px-md py-md border-b border-line-soft">
              <Text className="text-base text-ink flex-1">{COPY.push}</Text>
              <Text className="text-sm text-ink-muted">{COPY.pushValue}</Text>
            </View>
            <Pressable
              onPress={() => setFreqSheetOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={COPY.frequency}
              className="flex-row items-center px-md py-md border-b border-line-soft"
            >
              <Text className="text-base text-ink flex-1">{COPY.frequency}</Text>
              <Text className="text-sm text-ink-muted">
                {ALERT_COPY.frequency[draft.frequency].title}
              </Text>
              <AlertIcon name="chevron" color={colors.line.strong} size={18} />
            </Pressable>
            <View className="flex-row items-center gap-sm px-md py-sm">
              <Text className="text-base text-ink">{COPY.note}</Text>
              <TextInput
                value={draft.note}
                onChangeText={draft.setNote}
                placeholder={COPY.notePlaceholder}
                accessibilityLabel={COPY.note}
                className="flex-1 text-sm text-ink py-sm"
              />
              <Text
                className={`text-xs font-mono ${
                  noteCodePointCount(draft.note) > NOTE_MAX_CODE_POINTS
                    ? 'text-err'
                    : 'text-ink-subtle'
                }`}
              >
                {noteCodePointCount(draft.note)}/{NOTE_MAX_CODE_POINTS}
              </Text>
            </View>
          </View>

          {/* 删除预警（仅编辑态） */}
          {isEdit ? (
            <Pressable
              onPress={() => void onDeleteAlert()}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel={COPY.deleteAlert}
              className="bg-surface mt-sm py-md items-center"
            >
              <Text className="text-base font-medium text-err">{COPY.deleteAlert}</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      )}

      <FrequencySheet
        visible={freqSheetOpen}
        value={draft.frequency}
        onConfirm={(f) => {
          draft.setFrequency(f);
          setFreqSheetOpen(false);
        }}
        onClose={() => setFreqSheetOpen(false)}
      />
      <ValueInputSheet
        type={editing?.type ?? null}
        initialParams={editingParams}
        initialThreshold={editing?.threshold ?? ''}
        quotaMax={editingQuotaMax}
        market={single?.market}
        code={single?.code}
        onConfirm={(params, threshold) => {
          // 026：sheet 多选编辑 → reconcile 对齐本 type 选中集（同 type 已全预勾选，删未选/留他
          // type，替代旧 key-preserving remove+upsert；值类单实例 reconcile([0]) 等价 upsert）。
          if (editing) draft.reconcile(editing.type, params, threshold);
          setEditing(null);
        }}
        onClose={() => setEditing(null)}
      />
    </View>
  );
}
