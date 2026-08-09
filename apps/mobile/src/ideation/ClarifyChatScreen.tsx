// 032 T015 — 澄清对话屏（翻面 B，clarify-chat.dc.html 6 态 baseline，承 027 chat 视觉）。
//
// 6 态（态机由 use-ideation-session / ideation-reducer 驱动，本屏纯渲染 + 输入态）：
//   ① 流式反问气泡 + caret      streaming   → AI 左气泡 token 累加 + 末条打字机光标
//   ② chips 轮                  done        → 推荐项「（推荐）」brand-soft 首位不预选 +
//                                              末位逃生 + 横排换行（契约 §4）
//   ③ chip 点选 → **直接发送**            → tap 内容 chip ⇒ onSend(fill ?? label) 即成一轮
//                                              （契约 §4.5 quick-reply 即发）；逃生项 ⇒ 聚焦输入条自填
//   ④ 纯文本轮无 chips          done        → assistant turn 无 suggestion 即纯文本
//   ⑤ AI 软提示 + 「生成 brief」 done        → 底部主按钮触发 generateBrief（用户主动收敛）
//   ⑥ 流式失败 err-soft 条 + 重试 error      → 错误条 + 重试（reducer 已移除半成品 assistant）
// 自由输入条**全态常驻**（idle/streaming/done/stopped/error 皆可见，streaming 时锁编辑 → 停止）。
//
// 视觉 = 0 新 token：复用 ~/theme（brand/ink/line/surface/err）+ ~/ui（Spinner）。承 027
// chat 气泡/输入条/ScrollView 跟随结构（MessageRow / InputBar / onContentSizeChange scrollToEnd）。
//
// RN 布局（per mobile-impl-playbook）：消息区 flex-1 父 View wrapper 约束 ScrollView frame
// （width class 不约束 ScrollView frame → 须包 View），onContentSizeChange → scrollToEnd 跟随；
// 输入条用 react-native-keyboard-controller 的 KeyboardStickyView 顶起——它是该库官方 chat
// 输入条范式（KeyboardAvoidingView 仅原型级、Android 15 edge-to-edge 下顶不动；KeyboardStickyView
// 原生帧同步 translateY 跟键盘，iOS/Android 一致，web 无键盘事件 → translateY 恒 0 = 静态条由
// 浏览器自处理，三端统一无 Platform 分支）。offset.opened = insets.bottom：父 SafeAreaView
// edges=['bottom'] 已垫底部安全区，键盘起时收掉这段冗余 inset 使输入条贴键盘顶沿。
//
// 收敛触发：点「生成 brief」→ generateBrief()。converged=false → onMissing(missing) 让父屏
// 用 missing 提示「继续追问缺失段」（不跳 brief 屏）；converged=true → onConverged() 切 brief 屏
// （T016）。导航/屏切换单源在父屏（[id].tsx），本屏只回调，不自行导航（同 CreateOverlay 铁律 2）。
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
  TextInputSelectionChangeEventData,
} from 'react-native';
import { Keyboard, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';

import { ossThumbUrl } from '~/profile-image/oss-image';
import { colors } from '~/theme';
import { IconButton, Spinner } from '~/ui';
import { ideationImageViewerRoute } from './ideation-routes';
import { IDEATION_COPY, voiceDegradeToast } from './ideation-copy';
import { IdeationToast } from './IdeationToast';
import { IdeationWaveform } from './IdeationWaveform';
import { InputPlusSheet } from './InputPlusSheet';
import { RepoPickerSheet } from './RepoPickerSheet';
import { SourcesDisclosure } from './SourcesDisclosure';
import { ThumbChip } from './ThumbChip';
import { useAnnotateSendStore } from './annotate-send-store';
import { buildImageOnlySendPayload } from './image-send-payload';
import { useIdeationAttachments, type StagedAttachment } from './use-ideation-attachments';
import { mapIdeationUploadError, useIdeationImageUpload } from './use-ideation-image-upload';
import type { IdeationTurnImagePayload } from './ideation-stream-client';
import {
  useIdeationRecording,
  type DraftSelection,
  type UseIdeationRecording,
  type VoiceDegradeReason,
} from './use-ideation-recording';
import { chipDisplayLabel, chipFillValue } from './clarify-chip.rules';
import type { NormalizedSuggestion, SuggestionOption } from './ideation-sse-parse';
import type { IdeationStatus, IdeationTurn } from './ideation-reducer';

export interface ClarifyChatScreenProps {
  /** 035 语音输入：目标会话 id（开 ASR WS 用；null = 未就绪，禁录）。 */
  sessionId: string | null;
  status: IdeationStatus;
  turns: IdeationTurn[];
  error: string | null;
  /**
   * 发一轮澄清（空白由 hook 守卫拒）。036 T014 仅附图直发：带 image payload（原图 ossKey +
   * previewUris，无 annotationText）→ 同 send 链路触发 M3 视觉路由。缺省 image = 纯文本轮。
   */
  onSend: (content: string, image?: IdeationTurnImagePayload & { previewUris?: string[] }) => void;
  /** 停止进行中流式。 */
  onStop: () => void;
  /** 失败重试上一条。 */
  onRetry: () => void;
  /** 点「生成 brief」收敛（converged → 父切 brief 屏 / 未收敛 → 父提示 missing）。 */
  onGenerateBrief: () => void;
  /** brief 生成 in-flight（按钮 loading）。 */
  isGeneratingBrief: boolean;
  /** 未收敛缺失段提示（父屏从 generateBrief().missing 透传；null = 无提示）。 */
  missingHint: string | null;
  /** 034 接地：当前会话锁定的目标 repo（RepoPickerSheet 高亮；null = 未选）。 */
  selectedRepo: string | null;
  /** 034 接地：选中 repo → 写会话态（set-repo PATCH）。失败由本屏 toast。 */
  onSelectRepo: (repo: string) => Promise<boolean>;
  /** 034 接地：检索进行中指示（「正在检索代码…」短暂 pill）。 */
  retrieving: boolean;
}

export function ClarifyChatScreen({
  sessionId,
  status,
  turns,
  error,
  onSend,
  onStop,
  onRetry,
  onGenerateBrief,
  isGeneratingBrief,
  missingHint,
  selectedRepo,
  onSelectRepo,
  retrieving,
}: ClarifyChatScreenProps) {
  const [draft, setDraft] = useState('');
  // 035：追踪输入框选区（final 合并插入光标处用，FR-010）；无焦点 = {null,null} → 追加末尾。
  const [selection, setSelectionState] = useState<DraftSelection>({ start: null, end: null });
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  // 键盘起时收掉父 SafeAreaView edges=['bottom'] 垫的安全区，令输入条贴键盘顶沿（见文件头布局注）。
  const insets = useSafeAreaInsets();

  // 内联 toast（033 多模态壳：占位 / 权限提示）。fireToast 下传给 InputBar / 后续 sheet /
  // attachments hook（本期消费方逐步接入）；auto-hide ~1.9s，新 toast 顶掉前一个的计时器。
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fireToast = useCallback((msg: string) => {
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(null), 1900);
  }, []);
  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  // 本地暂存附件（033 多模态壳 US2）：选/拍 → 本地缩略图带回，client-only 无上传（FR-011）。
  const attachments = useIdeationAttachments(fireToast);

  // 036 T014 仅附图直发：发送时把暂存原图（未进标注画布 → 无 pin 烧录）顺序上传 OSS（uploadImages
  // 顺序保 FR-010 = 缩略条顺序）→ 组「attachmentKeys（原图）+ 文字」走 send 链路。sessionId 缺省空
  // 串（uploadImage 内部按 sessionId scope 凭证；无会话时下方 onSendPress 早返不触发上传）。
  const imageUpload = useIdeationImageUpload(sessionId ?? '');

  // `+` 附件面板开合 state（T006）。
  const [sheetOpen, setSheetOpen] = useState(false);
  // 034 选择代码库 sheet 开合 state（从 InputPlusSheet「选择代码库」打开）。
  const [repoSheetOpen, setRepoSheetOpen] = useState(false);
  // 🚨 跨 Modal 转场排序（RN + Fabric，真机 Mate50 实测 + RN 社区共识）：InputPlusSheet 与
  // RepoPickerSheet 都是 root `Modal`，RN 同一时刻只能 present 一个 Modal；「关 A 同帧开 B」
  // 两 Modal 在 slide 转场里重叠 → Fabric ShadowTree 与原生视图失同步 → RepoPickerSheet 量错
  // 高度塌缩、仓库行被裁出视口选不中。修法 = 待 InputPlusSheet slide-out (~300ms) 动画结束再开 B。
  const repoSheetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRepoPickerSequenced = useCallback(() => {
    if (repoSheetTimerRef.current !== null) clearTimeout(repoSheetTimerRef.current);
    repoSheetTimerRef.current = setTimeout(() => setRepoSheetOpen(true), 320);
  }, []);
  useEffect(
    () => () => {
      if (repoSheetTimerRef.current !== null) clearTimeout(repoSheetTimerRef.current);
    },
    [],
  );

  // 选中 repo → 写会话态；失败落 toast（不污染对话态机，per plan §6）。
  const onRepoChosen = useCallback(
    (repo: string) => {
      void onSelectRepo(repo).catch(() => fireToast(IDEATION_COPY.repoSetFailed));
    },
    [onSelectRepo, fireToast],
  );

  const trimmed = draft.trim();
  const isStreaming = status === 'streaming';
  // 🚨 send 可发送性**仅看文本**（附件不单独构成可发，图片随文字一轮提交，FR-010/011）；
  // 流式态 / 上传中（T014 仅附图直发上传 in-flight）禁发，防重入。
  const sendDisabled = trimmed.length === 0 || isStreaming || imageUpload.isUploading;
  const hasTurns = turns.length > 0;

  // 035 push-to-talk 录音编排（态机 + 采集 + WS + 60s + 合并插入；副作用薄壳）。
  // 权限拒绝（FR-006）：录音专用「需要麦克风权限·去设置」toast，引导去系统设置（仿 image-picker
  // deny→toast 范式，不 throw、不崩、会话继续，SC-004）。
  const onVoicePermissionDenied = useCallback(() => {
    fireToast(IDEATION_COPY.micPermissionDenied);
  }, [fireToast]);
  // 降级三态（FR-007/009）：转写失败 / 未识别 / 已达上限 → 据 reason 查穷举映射表（不泄露
  // 内部错误细节）；复用 B2-1 IdeationToast pill；会话不阻断（SC-004）。
  const onVoiceDegrade = useCallback(
    (reason: VoiceDegradeReason) => {
      fireToast(voiceDegradeToast(reason));
    },
    [fireToast],
  );
  const recording = useIdeationRecording({
    sessionId,
    draft,
    setDraft,
    selection,
    setSelection: setSelectionState,
    isStreaming,
    onPermissionDenied: onVoicePermissionDenied,
    onDegrade: onVoiceDegrade,
  });
  // 035 一次性范式：输入框全程可编辑（无实时 partial 机器写入）；仅流式澄清回复时锁编辑。
  const inputEditable = !isStreaming;

  const onSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      const { start, end } = e.nativeEvent.selection;
      setSelectionState({ start, end });
    },
    [],
  );

  // 收敛入口（⑤ 软提示按钮）：有至少一轮 assistant 完成且非流式/错误态才显示「生成 brief」。
  const canGenerateBrief =
    !isStreaming &&
    status !== 'error' &&
    turns.some((t) => t.role === 'assistant' && t.status !== 'stopped');

  // 036 T014 仅附图直发：暂存图（未进标注画布 → 原图，无 pin 烧录）+ 文字 → 顺序上传 → 组
  // 「attachmentKeys（原图 ossKey）+ 文字」走 send 链路（复用 T012 已通的 send image payload，
  // 不新建发送路径）。无暂存图 → 纯文本轮（行为零回归）。上传失败 → toast 不脏写（turn 不发、
  // 暂存图保留可重试，FR-011/SC-004）；成功后清空暂存图 + 输入框。
  const onSendPress = useCallback(() => {
    if (sendDisabled) return;
    const content = draft;
    const staged = attachments.attachments;
    // 无暂存图 → 纯文本轮（旧路径，零回归）。
    if (staged.length === 0 || sessionId === null) {
      onSend(content);
      setDraft('');
      return;
    }
    // 仅附图直发：顺序上传原图（FR-010 = 缩略条顺序）→ 组带图 payload → send。
    const uris = staged.map((a) => a.localUri);
    void (async () => {
      try {
        const keys = await imageUpload.uploadImages(uris);
        const image = buildImageOnlySendPayload(keys, uris);
        onSend(content, image);
        setDraft('');
        attachments.clear();
      } catch (e) {
        // 上传失败：turn 不发、暂存图保留（FR-011 不脏写）；友好 toast（不泄露 vendor/凭证细节）。
        fireToast(mapIdeationUploadError(e));
      }
    })();
  }, [sendDisabled, onSend, draft, attachments, sessionId, imageUpload, fireToast]);

  // `+`（附件入口）按下：开 InputPlusSheet（root Modal bottom-sheet）。
  // 打开前先收起键盘（避免与 sheet 叠加冲突，per spec edge case）。
  // 🚨 流式态禁用附件入口（FR-014，与 send→stop 互斥，沿用 035 流式 gate）。
  const onPlusPress = useCallback(() => {
    if (isStreaming) return;
    Keyboard.dismiss();
    inputRef.current?.blur();
    setSheetOpen(true);
  }, [isStreaming]);

  // 036 FR-001：点暂存缩略图 → 全屏查看器（带 uri/index/sessionId）。sessionId 缺（未就绪）则不导航。
  const onOpenAttachment = useCallback(
    (att: StagedAttachment, i: number) => {
      if (sessionId === null) return;
      router.push(ideationImageViewerRoute({ uri: att.localUri, index: String(i), sessionId }));
    },
    [sessionId],
  );

  // 036 T015 — 消费标注画布交接的「带图轮发送」（US1 脊柱跨屏闭环）：标注屏烧录+上传完成后
  // setPendingSend → router.back 回本屏 → 本 effect 监听同会话 pending → onSend(annotationText,
  // image) 走既有 send 链路（user turn 缩略回显 + 入澄清闭环）→ 消费即 clear（不重发）+ 清空暂存图
  // （标注源图已发送，缩略条不再保留，FR-006/009）。
  const pendingSend = useAnnotateSendStore((s) => s.pending);
  const clearPendingSend = useAnnotateSendStore((s) => s.clearPendingSend);
  useEffect(() => {
    if (pendingSend === null) return;
    // 仅消费本会话的 pending（防不同会话残留误发，store 带 sessionId）。
    if (sessionId === null || pendingSend.sessionId !== sessionId) return;
    const { annotationText, attachmentKeys, previewUris } = pendingSend;
    clearPendingSend();
    onSend(annotationText, { attachmentKeys, annotationText, previewUris });
    attachments.clear();
  }, [pendingSend, sessionId, clearPendingSend, onSend, attachments]);

  // ③ chip 点选 → **直接发送**（契约 §4.5：quick-reply 即发，不回填+二次点）。
  //   - 逃生项（都不是/自己说）：不发送 → 清空并聚焦输入条，让用户自己打。
  //   - 内容项（含「采纳」）：onSend(发送值=fill ?? label) 直接成一轮、继续对话。
  const onChipPress = useCallback(
    (opt: SuggestionOption) => {
      if (isStreaming) return; // 流式中不接（chips 本就只在非流式渲，双保险）。
      if (opt.escapeHatch) {
        setDraft('');
        inputRef.current?.focus();
        return;
      }
      const value = chipFillValue(opt);
      if (value.length === 0) return;
      onSend(value);
    },
    [isStreaming, onSend],
  );

  // 内容变化（新 turn / token 累加）→ 滚到底跟随（同 027）。
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [turns]);

  return (
    // 035 一次性录音改普通点击（非长按手势）→ 不再需要 GestureHandlerRootView 手势根。
    <View className="flex-1 bg-surface-sunken">
      {/* 消息区：flex-1 父 View wrapper 约束 ScrollView frame（per 布局铁律）。 */}
      <View className="flex-1">
        <ScrollView
          ref={scrollRef}
          className="flex-1"
          contentContainerClassName="px-md pt-md pb-sm gap-lg"
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
          testID="ideation-turn-list"
        >
          {turns.map((turn, i) => (
            <TurnRow
              key={i}
              turn={turn}
              isLast={i === turns.length - 1}
              status={status}
              retrieving={retrieving}
              onChipPress={onChipPress}
            />
          ))}

          {/* ⑥ 错误态：reducer 已移除半成品 assistant 占位 → 错误条单独挂尾（FR-006）。 */}
          {status === 'error' ? (
            <ErrorRow message={error ?? '生成失败，网络开小差了'} onRetry={onRetry} />
          ) : null}
        </ScrollView>
      </View>

      {/* ⑤ AI 软提示后的「生成 brief」主按钮（用户主动触发收敛）+ 未收敛 missing 提示。 */}
      {hasTurns ? (
        <View className="px-md pt-xs gap-1.5">
          {missingHint !== null ? (
            <View
              className="flex-row items-start gap-1.5 bg-warn-soft rounded-md px-md py-2"
              testID="ideation-missing-hint"
            >
              <Text className="text-xs text-ink-muted leading-relaxed flex-1">{missingHint}</Text>
            </View>
          ) : null}
          {canGenerateBrief ? (
            <Pressable
              onPress={onGenerateBrief}
              disabled={isGeneratingBrief}
              accessibilityRole="button"
              accessibilityLabel={IDEATION_COPY.generateBrief}
              accessibilityState={{ disabled: isGeneratingBrief, busy: isGeneratingBrief }}
              className="h-12 rounded-md bg-brand-500 items-center justify-center flex-row gap-2 shadow-cta active:bg-brand-600"
              style={{ opacity: isGeneratingBrief ? 0.6 : 1 }}
              testID="ideation-generate-brief-button"
            >
              {isGeneratingBrief ? <Spinner size={16} tone="white" /> : <BriefIcon />}
              <Text className="text-base font-semibold text-white">
                {IDEATION_COPY.generateBrief}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* `+` 附件面板（root Modal bottom-sheet，033 US2/US4）。 */}
      <InputPlusSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onPickImage={attachments.pickFromLibrary}
        onCaptureCamera={attachments.captureFromCamera}
        onOpenRepoPicker={openRepoPickerSequenced}
        fireToast={fireToast}
      />

      {/* 034 选择代码库 sheet（接地目标仓选择，翻面 A/A2）。 */}
      <RepoPickerSheet
        visible={repoSheetOpen}
        onClose={() => setRepoSheetOpen(false)}
        selectedRepo={selectedRepo}
        onSelectRepo={onRepoChosen}
      />

      {/* 内联占位 / 权限 toast（033 多模态壳）；absolute 居中，message=null 即不挂。 */}
      <IdeationToast message={toast} />

      {/* 自由输入条全态常驻（契约 §4，自由文本永驻）。streaming 锁编辑 → 停止位。
          KeyboardStickyView 跟键盘顶起（三端范式，见文件头布局注）。 */}
      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
        <InputBar
          inputRef={inputRef}
          value={draft}
          onChangeText={setDraft}
          onSelectionChange={onSelectionChange}
          editable={inputEditable}
          onSend={onSendPress}
          onStop={onStop}
          isStreaming={isStreaming}
          sendDisabled={sendDisabled}
          onPlusPress={onPlusPress}
          attachmentsDisabled={isStreaming}
          attachments={attachments.attachments}
          onRemoveAttachment={attachments.remove}
          onOpenAttachment={onOpenAttachment}
          recording={recording}
        />
      </KeyboardStickyView>
    </View>
  );
}

// ──────────────────────────── 澄清轮（user 右 / AI 左气泡 + chips） ────────────────────────────

function TurnRow({
  turn,
  isLast,
  status,
  retrieving,
  onChipPress,
}: {
  turn: IdeationTurn;
  isLast: boolean;
  status: IdeationStatus;
  retrieving: boolean;
  onChipPress: (opt: SuggestionOption) => void;
}) {
  if (turn.role === 'user') {
    return (
      <View className="flex-row justify-end" testID="ideation-turn-user">
        <View className="max-w-[82%] bg-brand-soft rounded-2xl rounded-br-sm px-md py-2.5 gap-2">
          {/* 036：带图轮缩略（烧录图 / 原图）。OSS http url 走 ossThumbUrl 派生缩略；本地乐观
              uri（file://，发送时回显）直渲。横排多图（FR-010 顺序与缩略条一致）。 */}
          {turn.attachmentPreviewUris && turn.attachmentPreviewUris.length > 0 ? (
            <View className="flex-row flex-wrap gap-1.5" testID="ideation-turn-images">
              {turn.attachmentPreviewUris.map((uri, j) => (
                <TurnImageThumb key={j} uri={uri} />
              ))}
            </View>
          ) : null}
          {turn.content.length > 0 ? (
            <Text className="text-base text-ink leading-relaxed">{turn.content}</Text>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-row gap-2.5 items-start" testID="ideation-turn-assistant">
      <AiAvatar />
      <View className="max-w-[84%] gap-2.5">
        {/* 034 检索指示 pill（末条流式 + retrieving；首 token 到达即收起）。 */}
        {isLast && status === 'streaming' && retrieving ? <RetrievingPill /> : null}

        {/* ① 流式反问气泡 + caret（末条 assistant 流式中挂打字机光标）。 */}
        <View className="bg-surface border border-line rounded-2xl rounded-bl-sm px-md py-3">
          <Text className="text-base text-ink leading-relaxed">
            {turn.content}
            {isLast && status === 'streaming' ? (
              <Text className="text-brand-500" testID="ideation-typing-caret">
                {' ▍'}
              </Text>
            ) : null}
          </Text>
        </View>

        {/* 034 降级系统气泡（notice 帧，FR-008）：code-index 不可达 → 会话内一次性系统提示，
            居中 muted surface-sunken，与普通对话气泡 / error 重试态区分；会话继续不中断。 */}
        {turn.notice ? <GroundingNotice /> : null}

        {/* 034 来源折叠（触发检索的轮才有 sources；流式中不渲，收口后挂）。 */}
        {turn.sources && turn.sources.length > 0 && status !== 'streaming' ? (
          <SourcesDisclosure sources={turn.sources} />
        ) : null}

        {/* ② chips 轮（纯文本轮无 suggestion → 跳过，对照 ④）。流式中不渲（收口后才挂）。 */}
        {turn.suggestion && status !== 'streaming' ? (
          <ChipRow suggestion={turn.suggestion} onChipPress={onChipPress} />
        ) : null}

        {/* 停止态标识（半成品保留）。 */}
        {turn.status === 'stopped' ? (
          <View className="flex-row items-center gap-1.5" testID="ideation-stopped-label">
            <View className="w-1.5 h-1.5 rounded-full bg-ink-subtle" />
            <Text className="text-xs text-ink-subtle">已停止</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ──────────────────────────── 036 带图轮缩略（user turn 图片回显） ────────────────────────────

const TURN_THUMB = 96;

/**
 * user turn 图片缩略（FR-009 即时回显 + 重展示）。OSS public-read http url → ossThumbUrl 服务端
 * 派生缩略（零下载原图）；本地乐观 uri（file:// / data:，发送时即时回显）直渲不派生。
 */
function TurnImageThumb({ uri }: { uri: string }) {
  const isHttp = uri.startsWith('http://') || uri.startsWith('https://');
  const src = isHttp ? ossThumbUrl(uri, { width: TURN_THUMB, height: TURN_THUMB }) : uri;
  return (
    <View
      className="rounded-lg overflow-hidden bg-surface-sunken"
      style={{ width: TURN_THUMB, height: TURN_THUMB }}
    >
      <Image
        source={{ uri: src }}
        style={{ width: '100%', height: '100%' }}
        contentFit="cover"
        accessibilityLabel="发送的标注图片"
      />
    </View>
  );
}

// ──────────────────────────── 034 检索指示 pill（tool_start，FR-013） ────────────────────────────

/** 「正在检索代码…」brand-soft pill + brand dot（复用 030 tool_start 语义，0 新 token）。 */
function RetrievingPill() {
  return (
    <View
      className="flex-row items-center gap-1.5 self-start rounded-full bg-brand-soft px-md py-1"
      testID="ideation-retrieving-pill"
    >
      <View className="w-1.5 h-1.5 rounded-full bg-brand-500" />
      <Text className="text-xs text-brand-600">{IDEATION_COPY.retrievingCode}</Text>
    </View>
  );
}

// ──────────────────────────── 034 降级系统气泡（notice，FR-008） ────────────────────────────

/**
 * code-index 不可达的会话内一次性系统提示（居中 muted surface-sunken radius-full caption）。
 * 与 error 帧重试态**不同语义**：notice = 本次未接地、会话继续（无重试钮）；不泄露内部错误细节。
 * 自身居中容器（self-center）+ 内层文字 —— 与普通左/右对话气泡视觉区分（系统提示态）。
 *
 * 🚨 文案固定为 `groundingDegraded` —— notice 帧 payload 是内部降级原因码（如 `grounding_degraded`），
 * **不直接渲染**（FR-008 不泄露内部错误细节）；turn.notice 仅作「本轮降级」存在标记。
 */
function GroundingNotice() {
  return (
    <View
      className="self-center bg-surface-sunken rounded-full px-md py-1"
      accessibilityRole="text"
      accessibilityLabel={IDEATION_COPY.groundingDegraded}
      testID="ideation-grounding-notice"
    >
      <Text className="text-xs text-ink-muted">{IDEATION_COPY.groundingDegraded}</Text>
    </View>
  );
}

// ──────────────────────────── chips（契约 §4：推荐排首 + 末位逃生 + 横排换行） ────────────────────────────

/** 一轮建议式选项。推荐项 brand-soft「（推荐）」/ 末位逃生 dashed / 其余 plain。点选 → 直接发送（逃生项→聚焦输入）。 */
function ChipRow({
  suggestion,
  onChipPress,
}: {
  suggestion: NormalizedSuggestion;
  onChipPress: (opt: SuggestionOption) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-2" testID="ideation-chip-row">
      {suggestion.options.map((opt, i) => (
        <Chip key={i} option={opt} onPress={() => onChipPress(opt)} />
      ))}
    </View>
  );
}

function Chip({ option, onPress }: { option: SuggestionOption; onPress: () => void }) {
  // 三态视觉（mockup chip rec/plain/escape）：
  const variant = option.escapeHatch ? 'escape' : option.recommended ? 'rec' : 'plain';
  const cls =
    variant === 'rec'
      ? 'bg-brand-soft border border-brand-500'
      : variant === 'escape'
        ? 'bg-transparent border border-dashed border-line'
        : 'bg-surface border border-line';
  const textCls =
    variant === 'rec' ? 'text-brand-600' : variant === 'escape' ? 'text-ink-muted' : 'text-ink';

  // 干净 label（剥内嵌「（推荐）」）；「（推荐）」由本层据 recommended 单次追加，防与存量数据叠加。
  const displayLabel = chipDisplayLabel(option);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={displayLabel}
      className={`rounded-full px-md py-2 ${cls}`}
      testID="ideation-chip"
    >
      {/* 「（推荐）」单次渲染装饰（落库 label 干净）+ 排首由 server normalizeSuggestion 保证（契约 §4.6）。 */}
      <Text className={`text-sm font-medium ${textCls}`}>
        {displayLabel}
        {option.recommended ? '（推荐）' : ''}
      </Text>
    </Pressable>
  );
}

// ──────────────────────────── 错误条（⑥ 克制 err-soft + 重试） ────────────────────────────

function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View className="flex-row gap-2.5 items-start" testID="ideation-error-state">
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
          accessibilityLabel="重试"
          testID="ideation-retry-button"
        >
          <RetryIcon />
          <Text className="text-sm font-medium text-err">重试</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ──────────────────────────── 输入条（自由文本永驻，三态共用） ────────────────────────────

// autosize 高度边界：上区文本区初始/最小约 2 行 48px、自增长至约 5 行上限 134px，
// 超出上限内部滚动（per spec FR-001 + plan Architecture Notes 1）。
const INPUT_MIN_H = 48;
const INPUT_MAX_H = 134;

function InputBar({
  inputRef,
  value,
  onChangeText,
  onSelectionChange,
  editable,
  onSend,
  onStop,
  isStreaming,
  sendDisabled,
  onPlusPress,
  attachmentsDisabled,
  attachments,
  onRemoveAttachment,
  onOpenAttachment,
  recording,
}: {
  inputRef: React.RefObject<TextInput | null>;
  value: string;
  onChangeText: (s: string) => void;
  /** 035：选区变化（final 合并插入光标处用，FR-010）。 */
  onSelectionChange: (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => void;
  /** 035：可编辑（录音中 partial 机器写入态 → false，FR-002；流式态 → false）。 */
  editable: boolean;
  onSend: () => void;
  onStop: () => void;
  isStreaming: boolean;
  sendDisabled: boolean;
  /** `+`（附件入口）按下；开 InputPlusSheet（root Modal bottom-sheet）。 */
  onPlusPress: () => void;
  /** 036 FR-014：流式态禁用附件入口（+/缩略图移除），与 send→stop 互斥。 */
  attachmentsDisabled: boolean;
  /** 本地暂存附件（033 US2）；非空时在 textarea 上方渲一排缩略图。 */
  attachments: StagedAttachment[];
  /** 移除单个附件（× 钮回调）。 */
  onRemoveAttachment: (id: string) => void;
  /** 036 FR-001：点缩略图 → 全屏查看器（带该附件 + index）。 */
  onOpenAttachment: (att: StagedAttachment, index: number) => void;
  /** 035 一次性录音编排（点 mic 起录 + 波形 ✓/✗ + processing + 60s + 流式互斥）。 */
  recording: UseIdeationRecording;
}) {
  // 上区 autosize：测内容高度 clamp 到 [MIN, MAX]；达上限后 scrollEnabled 内部滚动。
  // 动态高度是「className 表达不出的动态计算」→ 允许 inline style（per nativewind-mapping 例外）。
  const [inputHeight, setInputHeight] = useState(INPUT_MIN_H);
  const onContentSizeChange = useCallback(
    (e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
      const measured = e.nativeEvent.contentSize.height;
      setInputHeight(Math.min(INPUT_MAX_H, Math.max(INPUT_MIN_H, measured)));
    },
    [],
  );
  const atMaxHeight = inputHeight >= INPUT_MAX_H;

  return (
    <View className="px-3.5 pt-2 pb-5 bg-surface border-t border-line">
      <View className="bg-surface-alt border border-line rounded-2xl px-2.5 pt-2 pb-1.5 gap-1.5">
        {/* 缩略图排（textarea 上方，033 US2）：横排 ScrollView 需包 View 约束 frame（per memory）。 */}
        {attachments.length > 0 ? (
          <View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="gap-2 py-1"
              keyboardShouldPersistTaps="handled"
              testID="ideation-thumb-row"
            >
              {attachments.map((att, i) => (
                <ThumbChip
                  key={att.id}
                  uri={att.localUri}
                  index={i}
                  // 036 FR-001：点缩略图进查看器（流式态禁用，与附件入口同 gate）。
                  onPress={attachmentsDisabled ? undefined : () => onOpenAttachment(att, i)}
                  // 036 FR-014：流式态禁用移除（与附件入口同 gate，避免流式中改附件态）。
                  onRemove={() => {
                    if (attachmentsDisabled) return;
                    onRemoveAttachment(att.id);
                  }}
                />
              ))}
            </ScrollView>
          </View>
        ) : null}

        {/* 上区：自增长多行文本区（autosize，超上限内部滚动）。035 一次性范式：全程可编辑（仅流式锁）。 */}
        <TextInput
          ref={inputRef}
          className="text-base text-ink"
          style={{ height: inputHeight }}
          value={value}
          onChangeText={onChangeText}
          onSelectionChange={onSelectionChange}
          onContentSizeChange={onContentSizeChange}
          scrollEnabled={atMaxHeight}
          placeholder={IDEATION_COPY.clarifyInputPlaceholder}
          placeholderTextColor={colors.ink.subtle}
          editable={editable}
          multiline
          textAlignVertical="top"
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
          accessibilityLabel={IDEATION_COPY.clarifyInputPlaceholder}
          testID="ideation-input"
        />

        {/* 下区栏三态：① recording = [✕][波形][✓]；② processing = spinner；③ 否则 [+]···[mic][send/stop]。 */}
        {recording.status === 'recording' ? (
          // ① 录音面板（design 帧2）：✕ 取消（左，零副作用）/ 波形（metering 驱动）/ ✓ 完成（右，一次性识别）。
          <View className="flex-row items-center gap-2" testID="ideation-recording-panel">
            <IconButton
              bg="bg-transparent"
              onPress={recording.onCancel}
              accessibilityLabel={IDEATION_COPY.voiceCancelLabel}
              testID="ideation-voice-cancel"
            >
              <CancelIcon />
            </IconButton>
            <View className="flex-1 items-center">
              <IdeationWaveform levels={recording.levels} active />
            </View>
            <IconButton
              bg="bg-brand-500"
              onPress={recording.onConfirm}
              accessibilityLabel={IDEATION_COPY.voiceConfirmLabel}
              testID="ideation-voice-confirm"
            >
              <CheckIcon />
            </IconButton>
          </View>
        ) : recording.status === 'processing' ? (
          // ② 转写中（一次性识别，无 partial）：spinner + 居中提示（FR-001，processing UX）。
          <View
            className="flex-row items-center justify-center gap-2 py-1"
            testID="ideation-voice-processing"
          >
            <Spinner size={16} tone="brand" />
            <Text className="text-xs text-ink-muted">{IDEATION_COPY.voiceProcessingHint}</Text>
          </View>
        ) : (
          // ③ 常态栏：左 [+] ···· 右 [mic][send/stop]。
          <View className="flex-row items-center" testID="ideation-input-toolbar">
            <IconButton
              bg="bg-transparent"
              onPress={onPlusPress}
              disabled={attachmentsDisabled}
              accessibilityLabel="添加附件"
              testID="ideation-input-plus"
            >
              <PlusIcon />
            </IconButton>

            {/* 中间撑开，把 mic / send 推到右侧。 */}
            <View className="flex-1" />

            <View className="flex-row items-center gap-2">
              {/* 035 mic：普通点击起录（非长按）；流式态 disabled（FR-011，canRecord=false 体现）。 */}
              <Pressable
                onPress={recording.onPressMic}
                disabled={!recording.canRecord}
                accessibilityRole="button"
                accessibilityLabel={IDEATION_COPY.voiceMicLabel}
                accessibilityState={{ disabled: !recording.canRecord }}
                testID="ideation-input-mic"
                className="w-9 h-9 rounded-full items-center justify-center"
              >
                <MicIcon />
              </Pressable>
              {isStreaming ? (
                <IconButton
                  bg="bg-brand-500"
                  onPress={onStop}
                  accessibilityLabel="停止生成"
                  testID="ideation-stop-button"
                >
                  <View className="w-3 h-3 rounded-sm bg-white" />
                </IconButton>
              ) : (
                <IconButton
                  bg={sendDisabled ? 'bg-surface-sunken' : 'bg-brand-500'}
                  onPress={onSend}
                  disabled={sendDisabled}
                  accessibilityLabel="发送"
                  testID="ideation-send-button"
                >
                  <SendIcon disabled={sendDisabled} />
                </IconButton>
              )}
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

// ─────────────────────────────── icons（屏内一次性，承 027 范式） ───────────────────────────────

function AiAvatar() {
  return (
    <View className="w-8 h-8 rounded-full bg-brand-500 items-center justify-center">
      <Svg width={17} height={17} viewBox="0 0 24 24" fill="#fff">
        <Path d="M12 0c.5 5.4 2.6 9 12 12-9.4 3-11.5 6.6-12 12-.5-5.4-2.6-9-12-12C9.4 9 11.5 5.4 12 0Z" />
      </Svg>
    </View>
  );
}

function BriefIcon() {
  return (
    <Svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <Path d="M5 3h9l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <Path d="M8 13h8" />
      <Path d="M8 17h5" />
    </Svg>
  );
}

function PlusIcon() {
  return (
    <Svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.muted}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M12 5v14" />
      <Path d="M5 12h14" />
    </Svg>
  );
}

function MicIcon({ active = false }: { active?: boolean }) {
  // 录音活跃态白色（brand 实心底，design 帧2）；否则 muted（idle）。
  const stroke = active ? '#fff' : colors.ink.muted;
  return (
    <Svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <Path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <Path d="M12 18v4" />
    </Svg>
  );
}

function CheckIcon() {
  // ✓ 完成录音（brand 实心底 → 白色描边），同 SendIcon 体例。
  return (
    <Svg
      width={19}
      height={19}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M5 13l4 4L19 7" />
    </Svg>
  );
}

function CancelIcon() {
  // ✕ 取消录音（透明底 → muted 描边）。
  return (
    <Svg
      width={19}
      height={19}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.muted}
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M6 6l12 12" />
      <Path d="M18 6L6 18" />
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
