// 027 T012 — 首页 AI 对话屏（翻 mockup design/ai-chat-home.dc.html 5 状态 baseline）。
//
// 5 状态（态机由 useChat / chat-reducer 驱动，本屏纯渲染 + 输入态）：
//   ① 空态        idle 且无消息   → Gemini 简约：sparkle + halo + 带昵称问候（FR-001）
//   ② 对话流      streaming/done  → Kimi 气泡：user 右 / AI 左 + 头像 + 打字机 caret
//   ③ 输入条      三态共用        → 「尽管问」placeholder + 发送（空内容禁用，FR-002）
//   ④ 错误态      error           → 错误气泡 + 重试 → retry()（FR-009）
//   ⑤ 停止态      stopped         → 半成品保留 + 「已停止」标识（FR-008）
// 顶栏：hamburger 占位（FR-011，不展开抽屉）+ 模型名只读 + 新建会话。
// 屏底常驻「内容由 AI 生成」（FR-010）。
//
// 视觉 = 0 新 token：复用 ~/theme（brand/ink/line/surface/err）+ ~/ui（Spinner）。
// RN 布局（per mobile-impl-playbook）：消息区 ScrollView 自动跟随底部（onContentSizeChange
// → scrollToEnd）；输入条用 react-native-keyboard-controller 的 KeyboardAvoidingView 顶起，
// 避免无界高容器裸 flex-1 撑爆（ScrollView 由 flex-1 父 View wrapper 约束 frame）。
//
// 复制按钮（消息操作条）走 expo-clipboard `setStringAsync` 复制消息内容，复制后切「已复制」反馈。
import { useCallback, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Stack } from 'expo-router';
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import * as Clipboard from 'expo-clipboard';

import { useMe } from '~/core/api/use-me';
import { SafeAreaView, MarkdownMessage } from '~/ui';
import { colors } from '~/theme';
import { useChat, type ChatMessage, type ChatModel, type ChatStatus } from './use-chat';
import { useLastConversationStore } from './last-conversation-store';
import { CHAT_COPY, greeting } from './chat-copy';
import { ChatDrawer } from './chat-drawer';
import { ModelSwitcherTrigger, ModelDropdown } from './model-switcher';
import { SearchProgress, WebSearchSources, DegradedNotice } from './web-search-sources';

