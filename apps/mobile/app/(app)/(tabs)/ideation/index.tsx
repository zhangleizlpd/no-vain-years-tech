// 032 T018 [US2] — ideation 会话列表屏（翻面 D）。
//
// 渲染态（useSessionControllerList 数据驱动）：
//   ① loading   首屏拉取        居中 Spinner
//   ② error     GET 失败        提示 + 重试（不渲染空列表假态）
//   ③ 列表      有会话          标题 + 状态徽标 + 相对时间；点进继续 push /ideation/[id]；
//                               左滑露删除块 / 长按行 → ConfirmModal 二次确认 → 删除
//   ④ 空态      账号无会话      引导文案指向 + FAB（FR-008）
//
// 数据：server 已按 (updatedAt desc, id desc) 排序且 UC-level accountId scope（仅本账号），
//   前端不再过滤/重排（prepareSessionList 仅兜底防御 + 附徽标）。删除走 useSessionControllerRemove
//   成功后失效 list query key 重取（连带 turn + brief，server 单事务级联）。
//
// 删除入口（知会 T019 e2e）：① SwipeRow 左滑露删除块（RNGH Pan，headless web 非确定，e2e 不驱）
//   ② 行 onLongPress（mouse 按住可确定驱动，per reference_playwright_rngh_longpress_drivable_pan_not）
//   —— **e2e 用长按入口**。两入口都打开同一 ConfirmModal（testID 驱动确认）。
//
// SwipeRow 依赖手势根 → 套 GestureHandlerRootView（根 _layout 不全局挂，自包裹范式）。
// presentational/编排 —— 无 vitest（列表准备 / 相对时间 / 徽标穷举走 session-list.rules.spec；
// render / 滑动 / 长按 / 删除流走 T019 Playwright）。
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  getSessionControllerListQueryKey,
  useSessionControllerList,
  useSessionControllerRemove,
} from '@nvy/api-client';

import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, ConfirmModal, Spinner, SwipeRow } from '~/ui';
import {
  IDEATION_COPY,
  ideationSessionRoute,
  prepareSessionList,
  relativeUpdatedAt,
  type SessionRowView,
} from '~/ideation';

/** 列表 query key（删除成功后失效重取目标，orval 生成的 GET key）。 */
const LIST_QUERY_KEY = getSessionControllerListQueryKey();

export default function IdeationListScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const listQuery = useSessionControllerList();
  const removeMutation = useSessionControllerRemove();

  // 待二次确认删除的行（null = 无弹窗）。
  const [pendingDelete, setPendingDelete] = useState<SessionRowView | null>(null);
  const [deleting, setDeleting] = useState(false);

  const confirmDelete = useCallback(async () => {
    if (pendingDelete === null) return;
    setDeleting(true);
    try {
      await removeMutation.mutateAsync({ id: pendingDelete.id });
      await queryClient.invalidateQueries({ queryKey: LIST_QUERY_KEY });
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, removeMutation, queryClient]);

  // ── ① loading ──
  if (listQuery.isPending) {
    return (
      <View
        className="flex-1 items-center justify-center bg-surface"
        testID="ideation-list-loading"
      >
        <Spinner />
      </View>
    );
  }

  // ── ② error（GET 失败，不渲染空假态）──
  if (listQuery.isError) {
    return (
      <View className="flex-1 items-center justify-center gap-md bg-surface px-xl">
        <Text className="text-base text-ink-muted">{IDEATION_COPY.listLoadError}</Text>
        <Button label={IDEATION_COPY.listLoadRetry} onPress={() => void listQuery.refetch()} />
      </View>
    );
  }

  const rows = prepareSessionList(listQuery.data.data.items);
  const now = new Date();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1 }} edges={['bottom']}>
        {rows.length === 0 ? (
          <EmptyState />
        ) : (
          <ScrollView
            className="flex-1 bg-surface"
            contentContainerClassName="py-sm"
            testID="ideation-session-list"
          >
            {rows.map((row) => (
              <SessionRow
                key={row.id}
                row={row}
                now={now}
                onOpen={() => router.push(ideationSessionRoute(row.id))}
                onRequestDelete={() => setPendingDelete(row)}
              />
            ))}
          </ScrollView>
        )}

        {/* 删除二次确认（FR-012 / SC-005，复用 ~/ui ConfirmModal）。 */}
        <ConfirmModal
          visible={pendingDelete !== null}
          title={IDEATION_COPY.listDeleteConfirmTitle}
          message={IDEATION_COPY.listDeleteConfirmMessage}
          cancelLabel={IDEATION_COPY.listDeleteCancel}
          confirmLabel={IDEATION_COPY.listDeleteConfirm}
          busy={deleting}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

// ─────────────────────────── 会话行（左滑 + 长按双删除入口） ───────────────────────────

function SessionRow({
  row,
  now,
  onOpen,
  onRequestDelete,
}: {
  row: SessionRowView;
  now: Date;
  onOpen: () => void;
  onRequestDelete: () => void;
}) {
  return (
    <SwipeRow actionLabel={IDEATION_COPY.listDelete} onAction={onRequestDelete}>
      <Pressable
        className="flex-row items-center gap-sm px-md py-md"
        onPress={onOpen}
        onLongPress={onRequestDelete}
        accessibilityRole="button"
        accessibilityLabel={row.title}
        testID="ideation-session-row"
      >
        <View className="flex-1 min-w-0 gap-xs">
          <Text className="text-base text-ink" numberOfLines={1} ellipsizeMode="tail">
            {row.title}
          </Text>
          <Text className="text-xs text-ink-muted" testID="ideation-session-row-time">
            {relativeUpdatedAt(row.updatedAt, now)}
          </Text>
        </View>
        <StatusBadge label={row.badge.label} tone={row.badge.tone} />
      </Pressable>
    </SwipeRow>
  );
}

// ─────────────────────────── 状态徽标（复用 T016 STATUS_BADGE_META tone） ───────────────────────────

function StatusBadge({ label, tone }: { label: string; tone: 'brand' | 'muted' }) {
  return (
    <View
      className={`rounded-full px-sm py-xs ${tone === 'brand' ? 'bg-brand-soft' : 'bg-surface-alt'}`}
      testID="ideation-session-status-badge"
    >
      <Text
        className={`text-xs font-medium ${tone === 'brand' ? 'text-brand-500' : 'text-ink-muted'}`}
      >
        {label}
      </Text>
    </View>
  );
}

// ─────────────────────────── 空态（账号无会话，FR-008 引导） ───────────────────────────

function EmptyState() {
  return (
    <View
      className="flex-1 items-center justify-center bg-surface px-xl gap-sm"
      testID="ideation-list-empty"
    >
      <Text className="text-base text-ink text-center">{IDEATION_COPY.listEmptyTitle}</Text>
      <Text className="text-sm text-ink-muted text-center leading-relaxed">
        {IDEATION_COPY.listEmptyHint}
      </Text>
    </View>
  );
}
