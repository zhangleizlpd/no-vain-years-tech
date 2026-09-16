import { useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import {
  useAnchorSubmissionControllerList,
  useBrokerAccountControllerBackfillRuns,
  useMarketdataControllerAnchorColdStart,
  type AnchorColdStartRunResponse,
} from '@nvy/api-client';

import { ErrorRow, SafeAreaView, Spinner } from '~/ui';
import {
  coldStartProgress,
  consumedAnchorIds,
  groupColdStartRuns,
} from './anchor-cold-start.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import {
  backfillQueryTickers,
  brokerBackfillLine,
  indexBackfillRunsByTicker,
} from './trading-account-positions.rules';

const COPY = OPTIONSDESK_COPY.anchorSubmission;

/** 服务端单次 `anchorIds` 上限 100；这里留出余量，够看「最近这批」。 */
const MAX_TRACKED_ANCHORS = 50;

/**
 * 072 T021 — 冷启动结局面板（mockup 帧 ⑭；FR-009 / US5）。
 *
 * 「本批新锚」= 待审箱里已 CONSUMED 那些行的 `consumedAnchorId` —— 不另存一份本地清单
 * （本地清单会在换设备 / 清缓存后凭空消失，而那正是「我上次采纳的锚跑成什么了」最需要它的时候）。
 *
 * 🚨 **十档全显、五档置顶**，且分档只认服务端的 `needsAttention`（判据与那十个值同处一点）。
 * 🚨 **缺席 = 排队中，不是失败**：查不到的 anchorId 不出现在结局里，且这有语义。
 *
 * 083 T020 — 每只新锚行下加「券商历史 · 状态 · 时刻」（083 FR-018 / plan D16）：以结局的 ticker 集合请求补齐状态，
 * **按 ticker 合并**；无记录 ⇒「未触发」；该请求失败 ⇒ 只隐藏这一行，结局照常（不并入本屏的加载 / 失败态）。
 */