export function ChatHomeScreen() {
  const { data: profile } = useMe();
  const {
    status,
    messages,
    error,
    send,
    stop,
    retry,
    selectConversation,
    newConversation,
    model,
    setModel,
    searchProgress,
  } = useChat();
  const [draft, setDraft] = useState('');
  // 028：左抽屉开关态提升到本屏（per plan D6）。tap 驱动开/关（hamburger / backdrop）。
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 029：模型下拉开关态提升到本屏（overlay 渲在屏级以覆盖全屏，遮罩 tap 关）。
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // 当前正打开的会话 id（持久化单源）—— 抽屉列表高亮 + selectConversation 切换守卫。
  const currentConversationId = useLastConversationStore((s) => s.lastConversationId);

  const scrollRef = useRef<ScrollView>(null);

  const trimmed = draft.trim();
  const isStreaming = status === 'streaming';
  const sendDisabled = trimmed.length === 0 || isStreaming;
  const hasMessages = messages.length > 0;

  const onSend = useCallback(() => {
    if (sendDisabled) return;
    void send(draft);
    setDraft('');
  }, [sendDisabled, send, draft]);

  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const toggleModelMenu = useCallback(() => setModelMenuOpen((o) => !o), []);
  const closeModelMenu = useCallback(() => setModelMenuOpen(false), []);

  // 029：setModel 是 async（流中 abort + 已落库则 PATCH 持久化）；下拉选项 tap 只需 fire-and-forget
  // （UI 即时反映靠内存态，PATCH 失败不阻塞——属「锦上添花」，与元数据降级同philosophy）。
  const onSelectModel = useCallback(
    (next: ChatModel) => {
      void setModel(next);
    },
    [setModel],
  );

  return (
    // 外层全屏 View 承载 Gemini 式淡蓝竖向渐变（绝对铺满，含状态栏区）；SafeAreaView 透明
    // 叠其上 → 渐变贯通整屏（空态 + 对话流 + 输入区），不随发消息「啪」地变白。
    <View className="flex-1">
      <Stack.Screen options={{ headerShown: false }} />
      <ChatGradientBackground />
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* relative：模型下拉 overlay 以本屏为定位锚（覆盖顶栏 + 消息区，遮罩 tap 关）。
          bg 透明 → 透出底层渐变（视觉走 ChatGradientBackground，非 bg-surface）。 */}
        <View className="flex-1">
          <ChatTopBar
            onMenuPress={openDrawer}
            onNewConversation={newConversation}
            model={model}
            modelMenuOpen={modelMenuOpen}
            onToggleModelMenu={toggleModelMenu}
          />

          {/* 消息区：flex-1 父 View wrapper 约束 ScrollView frame（per 布局铁律）。 */}
          <View className="flex-1">
            {hasMessages ? (
              <ScrollView
                ref={scrollRef}
                className="flex-1"
                contentContainerClassName="px-md pt-md pb-sm gap-md"
                onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
                keyboardShouldPersistTaps="handled"
                testID="chat-message-list"
              >
                {messages.map((m, i) => (
                  <MessageRow
                    key={i}
                    message={m}
                    isLast={i === messages.length - 1}
                    status={status}
                  />
                ))}
                {/* 030 检索中间态「已阅读 N 个网页」（FR-004）：streaming 且 searchProgress!=null
                  时挂尾（answer token 一开始即被 reducer 清空，过渡到答案流）。 */}
                {isStreaming && searchProgress !== null ? (
                  <View className="pl-10">
                    <SearchProgress count={searchProgress} />
                  </View>
                ) : null}
                {/* 错误态（FR-009）：reducer 已移除半成品 assistant 占位，错误气泡单独挂尾。 */}
                {status === 'error' ? (
                  <ErrorBubble message={error ?? CHAT_COPY.errorDefault} onRetry={retry} />
                ) : null}
              </ScrollView>
            ) : (
              <EmptyState displayName={profile?.displayName} />
            )}
          </View>

          {/* 屏底「内容由 AI 生成」标识（FR-010），有消息时常驻。 */}
          {hasMessages ? (
            <Text
              className="text-center text-xs text-ink-subtle pb-xs"
              testID="chat-ai-generated-notice"
            >
              {CHAT_COPY.aiGeneratedNotice}
            </Text>
          ) : null}

          <KeyboardAvoidingView behavior="padding">
            <InputBar
              value={draft}
              onChangeText={setDraft}
              onSend={onSend}
              onStop={stop}
              isStreaming={isStreaming}
              sendDisabled={sendDisabled}
            />
          </KeyboardAvoidingView>

          {/* 029 模型下拉 overlay（屏级渲染 → absolute inset-0 锚整屏，遮罩 tap 关；open=false
            不挂载，不挡底层交互）。放最后 → z 序在顶栏/消息区/输入条之上。 */}
          {modelMenuOpen ? (
            <ModelDropdown model={model} onClose={closeModelMenu} onSelect={onSelectModel} />
          ) : null}
        </View>

        {/* 028 左抽屉（overlay 覆盖本屏，open=false 时 unmount 不挡交互）。 */}
        <ChatDrawer
          open={drawerOpen}
          onClose={closeDrawer}
          currentConversationId={currentConversationId}
          onSelectConversation={selectConversation}
          onNewConversation={newConversation}
        />
      </SafeAreaView>
    </View>
  );
}

// ─────────────────────────────── 顶栏（FR-011） ───────────────────────────────

