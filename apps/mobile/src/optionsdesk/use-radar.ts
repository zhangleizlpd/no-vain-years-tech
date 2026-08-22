// 045 T024 — 雷达数据源（游标增量加载 + 多选筛选）。
//
// 设计取舍（干净上下文须知）：
// - **走 `useInfiniteQuery` + orval raw queryFn**：orval 不 emit useInfinite hook（028 已实证），
//   直接自拼 cursor，`pageParam` 调生成的 `optionsdeskControllerRadar`。同 `~/chat/use-conversations` 体例。
// - 🚨 **`paramsSerializer: { indexes: null }` 是必须的**：server 的 `lLevels` 是逗号分隔 /
//   重复键形态；axios **默认**把数组序列化成 `lLevels[]=L1&lLevels[]=L3`，而 Fastify 默认
//   query parser（Node `querystring`）不认方括号 ⇒ 键变成 `lLevels[]`、筛选**静默失效**
//   （2026-08-02 本地实测：默认 `lLevels%5B%5D=L1`；`indexes:null` → `lLevels=L1&lLevels=L3`，
//   单选时退化成 `lLevels=L1` 也被 server 的 CSV `@Transform` 正确吃下）。
// - 空态判定只认**首页**的 `emptyState`（server 明确「续页不判空态」）。
import { useCallback, useMemo, useState } from 'react';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import {
  optionsdeskControllerRadar,
  type AnchorResponse,
  type RadarResponse,
} from '@nvy/api-client';
import type { AxiosResponse } from 'axios';

import {
  RADAR_MARKETS,
  getRadarNextCursor,
  mergeRadarPages,
  radarFilterParams,
  radarFreshness,
  radarQueryKey,
  radarViewState,
  toggleRadarFilter,
  type RadarFilterKey,
  type RadarFreshness,
  type RadarMarket,
  type RadarViewState,
} from './radar.rules';

/** 页大小（server 缺省 20 / 上限 100）。下拉一屏的标准翻页量。 */
const PAGE_SIZE = 20;

// key 前缀与工厂都住 `radar.rules.ts`（纯函数, 有 vitest 覆盖）。这里 re-export 保持
// `index.ts` 的对外面不变, 也让 mutation 侧能从任一处拿到**同一个**工厂（T12）。
export { RADAR_QUERY_KEY, radarQueryKey } from './radar.rules';

export interface UseRadarResult {
  items: AnchorResponse[];
  /** 当前市场作用域（冷启动落 `RADAR_MARKETS[0]` = 美股, FR-005）。 */
  market: RadarMarket;
  selectMarket: (market: RadarMarket) => void;
  /**
   * 有「可动锚」的市场（FR-016 小圆点数据源）—— 取自 server 的 `marketCounts`，
   * **不受当前作用域限制**，所以能回答「**别的**页签有没有值得看的东西」。
   */
  actionableMarkets: string[];
  viewState: RadarViewState;
  /** 三空态文案由 server 下发（前端不拼），无空态 → null。 */
  emptyStateMessage: string | null;
  freshness: RadarFreshness;
  selectedFilters: RadarFilterKey[];
  toggleFilter: (key: RadarFilterKey) => void;
  clearFilters: () => void;
  isLoading: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  refetch: () => void;
  isRefetching: boolean;
}

export function useRadar(): UseRadarResult {
  // 🚨 **会话内记忆**: 底部 Tab 常驻不 unmount ⇒ `useState` 就够, 不必持久化。
  // 🚫 **MUST NOT 依据「当前哪个市场开市」自动切换**（plan D8）—— 那会让「我刚才在哪个
  //    页签」变得不可预测, 并且在开 / 收盘那一刻自己翻页。默认恒落 `RADAR_MARKETS[0]`。
  const [market, setMarket] = useState<RadarMarket>(RADAR_MARKETS[0]!);
  // 🚨 筛选 state **跨页签保留**（plan D9）: 它是镜头, 不是每页签独立的状态 —— 切市场时
  //    保持同一组筛选, 才谈得上「同一把尺子量两个市场」。
  const [selectedFilters, setSelectedFilters] = useState<RadarFilterKey[]>([]);
  const filterParams = useMemo(() => radarFilterParams(selectedFilters), [selectedFilters]);

  const query = useInfiniteQuery<
    AxiosResponse<RadarResponse>,
    unknown,
    InfiniteData<AxiosResponse<RadarResponse>>,
    readonly unknown[],
    string | undefined
  >({
    // 市场与筛选都进 key：变更即换 query（首页重取，`pageParam` 自然重置 —— 这正是
    // plan D6 敢撤销「market 编进游标」的依据）。
    queryKey: radarQueryKey(market, filterParams),
    queryFn: ({ pageParam, signal }) =>
      optionsdeskControllerRadar(
        { limit: PAGE_SIZE, market, ...(pageParam ? { cursor: pageParam } : {}), ...filterParams },
        { signal, paramsSerializer: { indexes: null } },
      ),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => getRadarNextCursor(lastPage.data),
  });

  const pages = useMemo(() => (query.data?.pages ?? []).map((p) => p.data), [query.data]);
  const items = useMemo(() => mergeRadarPages(pages), [pages]);
  const firstPage = pages[0] ?? null;

  const viewState = useMemo(
    () => radarViewState({ items, emptyState: firstPage?.emptyState ?? null }),
    [items, firstPage],
  );
  const freshness = useMemo(() => radarFreshness(items), [items]);
  const actionableMarkets = useMemo(
    () => (firstPage?.marketCounts ?? []).filter((c) => c.actionableTotal > 0).map((c) => c.market),
    [firstPage],
  );

  const toggleFilter = useCallback((key: RadarFilterKey) => {
    setSelectedFilters((cur) => toggleRadarFilter(cur, key));
  }, []);
  const clearFilters = useCallback(() => setSelectedFilters([]), []);

  const fetchNextPage = useCallback(() => {
    void query.fetchNextPage();
  }, [query]);
  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    items,
    market,
    selectMarket: setMarket,
    actionableMarkets,
    viewState,
    emptyStateMessage: firstPage?.emptyStateMessage ?? null,
    freshness,
    selectedFilters,
    toggleFilter,
    clearFilters,
    isLoading: query.isPending,
    isError: query.isError,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage,
    refetch,
    isRefetching: query.isRefetching,
  };
}