export function AnchorColdStartScreen() {
  const consumed = useAnchorSubmissionControllerList({ status: 'CONSUMED' });
  const anchorIds = useMemo(
    () => consumedAnchorIds(consumed.data?.data.items ?? [], MAX_TRACKED_ANCHORS),
    [consumed.data],
  );

  const runs = useMarketdataControllerAnchorColdStart(
    { anchorIds: anchorIds.join(',') },
    // 一条 id 都没有时不发请求（空 anchorIds 是 400，且屏上本就该出空态）。
    { query: { enabled: anchorIds.length > 0 } },
  );

  const items = useMemo<AnchorColdStartRunResponse[]>(
    () => runs.data?.data.items ?? [],
    [runs.data],
  );
  const progress = useMemo(() => coldStartProgress(anchorIds, items), [anchorIds, items]);
  const { attention, done } = useMemo(() => groupColdStartRuns(items), [items]);

  // 结局 ≤ MAX_TRACKED_ANCHORS(50) 条 ⇒ tickers 不超过补齐状态接口的 50 上限。
  const backfillTickers = useMemo(() => backfillQueryTickers(items), [items]);
  const backfill = useBrokerAccountControllerBackfillRuns(
    { tickers: backfillTickers.join(',') },
    // 结局未就绪 / 无 ticker 时不发请求（空 tickers 是 400）。
    { query: { enabled: backfillTickers.length > 0 } },
  );
  // 未就绪或失败 ⇒ null ⇒ 各行不渲染券商历史行（FR-018：失败只隐藏这一行）。
  const backfillByTicker = useMemo(
    () =>
      backfill.isError || backfill.data === undefined
        ? null
        : indexBackfillRunsByTicker(backfill.data.data),
    [backfill.isError, backfill.data],
  );
  const backfillLineOf = (ticker: string): string | null =>
    backfillByTicker === null ? null : brokerBackfillLine(ticker, backfillByTicker.get(ticker));

  const loading = consumed.isPending || (anchorIds.length > 0 && runs.isPending);
  const failed = consumed.isError || runs.isError;

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      <Stack.Screen options={{ title: COPY.coldStartTitle }} />

      <View className="flex-1 bg-surface-sunken">
        {loading ? (
          <View className="flex-1 items-center justify-center">
            <Spinner size={16} tone="muted" />
          </View>
        ) : failed ? (
          <View className="gap-sm px-md pt-md">
            <ErrorRow text={COPY.coldStartLoadFailed} />
            <Pressable
              onPress={() => {
                void consumed.refetch();
                void runs.refetch();
              }}
              accessibilityRole="button"
              accessibilityLabel={COPY.retry}
              testID="optionsdesk-cold-start-retry"
            >
              <Text className="text-sm text-brand-500">{COPY.retry}</Text>
            </Pressable>
          </View>
        ) : anchorIds.length === 0 ? (
          <View className="flex-1 items-center justify-center px-xl">
            <Text
              className="text-center text-sm text-ink-muted"
              testID="optionsdesk-cold-start-empty"
            >
              {COPY.coldStartEmpty}
            </Text>
          </View>
        ) : (
          <ScrollView className="flex-1" testID="optionsdesk-cold-start-list">
            {/* 进度：settled / total —— 差额是「排队中」，🚫 不叫「失败」也不叫「未知」。 */}
            <View className="gap-xs bg-surface px-md py-md">
              <View className="flex-row items-center justify-between">
                <Text className="text-sm text-ink">{COPY.coldStartBatch(progress.total)}</Text>
                <Text
                  className="text-sm font-semibold text-ink"
                  testID="optionsdesk-cold-start-progress"
                >
                  {COPY.coldStartSettled(progress.settled, progress.total)}
                </Text>
              </View>
              <Text className="text-xs text-ink-muted">{COPY.coldStartQueueHint}</Text>
            </View>

            {attention.length > 0 ? (
              <View className="mt-sm gap-xs px-md">
                <Text
                  className="text-xs font-semibold text-err"
                  testID="optionsdesk-cold-start-attention-group"
                >
                  {COPY.coldStartAttentionGroup(attention.length)}
                </Text>
                <Text className="text-xs text-ink-muted">{COPY.coldStartAttentionHint}</Text>
                {attention.map((r) => (
                  <RunRow
                    key={r.anchorId}
                    run={r}
                    attention
                    backfillLine={backfillLineOf(r.ticker)}
                  />
                ))}
              </View>
            ) : null}

            {done.length > 0 ? (
              <View className="mt-sm gap-xs px-md">
                <Text
                  className="text-xs font-semibold text-ink-muted"
                  testID="optionsdesk-cold-start-done-group"
                >
                  {COPY.coldStartDoneGroup(done.length)}
                </Text>
                {done.map((r) => (
                  <RunRow key={r.anchorId} run={r} backfillLine={backfillLineOf(r.ticker)} />
                ))}
              </View>
            ) : null}

            {progress.pending > 0 ? (
              <View className="m-md rounded-md border border-dashed border-line-strong p-md">
                <Text
                  className="text-center text-xs text-ink-subtle"
                  testID="optionsdesk-cold-start-pending"
                >
                  {COPY.coldStartPending(progress.pending)}
                </Text>
              </View>
            ) : null}
          </ScrollView>
        )}
      </View>
    </SafeAreaView>
  );
}

interface RunRowProps {
  run: AnchorColdStartRunResponse;
  attention?: boolean;
  /** 「券商历史 · 状态 · 时刻」（083 T020）；null ⇒ 补齐状态未就绪或请求失败，不渲染。 */
  backfillLine: string | null;
}

/** 一行结局。`outcome` **原样呈现**（十档两两互异、禁折叠），reason 作自由文本补充。 */
function RunRow({ run, attention, backfillLine }: RunRowProps) {
  return (
    <View
      className={`gap-xs rounded-md border p-md ${
        attention ? 'border-err bg-err-soft' : 'border-line-soft bg-surface'
      }`}
      testID={`optionsdesk-cold-start-row-${run.ticker}`}
    >
      <View className="flex-row items-center gap-sm">
        <Text className="flex-1 text-sm font-semibold text-ink" numberOfLines={1}>
          {run.ticker}
        </Text>
        <Text
          className={`text-xs ${attention ? 'text-err' : 'text-ink-muted'}`}
          testID={`optionsdesk-cold-start-outcome-${run.ticker}`}
        >
          {run.outcome}
        </Text>
      </View>
      {run.reason ? <Text className="text-xs text-ink-muted">{run.reason}</Text> : null}
      <Text className="text-xs text-ink-subtle">
        {run.targetSession
          ? COPY.coldStartSessionPrefix(run.targetSession)
          : COPY.coldStartNoSession}
      </Text>
      {backfillLine === null ? null : (
        <Text
          className="text-xs text-ink-muted"
          testID={`optionsdesk-cold-start-broker-backfill-${run.ticker}`}
        >
          {backfillLine}
        </Text>
      )}
    </View>
  );
}
