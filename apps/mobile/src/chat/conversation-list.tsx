// 028 T009 — 抽屉中段会话列表（翻 mockup frame 1/2/2b/3/4b/5）。
//
// 渲染态（由 useConversations 数据 + 本地编辑态驱动）：
//   ① 分组列表    非搜索态     groupConversations 分组渲染（前7天/前30天/YYYY年）
//   ② 搜索平铺    搜索态命中   「N 个结果」+ 关键词高亮（仅按标题，FR-009）
//   ③ 空历史态    无任何会话   sparkle + 引导（Edge：账号无会话，仅新建可用）
//   ④ 搜索无命中  搜索态 0 命中 放大镜 + 「没有找到匹配的对话」（不报错，FR-009）
// 行操作：⋯ → 重命名·删除菜单（tap 驱动 Modal popover）/ 改名行内编辑（空禁用确定，FR-006）/
//   删除居中二次确认弹窗（复用 ~/ui ConfirmModal，FR-007 / SC-005）。
//
// 设计：tap 驱动所有交互（per RNGH web 手势非确定 memory），每个可交互元素带 testID/a11y label
//   供 T010 e2e 驱动。视觉 0 新 token（复用 ~/theme + ~/ui）。下滑加载（onEndReached）走
//   useConversations.fetchNextPage。presentational/编排 —— 无 vitest（render/交互走 Playwright）。
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Modal, ScrollView, Text, TextInput, View, Pressable } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { ConfirmModal, Spinner } from '~/ui';
import { colors } from '~/theme';
import { CHAT_COPY } from './chat-copy';
import { groupConversations, type ConversationItem } from './group-conversations';
import type { UseConversationsResult } from './use-conversations';

/** 滚动到底触发加载下一页的距离阈值（px）。 */
const END_REACHED_THRESHOLD = 120;

export interface ConversationListProps {
  conversations: ConversationItem[];
  isSearching: boolean;
  searchQuery: string;
  /** 当前选中（正打开）的会话 id —— 高亮该行。 */
  currentConversationId: string | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onEndReached: () => void;
  /** 点选某会话（切换 + 关抽屉，由上层接 useChat.selectConversation）。
   *  029 第二参 = 该会话 model，透传给 selectConversation 让顶栏跟随（FR-007）。 */
  onSelect: (id: string, model: string) => void;
  /** 改名（成功后失效列表）。 */
  onRename: (id: string, title: string) => Promise<void>;
  /** 删除（成功后失效列表）。 */
  onDelete: (id: string) => Promise<void>;
}

/** 当前 ISO now（分组依据；列表组件持有，避免每 render 漂移影响分组边界）。 */
function nowIso(): string {
  return new Date().toISOString();
}

