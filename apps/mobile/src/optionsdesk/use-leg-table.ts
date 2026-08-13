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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import {
  getOptionsdeskControllerLegsQueryKey,
  useOptionsdeskControllerLegs,
  useOptionsdeskControllerPositionBucket,
  type LegResponse,
  type LegTableResponse,
  type OptionsdeskControllerLegsParams,
  type PerspectiveCriteriaResponse,
} from '@nvy/api-client';

import {
  criteriaQueryParams,
  normalizeCriteriaForm,
  type CriteriaForm,
} from './leg-criteria.rules';
import {
  EMPTY_LEG_TAB_ORDER,
  legPickerNotices,
  legPickerSections,
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

/** 某视角**已提交**的覆盖 —— 表单（抽屉重开时回填）与它编译出的请求参数一起存。 */
interface SubmittedCriteria {
  readonly form: CriteriaForm;
  readonly params: OptionsdeskControllerLegsParams;
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
  /** 当前视角的条件全景（控件填 `defaults`、计数看 `outcomes`）。契约未到手 ⇒ `null`。 */
  criteria: PerspectiveCriteriaResponse | null;
  /** 当前视角**已提交**的覆盖值（抽屉重开时回填草稿）；未覆盖 ⇒ `null`。 */
  submittedCriteria: CriteriaForm | null;
  /** 「搜」—— 提交当前视角的条件（值回到默认 ⇒ 等价于复位）。 */
  submitCriteria: (form: CriteriaForm) => void;
  /** 「复位」—— 当前视角回系统默认值（请求不带任何条件）。 */
  resetCriteria: () => void;
  retry: () => void;
}

export function useLegTable(symbol: string): UseLegTableResult {
  // 🚨 **每视角各自持有自己的条件状态**（FR-015）—— 切视角看到的是**那个视角**的值，
  //    上一个视角的覆盖既不带走、也不丢弃（2026-08-13 user 定：各自留存）。
  // 🚫 MUST NOT 做成一份全局条件：覆盖只作用当前视角（T010 裁定），全局一份会让「在收租设的
  //    上界」把建仓也收窄，而建仓控件仍显示自己的默认值 —— 控件与数据不匹配且无从解释。
  // 📌 不持久化（FR-014）：状态只活在本 hook 的 state 里，离屏卸载即回默认值。
  const [criteriaByTab, setCriteriaByTab] = useState<
    Partial<Record<LegPickerTab, SubmittedCriteria>>
  >({});
  // 生效参数 —— 由下面那条 effect 与「当前视角」同步（解析视角需要 intent，而 intent 来自
  // 响应本身 ⇒ 参数只能滞后一拍；`keepPreviousData` 让这一拍无感）。
  const [activeParams, setActiveParams] = useState<OptionsdeskControllerLegsParams | undefined>(
    undefined,
  );
  // 第二参 = 检索条件的用户覆盖（052 FR-012）；`undefined` = 首屏 /「复位」⇒ 三视角全走默认值。
  // 📌 条件值一进这里就自动进 query key（orval 生成的 key 含 params）⇒ 每视角各自持有状态
  // （FR-015）是**结构保证**，不需要手写隔离；换视角就是换 key，回来时走缓存。
  // 🚨 `keepPreviousData` **不是体验糖，摘掉它整块屏当场炸**（052 T013 反例探针实测）：
  //    换 key 那一拍 `data` 变 undefined ⇒ `intent` 变 null ⇒ `resolveLegTab` 退回「全腿」⇒
  //    上面那条 effect 把参数换成全腿的 ⇒ `intent` 回来 ⇒ 又换回去……这一圈**全是同步的
  //    setState，跑赢了网络**：任何响应落地之前就撞到 React 的更新深度上限，页面被 error
  //    boundary 接住（React error #185「Maximum update depth exceeded」，e2e 里 6 条红）。
  //    留着它，解析出的视角在换 key 期间保持稳定，环从源头不成立。
  const query = useOptionsdeskControllerLegs(symbol, activeParams, {
    query: {
      enabled: symbol.length > 0,
      retry: retryUnlessNoAnchor,
      placeholderData: keepPreviousData,
    },
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
  const tab = resolveLegTab(picked, intent);

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

  const criteria = table?.criteriaByTab[tab] ?? null;
  const submitted = criteriaByTab[tab] ?? null;

  // 🚨 生效参数恒等于**当前视角**的那一份 —— 手点切视角、以及水位改变后意图让位那条路径
  //    （`resolveLegTab` 自己变的，没有回调可挂）都要跟上。跟不上就是「控件显示 A 的值、
  //    表却是按 B 的条件召回的」，而那个不一致在界面上无从解释。
  // 📌 存的是 params **对象引用**（只在提交 / 复位时重建）⇒ 这里比引用即可，不必深比。
  useEffect(() => {
    const next = criteriaByTab[tab]?.params;
    if (next !== activeParams) setActiveParams(next);
  }, [tab, criteriaByTab, activeParams]);

  const submitCriteria = useCallback(
    (form: CriteriaForm) => {
      const normalized = normalizeCriteriaForm(form);
      // 🚫 未改动的维度不下发（缺键 = 未覆盖）；全部回到默认值 ⇒ 无参数 = 等价于复位。
      const params = criteriaQueryParams(tab, normalized, criteria?.defaults ?? null);
      setCriteriaByTab((prev) => {
        const next = { ...prev };
        if (params === undefined) delete next[tab];
        else next[tab] = { form: normalized, params };
        return next;
      });
    },
    [tab, criteria],
  );

  const resetCriteria = useCallback(() => {
    setCriteriaByTab((prev) => {
      const next = { ...prev };
      delete next[tab];
      return next;
    });
  }, [tab]);

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
    criteria,
    submittedCriteria: submitted?.form ?? null,
    submitCriteria,
    resetCriteria,
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
