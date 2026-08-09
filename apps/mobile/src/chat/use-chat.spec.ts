// @vitest-environment happy-dom
// 028 T008 — use-chat 扩展（切换/新建 + 流中断协同）hook 编排单测。
// 纯态转换在 chat-reducer.spec（含 reset action）；本文件用 renderHook 验 hook 副作用
// 编排：selectConversation/newConversation 对进行中流的 abort（FR-011）、conversationId
// 切换、reset 回空态。mock orval hook + stream client + last-conversation-store，真 SSE
// 流式交互留 e2e。镜像 settings/use-gender-edit.spec 的 renderHook + QueryClient 体例。
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 可控的 last-conversation-store 状态（mock 替身，每用例 reset）。
const store = vi.hoisted(() => ({
  lastConversationId: null as string | null,
  setLastConversationId: vi.fn((id: string | null) => {
    store.lastConversationId = id;
  }),
}));

// 流句柄替身：暴露可观测的 abort spy（验 FR-011 切换/新建先中断）。
const stream = vi.hoisted(() => ({ abort: vi.fn(), sendMessage: vi.fn() }));

// 029 set-model mutation 替身：暴露可观测的 mutateAsync spy（验已落库切触发 PATCH）。
const setModelMutation = vi.hoisted(() => ({ mutateAsync: vi.fn(() => Promise.resolve()) }));

// 建会话 mutation 替身：空态首发走此路径，返回带 id 的响应（验建会话后失效列表）。
const createMutation = vi.hoisted(() => ({
  mutateAsync: vi.fn(() => Promise.resolve({ data: { id: 'new-conv-id' } })),
}));

// 030 messagesQuery 可控替身：hydrate 测试按需注入带 metadata 的已落库消息。
const messagesQueryState = vi.hoisted(() => ({
  data: undefined as unknown,
  error: undefined as unknown,
  isLoading: false,
}));

vi.mock('@nvy/api-client', () => ({
  useConversationControllerCreate: vi.fn(() => createMutation),
  useConversationControllerMessages: vi.fn(() => messagesQueryState),
  useConversationControllerSetModel: vi.fn(() => setModelMutation),
}));

vi.mock('./chat-stream-client', () => ({
  sendMessage: stream.sendMessage,
}));

vi.mock('./last-conversation-store', () => ({
  useLastConversationStore: (selector: (s: typeof store) => unknown) => selector(store),
}));

import { useChat } from './use-chat';
import { CONVERSATIONS_QUERY_KEY } from './use-conversations';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

/** 显式 client 包装（用于 spy invalidateQueries，验列表失效）。 */
function wrapperWith(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  store.lastConversationId = null;
  store.setLastConversationId.mockClear();
  messagesQueryState.data = undefined;
  messagesQueryState.error = undefined;
  messagesQueryState.isLoading = false;
  stream.abort.mockClear();
  setModelMutation.mutateAsync.mockClear();
  setModelMutation.mutateAsync.mockResolvedValue(undefined);
  createMutation.mutateAsync.mockClear();
  createMutation.mutateAsync.mockResolvedValue({ data: { id: 'new-conv-id' } });
  // sendMessage 返回带可观测 abort 的句柄（controller.abort → stream.abort）。
  stream.sendMessage.mockReset().mockImplementation(() => ({
    controller: { abort: stream.abort } as unknown as AbortController,
    done: Promise.resolve(),
  }));
});