export function ConversationList({
  conversations,
  isSearching,
  searchQuery,
  currentConversationId,
  hasNextPage,
  isFetchingNextPage,
  onEndReached,
  onSelect,
  onRename,
  onDelete,
}: ConversationListProps) {
  // 行操作三态（互斥）：menuFor = ⋯ 菜单打开的行 id；renameFor = 行内改名的行 id；
  // deleteFor = 删除二次确认的行项。null = 无。
  const [menuFor, setMenuFor] = useState<ConversationItem | null>(null);
  const [renameFor, setRenameFor] = useState<ConversationItem | null>(null);
  const [deleteFor, setDeleteFor] = useState<ConversationItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  // now 在挂载时取一次（分组边界稳定）。
  const nowRef = useRef(nowIso());

  const openMenu = useCallback((item: ConversationItem) => setMenuFor(item), []);
  const closeMenu = useCallback(() => setMenuFor(null), []);

  const startRename = useCallback((item: ConversationItem) => {
    setMenuFor(null);
    setRenameFor(item);
  }, []);

  const startDelete = useCallback((item: ConversationItem) => {
    setMenuFor(null);
    setDeleteFor(item);
  }, []);

  const submitRename = useCallback(
    async (id: string, title: string) => {
      setRenameFor(null);
      await onRename(id, title);
    },
    [onRename],
  );

  const confirmDelete = useCallback(async () => {
    if (deleteFor === null) return;
    setDeleting(true);
    try {
      await onDelete(deleteFor.id);
      setDeleteFor(null);
    } finally {
      setDeleting(false);
    }
  }, [deleteFor, onDelete]);

  // ── 空历史态（Edge：账号无任何会话，非搜索态） ──
  if (conversations.length === 0 && !isSearching) {
    return <EmptyHistory />;
  }

  // ── 搜索无命中态（搜索态 0 命中，FR-009） ──
  if (conversations.length === 0 && isSearching) {
    return <SearchNoMatch />;
  }

  return (
    <View className="flex-1">
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-sm pb-sm"
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={(e) => {
          const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
          const distanceToEnd = contentSize.height - layoutMeasurement.height - contentOffset.y;
          if (distanceToEnd < END_REACHED_THRESHOLD && hasNextPage && !isFetchingNextPage) {
            onEndReached();
          }
        }}
        testID="conversation-list"
      >
        {isSearching ? (
          <SearchResults
            conversations={conversations}
            keyword={searchQuery}
            currentConversationId={currentConversationId}
            renameFor={renameFor}
            onSelect={onSelect}
            onOpenMenu={openMenu}
            onSubmitRename={submitRename}
            onCancelRename={() => setRenameFor(null)}
          />
        ) : (
          <GroupedList
            groups={groupConversations(conversations, nowRef.current)}
            currentConversationId={currentConversationId}
            renameFor={renameFor}
            onSelect={onSelect}
            onOpenMenu={openMenu}
            onSubmitRename={submitRename}
            onCancelRename={() => setRenameFor(null)}
          />
        )}

        {isFetchingNextPage ? (
          <View className="py-md items-center" testID="conversation-list-loading-more">
            <Spinner size={16} tone="muted" />
          </View>
        ) : null}
      </ScrollView>

      {/* 行操作菜单（⋯ tap → 重命名/删除，tap 驱动 popover）。 */}
      <RowMenu item={menuFor} onClose={closeMenu} onRename={startRename} onDelete={startDelete} />

      {/* 删除二次确认（FR-007 / SC-005，复用 ~/ui ConfirmModal）。 */}
      <ConfirmModal
        visible={deleteFor !== null}
        title={CHAT_COPY.deleteModalTitle}
        message={CHAT_COPY.deleteModalMessage}
        cancelLabel={CHAT_COPY.deleteModalCancel}
        confirmLabel={CHAT_COPY.deleteModalConfirm}
        busy={deleting}
        onCancel={() => setDeleteFor(null)}
        onConfirm={() => void confirmDelete()}
      />
    </View>
  );
}

// ─────────────────────────── 分组列表（非搜索态） ───────────────────────────

function GroupedList({
  groups,
  currentConversationId,
  renameFor,
  onSelect,
  onOpenMenu,
  onSubmitRename,
  onCancelRename,
}: {
  groups: ReturnType<typeof groupConversations>;
  currentConversationId: string | null;
  renameFor: ConversationItem | null;
  onSelect: (id: string, model: string) => void;
  onOpenMenu: (item: ConversationItem) => void;
  onSubmitRename: (id: string, title: string) => void;
  onCancelRename: () => void;
}) {
  return (
    <>
      {groups.map((group) => (
        <View key={group.label}>
          <Text
            className="text-xs font-medium text-ink-muted px-md pt-md pb-xs"
            testID="conversation-group-header"
          >
            {group.label}
          </Text>
          {group.items.map((item) =>
            renameFor?.id === item.id ? (
              <RenameRow
                key={item.id}
                item={item}
                onSubmit={onSubmitRename}
                onCancel={onCancelRename}
              />
            ) : (
              <ConversationRow
                key={item.id}
                item={item}
                selected={item.id === currentConversationId}
                onSelect={onSelect}
                onOpenMenu={onOpenMenu}
              />
            ),
          )}
        </View>
      ))}
    </>
  );
}

// ─────────────────────────── 搜索平铺（搜索态命中） ───────────────────────────

