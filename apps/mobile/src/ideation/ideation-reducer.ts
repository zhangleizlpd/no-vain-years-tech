// 032 T014 — ideation 澄清会话态机纯 reducer（无 IO、无副作用，per 测试分层 vitest=logic）。
//
// 设计（同 027 chat-reducer 分层）：副作用（建会话/turn 流式 orval/expo-fetch、持久化）
// 与纯态转换分层 —— 本文件只做 (state, action) → state 的纯转换；use-ideation-session.ts
// 是薄壳，把流式回调（onToken/onSuggestion/onDone/onError/onAborted）翻成 dispatch、调
// orval、持久化 last sessionId。态机全部分支（含并发边界「streaming 态拒发」）可 vitest 穷举。
//
// 态机 5 态：
//   idle      空态（无 turn / hydrate 空）
//   streaming 流式中（已 append user turn + 空 assistant 占位，token 累加打字机）
//   done      本轮反问正常结束（assistant turn 定型 completed，可含 suggestion chips）
//   stopped   用户停止（保留半成品 assistant turn 标 stopped）
//   error     provider 失败（移除空 assistant 占位，不落半成品；user turn 保留）

import type { IdeationSource, NormalizedSuggestion } from './ideation-sse-parse';

export type { IdeationSource, NormalizedSuggestion } from './ideation-sse-parse';

/** 会话态机 5 态。 */
export type IdeationStatus = 'idle' | 'streaming' | 'done' | 'stopped' | 'error';

/**
 * UI 澄清 turn。assistant turn 的 content 流式期间逐 token 累加；suggestion 为本轮
 * chips（过两闸收口；纯文本轮缺省）。status 定型用。
 */
export interface IdeationTurn {
  role: 'user' | 'assistant';
  content: string;
  /** streaming（生成中）/ completed（正常完成）/ stopped（停止半成品）。 */
  status: 'streaming' | 'completed' | 'stopped';
  /** 本轮建议式选项（assistant turn；纯文本轮 / user turn 缺省）。 */
  suggestion?: NormalizedSuggestion;
  /** 034 接地：本轮命中来源（assistant turn；触发检索的轮才有，≤5）。挂对应 turn 不堆叠历史。 */
  sources?: IdeationSource[];
  /**
   * 034 接地降级：本轮 code-index 不可达的一次性系统提示文案（assistant turn；notice 帧才有）。
   * 与 error 帧不同语义 —— notice = 会话继续的「本次未接地」提示（FR-008），不触发整轮失败 / 重试。
   */
  notice?: string;
  /**
   * 036 带图轮（user turn）：本轮图片预览 uri。两种来源**择一**（同一轮不并存）：
   *   - 发送态：乐观挂本地 uri（烧录图 / 原图 file://，FR-009 即时回显）。
   *   - 重载态：冷启 hydrate 由 server `attachments[].ossKey` 派生 OSS public-read http URL
   *     （T021，TurnRow 走 ossThumbUrl 出缩略，FR-009 持久化重展示）。
   */
  attachmentPreviewUris?: string[];
}

export interface IdeationState {
  status: IdeationStatus;
  turns: IdeationTurn[];
  /** 当前 error 文案（status==='error' 时有值），否则 null。 */
  error: string | null;
  /** 最近一条用户输入 —— retry 重发用（user turn 已落不丢，重发同内容）。 */
  lastUserContent: string | null;
  /** 034 接地：当前会话锁定的目标 repo（选择代码库后写；null = 未选，不接地）。 */
  repo: string | null;
  /** 034 接地：检索进行中指示（tool_start → true，首 token / 终态 → false）。「正在检索代码…」。 */
  retrieving: boolean;
}

export const initialIdeationState: IdeationState = {
  status: 'idle',
  turns: [],
  error: null,
  lastUserContent: null,
  repo: null,
  retrieving: false,
};

/**
 * hydrate 用的已落库 turn 形状（来自 orval SessionTurnResponse 子集）。assistant turn
 * 额外回填 suggestion（若该轮发过 chips）。
 */
export interface HydratedTurn {
  role: string;
  content: string;
  status?: string;
  suggestion?: NormalizedSuggestion | null;
  /**
   * 036 FR-009 重载：本轮带图附件的 OSS public-read 完整 URL（hook 由 server ossKey +
   * OSS public base 派生；TurnRow 走 ossThumbUrl 出缩略）。纯文本轮空/缺省。
   */
  attachmentUris?: string[];
}

/**
 * 036 FR-009：server 投影的 attachments（ossKey 列表）→ OSS public-read 完整 URL 列表
 * （`<base>/<ossKey>`）。base 空（OSS 未配置 / dev 缺 env）→ 返空数组（不渲断图，纯文本轮
 * 同样空）。重载态用此派生的 http URL 喂 TurnRow（→ ossThumbUrl 缩略）；与发送态的本地乐观
 * uri **择一**（同一轮要么是冷启 server 派生、要么是发送时本地 uri，不并存）。
 */
