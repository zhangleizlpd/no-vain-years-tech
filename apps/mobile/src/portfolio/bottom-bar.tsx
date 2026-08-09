import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { useRouter } from 'expo-router';
import { type AddWatchlistItemRequestMarket, GroupItemSystemKind } from '@nvy/api-client';

import { colors } from '~/theme';
import { ErrorRow, SafeAreaView } from '~/ui';
import { resolveWatchlistToggle, watchlistToggleLabel } from './stock-detail.helpers';
import { STOCK_DETAIL_COPY } from './stock-detail-copy';
import { useWatchlistGroups } from './use-watchlist-groups';
import { useWatchlistItems } from './use-watchlist-items';
import { useWatchlistStatus } from './use-watchlist-status';

// 固定底栏（014 US6 / FR-M07，同花顺式 4 项，port mockup StockDetailKit3 BottomBar）：
//  ① 预警 —— 021 T021 接通：push 个股预警列表（/(app)/alert/[symbol]）
//  ② 笔记 —— disabled（tap → 「即将上线」轻提示，OQ1/FR-M09）
//  ③ 加·删自选 —— star toggle，**仅 toggle 系统「自选」组（窄义，D1）**：未自选 brand 描边星「自选」/
//     已自选 accent 实心星「已自选」；加=013 EP7 落「自选」/ 删=013 EP9 用 memberships 里自选组 itemId。
//     乐观更新（本地覆盖 inWatch）+ 失败回弹 + 错误分流复用 013 watchlistItemErrorToast。
//  ④ 编辑分组 —— 开 T013 EditGroupsSheet（自定义组 multi-select，全复用 013 端点）。
// presentational —— 渲染/交互走 Playwright e2e；加删真落库走 contract-smoke（per sdd.md §V）。
// 涨跌/状态色非唯一载体：star 描边↔实心 + 文案切换辅助（FR-M09 色盲友好）。

const COPY = STOCK_DETAIL_COPY.bottomBar;

export interface BottomBarProps {
  market: string;
  code: string;
  /** 开「编辑分组」sheet（T013 EditGroupsSheet）。 */
  onEditGroups: () => void;
  /** 编辑分组 sheet 是否打开（底栏第 4 项高亮态）。 */
  editOpen: boolean;
}

