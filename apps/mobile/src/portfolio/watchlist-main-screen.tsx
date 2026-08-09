import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { GroupItemSystemKind, type WatchlistItemView } from '@nvy/api-client';

import { Button, ErrorRow, LongPressMenu, Spinner, Tabs, type TabItem } from '~/ui';
import { DrawerMenuButton } from '~/core/app-shell-drawer';
import { ALERT_COPY } from '~/alert/alert-copy';
import { AlertIcon } from '~/alert/alert-icon';
import { useUnreadCount } from '~/alert/use-alert-messages';
import { AddWatchlistEntry } from './add-watchlist-entry';
import { canDrillDown } from './stock-detail.helpers';
import { HoldingsIcon } from './holdings-icon';
import { HOLDINGS_COPY } from './holdings-copy';
import { STOCK_DETAIL_COPY } from './stock-detail-copy';
import { useQuoteMerge } from './use-quote-merge';
import { useWatchlistGroups } from './use-watchlist-groups';
import { useWatchlistItems } from './use-watchlist-items';
import { WatchlistColumnHeader, WatchlistRow } from './watchlist-row';
import { WatchlistItemMenu } from './watchlist-item-menu';
import { WATCHLIST_COPY } from './watchlist-copy';

// 屏1 自选主列表（013 US3 / FR-M01-M03·M09）。投资 tab 落地页（替换 PHASE 1 placeholder, D6）。
// 顶部 Tab 横滑（可见组 + 末尾 ☰ 进分组管理）+ 列头 + 虚拟化 FlatList；行情 client 调 015
// /quote merge 涨红跌绿（ADR-0048）。长按行 → 屏2 菜单（6 项，持仓「删除」disabled）。
// 右上工具栏三 icon（021 T021）：放大镜=屏4 添加入口（行为不变仅换图标）/ 铃+闪电→全部预警 /
// 信封+unread 红点（focus refetch 不轮询）→ 消息通知。
// **兜底强制「自选」可见**（D4：即便用户隐藏，主列表仍保留自选 tab）。
// LongPressMenu 依赖手势根 → 套 GestureHandlerRootView（根 _layout 不全局挂，镜像 broker 屏）。

const COPY = WATCHLIST_COPY.main;

