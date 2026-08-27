// GOLDEN SAMPLE — mobile 数据层另一形态：数据 hook 自持 list + mutation + 共置失效。索引见 docs/conventions/golden-sample-registry.md，详版见 mobile-impl-playbook § 8。
// 028 T007 — 会话列表 hook（抽屉历史列表数据源）。
//
// 职责：cursor 分页累加（list）+ 标题搜索防抖（q）+ rename / delete mutation + 失效。
//
// 设计取舍（干净上下文须知）：
// - **list 走 useInfiniteQuery + orval raw queryFn**：orval 默认不 emit useInfinite hook
//   （F3 实证）→ 不改 orval config，直接用 `useInfiniteQuery` 自拼 cursor，pageParam 调
//   生成的 `conversationControllerList({limit, cursor, q})`。
// - **rename / delete 走 orval 生成 mutation hook**（标准 JSON 端点），成功后
//   `invalidateQueries({queryKey: CONVERSATIONS_QUERY_KEY})` 重取列表（含改名回显 / 删除移除）。
// - **搜索 q 防抖 250ms**（mono 既有体例，见 alert/target-select-screen）；q 进 query key →
//   变更即换 query（首页重取，不与旧 q 的页混淆）。
// - **纯逻辑**（mergeConversationPages / getNextCursorParam）抽出 vitest 覆盖；hook 编排
//   （render / 真分页 / invalidate 副作用）走 Playwright + contract-smoke（per 测试分层）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  type ConversationListResponse,
  conversationControllerList,
  useConversationControllerRemove,
  useConversationControllerRename,
} from '@nvy/api-client';
import type { AxiosResponse } from 'axios';

import type { ConversationItem } from './group-conversations';

/** 页大小（server 默认 20，1..50）。抽屉滚动累加，标准翻页量。 */
const PAGE_SIZE = 20;

/** 搜索防抖窗口（ms，与 alert/target-select-screen 同款，避免每键一打）。 */
const SEARCH_DEBOUNCE_MS = 250;

/** 列表 query key 稳定前缀（mutation 成功后失效目标；q 作第二段区分搜索态）。 */
export const CONVERSATIONS_QUERY_KEY = ['conversations'] as const;

/**
 * 把 useInfiniteQuery 的多页响应拍平为单一会话列表（页序拼接 + 按 id 去重保留首见）。
 *
 * 复杂度 O(n)：单遍累加 + Set 去重，n = 全页会话总数。去重兜底跨页边界数据 /
 * 失效重取可能令同 id 跨页重现（cursor 复合 (updatedAt,id) 仍可能边界重叠）。
 */
export function mergeConversationPages(pages: ConversationListResponse[]): ConversationItem[] {
  const seen = new Set<string>();
  const merged: ConversationItem[] = [];
  for (const p of pages) {
    for (const it of p.items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      merged.push(it);
    }
  }
  return merged;
}

/** 翻页参数：有 nextCursor → 继续翻；null / 缺省 → undefined（useInfiniteQuery 停止翻页）。 */
export function getNextCursorParam(page: ConversationListResponse): string | undefined {
  return page.nextCursor ?? undefined;
}

export interface UseConversationsResult {
  /** 拍平后的会话列表（多页累加，去重，页序）。 */
  conversations: ConversationItem[];
  /** 当前生效的搜索词（防抖后）；空串 = 全量。 */
  query: string;
  /** 更新搜索输入（防抖后写入 query 触发重取）。 */
  setSearchInput: (value: string) => void;
  /** 搜索输入原始值（受控 input 绑定）。 */
  searchInput: string;
  /** 是否处于搜索态（防抖词非空）。 */
  isSearching: boolean;
  isLoading: boolean;
  isError: boolean;
  /** 还有下一页可加载。 */
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  /** 改名（成功后失效列表）。 */
  renameConversation: (id: string, title: string) => Promise<void>;
  /** 删除（成功后失效列表）。 */
  deleteConversation: (id: string) => Promise<void>;
}

/** 会话列表 hook：分页累加 + 搜索防抖 + rename/delete + 失效。 */
export function useConversations(): UseConversationsResult {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');

  // 防抖：输入停顿 250ms 后才写入 query（→ query key 变更触发重取）。
  useEffect(() => {
    const t = setTimeout(() => setQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const listQuery = useInfiniteQuery<
    AxiosResponse<ConversationListResponse>,
    unknown,
    InfiniteData<AxiosResponse<ConversationListResponse>>,
    readonly unknown[],
    string | undefined
  >({
    queryKey: [...CONVERSATIONS_QUERY_KEY, query],
    queryFn: ({ pageParam, signal }) =>
      conversationControllerList(
        {
          limit: PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
          ...(query ? { q: query } : {}),
        },
        { signal },
      ),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => getNextCursorParam(lastPage.data),
  });

  const conversations = useMemo(
    () => mergeConversationPages((listQuery.data?.pages ?? []).map((p) => p.data)),
    [listQuery.data],
  );

  const renameMutation = useConversationControllerRename();
  const removeMutation = useConversationControllerRemove();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY });
  }, [queryClient]);

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      await renameMutation.mutateAsync({ id, data: { title } });
      invalidate();
    },
    [renameMutation, invalidate],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      await removeMutation.mutateAsync({ id });
      invalidate();
    },
    [removeMutation, invalidate],
  );

  const fetchNextPage = useCallback(() => {
    void listQuery.fetchNextPage();
  }, [listQuery]);

  return {
    conversations,
    query,
    searchInput,
    setSearchInput,
    isSearching: query.length > 0,
    isLoading: listQuery.isPending,
    isError: listQuery.isError,
    hasNextPage: listQuery.hasNextPage,
    isFetchingNextPage: listQuery.isFetchingNextPage,
    fetchNextPage,
    renameConversation,
    deleteConversation,
  };
}
