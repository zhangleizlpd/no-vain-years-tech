import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { RejectAnchorSubmissionsResponse } from '@nvy/api-client';

import { ConfirmModal, ErrorRow, SafeAreaView, Spinner } from '~/ui';
import { AnchorSubmissionRow } from './anchor-submission-row';
import {
  filterSubmissions,
  SUBMISSION_MARKET_FILTERS,
  submissionMarketCounts,
  toggleSubmissionSelection,
  visibleSelection,
  type SubmissionMarketFilter,
} from './anchor-submission.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { optionsdeskAnchorSubmissionRoute } from './optionsdesk-routes';
import { useAnchorSubmissions, useRejectAnchorSubmissions } from './use-anchor-submissions';

const COPY = OPTIONSDESK_COPY.anchorSubmission;

const FILTER_LABEL: Record<SubmissionMarketFilter, string> = {
  all: COPY.filterAll,
  us: COPY.filterUs,
  hk: COPY.filterHk,
};

/**
 * 072 T018 — 全屏待审列表（mockup 帧 ⑤⑥⑦）。二级页，「我的」审批栏「查看全部」进入。
 *
 * 🚨 **驳回可批量、采纳不可批量**（FR-007）—— 判据是副作用数量而非对称性：驳回只翻一个
 * status，采纳会落锚、冲人工位、排冷启动。故本屏只有批量驳回，采纳一律逐条进详情（T019）。
 */
