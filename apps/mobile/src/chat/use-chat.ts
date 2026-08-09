// 027 T011 — chat 会话态机 hook（薄壳）。纯态转换全在 chat-reducer.ts（vitest 覆盖）；
// 本文件只负责副作用编排：建会话(orval) / 流式发消息(expo-fetch client) / token 回调 →
// dispatch / last conversationId 持久化 / 冷启 reload。**不含可单测的纯逻辑**（render /
// 流式交互留 T013 e2e，per 测试分层 vitest=logic·Playwright=UI）。
//
// 态机映射（继承 T010 client 接口）：
//   send → 建会话(若无 id) → sendMessage → 'streaming'
//   onToken → dispatch token（打字机累加）  onDone → 'done'
//   onError → 'error'   onAborted（controller.abort）→ 'stopped'
// 并发边界（spec Edge）：streaming 态 send 被 reducer 守卫拒（返回原引用），hook 同步早返
// 不发起新流。
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useConversationControllerCreate,
  useConversationControllerMessages,
  useConversationControllerSetModel,
} from '@nvy/api-client';
import { sendMessage, type ChatStreamHandle } from './chat-stream-client';
import { chatReducer, initialChatState } from './chat-reducer';
import { CONVERSATIONS_QUERY_KEY } from './use-conversations';
import { useLastConversationStore } from './last-conversation-store';

export type { ChatState, ChatMessage, ChatStatus } from './chat-reducer';

/** 029 可切换的逻辑模型（与 server 可用集 / orval SetConversationModelRequestModel 一致）。 */
export type ChatModel = 'flash' | 'pro' | 'minimax';

/** 新会话默认模型（flash 快速，FR-008）。 */
const DEFAULT_MODEL: ChatModel = 'flash';

/**
 * 归一历史会话的 model 值为可切换集（flash/pro/minimax）。legacy / 未知值（如 027 的
 * 'deepseek-chat'）回落默认 flash —— 顶栏稳健降级，不崩（spec Edge「旧/未知 model 值」）。
 */
function normalizeModel(model: string | null | undefined): ChatModel {
  if (model === 'pro') return 'pro';
  if (model === 'minimax') return 'minimax';
  return DEFAULT_MODEL;
}

