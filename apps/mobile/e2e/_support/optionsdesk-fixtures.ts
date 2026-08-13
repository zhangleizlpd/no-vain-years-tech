import type {
  LegCriteriaByTabResponse,
  PerspectiveCriteriaResponse,
  RetrievalCriteriaResponse,
} from '@nvy/api-client';

/**
 * 选约表 e2e mock 的共享片段（052 T011）。
 *
 * 🚨 **为什么抽出来而不是三个 spec 各写一份**：`criteriaByTab` 是六维 × 三视角 × 三组字段的
 * 嵌套结构，各写一份就是三份必 drift 的镜像 —— 而 drift 时 typecheck 全绿（形状对、值不同），
 * 只有某一条断言碰巧读到那一维时才露馅。三个既有 `makeLegTable` 本身仍各自持有（它们的腿与
 * 锚数据本就该按各自场景造），这里只共享**与场景无关**的那一块。
 */

/** 一个视角的条件全景：全维度不限 + 三态全 `default`（= 首屏 / 「复位」下发的形态）。 */
export function emptyPerspectiveCriteria(): PerspectiveCriteriaResponse {
  const values: RetrievalCriteriaResponse = {
    strikeMax: null,
    strikeMin: null,
    dteBand: null,
    premiumMin: null,
    openInterestMin: null,
    relativeSpreadMax: null,
  };
  const untouched = { state: 'default' as const, excludedCount: 0 };
  return {
    defaults: values,
    effective: values,
    // 🚨 六维**逐个写出**而非 Partial：漏一维时消费侧读到 `undefined` 会当「不限」渲染出一个
    // 空控件，而 typecheck 不报（Partial 把缺席合法化了）。
    outcomes: {
      strikeMax: untouched,
      strikeMin: untouched,
      dteBand: untouched,
      premiumMin: untouched,
      openInterestMin: untouched,
      relativeSpreadMax: untouched,
    },
  };
}

/** 三视角各一份 —— 契约恒有三份（客户端本地切视角时不发请求）。 */
export function emptyCriteriaByTab(): LegCriteriaByTabResponse {
  return {
    all: emptyPerspectiveCriteria(),
    build: emptyPerspectiveCriteria(),
    rent: emptyPerspectiveCriteria(),
  };
}
