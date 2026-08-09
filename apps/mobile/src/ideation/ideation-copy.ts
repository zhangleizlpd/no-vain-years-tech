// 032 T013 — ideation 中文文案集中（创建浮层 / 标题输入 / 错误）。集中便于 e2e
// （T017）按文案 locate + 后续改文案单点。纯文案常量 + 表单错误映射纯函数（可 vitest）。
import type { VoiceDegradeReason } from './use-ideation-recording';

/** 全屏文案表（静态串）。 */
export const IDEATION_COPY = {
  // ─────────────── 翻面 D：会话列表（IdeationListScreen，US2 T018） ───────────────

  /** 列表首屏 GET 失败提示。 */
  listLoadError: '加载会话失败',
  /** 列表加载失败重试按钮。 */
  listLoadRetry: '重试',
  /** 空态主文案（账号无任何会话，FR-008 引导）。 */
  listEmptyTitle: '还没有需求灵感会话',
  /** 空态引导副文案（指向 + FAB 创建入口）。 */
  listEmptyHint: '点右下角「+」开始一个需求灵感澄清',
  /** 行左滑/删除块文案 + 删除菜单项。 */
  listDelete: '删除',
  /** 删除二次确认标题（FR-012 / SC-005）。 */
  listDeleteConfirmTitle: '删除这个会话？',
  /** 删除二次确认副文案（连带对话轮 + brief）。 */
  listDeleteConfirmMessage: '会话连同其对话轮与 brief 将一并删除，不可恢复。',
  /** 删除二次确认取消。 */
  listDeleteCancel: '取消',
  /** 删除二次确认确定。 */
  listDeleteConfirm: '删除',
  /** 删除失败 toast。 */
  listDeleteFailed: '删除失败，请稍后重试',

  /** 抽屉菜单里的灵感入口（045 FR-025：灵感被摘 tab 后的常驻入口，两个抽屉共用同一份文案）。 */
  drawerEntry: '灵感',

  // ─────────────── 翻面 A：创建浮层（CreateOverlay，create-fab-overlay mockup） ───────────────

  /** 中央 + FAB a11y label（FR-001 创建入口）。 */
  fab: '创建',
  /** 创建浮层根容器 a11y label（root Modal）。 */
  overlayLabel: '创建菜单',
  /** 浮层外遮罩 a11y label（tap 关，scrim .48）。 */
  overlayBackdrop: '关闭创建菜单',
  /** 浮层分组标题。 */
  overlayTitle: '创建',
  /** 活入口「prd灵感」标签（FR-001 本期唯一活入口）。 */
  entryIdeationLabel: 'PRD灵感',
  /** 活入口角标（mockup「可用」）。 */
  entryAvailableBadge: '可用',
  /** 置灰未来槽位 a11y label（不命名具体类型，PKM parked）。 */
  futureSlotLabel: '即将推出',

  // ─────────────── 翻面 A 续：标题输入（state ② title-input） ───────────────

  /** 标题输入头标题（点 prd灵感 后切换）。 */
  titleInputHeading: 'PRD灵感',
  /** 标题输入头副文案（mockup「仅需一个标题」）。 */
  titleInputSubtitle: '仅需一个标题',
  /** 标题输入框 placeholder（mockup）。 */
  titlePlaceholder: '给这个灵感起个标题…',
  /** 标题输入框 a11y label。 */
  titleInputLabel: '灵感标题',
  /** 开聊主按钮（建会话 → push 详情）。 */
  startCta: '新建',
  /** 标题为空校验提示（trim 后空）。 */
  titleRequired: '请输入一个标题',
  /** 标题超长校验提示（> 60）。 */
  titleTooLong: '标题最多 60 个字',

  // ─────────────── 翻面 B：澄清对话（ClarifyChatScreen，clarify-chat mockup） ───────────────

  /** 澄清输入条 placeholder（自由文本永驻）。 */
  clarifyInputPlaceholder: '输入你的回答…',
  /** 「生成 brief」主按钮（用户主动触发收敛，⑤ 软提示）。 */
  generateBrief: '生成 brief',

  // ─────────────── 033 多模态输入壳：占位 / 权限 toast（内联 IdeationToast） ───────────────

  /** 未上线能力点击占位 toast（即将开放的入口）。 */
  comingSoon: '即将开放',
  /** 相册 / 相机权限被拒引导 toast。 */
  permissionDenied: '请在系统设置开启相册/相机权限',

  // ─────────────── 035 语音输入：录音态提示 + 降级 toast（ClarifyChatScreen 点录一次性识别） ───────────────

  /** 录音中居中提示（一次性范式：点 ✓ 完成 / ✕ 取消）。 */
  voiceRecordingHint: '正在录音 · ✓ 完成 / ✕ 取消',
  /** 上传识别中提示（processing spinner 旁）。 */
  voiceProcessingHint: '正在转写…',
  /** mic 按钮 a11y label（点击起录，非长按）。 */
  voiceMicLabel: '点击说话',
  /** ✓ 确认按钮 a11y label（停录 → 一次性识别）。 */
  voiceConfirmLabel: '完成录音',
  /** ✕ 取消按钮 a11y label（丢弃本段，零副作用）。 */
  voiceCancelLabel: '取消录音',
  /**
   * 麦克风权限被拒引导 toast（FR-006，design 帧5）。与相册/相机的 `permissionDenied` 区分：
   * 录音专用、引导去系统设置开启；拒绝不 throw（仿 image-picker 范式），会话不中断。
   */
  micPermissionDenied: '需要麦克风权限·去设置',

  // ─────────────── 034 接地检索：选择代码库（RepoPickerSheet，翻面 A/A2） ───────────────

  /** 选择代码库 sheet 标题。 */
  repoPickerTitle: '选择代码库',
  /** 选择代码库 sheet 副标题（接地说明）。 */
  repoPickerSubtitle: '选一个仓库，澄清时可检索其代码接地',
  /** catalog 加载中文案。 */
  repoPickerLoading: '加载代码库…',
  /** catalog 不可达错误态文案（FR-010，可重试）。 */
  repoPickerLoadError: '代码库服务暂不可用',
  /** catalog 错误态重试按钮。 */
  repoPickerRetry: '重试',
  /** 空态（无 ready repo）主文案（US2 AS4 / FR-010）。 */
  repoPickerEmpty: '暂无可检索的代码库',
  /** 空态副文案。 */
  repoPickerEmptyHint: '索引就绪后会出现在这里',
  /** set-repo 失败 toast。 */
  repoSetFailed: '切换代码库失败，请稍后重试',
  /** 检索进行中指示（tool_start，FR-013）。 */
  retrievingCode: '正在检索代码…',
  /**
   * 降级系统气泡（notice 帧，FR-008）：code-index 不可达 → 会话内一次性系统提示。
   * 不泄露内部错误细节（不显 401/5xx/超时）；与 error 帧重试态不同语义（会话继续）。
   */
  groundingDegraded: '本次未接地 · 索引服务暂不可用，已按常规澄清继续',
  /** 状态点 a11y：可检索。 */
  repoStatusReady: '可检索',
  /** 状态点 a11y：索引中（置灰不可选）。 */
  repoStatusIndexing: '索引中',

  // ─────────────── 翻面 C：brief 预览 / 导出（BriefPreviewScreen，brief-preview mockup） ───────────────

  /** brief 屏标题。 */
  briefHeading: '需求 brief',
  /** 「复制 md」主按钮。 */
  briefExport: '复制 md',
  /** 「重新生成」次按钮（reopen + generate 覆盖上版）。 */
  briefRegenerate: '重新生成',
  /** 复制成功 toast。 */
  briefCopiedToast: '已复制 markdown，去电脑端粘进 /speckit-specify',
  /** 已交接回流提示（handed-off 态）。 */
  briefHandedOffNote: '已导出，可重开继续澄清',
  /** T2 接地段占位文案（灰虚线非阻塞，非报错）。 */
  briefGroundingPlaceholder: '本期留空，可手动补充 / 接地能力上线后自动填',
  /** 导出失败 toast。 */
  briefExportFailed: '导出失败，请稍后重试',
  /** 重新生成失败 toast。 */
  briefRegenerateFailed: '重新生成失败，请稍后重试',

  // ─────────────── 037 设计稿（SessionMockupScreen，mockup 交付渲染） ───────────────

  /** 设计稿屏标题（从 session 进入的「设计稿」区）。 */
  mockupHeading: '设计稿',
  /** 空态（该 session 尚无任何 mockup，非错误，US1 AC3）。 */
  mockupEmpty: '暂无设计稿',
  /** 空态副文案（引导：生成后自动交付）。 */
  mockupEmptyHint: '生成的设计稿会自动交付到这里',
  /** 读列表 GET 失败提示（FR-009，可重试，不阻断 session）。 */
  mockupListError: '设计稿列表加载失败',
  /** 渲染降级提示（产物不可达 / 加载失败，US1 AC4 / FR-009，一次性、不崩）。 */
  mockupRenderError: '设计稿加载失败',
  /** 列表 / 渲染失败重试按钮。 */
  mockupRetry: '重试',
  /** brief 屏进入设计稿区的入口按钮（037 T011 viewer 入口）。 */
  mockupViewEntry: '设计稿',
} as const;

