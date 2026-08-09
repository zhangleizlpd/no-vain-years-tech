// 028 T009 — 左侧历史会话抽屉（翻 mockup frame 1 骨架 + frame 5 搜索框 + 底部用户区）。
//
// 045 T018 起**骨架已抽到 `~/ui/app-drawer`**（plan D11：Modal root 层挂载 / backdrop 淡入 +
// tap 关 / 面板 82% translateX 滑入 / swipe-left 关 / 安全区内缩 / onRequestClose 接 Android
// 硬件返回 / 关态 unmount）。本文件只留 chat 业务内容，作为 children 传入：
//   ├─ 顶段：搜索框（仅按标题，FR-009）+「新建对话」入口（FR-005）
//   ├─ 中段：ConversationList（分组 / 搜索 / 空态，行操作）
//   ├─ 菜单区：灵感入口（045 T021 新增，与全局抽屉共用 IdeationDrawerEntry）
//   └─ 底段：用户脚（045 T021 抽到 ~/core/drawer-user-footer，与全局抽屉共用；testID 前缀派生）
// testID 契约（`chat-drawer` / `-panel` / `-backdrop` 由容器按前缀派生，`-user-name` /
// `-settings-button` 由用户脚按前缀派生，其余在本文件）**逐字不变**。
//
// 开关 tap 驱动（hamburger 开 / backdrop tap 关，per RNGH web 手势非确定 memory）。open 态由
// chat-home-screen 持有，传入 props。
// presentational/编排 —— 无 vitest（render/手势走 Playwright e2e，per mono 测试分层）。
import { useCallback } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { DrawerUserFooter } from '~/core/drawer-user-footer';
import { IdeationDrawerEntry } from '~/ideation';
import { colors } from '~/theme';
import { AppDrawer } from '~/ui';
import { CHAT_COPY } from './chat-copy';
import { ConversationList } from './conversation-list';
import { useConversations } from './use-conversations';

export interface ChatDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 当前正打开的会话 id（高亮 + 切换守卫）。 */
  currentConversationId: string | null;
  /** 点选历史会话（切换 hydrate；上层接 useChat.selectConversation 后关抽屉）。
   *  029 第二参 = 该会话 model（FR-007：透传让顶栏 model 随会话恢复）。 */
  onSelectConversation: (id: string, model: string) => void;
  /** 新建对话（清空回空态；上层接 useChat.newConversation 后关抽屉）。 */
  onNewConversation: () => void;
}

