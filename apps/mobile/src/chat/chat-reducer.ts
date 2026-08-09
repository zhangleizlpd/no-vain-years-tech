// 027 T011 — chat 会话态机纯 reducer（无 IO、无副作用，per 测试分层 vitest=logic）。
//
// 设计（关键）：副作用（建会话 orval / expo-fetch 流式 / AsyncStorage 持久化）与纯态
// 转换分层 —— 本文件只做 (state, action) → state 的纯转换，`use-chat.ts` 是薄壳，负责
// 把流式回调（onToken/onDone/onError/onAborted）翻成 dispatch、调 orval、持久化 last id。
// 这样态机的全部分支（含并发边界「streaming 态拒发送」）可被 vitest 直接穷举。
//
// 态机 5 态（spec / plan L147）：
//   idle      空态（无消息 / hydrate 空）
//   streaming 流式中（已 append user msg + 空 assistant 占位，token 累加打字机）
//   done      正常结束（assistant msg 定型 completed）
//   stopped   用户停止（保留半成品 assistant msg 标 stopped，FR-008）
//   error     provider 失败（移除空 assistant 占位，不落半成品 FR-009；user msg 保留）

import type { NumberedSource } from './sse-parse';

export type { NumberedSource } from './sse-parse';

/** 会话态机 5 态。 */
export type ChatStatus = 'idle' | 'streaming' | 'done' | 'stopped' | 'error';

/** UI 消息态。content 流式期间逐 token 累加；status 定型用。createdAt 仅 hydrate 携带。 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** streaming（生成中）/ completed（正常完成）/ stopped（停止半成品）。 */
  status: 'streaming' | 'completed' | 'stopped';
  /** 030 联网编号来源（assistant 消息，去重；缺省 = 无联网 / 旧消息）。 */
  sources?: NumberedSource[];
  /** 030 降级标记（检索失败基于已有知识作答，FR-009）。 */
  degraded?: boolean;
}

export interface ChatState {
  status: ChatStatus;
  messages: ChatMessage[];
  /** 当前 error 文案（status==='error' 时有值），否则 null。 */
  error: string | null;
  /** 最近一条用户输入 —— retry 重发用（FR-009：user msg 已落不丢，重发同内容）。 */
  lastUserContent: string | null;
  /**
   * 030 中间态「已阅读 N 个网页」（FR-004）。N = **累计原始页数**（tool_result.count 累加，
   * 🚨 F3：可 > 去重后来源数）；null = 不展示（无联网 / answer token 已开始 / 终态）。
   */
  searchProgress: number | null;
}

export const initialChatState: ChatState = {
  status: 'idle',
  messages: [],
  error: null,
  lastUserContent: null,
  searchProgress: null,
};

/**
 * hydrate 用的已落库消息形状（来自 orval ChatMessageResponse 的子集，role/content/status）。
 * 030：assistant 消息额外回填 sources/degraded（来自 ChatMessageResponse.metadata，由 hook 解包）。
 */
export interface HydratedMessage {
  role: string;
  content: string;
  status: string;
  /** 030 联网编号来源（冷启动恢复，SC-003）；无联网 / 旧消息缺省。 */
  sources?: NumberedSource[];
  /** 030 降级标记（冷启动恢复）。 */
  degraded?: boolean;
}

export type ChatAction =
  | { type: 'send'; content: string }
  | { type: 'token'; token: string }
  | { type: 'done' }
  | { type: 'stopped' }
  | { type: 'error'; message: string }
  | { type: 'retry' }
  | { type: 'reset' }
  | { type: 'hydrate'; messages: HydratedMessage[] }
  // 030 联网工具事件：一轮检索完成 → 累加原始页数到中间态（F3：N 可 > 去重来源数）。
  | { type: 'tool_result'; count: number }
  // 030 收尾完整编号来源 → 挂到末尾 assistant 消息。
  | { type: 'sources'; sources: NumberedSource[] }
  // 030 检索失败降级 → 末尾 assistant 消息标 degraded。
  | { type: 'degraded' };

/** 进入新一轮流式：append user msg + 空 assistant 占位，记 lastUserContent，清中间态。 */
function startStream(state: ChatState, content: string): ChatState {
  return {
    status: 'streaming',
    error: null,
    lastUserContent: content,
    searchProgress: null,
    messages: [
      ...state.messages,
      { role: 'user', content, status: 'completed' },
      { role: 'assistant', content: '', status: 'streaming' },
    ],
  };
}

/** 是否末尾 assistant 占位（done/stopped/error/token 都作用于它）。 */
function isLastAssistant(state: ChatState, i: number): boolean {
  return i === state.messages.length - 1 && state.messages[i]?.role === 'assistant';
}

/** 把末尾 assistant 占位定型为指定 status（done→completed / stopped→stopped）。 */
function finalizeAssistant(state: ChatState, status: 'completed' | 'stopped'): ChatMessage[] {
  return state.messages.map((m, i) => (isLastAssistant(state, i) ? { ...m, status } : m));
}

