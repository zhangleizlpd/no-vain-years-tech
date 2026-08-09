// 027 T012 — chat 屏中文文案集中（问候 / 错误 / 「内容由 AI 生成」标识 / 「已停止」/
// 「尽管问」placeholder 等）。集中便于 e2e（T013）按文案 locate + 后续改文案单点。
//
// 设计：纯文案常量 + 一个纯函数 greeting()（昵称回退逻辑，可 vitest）。无 IO、无组件。

/** 空态问候（FR-001）：带昵称形如「嗨 {昵称}，今天聊点什么」。 */
const GREETING_SUFFIX = '，今天聊点什么';
/** 昵称未就位（/me 未加载 / 无 displayName）时的通用问候（不显示空昵称，FR-001）。 */
const GREETING_GENERIC = '嗨，今天聊点什么';

/**
 * 组装空态问候语。
 *
 * @param displayName /me 的昵称；null / undefined / 纯空白 → 退回通用问候（FR-001 边界：
 *   「昵称未就位时退回通用问候，不显示空昵称」）。
 * @returns 带昵称问候 或 通用问候。
 */
export function greeting(displayName: string | null | undefined): string {
  const name = displayName?.trim();
  if (!name) return GREETING_GENERIC;
  return `嗨 ${name}${GREETING_SUFFIX}`;
}

/**
 * 029 顶栏模型名映射（逻辑 model → 顶栏展示名）。穷举 ChatModel 成员（用 Record<ChatModel, …>
 * 而非 Partial，tsc 强制覆盖所有成员，per mobile-impl-playbook enum→copy 铁律）。legacy/未知
 * 值在 use-chat.normalizeModel 已回落 flash，顶栏拿到的恒为 flash/pro/minimax。
 */
export const CHAT_MODEL_NAME = {
  flash: 'DeepSeek 快速',
  pro: 'DeepSeek 思考',
  minimax: 'MiniMax M3',
} as const satisfies Record<'flash' | 'pro' | 'minimax', string>;

/** 全屏文案表（非问候的静态串）。 */
export const CHAT_COPY = {
  /** 输入条 placeholder（FR-002）。 */
  inputPlaceholder: '尽管问',

  // ─────────────── 029 模型切换下拉文案（顶栏 popover 4 frame） ───────────────

  /** 下拉头部分组标题（mockup「选择模型」）。 */
  modelPickerTitle: '选择模型',
  /** flash 项展示名（下拉行标题）。 */
  modelFlashLabel: '快速',
  /** flash 项副标题（mockup）。 */
  modelFlashDesc: '响应迅速，适合日常问答',
  /** pro 项展示名（下拉行标题）。 */
  modelProLabel: '思考',
  /** pro 项副标题（mockup）。 */
  modelProDesc: '深度推理，适合复杂问题',
  /** 不可用留位项（MiniMax）pill 文案（FR-005）。 */
  modelComingSoon: '即将上线',
  /** 顶栏模型选择器按钮 a11y label（FR-001）。 */
  modelSwitcher: '切换模型',
  /** AI 生成内容合规标识（FR-010），屏底常驻。 */
  aiGeneratedNotice: '内容由 AI 生成',
  /** 流式中「停止生成」按钮（FR-008）。 */
  stopGenerating: '停止生成',
  /** 停止后半成品下方标识（FR-008）。 */
  stoppedLabel: '已停止',
  /** 错误态默认文案（FR-009；provider 失败 / 网络中断兜底）。 */
  errorDefault: '网络开小差了，请重试',
  /** 错误态重试按钮（FR-009）。 */
  retry: '重试',
  /** 消息操作条复制按钮 a11y label。 */
  copy: '复制',
  /** 复制成功反馈。 */
  copied: '已复制',
  /** 顶栏新建会话按钮 a11y label（FR-011）。 */
  newConversation: '新建会话',
  /** 顶栏 hamburger 按钮 a11y label（FR-001，028 起接抽屉）。 */
  menu: '菜单',
  /** 发送按钮 a11y label（FR-002）。 */
  send: '发送',

  // ─────────────── 030 智能搜索（联网检索中间态 / 来源 / 降级；A1 去 toggle 恒联网） ───────────────

  /** 中间态前缀，配合原始页数拼成「已阅读 N 个网页」（FR-004，N=累计原始页数 F3）。 */
  searchProgressPrefix: '已阅读 ',
  /** 中间态后缀（接在页数之后）。 */
  searchProgressSuffix: ' 个网页',
  /** 来源折叠头前缀，配合去重来源数拼成「N 个网页来源」（FR-005，可折叠）。 */
  sourcesHeaderSuffix: ' 个网页来源',
  /** 降级标识（检索失败基于已有知识作答，FR-009）。 */
  degradedNotice: '本次未联网，基于已有知识作答',

  // ─────────────── 028 抽屉文案（左侧历史会话抽屉 7 frame） ───────────────

  /** 抽屉根容器 a11y label（FR-001）。 */
  drawerLabel: '历史会话抽屉',
  /** 抽屉半透明遮罩 a11y label（tap 关，FR-001）。 */
  drawerBackdrop: '关闭抽屉',
  /** 抽屉顶部搜索框 placeholder（FR-009，仅按标题搜索）。 */
  searchPlaceholder: '搜索历史对话',
  /** 搜索框清除按钮 a11y label。 */
  searchClear: '清除搜索',
  /** 抽屉顶部「新建对话」入口（FR-005）。 */
  newConversationDrawer: '新建对话',
  /** 搜索命中时结果计数前缀，配合数量拼成「N 个结果」（FR-009）。 */
  searchResultCountSuffix: ' 个结果',
  /** 搜索无命中空态文案（FR-009，不报错）。 */
  searchNoMatch: '没有找到匹配的对话',
  /** 空历史态文案（Edge：账号无任何会话）。 */
  emptyHistory: '还没有历史对话，开始新对话吧',
  /** 会话行 ⋯ 操作按钮 a11y label。 */
  rowMenu: '会话操作',
  /** 行操作菜单「重命名」（FR-006）。 */
  rename: '重命名',
  /** 行操作菜单「删除」（FR-007）。 */
  deleteConversation: '删除',
  /** 行内改名输入 a11y label（FR-006）。 */
  renameInput: '会话名称',
  /** 行内改名「取消」按钮。 */
  renameCancel: '取消',
  /** 行内改名「确定」按钮（空标题禁用，FR-006）。 */
  renameConfirm: '确定',
  /** 删除二次确认弹窗标题（FR-007 / SC-005）。 */
  deleteModalTitle: '删除对话',
  /** 删除二次确认弹窗副文案（硬删不可恢复）。 */
  deleteModalMessage: '删除后该对话及其消息将无法恢复',
  /** 删除二次确认「取消」按钮。 */
  deleteModalCancel: '取消',
  /** 删除二次确认「删除」确认按钮（FR-007）。 */
  deleteModalConfirm: '删除',
  /** 底部用户区齿轮（→ 设置）a11y label（FR-010 / D8）。 */
  settings: '设置',
  /** 底部用户区昵称未就位兜底（/me 未加载）。 */
  userFallbackName: '我',
} as const;
