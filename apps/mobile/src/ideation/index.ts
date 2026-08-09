// Public surface for the ideation module (apps/mobile/src/ideation/, 032).
// 需求灵感澄清：+ FAB 创建浮层 → 多轮澄清 → 结构化 brief 导出。复用 027 chat 流式范式。

export {
  IDEATION_LIST_ROUTE,
  ideationSessionRoute,
  ideationImageViewerRoute,
  ideationImageAnnotateRoute,
  ideationMockupsRoute,
  type ImageViewerParams,
  type MockupScreenParams,
} from './ideation-routes';

// 032 T013 — 创建浮层（翻面 A，root Modal）+ 文案 + 标题表单。
export { CreateOverlay, type CreateOverlayProps } from './CreateOverlay';
// 045 T021 — 抽屉里的灵感入口（全局抽屉 + chat 抽屉共用同一份实现 / copy / 导航语义）。
export { IdeationDrawerEntry, type IdeationDrawerEntryProps } from './ideation-drawer-entry';
export { IDEATION_COPY, createSessionErrorToast } from './ideation-copy';
export { useCreateSessionForm, type CreateSessionFormState } from './use-create-session-form';
export {
  createSessionFormSchema,
  TITLE_MAX_LENGTH,
  type CreateSessionFormValues,
} from './create-session-form.schema';

// 032 T014 — SSE 澄清客户端 + 帧解析 + 两相会话态机（reducer 纯逻辑 + hook 薄壳）。
export { parseIdeationChunk } from './ideation-sse-parse';
export type {
  IdeationFrame,
  IdeationParseResult,
  IdeationSource,
  NormalizedSuggestion,
  SuggestionOption,
} from './ideation-sse-parse';
export { sendTurn } from './ideation-stream-client';
export type { IdeationStreamCallbacks, IdeationStreamHandle } from './ideation-stream-client';
export { ideationReducer, initialIdeationState } from './ideation-reducer';
export type {
  IdeationState,
  IdeationTurn,
  IdeationStatus,
  IdeationAction,
  HydratedTurn,
} from './ideation-reducer';
export { useLastSessionStore, type LastSessionState } from './last-session-store';
export { useIdeationSession } from './use-ideation-session';

// 032 T015 — 澄清对话屏（翻面 B 6 态，承 027 chat 视觉）+ chip 点选纯逻辑。
export { ClarifyChatScreen, type ClarifyChatScreenProps } from './ClarifyChatScreen';
export { chipFillValue } from './clarify-chip.rules';

// 034 T010 — 接地来源折叠 disclosure（翻面 B/C 上）。
export { SourcesDisclosure, type SourcesDisclosureProps } from './SourcesDisclosure';

// 034 T009 — 选择代码库（接地目标仓选择，翻面 A/A2）+ catalog 状态映射纯逻辑。
export { RepoPickerSheet, type RepoPickerSheetProps } from './RepoPickerSheet';
export {
  REPO_STATUS_META,
  buildRepoMetaLine,
  type RepoCatalogEntry,
  type RepoStatusMeta,
} from './repo-catalog.rules';

// 033 多模态输入壳 — 内联占位 / 权限 toast（~/ui 无通用 Toast，本 feature scope 内联）。
export { IdeationToast, type IdeationToastProps } from './IdeationToast';

// 032 T016 — brief 预览/导出屏（翻面 C 结构化分段）+ 分段视图/徽标纯逻辑。
export { BriefPreviewScreen, type BriefPreviewScreenProps } from './BriefPreviewScreen';
export {
  buildBriefSegments,
  normalizeStatus,
  STATUS_BADGE_META,
  type BriefSegmentView,
  type IdeationSessionStatus,
  type StatusBadgeMeta,
} from './brief-view.rules';

// 032 T018 — 会话列表纯逻辑（列表准备 / 相对时间）+ 行视图类型。
export {
  prepareSessionList,
  relativeUpdatedAt,
  type SessionListItem,
  type SessionRowView,
} from './session-list.rules';

// 036 T009 — 图片 client 直传 OSS hook（复用 profile-image 4 步流，签名 EP 换 ideation 凭证 fn）。
export {
  useIdeationImageUpload,
  executeIdeationUpload,
  compressForUpload,
  buildIdeationUploadFormData,
  mapIdeationUploadError,
  IdeationOssUploadError,
  IDEATION_IMAGE_WHITELIST,
  IDEATION_MAX_UPLOAD_BYTES,
  IDEATION_RESIZE_WIDTH,
  type UseIdeationImageUpload,
  type ProcessedIdeationImage,
  type IdeationUploadDeps,
} from './use-ideation-image-upload';