// 各 action 处理拆成小函数，逐个把守卫局部化 —— reducer 主体只做分发（控制 cyclomatic
// 复杂度，纯转换语义不变）。守卫不满足时返回原引用 = 被拒/忽略，hook 不发起副作用。
const handlers: {
  [K in ChatAction['type']]: (
    state: ChatState,
    action: Extract<ChatAction, { type: K }>,
  ) => ChatState;
} = {
  // 🚨 并发边界：streaming 态拒再次发送（spec Edge「上一轮未结束又发」）；空白输入拒。
  send: (state, action) => {
    if (state.status === 'streaming') return state;
    const content = action.content.trim();
    if (content.length === 0) return state;
    return startStream(state, content);
  },

  // 迟到帧（非 streaming）忽略；否则末尾 assistant 占位累加（打字机）。
  // 🚨 F3：answer token 开始即清中间态「已阅读 N」—— 检索阶段结束、过渡到答案流。
  token: (state, action) => {
    if (state.status !== 'streaming') return state;
    return {
      ...state,
      searchProgress: null,
      messages: state.messages.map((m, i) =>
        isLastAssistant(state, i) ? { ...m, content: m.content + action.token } : m,
      ),
    };
  },

  // 030 一轮检索完成：累加原始页数（F3：N = 累计 count，可 > 去重来源数）。
  // 迟到帧（非 streaming）忽略。
  tool_result: (state, action) => {
    if (state.status !== 'streaming') return state;
    return { ...state, searchProgress: (state.searchProgress ?? 0) + action.count };
  },

  // 030 收尾完整编号来源 → 挂到末尾 assistant 消息（[N]→源映射 + 来源列表，FR-007）。
  sources: (state, action) => {
    if (state.status !== 'streaming') return state;
    return {
      ...state,
      messages: state.messages.map((m, i) =>
        isLastAssistant(state, i) ? { ...m, sources: action.sources } : m,
      ),
    };
  },

  // 030 检索失败降级（FR-009）→ 末尾 assistant 消息标 degraded（不丢消息，照常作答）。
  degraded: (state) => {
    if (state.status !== 'streaming') return state;
    return {
      ...state,
      searchProgress: null,
      messages: state.messages.map((m, i) =>
        isLastAssistant(state, i) ? { ...m, degraded: true } : m,
      ),
    };
  },

  done: (state) =>
    state.status !== 'streaming'
      ? state
      : {
          ...state,
          status: 'done',
          searchProgress: null,
          messages: finalizeAssistant(state, 'completed'),
        },

  // FR-008：保留已生成半成品，标 stopped。中间态清除（FR-011 停止中断整链）。
  stopped: (state) =>
    state.status !== 'streaming'
      ? state
      : {
          ...state,
          status: 'stopped',
          searchProgress: null,
          messages: finalizeAssistant(state, 'stopped'),
        },

  // FR-009：失败不落半成品 —— 移除末尾空 assistant 占位，保留 user msg。中间态清除。
  error: (state, action) =>
    state.status !== 'streaming'
      ? state
      : {
          ...state,
          status: 'error',
          error: action.message,
          searchProgress: null,
          messages: state.messages.filter((_m, i) => !isLastAssistant(state, i)),
        },

  // FR-009：重发上一条 user content。user msg 仍在（error 分支只删了 assistant 占位），
  // 补回空 assistant 占位、回 streaming，不再 append 新 user msg。清中间态。
  retry: (state) =>
    state.status !== 'error' || state.lastUserContent === null
      ? state
      : {
          ...state,
          status: 'streaming',
          error: null,
          searchProgress: null,
          messages: [...state.messages, { role: 'assistant', content: '', status: 'streaming' }],
        },

  // 028 新建对话（FR-005）：无条件清空回 idle 空态。与 hydrate 守卫不同 —— reset 是显式
  // 用户动作，hook 已先 `handleRef.abort()` 中断进行中流（FR-011），故无回灌 race，直接清。
  reset: () => initialChatState,

  // 冷启 reload 已落库消息（SC-002）。空 → idle；有内容 → done（历史均已定型）。
  // 🚨 流式进行中拒回灌：新建会话后冷启 hydrate query（GET messages）会在流中途返回——此刻
  // DB 仅有即落的 user msg（AI msg 流末才落），若回灌会 clobber 掉进行中的 assistant 占位，
  // 致只剩 user 气泡、态跳 done、后续 token 被守卫丢弃（无 AI 回复且无报错）。守住 streaming
  // 态即可挡住该 race（及 RQ 焦点重取的同类中途回灌）。
  hydrate: (state, action) => {
    if (state.status === 'streaming') return state;
    const messages: ChatMessage[] = action.messages.map((m) => {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const base: ChatMessage = {
        role,
        content: m.content,
        status: m.status === 'stopped' ? 'stopped' : 'completed',
      };
      // 030 冷启动恢复（SC-003）：assistant 消息回填来源 / 降级标记（缺省不挂，省字段）。
      if (role === 'assistant') {
        if (m.sources && m.sources.length > 0) base.sources = m.sources;
        if (m.degraded) base.degraded = true;
      }
      return base;
    });
    return { ...initialChatState, status: messages.length === 0 ? 'idle' : 'done', messages };
  },
};

/** 纯态机转换。分发到 per-action handler（守卫局部化）。复杂度 O(n)，n = 消息数。 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  // discriminated union 分发：handler map 已在类型层把每个 action 收窄到对应 handler，
  // 运行时 action.type 与之一致；此处 cast 仅为消解 TS 无法跨 key 关联的形参型变。
  const handler = handlers[action.type] as (s: ChatState, a: ChatAction) => ChatState;
  return handler(state, action);
}
