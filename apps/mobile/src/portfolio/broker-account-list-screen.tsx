import { Fragment, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, useRouter } from 'expo-router';
import type { BrokerAccountItem } from '@nvy/api-client';

import { Card, Divider } from '~/settings/primitives';
import { Button, ConfirmModal, ErrorRow, Spinner } from '~/ui';
import { BROKER_COPY } from './broker-copy';
import { BrokerRow } from './broker-row';
import { useBrokerAccounts } from './use-broker-accounts';

// 券商账户列表屏（012 US4/US6）：默认账户置顶 + 已绑券商列表 + 右上「新建」→ 页 B。
// 首屏 loading / GET 失败 retry（不渲染错误默认态，Mobile Edge）；已绑行左滑删除 →
// ConfirmModal 二次确认 → 乐观删除（FR-M06，失败回滚 + errorToast）。SwipeRow 依赖
// 手势根 → 套一层 GestureHandlerRootView（根 _layout 不全局挂，per SwipeRow 自包裹范式）。
// 视觉复用 Card/Divider + ~/theme token（0 hex，SC-M06）；导航标题在 settings/_layout 注册。

export function BrokerAccountListScreen() {
  const router = useRouter();
  const { accounts, status, remove, deletingId, errorToast, refetch } = useBrokerAccounts();
  // 待二次确认删除的已绑行（null = 无弹窗）。
  const [pendingDelete, setPendingDelete] = useState<BrokerAccountItem | null>(null);

  const newButton = (
    <Pressable
      onPress={() => router.push('/(app)/settings/broker-accounts/bind')}
      accessibilityRole="button"
      accessibilityLabel={BROKER_COPY.list.create}
    >
      <Text className="text-base text-brand-500 px-md">{BROKER_COPY.list.create}</Text>
    </Pressable>
  );

  if (status === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-surface-sunken">
        <Stack.Screen options={{ headerRight: () => newButton }} />
        <Spinner />
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View className="flex-1 items-center justify-center gap-md bg-surface-sunken px-md">
        <Stack.Screen options={{ headerRight: () => newButton }} />
        <Text className="text-base text-ink-muted">{BROKER_COPY.load.error}</Text>
        <Button label={BROKER_COPY.load.retry} onPress={() => void refetch()} />
      </View>
    );
  }

  const bound = accounts.filter((a) => !a.isDefault);

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    void remove(id);
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack.Screen options={{ headerRight: () => newButton }} />
      <ScrollView
        className="flex-1 bg-surface-sunken"
        contentContainerClassName="px-md pt-md pb-xl gap-md"
      >
        {errorToast ? <ErrorRow text={errorToast} /> : null}
        <Card>
          {accounts.map((item, i) => (
            <Fragment key={item.id}>
              {i > 0 ? <Divider /> : null}
              <BrokerRow item={item} onRequestDelete={setPendingDelete} />
            </Fragment>
          ))}
        </Card>
        {bound.length === 0 ? (
          <Text className="text-sm text-ink-subtle text-center px-md">
            {BROKER_COPY.list.empty}
          </Text>
        ) : null}
      </ScrollView>

      <ConfirmModal
        visible={pendingDelete !== null}
        title={BROKER_COPY.list.deleteConfirm}
        message={
          pendingDelete ? `${pendingDelete.brokerName} · ${BROKER_COPY.list.boundTag}` : undefined
        }
        cancelLabel="取消"
        confirmLabel={BROKER_COPY.list.delete}
        busy={deletingId !== null}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </GestureHandlerRootView>
  );
}
