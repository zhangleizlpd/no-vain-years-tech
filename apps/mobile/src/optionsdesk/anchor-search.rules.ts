// 074 T006 — 锚搜索浮层结果区的五态纯判定（FR-009 / FR-010; plan D8; sb 1/4/7）。
//
// 抽成纯函数的理由：「空输入 ≠ 零命中」「失败不关浮层」这类互斥分支散在 JSX 三元里
// 既没有单点可验，也验不出「空输入 ∧ isError」那格 —— 而那格正是「没搜过 ≠ 搜不到」
// 的分辨点。这里是唯一判定处，`anchor-search-sheet.tsx` 只 switch 渲染（T008）。

/** 结果区五态。浮层壳（搜索框 / 取消）不在此判定内 —— 五态只管结果区渲染什么。 */
export type SearchSheetState = 'idle' | 'loading' | 'hits' | 'empty' | 'error';

export interface SearchSheetStateInput {
  /** 防抖后的检索词（组件层 debounce 时已 trim；这里再 trim 一次兜底，判据 = 有没有效输入）。 */
  debouncedQ: string;
  /** 当前防抖词的请求是否在途（react-query `isFetching`）。 */
  isFetching: boolean;
  /** 当前防抖词的请求是否失败（react-query `isError`）。 */
  isError: boolean;
  /** 已落地响应的命中行数；尚无响应时给 0。 */
  itemCount: number;
}

/**
 * 判定序是语义不是巧合：
 *  1. 空输入恒 `idle` —— **即使 isError / 零命中**（sb-1：没搜过 ≠ 搜不到；FR-009
 *     「空输入 MUST NOT 显示空态」，旧请求的失败也不许在没搜过时呈现）。
 *  2. 在途压过一切非 idle 态：重试在途要看得见在转（sb-7 的可重试半边），换词在途
 *     不许把上个词的命中当本词的结果闪回（sb-2 的判定半边）。
 *  3. 失败压过命中/空：`error` 行 + 重试（sb-7），缓存残留的 itemCount 不参与。
 *  4. 余下按命中数二分：`hits` / `empty`（sb-4 显式空态）。
 */
export function searchSheetState({
  debouncedQ,
  isFetching,
  isError,
  itemCount,
}: SearchSheetStateInput): SearchSheetState {
  if (debouncedQ.trim().length === 0) return 'idle';
  if (isFetching) return 'loading';
  if (isError) return 'error';
  return itemCount > 0 ? 'hits' : 'empty';
}
