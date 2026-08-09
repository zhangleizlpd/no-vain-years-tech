// 032 T014 — ideation 澄清会话态机 hook（薄壳）。纯态转换全在 ideation-reducer.ts（vitest
// 覆盖）；本文件只负责副作用编排：流式 turn（expo-fetch client）/ token·suggestion 回调 →
// dispatch / last sessionId 持久化 / 冷启 reload（orval get）/ brief 生成。**不含可单测的纯
// 逻辑**（屏 render / 流式交互留 T017 e2e，per 测试分层 vitest=logic·Playwright=UI）。
//
// 态机映射（继承 client 接口）：
//   send → sendTurn → 'streaming'
//   onToken → dispatch token（打字机累加）   onSuggestion → dispatch suggestion（chips 收口）
//   onDone → 'done'   onError → 'error'   onAborted（controller.abort）→ 'stopped'
// 并发边界：streaming 态 send 被 reducer 守卫拒（返回原引用），hook 同步早返不发起新流。
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getSessionControllerGetQueryKey,
  useSessionControllerGet,
  useSessionControllerSetRepo,
} from '@nvy/api-client';
import {
  sendTurn,
  type IdeationStreamHandle,
  type IdeationTurnImagePayload,
} from './ideation-stream-client';
import { useGenerateBrief, useInvalidateSessionList } from './use-session-mutations';
import {
  hydratedAttachmentUris,
  ideationReducer,
  initialIdeationState,
  type HydratedTurn,
  type NormalizedSuggestion,
} from './ideation-reducer';
import { useLastSessionStore } from './last-session-store';

export type { IdeationState, IdeationTurn, IdeationStatus } from './ideation-reducer';

// 036 FR-009 重载：OSS public-read base（带图轮 ossKey → 完整缩略 URL 前缀）。Expo/Metro 只
// 静态内联 `process.env.EXPO_PUBLIC_*` 的**点访问**（非 bracket，见 core/api/setup.ts 注）。
// 缺省空串 → hydratedAttachmentUris 返空数组（不渲断图，等真 OSS 接线注入此 env）。
const OSS_PUBLIC_BASE_URL = process.env.EXPO_PUBLIC_OSS_PUBLIC_BASE_URL ?? '';

/**
 * 澄清会话 hook。
 *
 * @param sessionId 当前会话 id（T013 建会话后路由到 `[id]` 携带）。null = 无会话（idle）。
 */