export function ChatDrawer({
  open,
  onClose,
  currentConversationId,
  onSelectConversation,
  onNewConversation,
}: ChatDrawerProps) {
  const {
    conversations,
    searchInput,
    setSearchInput,
    isSearching,
    query,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    renameConversation,
    deleteConversation,
  } = useConversations();

  const onSelect = useCallback(
    (id: string, model: string) => {
      onSelectConversation(id, model);
      onClose();
    },
    [onSelectConversation, onClose],
  );

  const onNew = useCallback(() => {
    onNewConversation();
    onClose();
  }, [onNewConversation, onClose]);

  // 删除当前正打开的会话 → 主屏清空回 027 空态（FR-008 / SC-008）。删非当前会话仅移除列表行，
  // 主屏不变。删当前会话复用 newConversation 语义（先中断进行中流 + reducer reset，FR-011）。
  const onDelete = useCallback(
    async (id: string) => {
      await deleteConversation(id);
      if (id === currentConversationId) onNewConversation();
    },
    [deleteConversation, currentConversationId, onNewConversation],
  );

  return (
    // 骨架（Modal root 层挂载盖住 Tab 栏 / backdrop tap 关 / 面板 82% 滑入 / swipe-left 关 /
    // 安全区内缩 / 硬件返回 / 关态 unmount）全在 ~/ui/app-drawer（045 T018 抽出，plan D11）。
    // testID 前缀 'chat-drawer' → 容器按前缀派生 '-panel' / '-backdrop'，既有 e2e 契约不变。
    <AppDrawer
      open={open}
      onClose={onClose}
      testID="chat-drawer"
      accessibilityLabel={CHAT_COPY.drawerLabel}
      backdropAccessibilityLabel={CHAT_COPY.drawerBackdrop}
    >
      {/* 顶段：搜索框 + 新建对话（pt-2xl 在安全区之下留设计间距）。 */}
      <View className="px-md pt-2xl pb-xs">
        <View className="flex-row items-center gap-sm bg-surface-alt border border-line rounded-full px-md py-2.5">
          <SearchGlyph />
          <TextInput
            className="flex-1 text-sm text-ink"
            value={searchInput}
            onChangeText={setSearchInput}
            placeholder={CHAT_COPY.searchPlaceholder}
            placeholderTextColor={colors.ink.subtle}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={CHAT_COPY.searchPlaceholder}
            testID="chat-drawer-search-input"
          />
          {searchInput.length > 0 ? (
            <Pressable
              hitSlop={8}
              onPress={() => setSearchInput('')}
              accessibilityRole="button"
              accessibilityLabel={CHAT_COPY.searchClear}
              testID="chat-drawer-search-clear"
            >
              <ClearGlyph />
            </Pressable>
          ) : null}
        </View>

        <Pressable
          className="flex-row items-center gap-sm rounded-sm px-sm py-2.5 mt-sm"
          onPress={onNew}
          accessibilityRole="button"
          accessibilityLabel={CHAT_COPY.newConversationDrawer}
          testID="chat-drawer-new-conversation"
        >
          <View
            className="rounded-sm bg-brand-soft items-center justify-center"
            style={{ width: 26, height: 26 }}
          >
            <PlusGlyph />
          </View>
          <Text className="text-base font-medium text-brand-500">
            {CHAT_COPY.newConversationDrawer}
          </Text>
        </Pressable>
      </View>

      {/* 中段：会话列表（分组 / 搜索 / 空态 / 行操作）。 */}
      <ConversationList
        conversations={conversations}
        isSearching={isSearching}
        searchQuery={query}
        currentConversationId={currentConversationId}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onEndReached={fetchNextPage}
        onSelect={onSelect}
        onRename={renameConversation}
        onDelete={onDelete}
      />

      {/* 菜单区：灵感入口（045 FR-025）。与全局抽屉**共用同一个组件 / copy / 导航语义**，
        只有 testID 前缀不同 —— 首页汉堡维持开本抽屉（user 2026-08-01 裁决方案 C），故灵感
        入口必须也落在这里，否则首页进不了灵感。上边框把它与会话列表分开（非列表行）。 */}
      <View className="border-t border-line">
        <IdeationDrawerEntry testID="chat-drawer-ideation-entry" onNavigate={onClose} />
      </View>

      {/* 底段：用户区（头像 + 昵称 + 齿轮 → 设置，D8）。045 T021 抽到 ~/core/drawer-user-footer
        与全局抽屉共用；testID 由前缀派生，`chat-drawer-user-name` / `-settings-button` 逐字不变。 */}
      <DrawerUserFooter
        testIDPrefix="chat-drawer"
        settingsLabel={CHAT_COPY.settings}
        fallbackName={CHAT_COPY.userFallbackName}
        onNavigate={onClose}
      />
    </AppDrawer>
  );
}

// ─────────────────────────── icons（屏内一次性，不抽 ~/ui） ───────────────────────────

function SearchGlyph() {
  return (
    <Svg
      width={17}
      height={17}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.muted}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Circle cx={11} cy={11} r={7} />
      <Path d="M21 21l-4.3-4.3" />
    </Svg>
  );
}

function ClearGlyph() {
  return (
    <Svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.subtle}
      strokeWidth={2}
      strokeLinecap="round"
    >
      <Path d="M6 6l12 12" />
      <Path d="M18 6L6 18" />
    </Svg>
  );
}

function PlusGlyph() {
  return (
    <Svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.brand[500]}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M12 5v14" />
      <Path d="M5 12h14" />
    </Svg>
  );
}
