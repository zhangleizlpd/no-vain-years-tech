import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import {
  type AddWatchlistItemRequestMarket,
  type GroupItem,
  GroupItemSystemKind,
} from '@nvy/api-client';

import { colors } from '~/theme';
import { ErrorRow, SafeAreaView } from '~/ui';
import { CreateGroupDialog } from './create-group-dialog';
import { resolveGroupToggle } from './stock-detail.helpers';
import { STOCK_DETAIL_COPY } from './stock-detail-copy';
import { useWatchlistGroups } from './use-watchlist-groups';
import { useWatchlistItems } from './use-watchlist-items';
import { useWatchlistStatus } from './use-watchlist-status';

// 编辑分组 sheet（014 US6 / FR-M08，T013，port mockup EditGroupSheet）。底部上滑 Modal：列该账号
// **所有非持仓组**（系统「自选」+ 自定义，复用 013 useWatchlistGroups EP1）为 2 列网格；命中组高亮
// （brand-soft 底 + brand-500 边 + ✓ 角标，系统组带星，**不用红**）。点格 toggle → 加入（013 EP7）/
// 移出（013 EP9 用 memberships itemId）；底「＋新建分组」开 CreateGroupDialog（复用 013 createGroup）/
// 「完成」。无颜色 / 无快速建组 / 无分享。乐观本地覆盖 + 失败回弹 + 复用 013 watchlistItemErrorToast。
// presentational —— 渲染/交互走 Playwright e2e；加移真落库走 contract-smoke（per sdd.md §V）。

const COPY = STOCK_DETAIL_COPY.editGroups;

export interface EditGroupsSheetProps {
  visible: boolean;
  onClose: () => void;
  market: string;
  code: string;
  /** 详情名（sheet 副标题）。 */
  stockName?: string;
}