export function hydratedAttachmentUris(
  ossKeys: readonly string[],
  ossPublicBaseUrl: string,
): string[] {
  const base = ossPublicBaseUrl.replace(/\/+$/, '');
  if (base.length === 0) return [];
  return ossKeys.filter((k) => k.length > 0).map((k) => `${base}/${k.replace(/^\/+/, '')}`);
}

export type IdeationAction =
  | { type: 'send'; content: string; attachmentPreviewUris?: string[] }
  | { type: 'token'; token: string }
  | { type: 'suggestion'; suggestion: NormalizedSuggestion }
  | { type: 'done' }
  | { type: 'stopped' }
  | { type: 'error'; message: string }
  | { type: 'retry' }
  | { type: 'reset' }
  | { type: 'hydrate'; turns: HydratedTurn[]; repo?: string | null }
  | { type: 'set-repo'; repo: string }
  // 034 接地：检索指示开始（tool_start 帧）+ 命中来源挂当前 assistant turn（sources 帧）。
  | { type: 'tool_start' }
  | { type: 'sources'; sources: IdeationSource[] }
  // 034 接地降级：code-index 不可达 → 会话内一次性系统气泡（FR-008），会话继续不中断。
  | { type: 'notice'; notice: string };

/** 进入新一轮流式：append user turn + 空 assistant 占位，记 lastUserContent；repo 选择延续。 */
function startStream(
  state: IdeationState,
  content: string,
  attachmentPreviewUris?: string[],
): IdeationState {
  const userTurn: IdeationTurn = { role: 'user', content, status: 'completed' };
  // 036：带图轮乐观挂图预览（仅非空才挂；纯文本轮无此字段，形状零回归）。
  if (attachmentPreviewUris && attachmentPreviewUris.length > 0) {
    userTurn.attachmentPreviewUris = attachmentPreviewUris;
  }
  return {
    status: 'streaming',
    error: null,
    lastUserContent: content,
    repo: state.repo,
    retrieving: false,
    turns: [...state.turns, userTurn, { role: 'assistant', content: '', status: 'streaming' }],
  };
}

/** 是否末尾 assistant 占位（done/stopped/error/token/suggestion 都作用于它）。 */
function isLastAssistant(state: IdeationState, i: number): boolean {
  return i === state.turns.length - 1 && state.turns[i]?.role === 'assistant';
}

/** 把末尾 assistant 占位定型为指定 status。 */
function finalizeAssistant(state: IdeationState, status: 'completed' | 'stopped'): IdeationTurn[] {
  return state.turns.map((t, i) => (isLastAssistant(state, i) ? { ...t, status } : t));
}