export function useChat() {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);

  const queryClient = useQueryClient();
  const createConversation = useConversationControllerCreate();
  const lastConversationId = useLastConversationStore((s) => s.lastConversationId);
  const setLastConversationId = useLastConversationStore((s) => s.setLastConversationId);

  // 029 set-model mutation：只解构 mutateAsync（mutation 对象 identity 每 render 变，
  // 整体进 useCallback 依赖会自激风暴，per react-query-mutation-identity-usecallback-trap）。
  const { mutateAsync: setModelMutateAsync } = useConversationControllerSetModel();

  // 029 会话级 model 态（render 态：顶栏读取显示当前会话所用模型，FR-007）。默认 flash。
  const [model, setModelState] = useState<ChatModel>(DEFAULT_MODEL);

  // 当前会话 id（建会话后写入）+ 进行中流句柄（停止用）。ref 不触发 render。
  const conversationIdRef = useRef<string | null>(lastConversationId);
  const handleRef = useRef<ChatStreamHandle | null>(null);

  // 冷启 reload：last id 存在 → 拉已落库消息 hydrate（SC-002）。enabled 由 id 决定。
  const messagesQuery = useConversationControllerMessages(lastConversationId ?? '', {
    query: { enabled: lastConversationId !== null },
  });

  useEffect(() => {
    if (lastConversationId === null) return;
    const data = messagesQuery.data?.data;
    if (data) {
      conversationIdRef.current = lastConversationId;
      // 030：解包 metadata（degraded/sources）→ 扁平 HydratedMessage（冷启动恢复 SC-003）。
      // 旧消息 / 未检索消息 metadata 缺省 → sources/degraded 不挂（reducer 省字段）。
      dispatch({
        type: 'hydrate',
        messages: data.messages.map((m) => ({
          role: m.role,
          content: m.content,
          status: m.status,
          sources: m.metadata?.sources,
          degraded: m.metadata?.degraded,
        })),
      });
    }
    // 命中 404（他人/已删 id）→ 清本地 id，回空态（不串话，反枚举兜底）。
    if (messagesQuery.error?.response?.status === 404) {
      setLastConversationId(null);
      conversationIdRef.current = null;
    }
  }, [lastConversationId, messagesQuery.data, messagesQuery.error, setLastConversationId]);

  /**
   * 失效会话列表 query（抽屉历史数据源）。会话首发落库后 / 首条消息流完后调用,令抽屉
   * 列表反映新会话 + 派生 title。修 028 FR-005 漏失效：旧实现仅 rename/delete 失效列表
   * （use-conversations.ts），新建会话不刷新 → 同一 app session 内新建的会话虽已落库,
   * 却因列表 query 缓存陈旧（抽屉常驻挂载不重取 + 全局 staleTime 30s）不出现在历史抽屉。
   */
  const invalidateConversations = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY });
  }, [queryClient]);

  /**
   * 真正发起一条流（已确保有 conversationId）。绑 client 回调 → dispatch。
   * 030 A1：恒联网 —— 是否检索由 server 模型自决；工具事件 / 来源 / 降级帧 → dispatch 中间态 + message。
   */
  const startStream = useCallback(
    (conversationId: string, content: string) => {
      handleRef.current = sendMessage(conversationId, content, {
        onToken: (token) => dispatch({ type: 'token', token }),
        // 流完：派生 title 已由 server 回填（首条消息）→ 失效列表让抽屉刷新 title + 排序。
        onDone: () => {
          dispatch({ type: 'done' });
          invalidateConversations();
        },
        onError: (message) => dispatch({ type: 'error', message }),
        onAborted: () => dispatch({ type: 'stopped' }),
        // 030：一轮检索完成累加「已阅读 N」（F3：N=累计原始页数）。tool_start 仅日志语义，无态变更。
        onToolEvent: (event) => {
          if (event.type === 'tool_result') dispatch({ type: 'tool_result', count: event.count });
        },
        onSources: (sources) => dispatch({ type: 'sources', sources }),
        onDegraded: () => dispatch({ type: 'degraded' }),
      });
    },
    [invalidateConversations],
  );

  /**
   * 发消息。空态首发无 id → 先建会话(D3 两步) 再发；streaming 态早返不发起新流。
   * 030 A1：恒联网（去 per-message webSearch 开关）—— 是否检索由 server 模型自决。
   */
  const send = useCallback(
    async (content: string) => {
      if (state.status === 'streaming') return; // 并发边界硬早返（与 reducer 守卫一致）。
      if (content.trim().length === 0) return;

      dispatch({ type: 'send', content });

      let conversationId = conversationIdRef.current;
      if (conversationId === null) {
        // D3：建会话/发消息分离 —— 先建空会话拿 id（极快无流式）再发。
        try {
          const res = await createConversation.mutateAsync({ data: {} });
          conversationId = res.data.id;
          conversationIdRef.current = conversationId;
          setLastConversationId(conversationId);
          // 会话已落库 → 立即失效列表,新会话即刻入抽屉（不等流完,兼容中途 abort/error）。
          invalidateConversations();
        } catch {
          dispatch({ type: 'error', message: '会话创建失败，请重试' });
          return;
        }
      }
      startStream(conversationId, content.trim());
    },
    [state.status, createConversation, setLastConversationId, startStream, invalidateConversations],
  );

  /** 停止生成 —— abort 进行中流；client onAborted → dispatch stopped（FR-008）。 */
  const stop = useCallback(() => {
    handleRef.current?.controller.abort();
  }, []);

  // 028 抽屉切换/新建：进行中流先中断（FR-011，等同停止生成），避免旧流 token 串到新会话。
  const abortActiveStream = useCallback(() => {
    handleRef.current?.controller.abort();
    handleRef.current = null;
  }, []);

  /**
   * 028 切换会话（抽屉点选历史）：流进行中先 abort（FR-011）→ 切 conversationIdRef +
   * 持久化 last id → 拉该会话已落库消息 hydrate。messages 由既有 hydrate effect 在
   * `lastConversationId` 变更后 query 落定时 dispatch（query key 绑 last id，自动重取）。
   */
  const selectConversation = useCallback(
    (id: string, conversationModel?: string | null) => {
      if (id === conversationIdRef.current) return; // 选中当前会话，无须切换。
      abortActiveStream();
      conversationIdRef.current = id;
      // 029 FR-007：顶栏 model 随会话恢复（drawer item 携带 model，legacy/未知值回落默认）。
      setModelState(normalizeModel(conversationModel));
      setLastConversationId(id); // → messagesQuery 重取 → hydrate effect dispatch（SC-002）。
    },
    [abortActiveStream, setLastConversationId],
  );

  /**
   * 028 新建对话（FR-005）：流进行中先 abort → 清 conversationIdRef + last id → reducer
   * reset 回空态。**不**预建会话（D6：首发消息时才建，新建对话不落库）。
   * 029 FR-008：model 回默认 flash（新会话首选）。
   */
  const newConversation = useCallback(() => {
    abortActiveStream();
    conversationIdRef.current = null;
    setModelState(DEFAULT_MODEL);
    setLastConversationId(null);
    dispatch({ type: 'reset' });
  }, [abortActiveStream, setLastConversationId]);

  /**
   * 029 切换会话模型（FR-003/011）：
   *  - 选与当前相同 model → no-op（不重复写 / 不打断，state_branch #4）；
   *  - 流进行中先 abort（FR-011，等同停止生成；已落库内容不丢，切换对下一条生效）；
   *  - 设会话级内存态（顶栏即时反映）；
   *  - 当前会话**已落库**（有 conversationId）→ 触发 PATCH 持久化（D3①）；
   *    **未落库**（首发前）→ 仅内存态（D3②），首发时随会话落库。
   */
  const setModel = useCallback(
    async (next: ChatModel) => {
      if (next === model) return; // state_branch #4：同 model 无副作用。
      abortActiveStream();
      setModelState(next);
      const conversationId = conversationIdRef.current;
      if (conversationId !== null) {
        await setModelMutateAsync({ id: conversationId, data: { model: next } });
      }
    },
    [model, abortActiveStream, setModelMutateAsync],
  );

  /**
   * 失败重试 —— 复用上一条 user content 重发（FR-009）。reducer 守卫非 error 态忽略。
   * 030 A1：恒联网，retry 与原发送同路径（是否检索由 server 模型自决）。
   */
  const retry = useCallback(() => {
    const content = state.lastUserContent;
    const conversationId = conversationIdRef.current;
    if (state.status !== 'error' || content === null || conversationId === null) return;
    dispatch({ type: 'retry' });
    startStream(conversationId, content);
  }, [state.status, state.lastUserContent, startStream]);

  return {
    /** 5 态机当前态。 */
    status: state.status,
    /** 多轮消息（user + assistant，流式中末条 assistant 逐 token 累加）。 */
    messages: state.messages,
    /** error 文案（status==='error' 时有值）。 */
    error: state.error,
    /** 030 检索中间态「已阅读 N 个网页」（FR-004，N=累计原始页数）；null=不展示。 */
    searchProgress: state.searchProgress,
    /** 冷启 reload 进行中（messagesQuery pending）。 */
    isHydrating: lastConversationId !== null && messagesQuery.isLoading,
    send,
    stop,
    retry,
    /** 028 切换到历史会话（抽屉点选）：先中断进行中流，再 hydrate 该会话消息（FR-004/011）；
     *  029 第二参 model 同步顶栏会话级记忆（FR-007）。 */
    selectConversation,
    /** 028 新建对话：先中断进行中流，清当前 id + 回空态，不预建会话（FR-005）；029 model 回默认 flash。 */
    newConversation,
    /** 029 当前会话所用逻辑模型（flash/pro），顶栏显示用（FR-007）。 */
    model,
    /** 029 切换会话模型（FR-003/011）：流中先 abort + 内存态 + 已落库则持久化。 */
    setModel,
  };
}
