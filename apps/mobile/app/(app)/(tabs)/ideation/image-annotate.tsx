// 036 T010 — 标注画布屏（B2-3 US1，mockup 帧③④）。
//
// 双指捏合缩放/平移（ImageAnnotateCanvas）+ 单击落递增编号 pin（软上限 9 达限轻提示，FR-003）。
// pin/注记本地态 = 本屏 useReducer(pinReducer)，**取消/返回 = 组件卸载即丢弃**（不上传不发送、
// 暂存图保留可重进，FR-012 零副作用）。注记输入行 + SoM 烧录发送 = T011/T012（本屏先脊柱）。
//
// 036 T013 — pin 注记语音转写（复用 035 一次性识别 + insert-at-cursor，mockup 帧⑤）：
// 注记行麦克风（AnnotationRow.onPressMic）接 035 useIdeationRecording —— 它是「单注记框
// （draft/setDraft）」范式，本屏经 pin-voice-bind 把它映射到**当前 selected pin** 的注记框
// （selectedPinNote → draft；noteSetterFor → setNote）。点某行麦克风 = 选中该 pin + 起录；
// ✓ → transcript 经 hook 内部 insert-at-cursor 落该 pin 注记（光标处插/末尾追加、不覆盖，FR-005）；
// 空转写/失败 → hook 不调 setDraft（注记零改写）+ 降级 toast（SC-004）；✗ 取消零副作用。
// 录音/转写/面板/insert 全复用 035 不改，本屏只接线。
//
// 路由屏 = app/ 树下只放路由屏；画布/pin/reducer 在 src/ideation/image-annotate/（Expo Router
// app/ 扫描铁律：app/ 下任何 *.tsx 当 route，可复用组件/纯函数必须在 src/）。
// 🚨 手势根：根 _layout **不全局挂** GestureHandlerRootView（仓内约定：用手势的屏各自自包裹，
// 见 ideation/index.tsx / portfolio 各屏 / profile-image ImageViewer / chat-drawer）。本屏画布
// 的 GestureDetector → **必须自套一层 GestureHandlerRootView**，否则 "GestureDetector must be
// used as a descendant of GestureHandlerRootView" 红屏（#606 初版漏套，真机 Mate50 实证）。
import { useCallback, useEffect, useReducer, useRef, useState, type ComponentRef } from 'react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ImageManipulator } from 'expo-image-manipulator';
import type { NativeSyntheticEvent, TextInputSelectionChangeEventData } from 'react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { colors } from '~/theme';
import { IconButton, Spinner } from '~/ui';
import {
  AnnotationRow,
  composeAnnotationText,
  flattenAnnotatedImage,
  ideationSessionRoute,
  IDEATION_COPY,
  IdeationToast,
  IdeationWaveform,
  ImageAnnotateCanvas,
  initialPinState,
  mapIdeationUploadError,
  noteSetterFor,
  pinReducer,
  pinsWithNotes,
  selectedPinNote,
  SomBurnView,
  useAnnotateSendStore,
  useIdeationImageUpload,
  useIdeationRecording,
  voiceDegradeToast,
  type DraftSelection,
  type ImageNaturalSize,
  type ImageViewerParams,
  type VoiceDegradeReason,
} from '~/ideation';

const SOFT_CAP_TOAST = '最多标注 9 个点';
const TOAST_MS = 1900;