describe('useChat — 028 切换 / 新建编排', () => {
  it('newConversation 在空态 → 仍 idle 空消息（FR-005 回空态）', () => {
    const { result } = renderHook(() => useChat(), { wrapper });
    act(() => result.current.newConversation());
    expect(result.current.status).toBe('idle');
    expect(result.current.messages).toEqual([]);
    expect(store.setLastConversationId).toHaveBeenCalledWith(null);
  });

  it('有消息后 newConversation → 清空回 idle 空态', async () => {
    store.lastConversationId = 'c1';
    const { result } = renderHook(() => useChat(), { wrapper });
    // 先发一条进 streaming 态（建会话已有 id，直接 startStream）。
    await act(async () => {
      await result.current.send('你好');
    });
    expect(result.current.messages.length).toBeGreaterThan(0);

    act(() => result.current.newConversation());
    expect(result.current.status).toBe('idle');
    expect(result.current.messages).toEqual([]);
  });

  it('🚨 streaming 中 newConversation → 先 abort 进行中流（FR-011）', async () => {
    store.lastConversationId = 'c1';
    const { result } = renderHook(() => useChat(), { wrapper });
    await act(async () => {
      await result.current.send('生成中');
    });
    expect(result.current.status).toBe('streaming');

    act(() => result.current.newConversation());
    expect(stream.abort).toHaveBeenCalledTimes(1);
    expect(store.setLastConversationId).toHaveBeenLastCalledWith(null);
  });

  it('🚨 streaming 中 selectConversation(其他 id) → 先 abort + 切 last id（FR-011/004）', async () => {
    store.lastConversationId = 'c1';
    const { result } = renderHook(() => useChat(), { wrapper });
    await act(async () => {
      await result.current.send('生成中');
    });
    expect(result.current.status).toBe('streaming');

    act(() => result.current.selectConversation('c2'));
    expect(stream.abort).toHaveBeenCalledTimes(1);
    // 切到目标会话 id → 触发 messagesQuery 重取（hydrate effect 落定后回灌）。
    expect(store.setLastConversationId).toHaveBeenLastCalledWith('c2');
  });

  it('selectConversation 选中当前会话 → no-op（不重复 abort / 不重设 id）', async () => {
    store.lastConversationId = 'c1';
    const { result } = renderHook(() => useChat(), { wrapper });
    await act(async () => {
      await result.current.send('hi');
    });
    store.setLastConversationId.mockClear();
    stream.abort.mockClear();

    act(() => result.current.selectConversation('c1'));
    expect(stream.abort).not.toHaveBeenCalled();
    expect(store.setLastConversationId).not.toHaveBeenCalled();
  });
});

describe('useChat — 029 模型切换（setModel + 会话级 model 态）', () => {
  it('默认 model = flash（新会话首选，FR-008）', () => {
    const { result } = renderHook(() => useChat(), { wrapper });
    expect(result.current.model).toBe('flash');
  });

  it('未落库（无 conversationId）setModel → 仅内存态，不触发 PATCH（D3②）', async () => {
    const { result } = renderHook(() => useChat(), { wrapper });
    await act(async () => {
      await result.current.setModel('pro');
    });
    expect(result.current.model).toBe('pro');
    expect(setModelMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it('已落库 setModel → 设内存态 + 触发 PATCH 持久化（D3①）', async () => {
    store.lastConversationId = 'c1';
    const { result } = renderHook(() => useChat(), { wrapper });
    await act(async () => {
      await result.current.setModel('pro');
    });
    expect(result.current.model).toBe('pro');
    expect(setModelMutation.mutateAsync).toHaveBeenCalledWith({ id: 'c1', data: { model: 'pro' } });
  });

  it('选与当前相同的 model → no-op（不重复 PATCH，state_branch #4）', async () => {
    store.lastConversationId = 'c1';
    const { result } = renderHook(() => useChat(), { wrapper });
    await act(async () => {
      await result.current.setModel('flash'); // 当前已 flash（默认）。
    });
    expect(setModelMutation.mutateAsync).not.toHaveBeenCalled();
    expect(result.current.model).toBe('flash');
  });

  it('🚨 streaming 中 setModel → 先 abort 进行中流（FR-011）', async () => {
    store.lastConversationId = 'c1';
    const { result } = renderHook(() => useChat(), { wrapper });
    await act(async () => {
      await result.current.send('生成中');
    });
    expect(result.current.status).toBe('streaming');
    stream.abort.mockClear();

    await act(async () => {
      await result.current.setModel('pro');
    });
    expect(stream.abort).toHaveBeenCalledTimes(1);
    expect(result.current.model).toBe('pro');
  });

  it('selectConversation 带 model → 顶栏 model 跟随该会话（FR-007 会话级记忆）', () => {
    store.lastConversationId = 'c1';
    const { result } = renderHook(() => useChat(), { wrapper });
    act(() => result.current.selectConversation('c2', 'pro'));
    expect(result.current.model).toBe('pro');
  });

  it('newConversation → model 回默认 flash（FR-008）', () => {
    store.lastConversationId = 'c1';
    const { result } = renderHook(() => useChat(), { wrapper });
    act(() => result.current.selectConversation('c2', 'pro'));
    expect(result.current.model).toBe('pro');
    act(() => result.current.newConversation());
    expect(result.current.model).toBe('flash');
  });

  it('selectConversation 历史会话含 legacy/未知 model 值 → 稳健回落默认展示（Edge）', () => {
    store.lastConversationId = 'c1';
    const { result } = renderHook(() => useChat(), { wrapper });
    act(() => result.current.selectConversation('c2', 'deepseek-chat'));
    // 未知值不崩；回落默认 flash（顶栏稳健降级，spec Edge「旧/未知 model 值」）。
    expect(result.current.model).toBe('flash');
  });
});

describe('useChat — 会话列表失效（修 028 FR-005 新建会话不入抽屉 bug）', () => {
  it('空态首发 → 建会话落库后失效会话列表（新会话即刻入抽屉）', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    // lastConversationId 为 null（空态）→ send 走建会话分支。stream 默认不触发 onDone，
    // 隔离出「建会话后」这一次失效。
    const { result } = renderHook(() => useChat(), { wrapper: wrapperWith(client) });
    await act(async () => {
      await result.current.send('你好');
    });
    expect(createMutation.mutateAsync).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: CONVERSATIONS_QUERY_KEY });
  });

  it('首条消息流完(onDone) → 失效会话列表（刷新 server 派生 title + 排序）', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    // 已落库（有 id）跳过建会话，隔离出「onDone 后」这一次失效；本用例令 stream 同步回 onDone。
    store.lastConversationId = 'c1';
    stream.sendMessage.mockImplementationOnce(
      (_id: string, _content: string, handlers: { onDone: () => void }) => {
        handlers.onDone();
        return {
          controller: { abort: stream.abort } as unknown as AbortController,
          done: Promise.resolve(),
        };
      },
    );
    const { result } = renderHook(() => useChat(), { wrapper: wrapperWith(client) });
    await act(async () => {
      await result.current.send('hi');
    });
    expect(createMutation.mutateAsync).not.toHaveBeenCalled(); // 已落库不建会话
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: CONVERSATIONS_QUERY_KEY });
  });
});