function SearchResults({
  conversations,
  keyword,
  currentConversationId,
  renameFor,
  onSelect,
  onOpenMenu,
  onSubmitRename,
  onCancelRename,
}: {
  conversations: ConversationItem[];
  keyword: string;
  currentConversationId: string | null;
  renameFor: ConversationItem | null;
  onSelect: (id: string, model: string) => void;
  onOpenMenu: (item: ConversationItem) => void;
  onSubmitRename: (id: string, title: string) => void;
  onCancelRename: () => void;
}) {
  return (
    <>
      <Text className="text-xs text-ink-muted px-md pt-md pb-xs" testID="conversation-search-count">
        {`${conversations.length}${CHAT_COPY.searchResultCountSuffix}`}
      </Text>
      {conversations.map((item) =>
        renameFor?.id === item.id ? (
          <RenameRow
            key={item.id}
            item={item}
            onSubmit={onSubmitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <ConversationRow
            key={item.id}
            item={item}
            selected={item.id === currentConversationId}
            keyword={keyword}
            onSelect={onSelect}
            onOpenMenu={onOpenMenu}
          />
        ),
      )}
    </>
  );
}

// ─────────────────────────── 会话行 ───────────────────────────

function ConversationRow({
  item,
  selected,
  keyword,
  onSelect,
  onOpenMenu,
}: {
  item: ConversationItem;
  selected: boolean;
  keyword?: string;
  onSelect: (id: string, model: string) => void;
  onOpenMenu: (item: ConversationItem) => void;
}) {
  return (
    <View
      className={`flex-row items-center gap-sm px-md rounded-sm ${
        selected ? 'bg-brand-soft' : 'bg-transparent'
      }`}
      style={{ height: 44 }}
    >
      <Pressable
        className="flex-1 min-w-0 justify-center"
        style={{ height: 44 }}
        onPress={() => onSelect(item.id, item.model)}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={item.title}
        testID="conversation-row"
      >
        <Text
          className={`text-base ${selected ? 'font-medium text-brand-500' : 'text-ink'}`}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {keyword ? highlight(item.title, keyword) : item.title}
        </Text>
      </Pressable>
      <Pressable
        className="items-center justify-center rounded-sm"
        style={{ width: 28, height: 28 }}
        hitSlop={6}
        onPress={() => onOpenMenu(item)}
        accessibilityRole="button"
        accessibilityLabel={`${item.title} ${CHAT_COPY.rowMenu}`}
        testID="conversation-row-menu-button"
      >
        <MoreIcon />
      </Pressable>
    </View>
  );
}

/** 标题关键词高亮（仅首个子串命中，大小写不敏感，FR-009）。 */
function highlight(title: string, keyword: string) {
  const i = title.toLowerCase().indexOf(keyword.toLowerCase());
  if (i < 0 || keyword.length === 0) return title;
  return (
    <Text>
      {title.slice(0, i)}
      <Text className="text-brand-500 bg-brand-soft" testID="conversation-search-highlight">
        {title.slice(i, i + keyword.length)}
      </Text>
      {title.slice(i + keyword.length)}
    </Text>
  );
}

// ─────────────────────────── 行内改名（FR-006，空禁用确定） ───────────────────────────

function RenameRow({
  item,
  onSubmit,
  onCancel,
}: {
  item: ConversationItem;
  onSubmit: (id: string, title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(item.title);
  const trimmed = value.trim();
  const confirmDisabled = trimmed.length === 0;

  return (
    <View className="px-md py-sm" testID="conversation-rename-row">
      <View className="bg-surface border border-brand-500 rounded-md px-md py-2.5">
        <TextInput
          className="text-base text-ink"
          value={value}
          onChangeText={setValue}
          autoFocus
          accessibilityLabel={CHAT_COPY.renameInput}
          testID="conversation-rename-input"
        />
      </View>
      <View className="flex-row justify-end gap-sm mt-sm">
        <Pressable
          className="bg-surface-alt border border-line rounded-full px-md py-1.5"
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel={CHAT_COPY.renameCancel}
          testID="conversation-rename-cancel"
        >
          <Text className="text-sm font-medium text-ink-muted">{CHAT_COPY.renameCancel}</Text>
        </Pressable>
        <Pressable
          className={`rounded-full px-md py-1.5 ${confirmDisabled ? 'bg-brand-300' : 'bg-brand-500'}`}
          onPress={() => onSubmit(item.id, trimmed)}
          disabled={confirmDisabled}
          accessibilityRole="button"
          accessibilityLabel={CHAT_COPY.renameConfirm}
          accessibilityState={{ disabled: confirmDisabled }}
          testID="conversation-rename-confirm"
        >
          <Text className="text-sm font-medium text-white">{CHAT_COPY.renameConfirm}</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─────────────────────────── 行操作菜单（⋯ tap → 重命名/删除） ───────────────────────────

function RowMenu({
  item,
  onClose,
  onRename,
  onDelete,
}: {
  item: ConversationItem | null;
  onClose: () => void;
  onRename: (item: ConversationItem) => void;
  onDelete: (item: ConversationItem) => void;
}) {
  // Modal portal + tap-scrim（tap 驱动，per RNGH web 手势非确定）。菜单卡居中浮于抽屉上。
  return (
    <ConfirmModalShell visible={item !== null} onScrimPress={onClose}>
      {item ? (
        <View
          className="bg-surface rounded-md border border-line overflow-hidden shadow-modal"
          style={{ width: 200 }}
          testID="conversation-row-menu"
        >
          <Pressable
            className="flex-row items-center gap-sm px-md py-3"
            onPress={() => onRename(item)}
            accessibilityRole="button"
            accessibilityLabel={CHAT_COPY.rename}
            testID="conversation-menu-rename"
          >
            <RenameIcon />
            <Text className="text-sm text-ink">{CHAT_COPY.rename}</Text>
          </Pressable>
          <View className="h-px bg-line" />
          <Pressable
            className="flex-row items-center gap-sm px-md py-3"
            onPress={() => onDelete(item)}
            accessibilityRole="button"
            accessibilityLabel={CHAT_COPY.deleteConversation}
            testID="conversation-menu-delete"
          >
            <TrashIcon />
            <Text className="text-sm text-err">{CHAT_COPY.deleteConversation}</Text>
          </Pressable>
        </View>
      ) : null}
    </ConfirmModalShell>
  );
}

/** 轻量 Modal 容器（行菜单用，居中 + tap-scrim 关）。镜像 ConfirmModal scrim 体例。 */
function ConfirmModalShell({
  visible,
  onScrimPress,
  children,
}: {
  visible: boolean;
  onScrimPress: () => void;
  children: ReactNode;
}) {
  // 复用 react-native Modal（与 ConfirmModal 同范式），不引新 dep。
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onScrimPress}>
      <View className="flex-1 bg-modal-overlay items-center justify-center px-xl">
        <Pressable
          onPress={onScrimPress}
          accessibilityLabel={CHAT_COPY.drawerBackdrop}
          className="absolute inset-0"
          testID="conversation-row-menu-scrim"
        />
        {children}
      </View>
    </Modal>
  );
}

// ─────────────────────────── 空态 ───────────────────────────

function EmptyHistory() {
  return (
    <View
      className="flex-1 items-center justify-center px-xl gap-md"
      testID="conversation-empty-history"
    >
      <View
        className="rounded-full bg-brand-soft items-center justify-center"
        style={{ width: 66, height: 66 }}
      >
        <SparkIcon size={30} color={colors.brand[500]} />
      </View>
      <Text className="text-base text-ink-muted text-center leading-relaxed">
        {CHAT_COPY.emptyHistory}
      </Text>
    </View>
  );
}

function SearchNoMatch() {
  return (
    <View
      className="flex-1 items-center justify-center px-xl gap-md"
      testID="conversation-search-no-match"
    >
      <View
        className="rounded-full bg-surface-alt items-center justify-center"
        style={{ width: 60, height: 60 }}
      >
        <SearchIcon size={26} color={colors.ink.subtle} />
      </View>
      <Text className="text-base text-ink-muted text-center">{CHAT_COPY.searchNoMatch}</Text>
    </View>
  );
}

// ─────────────────────────── icons（屏内一次性，不抽 ~/ui） ───────────────────────────

function MoreIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill={colors.ink.subtle}>
      <Circle cx={5} cy={12} r={1.7} />
      <Circle cx={12} cy={12} r={1.7} />
      <Circle cx={19} cy={12} r={1.7} />
    </Svg>
  );
}

function RenameIcon() {
  return (
    <Svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.muted}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M12 20h9" />
      <Path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Svg>
  );
}

function TrashIcon() {
  return (
    <Svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.err.DEFAULT}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M3 6h18" />
      <Path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <Path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </Svg>
  );
}

function SearchIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Circle cx={11} cy={11} r={7} />
      <Path d="M21 21l-4.3-4.3" />
    </Svg>
  );
}

function SparkIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M12 0c.5 5.4 2.6 9 12 12-9.4 3-11.5 6.6-12 12-.5-5.4-2.6-9-12-12C9.4 9 11.5 5.4 12 0Z" />
    </Svg>
  );
}
