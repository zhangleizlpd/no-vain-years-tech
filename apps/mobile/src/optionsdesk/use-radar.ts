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
  getRadarNextCursor,
  mergeRadarPages,
  radarFilterParams,
  radarFreshness,
  radarViewState,
  toggleRadarFilter,
  type RadarFilterKey,
  type RadarFreshness,
  type RadarViewState,
} from './radar.rules';

/** 页大小（server 缺省 20 / 上限 100）。下拉一屏的标准翻页量。 */
const PAGE_SIZE = 20;

/** 列表 query key 稳定前缀 —— 锚 mutation（建 / 删 / 改 list-visible 字段）须失效它。 */
export const RADAR_QUERY_KEY = ['optionsdesk', 'radar'] as const;

export interface UseRadarResult {
  items: AnchorResponse[];
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
  const [selectedFilters, setSelectedFilters] = useState<RadarFilterKey[]>([]);
  const filterParams = useMemo(() => radarFilterParams(selectedFilters), [selectedFilters]);

  const query = useInfiniteQuery<
    AxiosResponse<RadarResponse>,
    unknown,
    InfiniteData<AxiosResponse<RadarResponse>>,
    readonly unknown[],
    string | undefined
  >({
    // 筛选进 key：变更即换 query（首页重取，不与旧筛选的页混淆）。
    queryKey: [...RADAR_QUERY_KEY, filterParams],
    queryFn: ({ pageParam, signal }) =>
      optionsdeskControllerRadar(
        { limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}), ...filterParams },
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