export function BottomBar({ market, code, onEditGroups, editOpen }: BottomBarProps) {
  const router = useRouter();
  const { inWatchlist, membershipByGroup, refetch } = useWatchlistStatus(market, code);
  const { groups } = useWatchlistGroups();
  const { addItem, deleteItem, errorToast, clearErrorToast } = useWatchlistItems(null);

  const watchlistGroup = groups.find((g) => g.systemKind === GroupItemSystemKind.watchlist);

  // 乐观本地覆盖（null=跟随 server 真态）；busy 防连点；notice=disabled 项轻提示。
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inWatch = optimistic ?? inWatchlist;

  // 对账：refetch 落地后 server 真态追上乐观值 → 清本地覆盖（避免长期分叉）。
  useEffect(() => {
    if (optimistic !== null && inWatchlist === optimistic) setOptimistic(null);
  }, [inWatchlist, optimistic]);

  const onToggleWatch = async () => {
    if (busy || !watchlistGroup) return;
    const action = resolveWatchlistToggle(inWatchlist, watchlistGroup.id, membershipByGroup);
    if (!action) return;
    clearErrorToast();
    setBusy(true);
    setOptimistic(!inWatchlist);
    try {
      if (action.kind === 'add') {
        await addItem(action.groupId, { market: market as AddWatchlistItemRequestMarket, code });
      } else {
        await deleteItem(action.itemId);
      }
      refetch(); // 拉 014 watchlist-status 真态对账（013 mutation 不失效本端点）。
    } catch {
      setOptimistic(null); // 回弹（errorToast 已由 hook 设置）。
    } finally {
      setBusy(false);
    }
  };

  const onDisabledTap = (label: string) => setNotice(`${label}${COPY.comingSoonSuffix}`);

  const starTint = inWatch ? TINT.accent : TINT.brand;

  return (
    <View>
      {notice ? (
        <Pressable onPress={() => setNotice(null)} accessibilityRole="alert">
          <View className="bg-warn-soft px-md py-sm">
            <Text className="text-sm text-ink">{notice}</Text>
          </View>
        </Pressable>
      ) : null}
      {errorToast ? (
        <Pressable onPress={clearErrorToast} accessibilityRole="alert" className="px-md pt-sm">
          <ErrorRow text={errorToast} />
        </Pressable>
      ) : null}

      <SafeAreaView edges={['bottom']} className="bg-surface border-t border-line">
        <View className="flex-row items-stretch">
          <BarItem
            icon="bell"
            label={COPY.alert}
            tint={TINT.muted}
            onPress={() => router.push(`/(app)/alert/${market}:${code}`)}
          />
          <BarItem
            icon="note"
            label={COPY.note}
            tint={TINT.disabled}
            onPress={() => onDisabledTap(COPY.note)}
          />
          <BarItem
            icon="star"
            label={watchlistToggleLabel(inWatch)}
            tint={starTint}
            fill={inWatch}
            selected={inWatch}
            onPress={() => void onToggleWatch()}
          />
          <BarItem
            icon="group"
            label={COPY.editGroups}
            tint={editOpen ? TINT.brand : TINT.muted}
            selected={editOpen}
            onPress={onEditGroups}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

// 色调对：icon 走 token hex（SVG color prop）/ label 走 token className（text-*）—— 两侧同 token，
// 0 硬编码 hex（SC-M06）。disabled 用 ink-subtle（mockup 浅灰无专属 token，取最近语义灰）。
type Tint = { hex: string; text: string };
const TINT = {
  disabled: { hex: colors.ink.subtle, text: 'text-ink-subtle' },
  brand: { hex: colors.brand[500], text: 'text-brand-500' },
  accent: { hex: colors.accent.DEFAULT, text: 'text-accent' },
  muted: { hex: colors.ink.muted, text: 'text-ink-muted' },
} satisfies Record<string, Tint>;

type BarIconName = 'bell' | 'note' | 'star' | 'group';

interface BarItemProps {
  icon: BarIconName;
  label: string;
  tint: Tint;
  onPress: () => void;
  fill?: boolean;
  selected?: boolean;
}

function BarItem({ icon, label, tint, onPress, fill, selected }: BarItemProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      className="flex-1 items-center gap-xs py-sm"
    >
      <BarIcon name={icon} color={tint.hex} fill={fill} />
      <Text className={`text-xs ${tint.text}`}>{label}</Text>
    </Pressable>
  );
}

// 21px 线性图标（port mockup Icon，stroke 1.7）；star 实心态 fill=true（已自选 accent 实心星）。
function BarIcon({ name, color, fill }: { name: BarIconName; color: string; fill?: boolean }) {
  const s = {
    fill: 'none',
    stroke: color,
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const;
  const star = 'M12 3l2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17.8 6.4 20.3l1.2-6.2L3 9.8l6.3-.8z';
  return (
    <Svg width={21} height={21} viewBox="0 0 24 24">
      {name === 'bell' ? (
        <Path {...s} d="M6 9a6 6 0 0112 0c0 5 2 7 2 7H4s2-2 2-7M10 20a2 2 0 004 0" />
      ) : name === 'note' ? (
        <>
          <Path {...s} d="M5 4h10l4 4v12H5zM15 4v4h4" />
          <Path {...s} d="M8 12h8M8 16h5" />
        </>
      ) : name === 'group' ? (
        <>
          <Rect x={3.5} y={4} width={7} height={7} rx={1.6} {...s} />
          <Rect x={13.5} y={4} width={7} height={7} rx={1.6} {...s} />
          <Rect x={3.5} y={14} width={7} height={6} rx={1.6} {...s} />
          <Rect x={13.5} y={14} width={7} height={6} rx={1.6} {...s} />
        </>
      ) : fill ? (
        <Path d={star} fill={color} stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
      ) : (
        <Path {...s} d={star} />
      )}
    </Svg>
  );
}