describe('useChat — 030 A1 恒联网（去 toggle，send 不再带 webSearch）', () => {
  it('不再暴露 webSearch 态 / setWebSearch（ChatGPT 式恒联网，去 per-message toggle）', () => {
    const { result } = renderHook(() => useChat(), { wrapper });
    expect('webSearch' in result.current).toBe(false);
    expect('setWebSearch' in result.current).toBe(false);
  });

  it('send → sendMessage 不带 webSearch options（联网由 server 默认决定）', async () => {
    store.lastConversationId = 'c1';
    const { result } = renderHook(() => useChat(), { wrapper });
    await act(async () => {
      await result.current.send('今天天气');
    });
    expect(stream.sendMessage).toHaveBeenCalledTimes(1);
    const args = stream.sendMessage.mock.calls[0] ?? [];
    expect(args[0]).toBe('c1'); // conversationId
    expect(args[1]).toBe('今天天气'); // content
    expect(args[3]).toBeUndefined(); // 无第 4 参 options（webSearch 已去）
  });
});

describe('useChat — 030 hydrate 从 metadata 回填 sources/degraded（冷启动 SC-003）', () => {
  it('hydrate 解包 metadata.sources/degraded → assistant 消息回填', () => {
    store.lastConversationId = 'c1';
    messagesQueryState.data = {
      data: {
        messages: [
          {
            id: '1',
            role: 'user',
            content: 'Q',
            status: 'completed',
            createdAt: '',
            metadata: null,
          },
          {
            id: '2',
            role: 'assistant',
            content: 'A[1]',
            status: 'completed',
            createdAt: '',
            metadata: {
              searched: true,
              degraded: false,
              sources: [{ index: 1, title: 'T', url: 'https://t.com', publishedAt: 1700000000000 }],
            },
          },
        ],
      },
    };
    const { result } = renderHook(() => useChat(), { wrapper });
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1]).toMatchObject({
      role: 'assistant',
      sources: [{ index: 1, title: 'T', url: 'https://t.com', publishedAt: 1700000000000 }],
    });
    expect(result.current.messages[1]?.degraded).toBeUndefined(); // degraded:false 不挂
  });

  it('hydrate degraded:true 消息 → 标降级（冷启动恢复降级标识）', () => {
    store.lastConversationId = 'c1';
    messagesQueryState.data = {
      data: {
        messages: [
          {
            id: '1',
            role: 'assistant',
            content: '基于已有知识',
            status: 'completed',
            createdAt: '',
            metadata: { searched: true, degraded: true, sources: [] },
          },
        ],
      },
    };
    const { result } = renderHook(() => useChat(), { wrapper });
    expect(result.current.messages[0]?.degraded).toBe(true);
  });

  it('旧消息 metadata 缺省（null）→ 不挂 sources/degraded（向后兼容）', () => {
    store.lastConversationId = 'c1';
    messagesQueryState.data = {
      data: {
        messages: [
          {
            id: '1',
            role: 'assistant',
            content: '旧回复',
            status: 'completed',
            createdAt: '',
            metadata: null,
          },
        ],
      },
    };
    const { result } = renderHook(() => useChat(), { wrapper });
    expect(result.current.messages[0]?.sources).toBeUndefined();
    expect(result.current.messages[0]?.degraded).toBeUndefined();
  });
});