export function WatchlistMainScreen() {
  const router = useRouter();
  const groupsState = useWatchlistGroups();
  const { groups, status: groupsStatus, errorToast: groupsError, refetch } = groupsState;

  // 兜底强制「自选」可见（D4）：隐藏组不上 Tab，但「自选」恒在。
  const tabGroups = useMemo(
    () => groups.filter((g) => g.visible || g.systemKind === GroupItemSystemKind.watchlist),
    [groups],
  );
  const tabs: TabItem[] = tabGroups.map((g) => ({ id: g.id, name: g.name }));

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeId = tabGroups.find((g) => g.id === selectedId)?.id ?? tabGroups[0]?.id ?? null;
  const activeGroup = groups.find((g) => g.id === activeId) ?? null;
  const isHoldings = activeGroup?.systemKind === GroupItemSystemKind.holdings;

  const { items, updateItem, deleteItem, errorToast: itemsError } = useWatchlistItems(activeId);
  const quotes = useQuoteMerge(items);
  const reassignTargets = useMemo(
    () => groups.filter((g) => g.systemKind !== GroupItemSystemKind.holdings),
    [groups],
  );

  const [addOpen, setAddOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 未读角标（021 FR-M07）：tab focus 时拉一次（消息中心 mark-read 后回来即清，不轮询）。
  const { badgeVisible, refetch: refetchUnread } = useUnreadCount();
  useFocusEffect(
    useCallback(() => {
      void refetchUnread();
    }, [refetchUnread]),
  );

  // 工具栏三 icon（021 T021）：放大镜=既有添加入口 / 铃→全部预警 / 信封+红点→消息通知。
  const toolbar = (
    <View className="flex-1 flex-row items-center justify-end gap-lg">
      <Pressable
        onPress={() => setAddOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={COPY.add}
        hitSlop={6}
      >
        <AlertIcon name="search" />
      </Pressable>
      <Pressable
        onPress={() => router.push('/(app)/alert')}
        accessibilityRole="button"
        accessibilityLabel={ALERT_COPY.allAlerts.title}
        hitSlop={6}
      >
        <AlertIcon name="alertBell" />
      </Pressable>
      {/* 025 T014：持仓入口（钱包 icon 品牌色），位序 搜索→铃铛→持仓→消息（mockup 定稿）。 */}
      <Pressable
        onPress={() => router.push('/(app)/portfolio/holdings')}
        accessibilityRole="button"
        accessibilityLabel={HOLDINGS_COPY.toolbar.holdings}
        hitSlop={6}
      >
        <HoldingsIcon />
      </Pressable>
      <Pressable
        onPress={() => router.push('/(app)/alert/messages')}
        accessibilityRole="button"
        accessibilityLabel={ALERT_COPY.messages.title}
        hitSlop={6}
      >
        <View>
          <AlertIcon name="mail" />
          {badgeVisible ? (
            // testID：红点纯视觉无文案/role，e2e（alert.spec T022）唯一可达断言锚。
            <View
              testID="alert-unread-badge"
              className="absolute top-0 right-0 w-2 h-2 rounded-full bg-err"
            />
          ) : null}
        </View>
      </Pressable>
    </View>
  );

  if (groupsStatus === 'loading') {
    return (
      <SafeAreaView edges={['top']} className="flex-1 items-center justify-center bg-surface">
        <Spinner />
      </SafeAreaView>
    );
  }

  if (groupsStatus === 'error') {
    return (
      <SafeAreaView
        edges={['top']}
        className="flex-1 items-center justify-center gap-md bg-surface px-md"
      >
        <Text className="text-base text-ink-muted">{COPY.load.error}</Text>
        <Button label={COPY.load.retry} onPress={() => void refetch()} />
      </SafeAreaView>
    );
  }

  // 单击行 → 下钻详情（014 US3）；us 标的 gate（D9）→ 轻提示「美股即将上线」不下钻。
  const onRowTap = (item: WatchlistItemView) => {
    if (canDrillDown(item.market)) {
      router.push(`/(app)/portfolio/${item.market}:${item.code}`);
    } else {
      setNotice(STOCK_DETAIL_COPY.usGate.title);
    }
  };

  const renderRow = ({ item }: { item: WatchlistItemView }) => (
    <LongPressMenu
      accessibilityLabel={item.code}
      onTap={() => onRowTap(item)}
      renderMenu={(close) =>
        activeGroup ? (
          <WatchlistItemMenu
            item={item}
            group={activeGroup}
            reassignTargets={reassignTargets}
            onDelete={() => void deleteItem(item.id)}
            onTogglePin={() => void updateItem(item.id, { pinned: !item.pinned })}
            onMove={(dir) => void updateItem(item.id, { move: dir })}
            onReassign={(gid) => void updateItem(item.id, { targetGroupId: gid })}
            onRecolor={(color) => void updateItem(item.id, { color: color ?? '' })}
            onNote={() => setNotice(WATCHLIST_COPY.menu.noteComingSoon)}
            close={close}
          />
        ) : null
      }
    >
      <WatchlistRow item={item} quote={quotes.quoteFor(item)} />
      <View className="h-px bg-line-soft ml-md" />
    </LongPressMenu>
  );

  const empty = isHoldings ? COPY.emptyHoldings : COPY.emptyGroup;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaView edges={['top']} className="flex-1 bg-surface">
        {/* 自选标题栏 + 工具栏三 icon（tab 无 navigator header）。左上汉堡开全局抽屉（045 FR-023）。 */}
        <View className="flex-row items-center justify-between px-md py-sm border-b border-line-soft">
          <View className="flex-1 flex-row">
            <DrawerMenuButton testID="portfolio-menu-button" />
          </View>
          <Text className="text-base font-semibold text-ink">{COPY.title}</Text>
          {toolbar}
        </View>

        <Tabs
          tabs={tabs}
          activeId={activeId ?? ''}
          onSelect={setSelectedId}
          onManage={() => router.push('/(app)/portfolio/watchlist-groups')}
        />
        <WatchlistColumnHeader />

        {notice ? (
          <Pressable onPress={() => setNotice(null)} accessibilityRole="alert">
            <View className="bg-warn-soft px-md py-sm">
              <Text className="text-sm text-ink">{notice}</Text>
            </View>
          </Pressable>
        ) : null}
        {(groupsError ?? itemsError) ? (
          <View className="px-md pt-sm">
            <ErrorRow text={(groupsError ?? itemsError) as string} />
          </View>
        ) : null}

        <FlatList
          data={items}
          keyExtractor={(it) => it.id}
          renderItem={renderRow}
          className="flex-1 bg-surface-sunken"
          ListEmptyComponent={
            <View className="items-center gap-xs px-xl py-2xl">
              <Text className="text-base font-medium text-ink-muted">{empty.title}</Text>
              <Text className="text-sm text-ink-subtle text-center">{empty.sub}</Text>
            </View>
          }
        />
      </SafeAreaView>

      <AddWatchlistEntry
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        groups={groups}
        onAdded={() => setSelectedId(activeId)}
      />
    </GestureHandlerRootView>
  );
}
