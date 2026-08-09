// 037 T011 — session mockup 读列表 hook（fetch-on-open，无实时刷新 FR-011）。
//
// 数据层薄壳：包 orval 生成的 `useMockupListControllerList`（GET /ideation/sessions/{id}/mockups），
// **禁手写 fetch/axios**（api-contract 硬 invariant）。fetch-on-open = 打开屏即拉一次（React Query
// 默认 + 全局 staleTime 30s 兜底），不订阅实时刷新——交付若发生在用户未查看时下次进入可见（FR-011）。
//
// 派生「最新版」= versionRank 1（server append-only 倒序派生，最新 = 1）；多版切换条 T014 用全 items。
// 空态（items=[] 非错误，US1 AC3）/ 加载态 / 错误态判定纯逻辑抽 `deriveMockupView`（vitest 覆盖）；
// 渲染 / 状态屏 e2e = T013。
import { useMemo } from 'react';
import { useMockupListControllerList } from '@nvy/api-client';
import type { SessionMockupResponse } from '@nvy/api-client';

export type { SessionMockupResponse } from '@nvy/api-client';

/** 读列表派生视图态（屏据此渲 loading / error / empty / list）。 */
export interface MockupView {
  /** 该 session 全部交付版（倒序，最新在前；append-only）。 */
  items: SessionMockupResponse[];
  /** 最新版（versionRank 1；空列表 → null）。屏默认渲此版。 */
  latest: SessionMockupResponse | null;
  /** 拉取中（首屏 Spinner）。 */
  isPending: boolean;
  /** 拉取失败（错误态 + 重试，不渲空假态）。 */
  isError: boolean;
  /** 拉到但无任何 mockup（空态非错误，US1 AC3）。 */
  isEmpty: boolean;
}

/**
 * 从读列表 items 派生「最新版」：取 versionRank === 1（server append-only 派生，最新 = 1）。
 * 兜底——无显式 rank 命中时退回首元素（server 已 createdAt 倒序）；空 → null。纯函数，vitest 覆盖。
 */
export function selectLatestMockup(
  items: readonly SessionMockupResponse[],
): SessionMockupResponse | null {
  if (items.length === 0) return null;
  return items.find((m) => m.versionRank === 1) ?? items[0] ?? null;
}

/**
 * 据 React Query 态 + items 派生屏视图态（loading / error / empty / list + latest）。纯函数：
 * 入参为已解构的 query 态（脱离 hook，便于 vitest 直测各态组合）。
 */
export function deriveMockupView(args: {
  items: readonly SessionMockupResponse[] | undefined;
  isPending: boolean;
  isError: boolean;
}): MockupView {
  const items = args.items ?? [];
  return {
    items: [...items],
    latest: selectLatestMockup(items),
    isPending: args.isPending,
    isError: args.isError,
    // 空态仅在「拉取成功（非 pending / 非 error）且列表空」时成立（不与 loading/error 混淆）。
    isEmpty: !args.isPending && !args.isError && items.length === 0,
  };
}

/** session mockup 读列表 hook 返型（视图态 + 重试）。 */
export interface UseSessionMockups extends MockupView {
  /** 错误态重试（重新拉一次）。 */
  refetch: () => void;
}

/**
 * 拉某 session 的 mockup 列表（fetch-on-open）。
 * @param sessionId 会话 id（数字串）。null/空 → 不发请求（enabled=false），返空闲态。
 */
export function useSessionMockups(sessionId: string | null): UseSessionMockups {
  const query = useMockupListControllerList(sessionId ?? '', {
    query: { enabled: !!sessionId },
  });

  const view = useMemo(
    () =>
      deriveMockupView({
        items: query.data?.data.items,
        // sessionId 缺省时 query disabled → isPending 恒 true（React Query 语义），此处按非 pending
        // 处理避免无 session 也转圈；有 session 时透传真实 isPending。
        isPending: !!sessionId && query.isPending,
        isError: query.isError,
      }),
    [sessionId, query.data, query.isPending, query.isError],
  );

  return { ...view, refetch: () => void query.refetch() };
}
