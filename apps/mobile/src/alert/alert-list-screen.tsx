import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';

import { Button, ErrorRow, makeHeaderBackOrParent, Spinner } from '~/ui';
import { ALERT_COPY } from './alert-copy';
import { AlertCard } from './alert-card';
import { AlertActionFooter, AlertDeleteFooter } from './alert-footer';
import { isAllSelected, toggleSelectAll, toggleSelection } from './alert-selection';
import { InstrumentQuoteStrip } from './instrument-quote-strip';
import { useAlertMutations, useInstrumentAlerts } from './use-alerts';

// 屏 1 个股预警列表 + 1b 多选删除（021 US1/US5 / FR-M01·M05，mockup AlertListScreen 翻 RN）。
// 顶部行情条（InstrumentQuoteStrip：015 quote merge，名称同源 quote.name）+ 预警卡片列表 +
// 底栏两态。header 屏内 Stack.Screen 动态设：常态右上「全部预警」/ 多选态「完成」，
// headerLeft 硬刷新回退到铃铛入口所在详情页（动态 symbol，layout 静态设不了）。
// 多选删除直删无二确（mockup/spec 无确认弹窗）。渲染/交互走 Playwright（mono 测试分层）。

const COPY = ALERT_COPY.listScreen;

export interface AlertListScreenProps {
  market: string;
  code: string;
}

export function AlertListScreen({ market, code }: AlertListScreenProps) {
  const router = useRouter();
  const symbol = `${market}:${code}`;
  const { alerts, status, refetch } = useInstrumentAlerts(market, code);
  const { toggleAlert, deleteAlerts, errorToast } = useAlertMutations();

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const onDelete = async () => {
    try {
      await deleteAlerts([...selected], [{ market, code }]);
      exitSelectMode();
    } catch {
      // errorToast 已由 useAlertMutations 分流展示，多选态保留供重试。
    }
  };

  const headerRight = selectMode ? (
    <Pressable onPress={exitSelectMode} accessibilityRole="button" accessibilityLabel={COPY.done}>
      <Text className="text-base text-brand-500">{COPY.done}</Text>
    </Pressable>
  ) : (
    <Pressable
      onPress={() => router.push('/(app)/alert')}
      accessibilityRole="button"
      accessibilityLabel={COPY.allAlerts}
    >
      <Text className="text-base text-brand-500">{COPY.allAlerts}</Text>
    </Pressable>
  );

  const alertIds = alerts.map((a) => a.id);

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
        {alerts.map((a) => (
          <AlertCard
            key={a.id}
            alert={a}
            selectMode={selectMode}
            selected={selected.has(a.id)}
            onSelectToggle={() => setSelected(toggleSelection(selected, a.id))}
            onToggle={(next) =>
              void toggleAlert({ id: a.id, market, code }, next).catch(() => {
                // 失败已回弹 + errorToast 分流。
              })
            }
            onEdit={() => router.push({ pathname: '/(app)/alert/edit', params: { alertId: a.id } })}
          />
        ))}
        {alerts.length === 0 ? (
          <Text className="text-center text-sm text-ink-subtle pt-3xl">
            {ALERT_COPY.list.emptyAlerts}
          </Text>
        ) : (
          <Text className="text-center text-xs text-ink-subtle py-lg">{ALERT_COPY.list.end}</Text>
        )}
      </ScrollView>
    );

  return (
    <View className="flex-1 bg-surface-sunken">
      <Stack.Screen
        options={{
          headerRight: () => headerRight,
          // web 硬刷新栈底空 → 回落铃铛入口所在详情页（动态 symbol，_layout 静态设不了）。
          headerLeft: makeHeaderBackOrParent(`/(app)/portfolio/${symbol}`),
        }}
      />
      <InstrumentQuoteStrip market={market} code={code} />
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
          mainLabel={COPY.addAlert}
          onMain={() =>
            router.push({ pathname: '/(app)/alert/edit', params: { instruments: symbol } })
          }
          onSelectDelete={() => setSelectMode(true)}
          selectDeleteDisabled={alerts.length === 0}
        />
      )}
    </View>
  );
}