// 各 action 处理拆小函数，守卫局部化 —— reducer 主体只做分发（控制复杂度，语义不变）。
// 守卫不满足时返回原引用 = 被拒/忽略，hook 不发起副作用。
const handlers: {
  [K in IdeationAction['type']]: (
    state: IdeationState,
    action: Extract<IdeationAction, { type: K }>,
  ) => IdeationState;
} = {
  // 🚨 并发边界：streaming 态拒再发（上一轮未结束又发）；空白输入拒。
  send: (state, action) => {
    if (state.status === 'streaming') return state;
    const content = action.content.trim();
    if (content.length === 0) return state;
    return startStream(state, content, action.attachmentPreviewUris);
  },

  // 迟到帧（非 streaming）忽略；否则末尾 assistant 占位累加（打字机）。
  // 034：首 token 到达即清检索指示（模型据真实代码恢复出文，「正在检索代码…」收起）。
  token: (state, action) => {
    if (state.status !== 'streaming') return state;
    return {
      ...state,
      retrieving: false,
      turns: state.turns.map((t, i) =>
        isLastAssistant(state, i) ? { ...t, content: t.content + action.token } : t,
      ),
    };
  },

  // 034 接地：检索开始 → 置检索指示（仅 streaming 态；末尾 assistant turn 显示「正在检索代码…」）。
  tool_start: (state) => (state.status !== 'streaming' ? state : { ...state, retrieving: true }),

  // 034 接地：命中来源挂当前 assistant turn（≤5；不混淆/不堆叠历史，各轮各自归属，US1 AC3）。
  sources: (state, action) => {
    if (state.status !== 'streaming') return state;
    return {
      ...state,
      turns: state.turns.map((t, i) =>
        isLastAssistant(state, i) ? { ...t, sources: action.sources } : t,
      ),
    };
  },

  // 034 接地降级：code-index 不可达 → 一次性系统提示挂当前 assistant turn（会话继续不中断，
  // FR-008）。收检索指示（降级即视空命中、不再检索）；不动态机 / 不移占位 / 不进 error（与 error
  // 帧严格区分语义：error = 整轮失败 + 重试；notice = 本次未接地、续问）。各轮各自归属不堆叠历史。
  notice: (state, action) => {
    if (state.status !== 'streaming') return state;
    return {
      ...state,
      retrieving: false,
      turns: state.turns.map((t, i) =>
        isLastAssistant(state, i) ? { ...t, notice: action.notice } : t,
      ),
    };
  },

  // 一轮 chips 收口 → 挂到末尾 assistant turn（纯文本轮不发此 action）。迟到帧忽略。
  suggestion: (state, action) => {
    if (state.status !== 'streaming') return state;
    return {
      ...state,
      turns: state.turns.map((t, i) =>
        isLastAssistant(state, i) ? { ...t, suggestion: action.suggestion } : t,
      ),
    };
  },

  done: (state) =>
    state.status !== 'streaming'
      ? state
      : {
          ...state,
          status: 'done',
          retrieving: false,
          turns: finalizeAssistant(state, 'completed'),
        },

  // 保留已生成半成品，标 stopped。
  stopped: (state) =>
    state.status !== 'streaming'
      ? state
      : {
          ...state,
          status: 'stopped',
          retrieving: false,
          turns: finalizeAssistant(state, 'stopped'),
        },

  // 失败不落半成品 —— 移除末尾空 assistant 占位，保留 user turn。
  error: (state, action) =>
    state.status !== 'streaming'
      ? state
      : {
          ...state,
          status: 'error',
          error: action.message,
          retrieving: false,
          turns: state.turns.filter((_t, i) => !isLastAssistant(state, i)),
        },

  // 重发上一条 user content。user turn 仍在（error 分支只删了 assistant 占位），补回空
  // assistant 占位、回 streaming，不再 append 新 user turn。
  retry: (state) =>
    state.status !== 'error' || state.lastUserContent === null
      ? state
      : {
          ...state,
          status: 'streaming',
          error: null,
          retrieving: false,
          turns: [...state.turns, { role: 'assistant', content: '', status: 'streaming' }],
        },

  // 显式清空回 idle（hook 已先 abort 进行中流，无回灌 race）。
  reset: () => initialIdeationState,

  // 034 接地：锁定目标 repo（选择代码库 set-repo 成功后）。只改 repo，不动态机/turns；
  // 切仓只影响后续轮（既有 turn 引用不回改 = 不动历史，FR-006）。
  'set-repo': (state, action) => ({ ...state, repo: action.repo }),

  // 冷启 reload 已落库 turns（last sessionId）。空 → idle；有内容 → done（历史均已定型）。
  // 🚨 流式进行中拒回灌：新建会话后冷启 hydrate query 会在流中途返回 —— 守住 streaming 态
  // 挡住该 race（及 RQ 焦点重取的同类中途回灌）。
  hydrate: (state, action) => {
    if (state.status === 'streaming') return state;
    const turns: IdeationTurn[] = action.turns.map((t, i) => {
      const role = t.role === 'assistant' ? 'assistant' : 'user';
      const base: IdeationTurn = {
        role,
        content: t.content,
        status: t.status === 'stopped' ? 'stopped' : 'completed',
      };
      if (role === 'assistant' && t.suggestion) base.suggestion = t.suggestion;
      // 位置对齐 + 同 role + 同 content = 同一轮 —— 终态 invalidate 触发的重取 hydrate 据此保留前态
      // 内存里挂的瞬时痕迹（attachmentPreviewUris / sources / notice），否则刚流式/乐观挂的东西被空
      // server turn 抹掉（flash-then-gone）。
      const prev = state.turns[i];
      const sameTurn = prev?.role === role && prev.content === t.content;
      // 036 FR-009 重载：带图 user 轮回填附件缩略 URL。优先 server 派生（冷启重载真相源，ossKey →
      // OSS public-read URL）；server 派生为空（dev 缺 EXPO_PUBLIC_OSS_PUBLIC_BASE_URL / OSS 未配置）
      // 时回退前态乐观本地 uri（file://，发送时即时回显），避免 onDone→invalidate→hydrate 用空数组
      // 把刚发的图抹掉。纯文本轮两者皆空 → 不渲。
      if (role === 'user') {
        if (t.attachmentUris && t.attachmentUris.length > 0) {
          base.attachmentPreviewUris = t.attachmentUris;
        } else if (
          sameTurn &&
          prev?.attachmentPreviewUris &&
          prev.attachmentPreviewUris.length > 0
        ) {
          base.attachmentPreviewUris = prev.attachmentPreviewUris;
        }
      }
      // 034 接地：sources/notice 为 SSE 瞬时态、不落 idea_turn 表（plan §5「瞬时不落」）；
      // 终态 invalidate 触发的重取 hydrate 须**保留**前态内存里挂的来源折叠 / 降级气泡，否则刚流式出
      // 的接地痕迹被空 server turn 抹掉（flash-then-gone）。
      if (role === 'assistant' && sameTurn) {
        if (prev?.sources) base.sources = prev.sources;
        if (prev?.notice) base.notice = prev.notice;
      }
      return base;
    });
    return {
      ...initialIdeationState,
      status: turns.length === 0 ? 'idle' : 'done',
      turns,
      // 冷启回填会话锁定的 repo（session.repo）；缺省保持 null（未选不接地）。
      repo: action.repo ?? null,
    };
  },
};

/** 纯态机转换。分发到 per-action handler（守卫局部化）。复杂度 O(n)，n = turn 数。 */
export function ideationReducer(state: IdeationState, action: IdeationAction): IdeationState {
  const handler = handlers[action.type] as (s: IdeationState, a: IdeationAction) => IdeationState;
  return handler(state, action);
}