export function AnchorSubmissionListScreen() {
  const router = useRouter();
  const { items, total, truncated, status, refetch } = useAnchorSubmissions();
  const reject = useRejectAnchorSubmissions();

  const [filter, setFilter] = useState<SubmissionMarketFilter>('all');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<RejectAnchorSubmissionsResponse | null>(null);
  const [failed, setFailed] = useState(false);

  const counts = useMemo(() => submissionMarketCounts(items), [items]);
  const rows = useMemo(() => filterSubmissions(items, filter), [items, filter]);
  // 🚨 只驳回**当前可见**的选中项：切 chip 会让已选行离开视野，而看不见的选中项照样会被
  // 驳回 —— 「屏上选了 3 条、实际驳回 5 条」是不可接受的偏差。
  const targets = useMemo(
    () =>
      visibleSelection(
        selected,
        rows.map((r) => r.id),
      ),
    [selected, rows],
  );

  const exitSelect = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const submitReject = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const result = await reject(targets);
      setNotice(result);
      exitSelect();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: selecting ? COPY.selectTitle : COPY.title,
          headerRight: () => (
            <Pressable
              onPress={() => (selecting ? exitSelect() : setSelecting(true))}
              accessibilityRole="button"
              accessibilityLabel={selecting ? COPY.cancelSelect : COPY.select}
              testID="optionsdesk-submission-select-toggle"
            >
              <Text className="text-sm text-brand-500 px-md">
                {selecting ? COPY.cancelSelect : COPY.select}
              </Text>
            </Pressable>
          ),
        }}
      />

      <View className="flex-1 bg-surface-sunken">
        {/* 市场 chips（单选）。横滑容器包一层 View 约束 frame（NativeWind web 坑）。 */}
        <View className="px-md py-sm">
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-sm">
              {SUBMISSION_MARKET_FILTERS.map((f) => {
                const on = filter === f;
                return (
                  <Pressable
                    key={f}
                    onPress={() => setFilter(f)}
                    accessibilityRole="button"
                    accessibilityLabel={FILTER_LABEL[f]}
                    accessibilityState={{ selected: on }}
                    testID={`optionsdesk-submission-filter-${f}`}
                    className={`rounded-full border px-md py-xs ${
                      on ? 'border-brand-500 bg-brand-soft' : 'border-line bg-surface'
                    }`}
                  >
                    <Text className={`text-sm ${on ? 'text-brand-500' : 'text-ink-muted'}`}>
                      {FILTER_LABEL[f]} {counts[f]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </View>

        {/* 计数条：提交方缺失时只出前半句（不编「未知提交方」）。 */}
        {status === 'ready' && items.length > 0 ? (
          <View className="px-md pb-sm">
            <Text className="text-xs text-ink-muted" testID="optionsdesk-submission-count">
              {COPY.pendingCount(total)}
              {items[0]?.submitter ? COPY.submitterSuffix(items[0].submitter) : ''}
            </Text>
            {truncated ? (
              <Text className="pt-xs text-xs text-warn" testID="optionsdesk-submission-truncated">
                {COPY.truncated}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* 驳回结局：rejected 与 skipped 分别成句 —— MUST NOT 折成一句 ok（FR-007）。 */}
        {notice ? (
          <View className="mx-md mb-sm rounded-md border border-line bg-surface p-md gap-xs">
            <Text className="text-sm text-ink" testID="optionsdesk-submission-reject-done">
              {COPY.rejectDone(notice.rejected)}
            </Text>
            {notice.skipped.length > 0 ? (
              <Text className="text-xs text-warn" testID="optionsdesk-submission-reject-skipped">
                {COPY.rejectSkipped(notice.skipped.length)}
              </Text>
            ) : null}
            <Pressable
              onPress={() => setNotice(null)}
              accessibilityRole="button"
              accessibilityLabel={COPY.dismissNotice}
              testID="optionsdesk-submission-notice-dismiss"
            >
              <Text className="text-sm text-brand-500">{COPY.dismissNotice}</Text>
            </Pressable>
          </View>
        ) : null}

        {failed ? (
          <View className="px-md pb-sm">
            <ErrorRow text={COPY.rejectFailed} />
          </View>
        ) : null}

        {status === 'loading' ? (
          <View className="flex-1 items-center justify-center">
            <Spinner size={16} tone="muted" />
          </View>
        ) : status === 'error' ? (
          <View className="px-md gap-sm">
            <ErrorRow text={COPY.loadFailed} />
            <Pressable
              onPress={refetch}
              accessibilityRole="button"
              accessibilityLabel={COPY.retry}
              testID="optionsdesk-submission-retry"
            >
              <Text className="text-sm text-brand-500">{COPY.retry}</Text>
            </Pressable>
          </View>
        ) : rows.length === 0 ? (
          // 两种空态不复用文案：待审箱真空了（好消息）vs 该市场没有（切回全部就有）。
          <View className="flex-1 items-center justify-center gap-xs px-xl">
            {items.length === 0 ? (
              <>
                <Text
                  className="text-base font-semibold text-ink"
                  testID="optionsdesk-submission-list-empty"
                >
                  {COPY.emptyTitle}
                </Text>
                <Text className="text-sm text-ink-muted text-center">{COPY.emptyHint}</Text>
              </>
            ) : (
              <Text
                className="text-sm text-ink-muted text-center"
                testID="optionsdesk-submission-filter-empty"
              >
                {COPY.emptyFiltered}
              </Text>
            )}
          </View>
        ) : (
          <ScrollView className="flex-1" testID="optionsdesk-submission-list">
            <View className="px-md pb-lg gap-sm">
              {rows.map((item) => (
                <AnchorSubmissionRow
                  key={item.id}
                  item={item}
                  selected={selecting ? selected.has(item.id) : undefined}
                  onPress={
                    selecting
                      ? () => setSelected((cur) => toggleSubmissionSelection(cur, item.id))
                      : () => router.push(optionsdeskAnchorSubmissionRoute(item.id))
                  }
                />
              ))}
            </View>
          </ScrollView>
        )}

        {selecting ? (
          <View className="flex-row items-center justify-between border-t border-line bg-surface px-md py-sm">
            <Text className="text-sm text-ink-muted" testID="optionsdesk-submission-selected-count">
              {COPY.selectedCount(targets.length)}
            </Text>
            <View className="flex-row items-center gap-md">
              <Pressable
                onPress={() => setSelected(new Set())}
                accessibilityRole="button"
                accessibilityLabel={COPY.clearSelection}
                testID="optionsdesk-submission-clear-selection"
              >
                <Text className="text-sm text-ink-muted">{COPY.clearSelection}</Text>
              </Pressable>
              <Pressable
                onPress={() => setConfirming(true)}
                disabled={targets.length === 0}
                accessibilityRole="button"
                accessibilityLabel={COPY.reject}
                accessibilityState={{ disabled: targets.length === 0 }}
                testID="optionsdesk-submission-reject"
                className={`rounded-md px-lg py-sm ${
                  targets.length === 0 ? 'bg-surface-sunken' : 'bg-err'
                }`}
              >
                <Text
                  className={`text-sm font-semibold ${
                    targets.length === 0 ? 'text-ink-subtle' : 'text-surface'
                  }`}
                >
                  {COPY.reject}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>

      <ConfirmModal
        visible={confirming}
        title={COPY.rejectConfirmTitle(targets.length)}
        message={COPY.rejectConfirmMessage}
        cancelLabel={COPY.rejectCancel}
        confirmLabel={COPY.reject}
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void submitReject()}
      />
    </SafeAreaView>
  );
}