// 036 T010 — 标注画布（手势缩放/平移 + 落 pin）+ pin 纯 reducer + 屏↔图坐标映射。
export {
  ImageAnnotateCanvas,
  type ImageAnnotateCanvasProps,
} from './image-annotate/ImageAnnotateCanvas';
export { AnnotationPin, type AnnotationPinProps } from './image-annotate/AnnotationPin';
export {
  pinReducer,
  initialPinState,
  screenToImage,
  imageToScreen,
  computeContainLayout,
  PIN_SOFT_CAP,
  type PinState,
  type PinAction,
  type AnnotationPin as AnnotationPinModel,
  type ImageLayout,
  type CanvasTransform,
} from './image-annotate/pin-reducer';

// 036 T011 — 单点注记输入行（行式布局 + 周边裁切预览）+ crop 参数计算纯函数。
export { AnnotationRow, type AnnotationRowProps } from './image-annotate/AnnotationRow';
export {
  pinCropRect,
  CROP_WINDOW_FRACTION,
  type CropRect,
  type ImageNaturalSize,
} from './image-annotate/pin-crop-preview';

// 036 T012 — SoM 合成标注文字（纯函数）+ view-shot 烧录展平（含 e2e seam）。
export { composeAnnotationText, pinsWithNotes } from './image-annotate/annotation-compose';
export {
  flattenAnnotatedImage,
  getViewShotSeam,
  type CaptureViewRef,
} from './image-annotate/som-flatten';
// 036 — SoM 烧录专用静态视图（RN Image + 静态 pin，captureRef 截它；规避 expo-image/reanimated GPU 层黑图）。
export { SomBurnView, type SomBurnViewProps } from './image-annotate/SomBurnView';

// 036 T013 — pin 注记语音转写（复用 035 录音 hook + 波形面板 + 文案）+ 选中 pin 接线纯逻辑。
export {
  useIdeationRecording,
  type DraftSelection,
  type UseIdeationRecording,
  type VoiceDegradeReason,
} from './use-ideation-recording';
export { IdeationWaveform } from './IdeationWaveform';
export { voiceDegradeToast } from './ideation-copy';
export { selectedPinNote, noteSetterFor } from './image-annotate/pin-voice-bind';

// 036 T014 — 仅附图直发 send payload 组装纯逻辑（无 pin 烧录 = 原图 ossKey + 文本）。
export { buildImageOnlySendPayload, type IdeationImageSendPayload } from './image-send-payload';

// 036 T015 — 标注画布 → 澄清对话屏「带图轮发送」跨屏交接 store（zustand 瞬态）。
export {
  useAnnotateSendStore,
  type PendingAnnotatedSend,
  type AnnotateSendState,
} from './annotate-send-store';

// 037 T010 — mockup 隔离渲染（平台拆分：native WebView 硬化 / web iframe sandbox）+ 渲染纯逻辑。
export { MockupRenderer } from './MockupRenderer';
export type { MockupRendererProps } from './mockup-renderer.types';
export {
  MOCKUP_DISPLAY_BASE_URL,
  originOf,
  deriveOriginWhitelist,
  isNavigationAllowed,
  isRenderableMockupUrl,
  buildCspMetaContent,
} from './mockup-render.rules';

// 037 T011 — session mockup 读列表 hook（fetch-on-open）+ 最新版/视图态派生纯逻辑。
export {
  useSessionMockups,
  selectLatestMockup,
  deriveMockupView,
  type UseSessionMockups,
  type MockupView,
  type SessionMockupResponse,
} from './use-session-mockups';

// 037 T014 [US2] — 多版切换条（倒序 chips + 屏标签行）+ 版本排序/默认 latest/日期格式化纯逻辑。
export { MockupVersionStrip, type MockupVersionStripProps } from './MockupVersionStrip';
export {
  prepareVersionStrip,
  versionRankLabel,
  formatDeliveredAt,
  selectDefaultVersionId,
  selectMockupById,
  type VersionChipView,
} from './mockup-version.rules';