function ChatTopBar({
  onMenuPress,
  onNewConversation,
  model,
  modelMenuOpen,
  onToggleModelMenu,
}: {
  onMenuPress: () => void;
  onNewConversation: () => void;
  model: ChatModel;
  modelMenuOpen: boolean;
  onToggleModelMenu: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between px-sm h-[52px]">
      {/* hamburger：028 起点击展开左侧历史抽屉（FR-001）。 */}
      <Pressable
        className="w-10 h-10 items-center justify-center rounded-full"
        onPress={onMenuPress}
        accessibilityRole="button"
        accessibilityLabel={CHAT_COPY.menu}
        testID="chat-menu-button"
      >
        <HamburgerIcon />
      </Pressable>

      {/* 029 模型选择器（FR-001）：tap 开下拉切 flash/pro；下拉浮层在屏级渲染。 */}
      <ModelSwitcherTrigger model={model} open={modelMenuOpen} onToggle={onToggleModelMenu} />

      {/* 新建会话入口（FR-005）：清空回空态，新会话首发前不落库。 */}
      <Pressable
        className="w-10 h-10 items-center justify-center rounded-full"
        onPress={onNewConversation}
        accessibilityRole="button"
        accessibilityLabel={CHAT_COPY.newConversation}
        testID="chat-new-conversation-button"
      >
        <PlusCircleIcon />
      </Pressable>
    </View>
  );
}

// ──────────────────────────── 空态（FR-001 Gemini 简约） ────────────────────────────

function EmptyState({ displayName }: { displayName?: string | null }) {
  return (
    <View className="flex-1 items-center justify-center px-xl gap-lg" testID="chat-empty-state">
      <View className="w-20 h-20 items-center justify-center">
        <View className="absolute inset-0 rounded-full bg-brand-soft" />
        <SparkIcon size={40} color={colors.brand[500]} />
      </View>
      <Text
        className="text-2xl font-medium text-ink text-center leading-relaxed"
        testID="chat-greeting"
      >
        {greeting(displayName)}
      </Text>
    </View>
  );
}

// ──────────────────────────── 消息行（Kimi 气泡） ────────────────────────────

function MessageRow({
  message,
  isLast,
  status,
}: {
  message: ChatMessage;
  isLast: boolean;
  status: ChatStatus;
}) {
  if (message.role === 'user') {
    return (
      <View className="flex-row justify-end" testID="chat-message-user">
        <View className="max-w-[80%] bg-brand-500 rounded-2xl rounded-br-sm px-md py-2.5">
          <Text className="text-base text-white leading-relaxed">{message.content}</Text>
        </View>
      </View>
    );
  }

  // 错误态：末条 assistant 已被 reducer 移除（FR-009 失败不落半成品），故错误气泡挂在
  // 「最后一条是 user 且 status===error」时单独渲染（见下方 AssistantArea 决策）。
  return (
    <View className="flex-row gap-2.5 items-start" testID="chat-message-assistant">
      <AiAvatar />
      <View className="max-w-[82%] gap-2">
        <View className="bg-surface-alt border border-line-soft rounded-2xl rounded-bl-sm px-md py-3">
          {/* AI 回复走 markdown 渲染（DeepSeek 默认吐 markdown）；流式 caret 挂气泡尾。 */}
          <MarkdownMessage content={message.content} />
          {isLast && status === 'streaming' ? (
            <Text className="text-base text-brand-500 leading-relaxed" testID="chat-typing-caret">
              {' ▍'}
            </Text>
          ) : null}
        </View>

        {/* 停止态标识（FR-008）：半成品下方「已停止」。 */}
        {message.status === 'stopped' ? (
          <View className="flex-row items-center gap-1.5 pl-0.5" testID="chat-stopped-label">
            <View className="w-1.5 h-1.5 rounded-full bg-ink-subtle" />
            <Text className="text-xs text-ink-subtle">{CHAT_COPY.stoppedLabel}</Text>
          </View>
        ) : null}

        {/* 030 降级标识（FR-009）：检索失败基于已有知识作答时显「本次未联网」。 */}
        {message.degraded ? <DegradedNotice /> : null}

        {/* 030 编号来源区（FR-005/006/007）：可折叠「N 个网页来源 ›」+ 展开编号行 tap 打开。 */}
        {message.sources && message.sources.length > 0 ? (
          <WebSearchSources sources={message.sources} />
        ) : null}

        {/* 消息操作条：复制（赞 / 踩为扩展能力，留 028+，027 不做）。完成 / 停止态展示。 */}
        {message.status !== 'streaming' ? <MessageActions content={message.content} /> : null}
      </View>
    </View>
  );
}

