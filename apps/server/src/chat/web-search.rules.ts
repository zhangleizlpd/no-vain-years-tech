/**
 * 联网检索纯逻辑不变量 —— 无状态纯函数 (per ADR-0043 §2 贫血 + 纯函数)。
 *
 * 030 ReAct loop (plan D4) 的 server 端无 DB 逻辑:来源去重+全局编号 (FR-006)、`web_search`
 * tool-def 常量 (喂 LlmProvider, FR-002)、top-K 截取 (控 context 预算)。纯函数,无 DB / 无 side effect,
 * vitest 直测。编排 (多轮 loop / 调 SearchProvider) 在 `send-message.usecase`,不在此。
 */
import type { SearchResult } from './search-provider.port.js';

/** 默认每次检索喂回模型的 top-K 条数 (plan 调参:控 context 预算, IQS 默认返 10/page)。 */
export const DEFAULT_TOP_K = 5;

/**
 * 编号后的引用来源 (落 `Message.metadata.sources`, FR-007 持久化形状)。
 * `index` 全局唯一稳定 (1-based, 跨多轮检索不串号);`content`/`snippet` 不入持久化 (瞬态,仅喂模型)。
 */
export interface NumberedSource {
  index: number;
  title: string;
  url: string;
  publishedAt?: number;
}

/**
 * `web_search` 工具定义 (OpenAI function-calling 兼容形状, FR-002 模型自决检索)。
 * `query` 必填;`time_range` 可选 (时效过滤,模型按问题时效性自决传)。
 * 作为常量导出 → send-message 联网分支附给 `LlmProvider.stream({ tools })`。
 */
export const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      '联网检索实时网页以回答时效性/实时性问题 (天气、新闻、行情、今日/最近事件等)。' +
      '稳定常识或寒暄无需检索。返回带标题/链接/摘要的网页结果,据此作答并标注来源。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索关键词,应精炼且聚焦待查的实时信息',
        },
        time_range: {
          type: 'string',
          enum: ['NoLimit', 'OneDay', 'OneWeek', 'OneMonth', 'OneYear'],
          description: '可选的时效范围过滤;默认 NoLimit (不限时间)',
        },
      },
      required: ['query'],
    },
  },
} as const;

/**
 * 截取 top-K 检索结果 (控喂回模型的 context 预算)。k<=0 或省略 → 默认 5;k>=len → 原样返回。
 * 不修改入参 (返回新数组切片)。复杂度 O(k)。
 */
export function topK(results: SearchResult[], k: number = DEFAULT_TOP_K): SearchResult[] {
  const limit = k > 0 ? k : DEFAULT_TOP_K;
  return results.slice(0, limit);
}

/**
 * 把新一轮检索结果并入已累计来源:**同 URL 去重** (已存在则丢弃新的, 保留原编号 → 稳定不串号),
 * 新 URL 追加并赋下一个全局唯一编号 (1-based, 按出现顺序)。FR-006 核心。
 *
 * - 入参 `existing` 不被修改 (返回新数组);多轮调用把上轮返回值传回作 `existing` 累积。
 * - `incoming` 内部自带重复 URL → 仅首次纳入 (后续同 URL 跳过)。
 * - 顺序:`existing` 在前 (编号已定), 新来源按 `incoming` 出现序追加。
 *
 * 复杂度 O(m+n),m=existing 长度,n=incoming 长度 (用 Set 查重)。
 */
export function dedupAndNumber(
  existing: NumberedSource[],
  incoming: SearchResult[],
): NumberedSource[] {
  const seen = new Set(existing.map((s) => s.url));
  const merged = [...existing];
  let nextIndex = existing.length;
  for (const r of incoming) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    nextIndex += 1;
    merged.push({
      index: nextIndex,
      title: r.title,
      url: r.url,
      ...(r.publishedAt !== undefined ? { publishedAt: r.publishedAt } : {}),
    });
  }
  return merged;
}
