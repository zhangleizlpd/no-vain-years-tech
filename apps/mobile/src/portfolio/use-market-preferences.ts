import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getMarketPreferencesControllerGetPreferencesQueryKey,
  useMarketPreferencesControllerGetPreferences,
  useMarketPreferencesControllerUpdatePreference,
  type MarketItem,
  type MarketPreferencesResponse,
} from '@nvy/api-client';
import type { AxiosResponse } from 'axios';

import { extractProblemDetail } from '~/core/api/errors';
import { MARKET_COPY } from './market-copy';

// 证券市场偏好 hook（011 US4/US5）。包 orval query + mutation：
//  - 首屏态机：loading / error(retry) / ready（FR-M06 默认态来自 server）
//  - 乐观更新 + 响应对账：PUT 即时翻 cache，server 返**全量** 9 市场态覆盖 cache（D7）
//  - 失败回弹：PUT 失败恢复 cache 原态 + errorToast（FR-M07）
//  - min-1 客户端预判（D6）：关最后一个激活核心市场 → 直接拦截 + 轻提示，**不发 PUT**；
//    server `MIN_ONE_MARKET_REQUIRED`（422）为最终真相兜底，防多端竞态致 0 激活
// 逻辑分流（纯函数 predictMinOneViolation / applyToggle / marketToggleErrorToast）单测；
// 渲染走 Playwright（per mono 测试分层）。

type Prefs = AxiosResponse<MarketPreferencesResponse>;

/** 关最后一个激活核心市场的客户端预判（D6）。turning on 永不违规；非核心 / 已关 / 仍有其他激活核心 → 不拦。 */
export function predictMinOneViolation(
  markets: MarketItem[],
  marketCode: string,
  next: boolean,
): boolean {
  if (next) return false;
  const target = markets.find((m) => m.marketCode === marketCode);
  if (!target || target.group !== 'core' || !target.active) return false;
  const activeCore = markets.filter((m) => m.group === 'core' && m.active).length;
  return activeCore <= 1;
}

/** 乐观更新：返回 markets[target].active = next 的新响应（不可变，cache 安全）。 */
export function applyToggle(prev: Prefs, marketCode: string, next: boolean): Prefs {
  return {
    ...prev,
    data: {
      ...prev.data,
      markets: prev.data.markets.map((m) =>
        m.marketCode === marketCode ? { ...m, active: next } : m,
      ),
    },
  };
}

/** 切换失败 toast（FR-M07）：复用 ~/core/api ProblemDetail guard 体例，按 code 分流，min-1 与通用错误区分。 */
export function marketToggleErrorToast(error: unknown): string {
  const p = extractProblemDetail(error);
  if (p?.code === 'MIN_ONE_MARKET_REQUIRED') return MARKET_COPY.errorToast.minOne;
  if (p?.code === 'RATE_LIMIT_EXCEEDED') return MARKET_COPY.errorToast.rateLimit;
  const e = error as { isAxiosError?: boolean; response?: { status?: number } };
  if (e?.isAxiosError && e.response?.status === 429) return MARKET_COPY.errorToast.rateLimit;
  return MARKET_COPY.errorToast.network;
}

export type MarketPrefsStatus = 'loading' | 'error' | 'ready';

export function useMarketPreferences() {
  const queryClient = useQueryClient();
  const queryKey = getMarketPreferencesControllerGetPreferencesQueryKey();
  const query = useMarketPreferencesControllerGetPreferences();
  const mutation = useMarketPreferencesControllerUpdatePreference();

  const [hint, setHint] = useState<string | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [togglingMarket, setTogglingMarket] = useState<string | null>(null);

  const markets: MarketItem[] = query.data?.data.markets ?? [];

  const toggle = useCallback(
    async (marketCode: string, next: boolean) => {
      // in-flight 防重复点（Mobile Edge：避免重复 PUT）。
      if (togglingMarket !== null) return;

      const prev = queryClient.getQueryData<Prefs>(queryKey);
      const current = prev?.data.markets ?? markets;

      // min-1 客户端预判（D6）：直接拦截弹回 + 轻提示，不发 PUT。
      if (predictMinOneViolation(current, marketCode, next)) {
        setHint(MARKET_COPY.minOneHint);
        return;
      }

      setHint(null);
      setErrorToast(null);
      setTogglingMarket(marketCode);

      // 乐观更新（无 cache 时跳过，回弹仍以 server 响应为准）。
      if (prev) queryClient.setQueryData(queryKey, applyToggle(prev, marketCode, next));

      try {
        const res = await mutation.mutateAsync({ market: marketCode, data: { active: next } });
        // 对账：server 返全量态覆盖 cache（D7；含多端竞态下的真态同步）。
        queryClient.setQueryData(queryKey, res);
      } catch (e) {
        // 回弹原态 + 分流 toast（含 422 min-1 竞态兜底）。
        if (prev) queryClient.setQueryData(queryKey, prev);
        setErrorToast(marketToggleErrorToast(e));
      } finally {
        setTogglingMarket(null);
      }
    },
    [queryClient, queryKey, mutation, markets, togglingMarket],
  );

  const clearHint = useCallback(() => setHint(null), []);
  const clearErrorToast = useCallback(() => setErrorToast(null), []);

  const status: MarketPrefsStatus = query.isPending ? 'loading' : query.isError ? 'error' : 'ready';

  return {
    markets,
    status,
    toggle,
    togglingMarket,
    hint,
    errorToast,
    clearHint,
    clearErrorToast,
    refetch: query.refetch,
  };
}