/** 错误态气泡（FR-009）：用户 msg 已在，AI 区显示错误 + 重试。不显示半截失败内容。 */
function ErrorBubble({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View className="flex-row gap-2.5 items-start" testID="chat-error-state">
      <AiAvatar />
      <View className="max-w-[84%] bg-err-soft border border-err-soft rounded-2xl rounded-bl-sm px-md py-3.5 gap-3">
        <View className="flex-row items-start gap-2">
          <WarnIcon />
          <Text className="text-sm text-ink leading-relaxed flex-1">{message}</Text>
        </View>
        <Pressable
          className="self-start flex-row items-center gap-1.5 bg-surface border border-err rounded-full px-md py-1.5"
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={CHAT_COPY.retry}
          testID="chat-retry-button"
        >
          <RetryIcon />
          <Text className="text-sm font-medium text-err">{CHAT_COPY.retry}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** 消息操作条 —— 027 仅复制（赞 / 踩为扩展能力，留 028+）。复制走 expo-clipboard。 */
function MessageActions({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    await Clipboard.setStringAsync(content);
    setCopied(true);
  }, [content]);

  return (
    <View className="flex-row items-center pl-0.5" testID="chat-message-actions">
      <Pressable
        className="w-8 h-8 items-center justify-center rounded-lg flex-row gap-1"
        onPress={() => void onCopy()}
        accessibilityRole="button"
        accessibilityLabel={CHAT_COPY.copy}
        testID="chat-copy-button"
      >
        <CopyIcon />
        {copied ? (
          <Text className="text-xs text-ink-subtle" testID="chat-copied-feedback">
            {CHAT_COPY.copied}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

// ──────────────────────────── 输入条（FR-002，三态共用） ────────────────────────────

function InputBar({
  value,
  onChangeText,
  onSend,
  onStop,
  isStreaming,
  sendDisabled,
}: {
  value: string;
  onChangeText: (s: string) => void;
  onSend: () => void;
  onStop: () => void;
  isStreaming: boolean;
  sendDisabled: boolean;
}) {
  return (
    // 容器透明 → 透出底层渐变（Gemini 式输入条浮于渐变上）；输入药丸自带 surface-alt 底。
    // 030 A1：恒联网（ChatGPT 式）→ 去「智能搜索」toggle pill，是否检索由 server 模型自决。
    <View className="px-3.5 pt-2 pb-5 gap-2">
      <View className="flex-row items-center gap-2 bg-surface-alt border border-line-soft rounded-full pl-md pr-1.5 py-1.5">
        <TextInput
          className="flex-1 text-base text-ink"
          value={value}
          onChangeText={onChangeText}
          placeholder={CHAT_COPY.inputPlaceholder}
          placeholderTextColor={colors.ink.subtle}
          editable={!isStreaming}
          multiline
          // web：Enter 发送 / Shift+Enter 换行（对齐主流 AI 助手）。RN-Web 的 onKeyPress
          // nativeEvent 透传 DOM KeyboardEvent，含 key + shiftKey；blurOnSubmit={false} 防 Enter
          // 在 handler 前自动插换行/失焦（necolas/react-native-web#524）。原生侧 onKeyPress 不可靠
          // 上报 Enter/修饰键，走发送按钮，故仅 web 挂此处理。
          blurOnSubmit={false}
          onKeyPress={
            Platform.OS === 'web'
              ? (e) => {
                  const ne = e.nativeEvent as unknown as { key: string; shiftKey: boolean };
                  if (ne.key === 'Enter' && !ne.shiftKey) {
                    (e as unknown as { preventDefault?: () => void }).preventDefault?.();
                    onSend();
                  }
                }
              : undefined
          }
          accessibilityLabel={CHAT_COPY.inputPlaceholder}
          testID="chat-input"
        />
        {isStreaming ? (
          // 流式中：发送位变「停止」（FR-008）。
          <Pressable
            className="w-9 h-9 rounded-full items-center justify-center bg-brand-500"
            onPress={onStop}
            accessibilityRole="button"
            accessibilityLabel={CHAT_COPY.stopGenerating}
            testID="chat-stop-button"
          >
            <View className="w-3 h-3 rounded-sm bg-white" />
          </Pressable>
        ) : (
          <Pressable
            className={`w-9 h-9 rounded-full items-center justify-center ${
              sendDisabled ? 'bg-surface-sunken' : 'bg-brand-500'
            }`}
            onPress={onSend}
            disabled={sendDisabled}
            accessibilityRole="button"
            accessibilityLabel={CHAT_COPY.send}
            accessibilityState={{ disabled: sendDisabled }}
            testID="chat-send-button"
          >
            <SendIcon disabled={sendDisabled} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ─────────────────────── Gemini 式渐变背景（屏内一次性，不抽 ~/ui） ───────────────────────

/** 淡蓝竖向渐变：顶/底淡蓝（brand-100）、中段透白（surface），绝对铺满整屏（含状态栏区）。
 *  走 react-native-svg（与 profile.tsx HeroBlurBackdrop 同范式，0 新 dep）；色值取 ~/theme token。 */
function ChatGradientBackground() {
  return (
    <View className="absolute inset-0">
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="chatHomeBg" x1="0" y1="0" x2="0" y2="1">
            <Stop offset={0} stopColor={colors.brand[100]} />
            <Stop offset={0.35} stopColor={colors.surface.DEFAULT} />
            <Stop offset={0.65} stopColor={colors.surface.DEFAULT} />
            <Stop offset={1} stopColor={colors.brand[100]} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#chatHomeBg)" />
      </Svg>
    </View>
  );
}

// ─────────────────────────────── icons（屏内一次性，不抽 ~/ui） ───────────────────────────────

/** brand 星芒（空态标识 + AI 头像，mockup sparkSVG）。 */
function SparkIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M12 0c.5 5.4 2.6 9 12 12-9.4 3-11.5 6.6-12 12-.5-5.4-2.6-9-12-12C9.4 9 11.5 5.4 12 0Z" />
    </Svg>
  );
}

function AiAvatar() {
  return (
    <View className="w-8 h-8 rounded-full bg-brand-500 items-center justify-center">
      <SparkIcon size={17} color="#fff" />
    </View>
  );
}

function HamburgerIcon() {
  return (
    <Svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.DEFAULT}
      strokeWidth={2}
      strokeLinecap="round"
    >
      <Path d="M3 6h18" />
      <Path d="M3 12h18" />
      <Path d="M3 18h18" />
    </Svg>
  );
}

function PlusCircleIcon() {
  return (
    <Svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.DEFAULT}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M12 5v14" />
      <Path d="M5 12h14" />
      <Circle cx={12} cy={12} r={9.2} opacity={0.28} />
    </Svg>
  );
}

function SendIcon({ disabled }: { disabled: boolean }) {
  return (
    <Svg
      width={19}
      height={19}
      viewBox="0 0 24 24"
      fill="none"
      stroke={disabled ? colors.ink.subtle : '#fff'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M12 19V5" />
      <Path d="M6 11l6-6 6 6" />
    </Svg>
  );
}

function CopyIcon() {
  return (
    <Svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.subtle}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Rect x={9} y={9} width={11} height={11} rx={2.5} />
      <Path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </Svg>
  );
}

function WarnIcon() {
  return (
    <Svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.err.DEFAULT}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Circle cx={12} cy={12} r={9} />
      <Path d="M12 7.5v5" />
      <Circle cx={12} cy={16} r={0.6} fill={colors.err.DEFAULT} />
    </Svg>
  );
}

function RetryIcon() {
  return (
    <Svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.err.DEFAULT}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" />
      <Path d="M3 3v5h5" />
    </Svg>
  );
}