/**
 * 创建会话错误 toast 映射（建会话 POST 失败）。AxiosError 走 duck-type（`isAxiosError`
 * flag，避免给 mobile 加 axios 直接依赖，同 login loginErrorToast 范式）。400 → 标题非法
 * （前端 schema 已先挡，兜底）；429 → 限流；无 response / 5xx → 网络；其余 → 未知。
 */
export function createSessionErrorToast(error: unknown): string {
  const e = error as { isAxiosError?: boolean; response?: { status?: number } };
  if (e?.isAxiosError) {
    const status = e.response?.status;
    if (status === undefined) return '网络异常，请检查网络后重试';
    if (status === 400) return '标题不合法，请修改后重试';
    if (status === 429) return '操作过于频繁，请稍后再试';
    if (status >= 500) return '网络异常，请检查网络后重试';
    return '创建失败，请稍后再试';
  }
  return '创建失败，请稍后再试';
}

/**
 * 035 语音降级三态 toast 文案映射（FR-007/009，design 帧6）。
 *
 * 🚨 `Record<VoiceDegradeReason, string>`（**非 `Partial`**）→ tsc 强制穷举：reason 联合类型
 * 加成员而漏配文案即编译红（per mobile-impl-playbook enum→copy 铁律）。
 *
 * 🚨 安全（FR-009）：只给泛化用户向文案，**不**泄露内部错误细节（vendor / 401 / 5xx / 超时码），
 * 转写失败统一收敛到「转写失败，请重试或改用键盘」。
 */
export const VOICE_DEGRADE_COPY: Record<VoiceDegradeReason, string> = {
  /** 转写链路异常（不可达 / 超时 / 鉴权 / 断流）→ 丢弃本段、可改键盘或重试。 */
  transcribe: '转写失败，请重试或改用键盘',
  /** 静音 / 过短未检出有效语音 → 不回填、会话不受影响。 */
  empty: '未识别到语音',
  /** 单段录音达 60s 上限 → 自动按 final 处理已说内容。 */
  limit: '已达单段上限（60 秒）',
};

/** 据降级原因取 toast 文案（穷举映射查表，纯函数）。 */
export function voiceDegradeToast(reason: VoiceDegradeReason): string {
  return VOICE_DEGRADE_COPY[reason];
}
