// 046 T021 — 标的详情数据源：**两个端点并行合成**（plan D2 / spec § Clarifications Q1）。
//
// 🚨 **不是 BFF、不是链式** —— optionsdesk 详情端点（锚卡 + 四区间边界 + IV 读数）与
//    marketdata bars 端点（前复权价格序列）由客户端**并行**发起，两侧**各带各的 `asOf`、
//    各自独立降级**：任一侧 5xx，另一侧照常渲染。⚠️ 这与业界 BFF 共识相反，论证写在
//    spec § Clarifications Q1（modular monolith 同进程 / 两个 GET 并行 / HTTP/2 已开
//    ⇒ 成本 ≈ max(t1,t2)；且本项目只有一个客户端）。**别"优化"成后端聚合或整页 loading。**
//
// 🚨 **价格序列不走 optionsdesk**（ADR-0053 绊线）：前复权与时间桶聚合都归 marketdata 的
//    bars 端点，optionsdesk 侧零复权代码。窗口→`period` 的映射走 T020 的纯函数。
import { useCallback, useMemo, useState } from 'react';
import {
  useMarketdataControllerBars,
  useOptionsdeskControllerUnderlyingDetail,
  type DailyBarItem,
  type UnderlyingDetailResponse,
} from '@nvy/api-client';

import { todayYmd } from '~/format/as-of';
import {
  composeUnderlyingDetail,
  isNoAnchorError,
  windowStartDate,
  type DetailComposition,
  type FreshnessTier,
} from './underlying-detail.rules';
import {
  DEFAULT_TIME_SERIES_WINDOW,
  barsPeriodForWindow,
  type TimeSeriesWindow,
} from './window-granularity.rules';

/** 详情屏 query key 稳定前缀（锚 mutation 后须失效；本片只读，留给 045 表单侧接线）。 */
export const UNDERLYING_DETAIL_QUERY_KEY = ['optionsdesk', 'underlying-detail'] as const;

/**
 * 无锚是**预期分支**不是故障（FR-011）⇒ 不重试。其余错误退 1 次即可 ——
 * 详情屏是 EOD 只读面，多轮重试只会把降级态往后拖。
 */
function retryUnlessNoAnchor(failureCount: number, error: unknown): boolean {
  return !isNoAnchorError(error) && failureCount < 1;
}

export interface UseUnderlyingDetailResult {
  symbol: string;
  /**
   * 「今天」—— **只用于窗口起点求值与「序列短于窗口」的脚注**（bars 的 `from`/`to` 参数）。
   * 🚨 **不再用于新鲜度判断**：那个判据要查交易日历，已上移到 server（FR-020）。
   */
  today: string;
  /** 三块各自的呈现态（页级只有 ready / no_anchor）。 */
  composition: DetailComposition;
  detail: UnderlyingDetailResponse | null;
  series: DailyBarItem[];
  /** 序列 asOf 的新鲜度档（由 bars 端点下发）。 */
  seriesFreshnessTier: FreshnessTier;
  window: TimeSeriesWindow;
  setWindow: (window: TimeSeriesWindow) => void;
  /** 只重取序列侧（锚卡好着呢，没必要连坐）。 */
  retrySeries: () => void;
  refetchAll: () => void;
  isRefetching: boolean;
}

export function useUnderlyingDetail(symbol: string): UseUnderlyingDetailResult {
  const [window, setWindow] = useState<TimeSeriesWindow>(DEFAULT_TIME_SERIES_WINDOW);
  // 每次 render 取一次本地日历日；跨午夜的漂移在 EOD 面上无影响（asOf 恒来自数据本身）。
  const today = todayYmd();

  const detailQuery = useOptionsdeskControllerUnderlyingDetail(symbol, {
    query: { enabled: symbol.length > 0, retry: retryUnlessNoAnchor },
  });

  const barsParams = useMemo(
    () => ({
      adjust: 'forward' as const,
      period: barsPeriodForWindow(window),
      from: windowStartDate(window, today),
      to: today,
    }),
    [window, today],
  );

  const barsQuery = useMarketdataControllerBars(symbol, barsParams, {
    query: { enabled: symbol.length > 0, retry: 1 },
  });

  const composition = useMemo(
    () =>
      composeUnderlyingDetail(
        {
          isPending: detailQuery.isPending,
          isError: detailQuery.isError,
          error: detailQuery.error,
        },
        { isPending: barsQuery.isPending, isError: barsQuery.isError, error: barsQuery.error },
      ),
    [
      detailQuery.isPending,
      detailQuery.isError,
      detailQuery.error,
      barsQuery.isPending,
      barsQuery.isError,
      barsQuery.error,
    ],
  );

  const retrySeries = useCallback(() => {
    void barsQuery.refetch();
  }, [barsQuery]);

  const refetchAll = useCallback(() => {
    void detailQuery.refetch();
    void barsQuery.refetch();
  }, [detailQuery, barsQuery]);

  return {
    symbol,
    today,
    composition,
    detail: detailQuery.data?.data ?? null,
    series: barsQuery.data?.data.items ?? [],
    // 序列新鲜度档由 bars 端点下发 (判据在 server); 尚无响应时按不可用渲染, 不猜。
    seriesFreshnessTier: barsQuery.data?.data.freshnessTier ?? 'UNAVAILABLE',
    window,
    setWindow,
    retrySeries,
    refetchAll,
    isRefetching: detailQuery.isRefetching || barsQuery.isRefetching,
  };
}