export function useIdeationSession(sessionId: string | null) {
  const [state, dispatch] = useReducer(ideationReducer, initialIdeationState);

  const queryClient = useQueryClient();
  const setLastSessionId = useLastSessionStore((s) => s.setLastSessionId);
  // converge（status open→converged）+ 每轮 turn 终态（updatedAt 推进 → 列表冒泡/「X分钟前」）都改
  // list-visible 字段，故失效会话列表 —— 与 chat 范式同构（use-chat.ts onDone → invalidateConversations）
  // 且是 TanStack 推荐默认（事件后广失效；invalidate 只重取活跃 query + staleTime 30s 兜底，turn 为
  // 每轮非每 token 的低频，成本可忽略）。generateBrief 经 wrapper 自带 list 失效；turn 走 SSE（非
  // mutation、无法走 onSuccess 选项）→ 在 startStream done/aborted 终态手动调 invalidateSessionList。
  const generateBriefMutation = useGenerateBrief();
  const invalidateSessionList = useInvalidateSessionList();
  // 034 接地 set-repo：只解构 mutateAsync —— mutation 对象 identity 每 render 变，整个进
  // useCallback 依赖会自激（per react-query-mutation-identity 教训）。
  const { mutateAsync: setRepoMutate } = useSessionControllerSetRepo();

  const handleRef = useRef<IdeationStreamHandle | null>(null);

  // 冷启 reload：sessionId 存在 → 拉已落库 turns hydrate。enabled 由 id 决定。
  const sessionQuery = useSessionControllerGet(sessionId ?? '', {
    query: { enabled: sessionId !== null },
  });

  // 进入会话即记 last id（冷启动下次直接 reload 该会话）。
  useEffect(() => {
    if (sessionId !== null) setLastSessionId(sessionId);
  }, [sessionId, setLastSessionId]);

  // hydrate effect：query 落定 → dispatch（streaming 态由 reducer 守卫挡回灌 race）。
  useEffect(() => {
    if (sessionId === null) return;
    const data = sessionQuery.data?.data;
    if (data) {
      const turns: HydratedTurn[] = data.turns.map((t) => ({
        role: t.role,
        content: t.content,
        // suggestion 由 orval 生成为宽松对象（SessionTurnResponseSuggestion）；契约同构
        // NormalizedSuggestion，断言透传（reducer 仅在 assistant turn 且非空时回填）。
        suggestion: (t.suggestion as NormalizedSuggestion | null) ?? null,
        // 036 FR-009：server 投影的带图轮附件 ossKey → OSS public-read 完整 URL（重载缩略）。
        attachmentUris: hydratedAttachmentUris(
          (t.attachments ?? []).map((a) => a.ossKey),
          OSS_PUBLIC_BASE_URL,
        ),
      }));
      // 034 接地：冷启回填会话锁定的 repo（session.repo，nullable）。
      dispatch({ type: 'hydrate', turns, repo: data.repo ?? null });
    }
    // 命中 404（他人/已删 id）→ 清本地 last id（不串话，反枚举兜底）。
    if (sessionQuery.error?.response?.status === 404) {
      setLastSessionId(null);
    }
  }, [sessionId, sessionQuery.data, sessionQuery.error, setLastSessionId]);

  /**
   * 绑 client 回调 → dispatch（已确保有 sessionId）。
   *
   * 终态（done / aborted / error）后失效会话详情 query：user turn 永远即时落库（append-only），
   * assistant turn 在 done/abort 时落（abort 保留已 drip 半成品）、error 时不落——任一终态后 DB
   * 都比缓存新，invalidate 才能让 30s staleTime 内热重进取到真 turns（否则命中建会话时的空快照）。
   * 与 generateBrief 的 invalidate 同构。
   */
  const startStream = useCallback(
    (id: string, content: string, image?: IdeationTurnImagePayload) => {
      const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: getSessionControllerGetQueryKey(id) });
        // turn 终态推进 session.updatedAt → 失效列表让会话冒泡/「X分钟前」刷新（详情失效正交）。
        invalidateSessionList();
      };
      handleRef.current = sendTurn(
        id,
        content,
        {
          onToken: (token) => dispatch({ type: 'token', token }),
          onSuggestion: (suggestion) => dispatch({ type: 'suggestion', suggestion }),
          // 034 接地：检索开始指示 + 命中来源挂当前 assistant turn。
          onToolStart: () => dispatch({ type: 'tool_start' }),
          onSources: (sources) => dispatch({ type: 'sources', sources }),
          // 034 降级系统气泡（notice 帧）：落会话内一次性系统提示挂当前 assistant turn（FR-008），
          // 会话继续不中断（与 error 帧整轮失败不同语义）。
          onNotice: (notice) => dispatch({ type: 'notice', notice }),
          onDone: () => {
            dispatch({ type: 'done' });
            invalidate();
          },
          onError: (message) => {
            // error 终态不 invalidate：assistant turn 未落库（FR-010 不落半截），无新数据可拉；
            // 若 invalidate → refetch → hydrate 会把 status 从 'error' 冲成 'done'（hydrate 按
            // turns 数定 idle/done），错误条瞬间消失、用户看不到失败。user turn 已即时落库且
            // reducer 已乐观保留，retry 直接重发即可。
            dispatch({ type: 'error', message });
          },
          onAborted: () => {
            dispatch({ type: 'stopped' });
            invalidate();
          },
        },
        image,
      );
    },
    [queryClient, invalidateSessionList],
  );

  /**
   * 发一轮澄清。streaming 态早返不发起新流；空白拒（与 reducer 守卫一致 —— 故带图轮 `content`
   * 须非空：标注流传 SoM 合成文字、仅附图流传输入框文本，二者都保证 content 非空）。
   *
   * 036 带图轮（T012 标注烧录 / T014 仅附图直发）：传 `image.attachmentKeys`（已上传 ossKey）
   * + `image.annotationText`（SoM 合成文字注入视觉模型 text part）；`previewUris` 仅作乐观本地
   * 缩略回显（user turn）。缺省 = 纯文本轮（行为零回归）。
   */
  const send = useCallback(
    (content: string, image?: IdeationTurnImagePayload & { previewUris?: string[] }) => {
      if (state.status === 'streaming') return; // 并发边界硬早返（与 reducer 守卫一致）。
      if (sessionId === null) return;
      if (content.trim().length === 0) return;
      const hasImage = (image?.attachmentKeys?.length ?? 0) > 0;
      dispatch({ type: 'send', content, attachmentPreviewUris: image?.previewUris });
      startStream(sessionId, content.trim(), hasImage ? image : undefined);
    },
    [state.status, sessionId, startStream],
  );

  /** 停止生成 —— abort 进行中流；client onAborted → dispatch stopped。 */
  const stop = useCallback(() => {
    handleRef.current?.controller.abort();
  }, []);

  /** 失败重试 —— 复用上一条 user content 重发。reducer 守卫非 error 态忽略。 */
  const retry = useCallback(() => {
    const content = state.lastUserContent;
    if (state.status !== 'error' || content === null || sessionId === null) return;
    dispatch({ type: 'retry' });
    startStream(sessionId, content);
  }, [state.status, state.lastUserContent, sessionId, startStream]);

  /**
   * 生成 brief（用户主动触发收敛，T016 屏调）。成功后失效会话 query 让详情带上 brief。
   * 返回 GenerateBriefResponse（converged / briefJson / missing），屏据此渲染或继续追问。
   */
  const generateBrief = useCallback(async () => {
    if (sessionId === null) return null;
    const res = await generateBriefMutation.mutateAsync({ id: sessionId });
    void queryClient.invalidateQueries({ queryKey: getSessionControllerGetQueryKey(sessionId) });
    return res.data;
  }, [sessionId, generateBriefMutation, queryClient]);

  /**
   * 034 接地：选择/切换会话目标 repo（PATCH set-repo 成功后 dispatch set-repo 锁定会话态）。
   * 写 idea_session.repo + 失效详情 query（让冷启 hydrate 取到新 repo）。失败抛给调用方
   * （RepoPickerSheet 落 toast，不污染对话态机）。切仓只影响后续轮（FR-006）。
   *
   * @returns 成功 true / 无会话 false（调用方据此提示）。失败 throw（调用方 catch toast）。
   */
  const setRepo = useCallback(
    async (repo: string) => {
      if (sessionId === null) return false;
      await setRepoMutate({ id: sessionId, data: { repo } });
      dispatch({ type: 'set-repo', repo });
      void queryClient.invalidateQueries({ queryKey: getSessionControllerGetQueryKey(sessionId) });
      return true;
    },
    [sessionId, setRepoMutate, queryClient],
  );

  return {
    /** 5 态机当前态。 */
    status: state.status,
    /** 多轮 turn（user + assistant，流式中末条 assistant 逐 token 累加 + chips 收口）。 */
    turns: state.turns,
    /** error 文案（status==='error' 时有值）。 */
    error: state.error,
    /** 冷启 reload 进行中（sessionQuery pending）。 */
    isHydrating: sessionId !== null && sessionQuery.isLoading,
    /** 会话详情（含 brief；T016 brief 屏读取）。 */
    session: sessionQuery.data?.data ?? null,
    send,
    stop,
    retry,
    generateBrief,
    /** brief 生成 in-flight（T016 按钮 loading）。 */
    isGeneratingBrief: generateBriefMutation.isPending,
    /** 034 接地：当前会话锁定的目标 repo（null = 未选，不接地）。 */
    repo: state.repo,
    /** 034 接地：选择/切换目标 repo（RepoPickerSheet 调，成功后写会话态）。 */
    setRepo,
    /** 034 接地：检索进行中指示（「正在检索代码…」）。 */
    retrieving: state.retrieving,
  };
}