export function EditGroupsSheet({
  visible,
  onClose,
  market,
  code,
  stockName,
}: EditGroupsSheetProps) {
  const { membershipByGroup, refetch } = useWatchlistStatus(market, code);
  const { groups, createGroup } = useWatchlistGroups();
  const { addItem, deleteItem, errorToast, clearErrorToast } = useWatchlistItems(null);

  // 非持仓组（持仓为派生只读，不可手动增删）。
  const editable = useMemo(
    () => groups.filter((g) => g.systemKind !== GroupItemSystemKind.holdings),
    [groups],
  );

  const [createOpen, setCreateOpen] = useState(false);
  // 乐观覆盖（groupId→选中）+ 防连点 busy；server 真态（memberships）刷新后清覆盖对账。
  const [override, setOverride] = useState<Map<string, boolean>>(new Map());
  const [busy, setBusy] = useState<Set<string>>(new Set());

  useEffect(() => setOverride(new Map()), [membershipByGroup]);

  const isSelected = (gid: string) => override.get(gid) ?? membershipByGroup.has(gid);

  const toggle = async (gid: string) => {
    if (busy.has(gid)) return;
    const action = resolveGroupToggle(gid, membershipByGroup);
    clearErrorToast();
    setOverride((m) => new Map(m).set(gid, action.kind === 'add'));
    setBusy((s) => new Set(s).add(gid));
    try {
      if (action.kind === 'add') {
        await addItem(gid, { market: market as AddWatchlistItemRequestMarket, code });
      } else {
        await deleteItem(action.itemId);
      }
      refetch(); // 014 watchlist-status 对账（清覆盖由上面 effect 接手）。
    } catch {
      setOverride((m) => {
        const n = new Map(m);
        n.delete(gid); // 回弹（errorToast 已由 hook 设置）。
        return n;
      });
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(gid);
        return n;
      });
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-modal-overlay">
        <Pressable onPress={onClose} accessibilityLabel={COPY.close} className="absolute inset-0" />
        <View className="bg-surface rounded-t-lg overflow-hidden" style={{ maxHeight: '82%' }}>
          {/* 标头：抓手 + 标题 + 股票名/代码 + 关闭。 */}
          <View className="items-center px-md pt-md pb-sm border-b border-line-soft">
            <View className="w-9 h-1 rounded-full bg-line mb-sm" />
            <Text className="text-base font-semibold text-ink">{COPY.title}</Text>
            {stockName ? (
              <Text className="text-xs text-ink-subtle mt-0.5">
                {stockName} {code}
              </Text>
            ) : null}
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={COPY.close}
              className="absolute right-md top-md w-8 h-8 items-center justify-center"
            >
              <Text className="text-lg text-ink-subtle">✕</Text>
            </Pressable>
          </View>

          {errorToast ? (
            <Pressable onPress={clearErrorToast} accessibilityRole="alert" className="px-md pt-sm">
              <ErrorRow text={errorToast} />
            </Pressable>
          ) : null}

          {/* 2 列分组网格。 */}
          <ScrollView className="px-md py-sm">
            {editable.length === 0 ? (
              <Text className="text-sm text-ink-subtle text-center py-2xl">{COPY.empty}</Text>
            ) : (
              <View className="flex-row flex-wrap">
                {editable.map((g) => (
                  <View key={g.id} className="w-1/2 p-xs">
                    <GroupCell
                      group={g}
                      selected={isSelected(g.id)}
                      onToggle={() => void toggle(g.id)}
                    />
                  </View>
                ))}
              </View>
            )}
          </ScrollView>

          {/* 底栏：＋新建分组 / 完成。 */}
          <SafeAreaView edges={['bottom']} className="border-t border-line-soft">
            <View className="flex-row items-center justify-between px-md py-sm">
              <Pressable
                onPress={() => setCreateOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={COPY.newGroup}
                className="flex-row items-center gap-xs py-xs"
              >
                <Text className="text-lg text-brand-500">＋</Text>
                <Text className="text-sm font-medium text-brand-500">{COPY.newGroup}</Text>
              </Pressable>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel={COPY.done}
                className="h-10 rounded-md bg-brand-500 px-2xl items-center justify-center"
              >
                <Text className="text-base font-semibold text-white">{COPY.done}</Text>
              </Pressable>
            </View>
          </SafeAreaView>
        </View>
      </View>

      <CreateGroupDialog
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={createGroup}
      />
    </Modal>
  );
}

// 单格：组名 + (标的数)；命中 → brand-soft 底 + brand-500 边/字 + ✓ 角标；系统「自选」组带星（非红）。
function GroupCell({
  group,
  selected,
  onToggle,
}: {
  group: GroupItem;
  selected: boolean;
  onToggle: () => void;
}) {
  const isWatchlist = group.systemKind === GroupItemSystemKind.watchlist;
  const tone = selected ? colors.brand[500] : colors.quote.flat;
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={group.name}
      accessibilityState={{ selected }}
      className={`relative h-12 rounded-md border px-md flex-row items-center gap-xs ${
        selected ? 'border-brand-500 bg-brand-soft' : 'border-transparent bg-surface-sunken'
      }`}
    >
      {isWatchlist ? <StarIcon color={tone} /> : null}
      <Text
        numberOfLines={1}
        className={`flex-1 text-sm font-medium ${selected ? 'text-brand-500' : 'text-ink'}`}
      >
        {group.name}
      </Text>
      <Text className={`text-xs ${selected ? 'text-brand-500' : 'text-ink-subtle'}`}>
        ({group.itemCount})
      </Text>
      {selected ? (
        <View className="absolute right-1 bottom-1 w-4 h-4 rounded-full bg-brand-500 items-center justify-center">
          <Text className="text-xs text-white">✓</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function StarIcon({ color }: { color: string }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24">
      <Path
        d="M12 3l2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17.8 6.4 20.3l1.2-6.2L3 9.8l6.3-.8z"
        fill="none"
        stroke={color}
        strokeWidth={1.7}
        strokeLinejoin="round"
      />
    </Svg>
  );
}
