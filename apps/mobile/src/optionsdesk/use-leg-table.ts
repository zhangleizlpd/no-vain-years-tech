// 047 T031 — 选约表数据源：**单端点一次取回全量腿**（plan D-API-1）。
//
// 🚨 **零请求分页、零 top-N** —— 端点一次返回该票全部适格腿（730 行量级），三个 Tab 是
//    同一份数据的三种**取序**（051 起：按 `tabOrder[tab]` 取，切 Tab 不重新请求）。分三次
//    请求会让三个 Tab 的 `asOf` 与档位口径可能不一致，正是 FR-005 / plan D-API-1 否掉的形态。
//
// 🚨 **Tab 成员判据 MUST NOT 在客户端重算** —— 每腿自带 `tabs: ('all'|'build'|'rent')[]`，
//    判据单点在 server 的 `leg-recall.rules.ts`（050 起；047 时在 `leg-tab.rules.ts`）。
//    IT 已实证：greeks 缺失腿**合法进意图 Tab** —— 050 起 Δ 整个退出召回判据（FR-009）。
//    客户端重算极易漏掉那一支。
//
// 🚨 **顺序整条由 server 定死**（051 FR-001/FR-002）—— 每 Tab 一份有序合约代码列表，客户端
//    按它取、**MUST NOT 再排一次**。⚠️ `legs[]` 自带的那个序是 legacy 载体序，050 之后已不
//    承载任何 Tab 的排序语义（保留只为不惊动尚未升级的客户端）。
import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getOptionsdeskControllerLegsQueryKey,
  useOptionsdeskControllerLegs,
  useOptionsdeskControllerPositionBucket,
  type LegResponse,
  type LegTableResponse,
} from '@nvy/api-client';

import {
  EMPTY_LEG_TAB_ORDER,
  legPickerNotices,
  legPickerSections,
  promotePick,
  resolveLegTab,
  type LegPickerNotice,
  type LegPickerTab,
  type LegTabOrder,
  type PickedLegTab,
} from './leg-picker.rules';
import {
  isNoAnchorError,
  legBlockState,
  legRowTotal,
  type LegBlockState,
  type LegSection,
} from './underlying-detail.rules';

/** 选约表 query key 稳定前缀（水位手选写端点成功后须失效 —— 意图落位会随之变，T033 接线）。 */
export const LEG_TABLE_QUERY_KEY = ['optionsdesk', 'legs'] as const;

/**
 * 无锚是**预期分支**不是故障（FR-011，该端点对无锚票 404 带机器可读 code）⇒ 不重试。
 * 其余错误退 1 次 —— 选约表是 EOD 只读面，多轮重试只把降级态往后拖。
 */
function retryUnlessNoAnchor(failureCount: number, error: unknown): boolean {
  return !isNoAnchorError(error) && failureCount < 1;
}

export interface UseLegTableResult {
  table: LegTableResponse | null;
  /** 区块四态（loading / available / chain_not_ready / read_failed）—— 无「整页」这一档。 */
  block: LegBlockState;
  /** 当前生效 Tab（手点值优先，意图一变让位给新的默认落位，见 `resolveLegTab`）。 */
  tab: LegPickerTab;
  setTab: (tab: LegPickerTab) => void;
  /** 未选水位时的就地注明（已选时空数组）。 */
  notices: readonly LegPickerNotice[];
  /** `SectionList` 的 `sections`，恒长度 1（三 Tab 共用同一个列表实例，切 Tab 只换 `data`）。 */
  sections: LegSection[];
  /** 计数条分母 —— **当前 Tab 的**逻辑集合长度，不是渲染窗口大小（SC-012）。 */
  total: number;
  retry: () => void;
}

export function useLegTable(symbol: string): UseLegTableResult {
  const query = useOptionsdeskControllerLegs(symbol, {
    query: { enabled: symbol.length > 0, retry: retryUnlessNoAnchor },
  });
  // 手点值连同**当时的意图**一起记 —— 判定见 `resolveLegTab`（意图变了就让位）。
  const [picked, setPicked] = useState<PickedLegTab | null>(null);

  const table = query.data?.data ?? null;
  // 🚨 全量腿 —— 这里**不 slice、不排序**（两者都是 server 的职责）。它只是**按 code 定位腿的
  //    数据源**：哪些腿出现、以什么顺序出现，全看下面那份 `tabOrder`（051 FR-004）。
  const legs: readonly LegResponse[] = table?.legs ?? [];
  // 契约保证三份恒有值；`null` 只出现在「还没有数据」那一档，退空序（见 EMPTY_LEG_TAB_ORDER）。
  const tabOrder: LegTabOrder = table?.tabOrder ?? EMPTY_LEG_TAB_ORDER;
  const intent = table?.intent ?? null;
  // 🚨 契约到手时先把「点击时意图未知」的手点值升格，再解析 —— 否则 loading 期间那一下点击
  //    会被 `resolveLegTab` 当成「意图变了」丢掉（见 promotePick 注释里的真机实证）。
  //    render 期条件 setState 是 React 官方的 derived-state 修正范式：`promoted !== picked`
  //    只在升格那一次成立，随即收敛，不会自激。
  const promoted = promotePick(picked, intent);
  if (promoted !== picked) setPicked(promoted);
  const tab = resolveLegTab(promoted, intent);

  const block = useMemo(
    () =>
      legBlockState(
        { isPending: query.isPending, isError: query.isError, error: query.error },
        table?.state,
      ),
    [query.isPending, query.isError, query.error, table?.state],
  );

  const sections = useMemo(() => legPickerSections(legs, tabOrder, tab), [legs, tabOrder, tab]);

  const setTab = useCallback((next: LegPickerTab) => setPicked({ intent, tab: next }), [intent]);

  const retry = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    table,
    block,
    tab,
    setTab,
    notices: legPickerNotices(table, tab),
    sections,
    total: legRowTotal(sections),
    retry,
  };
}

/**
 * 水位手选写端点（FR-017, plan D-UI-5）。**成功即失效选约表** —— 水位是意图矩阵的一维输入，
 * 它一变，`intent` / `rentDepth` / 每腿的 `tabs` 与 `activityByTab` 全跟着变。
 *
 * 🚨 漏了这次失效，屏幕上会出现最难查的那种不一致：「人工输入」角标亮了、chip 也选中了，
 *    但表还是旧那张（全局 `staleTime 30s` + 详情屏常驻挂载 ⇒ **没有任何触发器**自动重取）。
 *    typecheck 与单测都拦不住它（形状没变，只是数据陈旧）。
 * 📌 只失效选约表 —— 锚列表 / 雷达的可见字段与水位无关，连坐失效是白跑一趟网络。
 */
export function useSetPositionBucket(symbol: string) {
  const queryClient = useQueryClient();
  return useOptionsdeskControllerPositionBucket({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getOptionsdeskControllerLegsQueryKey(symbol),
        });
      },
    },
  });
}
