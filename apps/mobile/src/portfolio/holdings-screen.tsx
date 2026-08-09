import { useState } from 'react';
import { FlatList, Modal, Pressable, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import { Button, Spinner, Tabs } from '~/ui';
import { formatSignedAmount, formatAmount, pnlDirection } from './holdings.helpers';
import { quoteColorClass } from './use-quote-merge';
import { useHoldings } from './use-holdings';
import { useHoldingsImport, importedCounts } from './use-holdings-import';
import { HoldingRow, ClosedRow } from './holdings-rows';
import { HOLDINGS_COPY } from './holdings-copy';
import type { ImportSummaryResponse } from '@nvy/api-client';

// 持仓屏（025 US2，mockup HoldingsKit 屏1 baseline）。汇总条（总市值实时合成 + 总累计盈亏
// 快照红绿 + asOf 标注唯一一处）+ 双 tab（当前持仓/已清仓）+ 行点入交易历史。空态 + headerRight
// 「＋」走 App 内导入（复用 server EP1 multipart，本机同步工具仍可用）。行情 = 015 quote
// client-merge（ADR-0048）。

const COPY = HOLDINGS_COPY.screen;
const IMPORT = COPY.import;

function SummaryBar({
  totalMarketValue,
  totalCumPnl,
  asOf,
}: {
  totalMarketValue: number | null;
  totalCumPnl: number | null;
  asOf: string;
}) {
  const pnlClass = quoteColorClass(pnlDirection(totalCumPnl));
  return (
    <View className="bg-surface px-md pt-sm pb-md border-b border-line-soft">
      <View className="flex-row items-end">
        <View className="flex-1">
          <Text className="text-xs text-ink-subtle">{COPY.summary.totalValue}</Text>
          <Text className="text-2xl font-bold text-ink mt-xs">
            {formatAmount(totalMarketValue)}
          </Text>
        </View>
        <View className="items-end">
          <Text className="text-xs text-ink-subtle">{COPY.summary.totalPnl}</Text>
          <Text className={`text-xl font-bold mt-xs ${pnlClass}`}>
            {formatSignedAmount(totalCumPnl)}
          </Text>
        </View>
      </View>
      {/* asOf 标注：快照口径，MM-DD（mockup 汇总条底部整行；不暗示实时性）。 */}
      <Text className="text-xs text-ink-subtle mt-sm">
        {COPY.summary.asOfPrefix} {asOf.slice(5)}
      </Text>
    </View>
  );
}

function EmptyState({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View className="items-center gap-xs px-xl py-2xl">
      <Text className="text-base font-medium text-ink-muted">{title}</Text>
      {sub ? <Text className="text-sm text-ink-subtle text-center">{sub}</Text> : null}
      {action ? (
        <View className="mt-md">
          <Button label={action.label} onPress={action.onPress} />
        </View>
      ) : null}
    </View>
  );
}

// headerRight「＋」导入入口。忙态转 spinner + 锁重入（忙态单源在 useHoldingsImport）。
function ImportButton({ busy, onPress }: { busy: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={busy ? undefined : onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={IMPORT.a11y}
      accessibilityState={{ disabled: busy, busy }}
      className="px-md"
    >
      {busy ? (
        <Spinner size={16} tone="muted" />
      ) : (
        <Text className="text-2xl text-brand-500">＋</Text>
      )}
    </Pressable>
  );
}

// 导入摘要行：「已导入 N 持仓 · M 已清仓 · K 交易（跳过 X 行）」。跳过 0 时省略尾注。
function formatSummary(result: ImportSummaryResponse): string {
  const c = importedCounts(result);
  const base = `${IMPORT.done} ${c.holdings} ${IMPORT.unit.holdings} · ${c.closed} ${IMPORT.unit.closed} · ${c.trades} ${IMPORT.unit.trades}`;
  return c.skipped > 0 ? `${base}（${IMPORT.skipped} ${c.skipped} ${IMPORT.rowsUnit}）` : base;
}

// 导入结果 / 错误居中对话框（单「完成」键，体例镜像 ~/ui ConfirmModal）。成功显摘要、失败显
// 映射文案；scrim 点击 = 关闭。
function ImportResultModal({
  visible,
  title,
  message,
  onDismiss,
}: {
  visible: boolean;
  title: string;
  message: string;
  onDismiss: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <View className="flex-1 bg-modal-overlay items-center justify-center px-xl">
        <Pressable
          onPress={onDismiss}
          accessibilityLabel={IMPORT.dismiss}
          className="absolute inset-0"
        />
        <View
          className="bg-surface rounded-lg px-lg pt-lg pb-md shadow-modal"
          style={{ width: '100%', maxWidth: 300 }}
        >
          <Text className="text-base font-semibold text-ink text-center">{title}</Text>
          <Text className="text-sm text-ink-muted text-center mt-sm" style={{ lineHeight: 21 }}>
            {message}
          </Text>
          <View className="mt-lg">
            <Button label={IMPORT.dismiss} onPress={onDismiss} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

type HoldingsTab = 'current' | 'closed';

export function HoldingsScreen() {
  const router = useRouter();
  const { asOf, current, closed, summary, quotes, status, refetch } = useHoldings();
  const imp = useHoldingsImport();
  const [tab, setTab] = useState<HoldingsTab>('current');

  if (status === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-surface">
        <Spinner />
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View className="flex-1 items-center justify-center gap-md bg-surface px-md">
        <Text className="text-base text-ink-muted">{COPY.load.error}</Text>
        <Button label={COPY.load.retry} onPress={() => refetch()} />
      </View>
    );
  }

  // 行点入标的交易历史（canonical `cn:603915` 体例，014 同款）。
  const openTrades = (market: string, code: string) =>
    router.push(`/(app)/portfolio/trades/${market}:${code}`);

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => <ImportButton busy={imp.isImporting} onPress={imp.pickAndImport} />,
        }}
      />
      <View className="flex-1 bg-surface-sunken">
        {asOf != null ? (
          <SummaryBar
            totalMarketValue={summary.totalMarketValue}
            totalCumPnl={summary.totalCumPnl}
            asOf={asOf}
          />
        ) : null}
        <Tabs
          tabs={[
            { id: 'current', name: COPY.tabs.current },
            { id: 'closed', name: COPY.tabs.closed },
          ]}
          activeId={tab}
          onSelect={(id) => setTab(id as HoldingsTab)}
        />
        {tab === 'current' ? (
          <FlatList
            data={current}
            keyExtractor={(it) => it.id}
            renderItem={({ item }) => (
              <HoldingRow
                item={item}
                quote={quotes.quoteFor(item)}
                onPress={() => openTrades(item.market, item.code)}
              />
            )}
            className="flex-1"
            ListEmptyComponent={
              <EmptyState
                title={COPY.empty.current.title}
                sub={COPY.empty.current.sub}
                action={{ label: IMPORT.action, onPress: imp.pickAndImport }}
              />
            }
          />
        ) : (
          <FlatList
            data={closed}
            keyExtractor={(it) => it.id}
            renderItem={({ item }) => (
              <ClosedRow item={item} onPress={() => openTrades(item.market, item.code)} />
            )}
            className="flex-1"
            ListEmptyComponent={<EmptyState title={COPY.empty.closed.title} />}
          />
        )}
      </View>
      <ImportResultModal
        visible={imp.result != null || imp.errorToast != null}
        title={imp.errorToast != null ? IMPORT.errorTitle : IMPORT.resultTitle}
        message={imp.errorToast ?? (imp.result != null ? formatSummary(imp.result) : '')}
        onDismiss={imp.errorToast != null ? imp.clearError : imp.clearResult}
      />
    </>
  );
}
