import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { QuoteItem } from '@nvy/api-client';

import { Button, ErrorRow, Spinner } from '~/ui';
import { colors } from '~/theme';
import {
  formatChange,
  formatPct,
  formatPrice,
  quoteColorClass,
  quoteDirection,
  useQuoteMerge,
} from '~/portfolio/use-quote-merge';
import { ALERT_COPY } from './alert-copy';
import { AlertCard } from './alert-card';
import { AlertActionFooter, AlertDeleteFooter } from './alert-footer';
import { AlertIcon } from './alert-icon';
import { AlertTabRow } from './alert-tab-row';
import { isAllSelected, toggleSelectAll, toggleSelection } from './alert-selection';
import { type InstrumentAlertsGroup, useAlertMutations, useAllAlerts } from './use-alerts';

// 屏 5 全部预警（021 US4/US5 / FR-M04·M05，mockup AllAlertsScreen 翻 RN）：A股单 tab +
// 按股票分组（EP2 平铺 client 聚组）。组头名 + 行情同走 015 quote 批量 merge
// （/quote 已返 name，原 per-group 014 detail N+1 退役）；
// 组内卡片就地 toggle/编辑，多选删复用屏 1b 组件（无智能预警 toggle）。
// presentational 编排 — 渲染/交互走 Playwright（mono 测试分层）。

const COPY = ALERT_COPY.allAlerts;
const LIST_COPY = ALERT_COPY.listScreen;

interface GroupHeaderProps {
  code: string;
  quote: QuoteItem | undefined;
  /** 下钻屏 1（多选态禁，避免丢勾选）。 */
  onPress?: () => void;
}

/** 组头：股票名（015 quote.name，未就位回落代码）+ 现价/涨跌额/涨跌幅 + chevron。 */
function GroupHeader({ code, quote, onPress }: GroupHeaderProps) {
  const name = quote?.name ?? code;
  const colorClass = quoteColorClass(quoteDirection(quote));
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={name}
      className="flex-row items-center gap-sm bg-surface px-md py-md border-b border-line-soft"
    >
      <Text className="flex-1 text-base font-semibold text-ink" numberOfLines={1}>
        {name}
      </Text>
      <Text className={`text-sm font-semibold ${colorClass}`}>{formatPrice(quote)}</Text>
      <Text className={`text-sm ${colorClass}`}>{formatChange(quote)}</Text>
      <Text className={`text-sm ${colorClass}`}>{formatPct(quote)}</Text>
      <AlertIcon name="chevron" color={colors.line.strong} size={17} />
    </Pressable>
  );
}

export function AllAlertsScreen() {
  const router = useRouter();
  const { alerts, groups, status, refetch } = useAllAlerts();
  const { toggleAlert, deleteAlerts, errorToast } = useAlertMutations();
  const { quoteFor } = useQuoteMerge(groups.map(({ market, code }) => ({ market, code })));

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const onDelete = async () => {
    // 失效 refs = 含勾选项的组（其 EP1 cache 也要刷）。
    const refs = groups
      .filter((g) => g.alerts.some((a) => selected.has(a.id)))
      .map(({ market, code }) => ({ market, code }));
    try {
      await deleteAlerts([...selected], refs);
      exitSelectMode();
    } catch {
      // errorToast 已由 useAlertMutations 分流展示，多选态保留供重试。
    }
  };

  const alertIds = alerts.map((a) => a.id);

  const renderGroup = (g: InstrumentAlertsGroup) => (
    <View key={`${g.market}:${g.code}`} className="mb-sm">
      <GroupHeader
        code={g.code}
        quote={quoteFor(g)}
        onPress={selectMode ? undefined : () => router.push(`/(app)/alert/${g.market}:${g.code}`)}
      />
      {g.alerts.map((a, i) => (
        <AlertCard
          key={a.id}
          alert={a}
          divider={i < g.alerts.length - 1}
          selectMode={selectMode}
          selected={selected.has(a.id)}
          onSelectToggle={() => setSelected(toggleSelection(selected, a.id))}
          onToggle={(next) =>
            void toggleAlert({ id: a.id, market: g.market, code: g.code }, next).catch(() => {
              // 失败已回弹 + errorToast 分流。
            })
          }
          onEdit={() => router.push({ pathname: '/(app)/alert/edit', params: { alertId: a.id } })}
        />
      ))}
    </View>
  );

  const body =
    status === 'loading' ? (
      <View className="flex-1 items-center justify-center">
        <Spinner />
      </View>
    ) : status === 'error' ? (
      <View className="flex-1 items-center justify-center gap-md px-md">
        <Text className="text-base text-ink-muted">{ALERT_COPY.list.loadError}</Text>
        <Button label={ALERT_COPY.list.retry} onPress={() => void refetch()} />
      </View>
    ) : (
      <ScrollView className="flex-1">
        {errorToast ? (
          <View className="px-md py-sm">
            <ErrorRow text={errorToast} />
          </View>
        ) : null}
        {groups.map(renderGroup)}
        {groups.length === 0 ? (
          <Text className="text-center text-sm text-ink-subtle pt-3xl">{COPY.empty}</Text>
        ) : (
          <Text className="text-center text-xs text-ink-subtle py-lg">{ALERT_COPY.list.end}</Text>
        )}
      </ScrollView>
    );

  return (
    <View className="flex-1 bg-surface-sunken">
      <Stack.Screen
        options={{
          // 常态无右上控件（mockup）；多选态「完成」退出。
          headerRight: selectMode
            ? () => (
                <Pressable
                  onPress={exitSelectMode}
                  accessibilityRole="button"
                  accessibilityLabel={LIST_COPY.done}
                >
                  <Text className="text-base text-brand-500">{LIST_COPY.done}</Text>
                </Pressable>
              )
            : undefined,
        }}
      />
      <AlertTabRow
        tabs={[{ key: 'cn', label: COPY.marketTab }]}
        active="cn"
        onChange={() => undefined}
      />
      {body}
      {selectMode ? (
        <AlertDeleteFooter
          allChecked={isAllSelected(selected, alertIds)}
          anyChecked={selected.size > 0}
          onToggleAll={() => setSelected(toggleSelectAll(selected, alertIds))}
          onDelete={() => void onDelete()}
        />
      ) : (
        <AlertActionFooter
          mainLabel={COPY.newAlert}
          onMain={() => router.push('/(app)/alert/select-target')}
          onSelectDelete={() => setSelectMode(true)}
          selectDeleteDisabled={alerts.length === 0}
        />
      )}
    </View>
  );
}