export default function IdeationImageAnnotateScreen() {
  const { uri, sessionId } = useLocalSearchParams<ImageViewerParams>();
  const insets = useSafeAreaInsets();
  const [state, dispatch] = useReducer(pinReducer, initialPinState);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  // 图片像素尺寸（注记行裁切周边小图块用）。
  // 🚨 必须用 **expo-image-manipulator 自己解出的尺寸**算 crop 矩形 —— 同一工具算尺寸又裁剪，
  // 坐标系必然一致。**不可**用 expo-image onLoad 的 source.width/height：后者是解码/缓存降采样值，
  // 同一图多次挂载漂移（真机实测 758×1672 / 1015×2238 / 1088×2400 三个值），与 manipulator 操作的
  // 像素错位 → 缩略图裁错位置（pin 落点正确但缩略图偏移的真凶）。RN Image.getSize 仍可能与
  // manipulator 解码尺寸不一致（content:// / 降采样），故直接问 manipulator。
  const [imageSize, setImageSize] = useState<ImageNaturalSize | null>(null);
  useEffect(() => {
    if (!uri) return;
    let alive = true;
    void (async () => {
      try {
        const ref = await ImageManipulator.manipulate(uri).renderAsync();
        if (alive) setImageSize({ width: ref.width, height: ref.height });
      } catch {
        // 取尺寸失败 → 保持 null（AnnotationRow 据此退化整图缩略，不崩）。
      }
    })();
    return () => {
      alive = false;
    };
  }, [uri]);
  // 036 T013：当前 selected pin 注记框选区（transcript 插入光标处用，FR-010）；无焦点 = {null,null}
  // → 末尾追加。仅对选中行透传 onSelectionChange，故跟随选中 pin 即可。
  const [noteSelection, setNoteSelection] = useState<DraftSelection>({ start: null, end: null });

  // 036 T015 — 烧录捕获引用：挂**专用静态烧录视图 SomBurnView**（非活画布——活画布的 expo-image/
  // reanimated GPU 层 captureRef 软件重绘截不到 → 黑，真机实证）。+ 上传 hook（凭证 scope 随
  // sessionId）+ 跨屏交接 store（带图轮 payload 回交 [id] 屏 send 链路）。
  const burnRef = useRef<ComponentRef<typeof View> | null>(null);
  const imageUpload = useIdeationImageUpload(sessionId ?? '');
  const setPendingSend = useAnnotateSendStore((s) => s.setPendingSend);
  const [isSending, setIsSending] = useState(false);
  // 发送可用性：≥1 个有注记的 pin（FR-006 仅有注记 pin 入烧录/合成文字）+ 非上传/发送中 + 会话就绪。
  const sendablePins = pinsWithNotes(state.pins);
  const canSend = sendablePins.length > 0 && !isSending && !imageUpload.isUploading && !!sessionId;

  // 软上限轻提示 / 语音降级提示（reducer 达上限返回同引用 → length 未变即判定，FR-003 不硬阻断）。
  const [toast, setToast] = useState<string | null>(null);
  const fireToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const onAddPin = useCallback(
    (nx: number, ny: number) => {
      const before = state.pins.length;
      const next = pinReducer(state, { type: 'add', nx, ny });
      if (next.pins.length === before) {
        // 达软上限：reducer 未新增 → 轻提示（不硬阻断后续平移/缩放/已落 pin 编辑）。
        fireToast(SOFT_CAP_TOAST);
        return;
      }
      dispatch({ type: 'add', nx, ny });
    },
    [state, fireToast],
  );

  const onSelectPin = useCallback((id: string) => {
    setSelectedPinId((prev) => (prev === id ? null : id));
  }, []);

  // 移除 pin（选中态「移除标记」气泡触发）：删 pin + 清选中（编号不复用，pin-reducer remove）。
  const onRemovePin = useCallback((id: string) => {
    dispatch({ type: 'remove', id });
    setSelectedPinId((prev) => (prev === id ? null : prev));
  }, []);

  // 文字键入 → 写该 pin 注记（setNote 字段已在 pin-reducer，T010 落）。
  const onChangeNote = useCallback((id: string, note: string) => {
    dispatch({ type: 'setNote', id, note });
  }, []);

  // 036 T015 — 发送带标注图轮（US1 脊柱）：① 烧录「图 + 编号 pin」为单图（captureRef / seam）→
  // ② 上传 OSS 拿 ossKey → ③ 合成同编号标注文字（FR-006 严格 1:1，仅有注记 pin）→ ④ 交接 store
  // 回交 [id] 屏 send 链路（带图轮入既有澄清闭环 + user turn 缩略回显）→ ⑤ router.back 回对话屏。
  // 失败（烧录/上传非 2xx）→ 降级 toast、留在标注屏不脏写（pin/注记保留可重试，FR-011/SC-004）。
  const onSend = useCallback(() => {
    if (!canSend || !sessionId) return;
    const annotationText = composeAnnotationText(state.pins);
    if (annotationText.length === 0) return; // 无有注记 pin → 不发（双保险，与 canSend 一致）。
    setIsSending(true);
    void (async () => {
      try {
        const burnedUri = await flattenAnnotatedImage(burnRef);
        const ossKey = await imageUpload.uploadImage(burnedUri);
        // 交接带图轮 payload → [id] 屏 effect 消费调 onSend（content = annotationText）。
        setPendingSend({
          sessionId,
          attachmentKeys: [ossKey],
          annotationText,
          previewUris: [burnedUri],
        });
        // 回对话屏（栈：chat → viewer → annotate；dismissTo 一次弹 annotate+viewer 回 chat，
        // 非 router.back 只弹一层留在 viewer）。ClarifyChatScreen effect 消费 pending 发带图轮。
        router.dismissTo(ideationSessionRoute(sessionId));
      } catch (e) {
        // 烧录/上传失败：不交接、不发送、pin/注记保留（FR-011 不脏写）；友好 toast（不泄 vendor）。
        setIsSending(false);
        fireToast(mapIdeationUploadError(e));
      }
    })();
  }, [canSend, sessionId, state.pins, imageUpload, setPendingSend, fireToast]);

  // ── 036 T013 语音录音编排（035 复用，接到「当前 selected pin」注记框）──
  // sessionId 缺（未就绪）→ null，录音 hook 据此禁录（canRecord=false）。
  const recordingSessionId = sessionId ?? null;
  const onVoicePermissionDenied = useCallback(() => {
    fireToast(IDEATION_COPY.micPermissionDenied);
  }, [fireToast]);
  const onVoiceDegrade = useCallback(
    (reason: VoiceDegradeReason) => {
      fireToast(voiceDegradeToast(reason));
    },
    [fireToast],
  );
  // draft = 选中 pin 当前注记；setDraft = hook 合并后整段 → setNote 路由该 pin（pin-voice-bind）。
  // 二者每 render 重建并绑定最新 selectedPinId —— hook 内部经 ref 透传，✓ 时取最新选中 pin（接线
  // 期 setSelectedPinId 已落定、re-render 后 refs 指向目标 pin），无 stale 闭包。
  const recording = useIdeationRecording({
    sessionId: recordingSessionId,
    draft: selectedPinNote(state.pins, selectedPinId),
    setDraft: noteSetterFor(selectedPinId, dispatch),
    selection: noteSelection,
    setSelection: setNoteSelection,
    isStreaming: false, // 标注屏无澄清流式态。
    onPermissionDenied: onVoicePermissionDenied,
    onDegrade: onVoiceDegrade,
  });

  // 点某行麦克风：先选中该 pin（录哪个 → ✓ 时落哪个）→ 起录。录音活跃中其它行 mic disabled。
  const onPressMic = useCallback(
    (id: string) => {
      setSelectedPinId(id);
      recording.onPressMic();
    },
    [recording],
  );

  // 仅对选中行透传选区（transcript 插光标处用）；切选中 pin → 选区重置为无焦点（末尾追加兜底）。
  const onRowSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      const { start, end } = e.nativeEvent.selection;
      setNoteSelection({ start, end });
    },
    [],
  );

  if (!uri) return <View className="flex-1 bg-black" testID="ideation-image-annotate" />;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View className="flex-1 bg-black" testID="ideation-image-annotate">
        <Stack.Screen
          options={{ title: '标注', headerTransparent: true, headerTintColor: '#fff' }}
        />
        <ImageAnnotateCanvas
          uri={uri}
          pins={state.pins}
          onAddPin={onAddPin}
          onSelectPin={onSelectPin}
          onRemovePin={onRemovePin}
          selectedPinId={selectedPinId}
        />

        {/* 专用静态烧录视图（离屏常驻，图提前加载）：发送时 captureRef(burnRef) 截它出 SoM 烧录图。
          仅烧有注记 pin（pinsWithNotes，与合成文字 1:1，FR-006）。 */}
        <SomBurnView ref={burnRef} uri={uri} pins={sendablePins} imageSize={imageSize} />

        {/* 注记输入行（FR-004，每 pin 一行；无 pin 时不挂）。底部面板**固定高**（非 max-h 随行数增高）
          —— 否则加 pin 时面板长高挤压上方 flex-1 画布 → 整图 reflow、已落 pin 视觉偏移（真机实证）。
          固定高后画布尺寸稳定，已落 pin 不动。width class 不约束 ScrollView frame，包 flex-1 View
          wrapper（per mobile-impl-playbook 布局铁律）。 */}
        {/* KeyboardStickyView 顶起面板（注记输入聚焦时键盘起 → 面板贴键盘顶沿，否则被键盘遮挡；
          仓内键盘范式同 ClarifyChatScreen，offset.opened=insets.bottom 收掉冗余底部安全区）。 */}
        {state.pins.length > 0 ? (
          <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
            <View className="h-72 bg-surface border-t border-line px-md py-2">
              {/* 036 T013 录音面板（mockup 帧⑤）：录音中 = [✕][波形][✓]；转写中 = spinner；否则不挂
              （注记行内 mic 触发）。复用 035 IdeationWaveform + ✓/✗ 流，挂在注记行上方。 */}
              {recording.status === 'recording' ? (
                <View
                  className="flex-row items-center gap-2 pb-2"
                  testID="ideation-annotation-recording-panel"
                >
                  <IconButton
                    bg="bg-transparent"
                    onPress={recording.onCancel}
                    accessibilityLabel={IDEATION_COPY.voiceCancelLabel}
                    testID="ideation-annotation-voice-cancel"
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
                    testID="ideation-annotation-voice-confirm"
                  >
                    <CheckIcon />
                  </IconButton>
                </View>
              ) : recording.status === 'processing' ? (
                <View
                  className="flex-row items-center justify-center gap-2 pb-2"
                  testID="ideation-annotation-voice-processing"
                >
                  <Spinner size={16} tone="brand" />
                  <Text className="text-xs text-ink-muted">
                    {IDEATION_COPY.voiceProcessingHint}
                  </Text>
                </View>
              ) : null}

              {/* flex-1 wrapper：固定高面板内，行列表占满剩余高（发送按钮固定底部），多行内部滚动。 */}
              <View className="flex-1">
                <ScrollView
                  contentContainerClassName="gap-1.5 py-1"
                  keyboardShouldPersistTaps="handled"
                  testID="ideation-annotation-rows"
                >
                  {state.pins.map((p) => (
                    <AnnotationRow
                      key={p.id}
                      uri={uri}
                      imageSize={imageSize}
                      n={p.n}
                      nx={p.nx}
                      ny={p.ny}
                      note={p.note}
                      onChangeNote={(note) => onChangeNote(p.id, note)}
                      // 仅选中行透传选区（transcript 插光标处用，FR-005）。
                      onSelectionChange={selectedPinId === p.id ? onRowSelectionChange : undefined}
                      selected={selectedPinId === p.id}
                      onPressMic={() => onPressMic(p.id)}
                      // 录音活跃 / sessionId 未就绪 → 全行 mic disabled（一次只录一个 pin）。
                      micDisabled={!recording.canRecord}
                    />
                  ))}
                </ScrollView>
              </View>

              {/* 036 T015 发送（US1 脊柱）：≥1 有注记 pin 启用；点 → 烧录 + 上传 + 合成文字 →
              交接 [id] 屏 send → router.back。上传/发送中 disabled + spinner（防重入）。 */}
              <Pressable
                onPress={onSend}
                disabled={!canSend}
                accessibilityRole="button"
                accessibilityLabel="发送标注"
                accessibilityState={{
                  disabled: !canSend,
                  busy: isSending || imageUpload.isUploading,
                }}
                testID="ideation-annotation-send-button"
                className={`mt-2 h-12 rounded-md items-center justify-center flex-row gap-2 ${
                  canSend ? 'bg-brand-500 active:bg-brand-600' : 'bg-surface-sunken'
                }`}
              >
                {isSending || imageUpload.isUploading ? <Spinner size={16} tone="white" /> : null}
                <Text
                  className={`text-base font-semibold ${canSend ? 'text-white' : 'text-ink-subtle'}`}
                >
                  发送
                </Text>
              </Pressable>
            </View>
          </KeyboardStickyView>
        ) : null}

        {/* 软上限 / 语音降级轻提示（absolute 居中，message=null 即不挂）。 */}
        <IdeationToast message={toast} />
      </View>
    </GestureHandlerRootView>
  );
}

// ─────────────────────────────── icons（录音面板，承 ClarifyChatScreen 体例） ───────────────────────────────

function CheckIcon() {
  // ✓ 完成录音（brand 实心底 → 白色描边）。
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
