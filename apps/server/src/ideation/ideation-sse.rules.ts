/**
 * Ideation 澄清流式下行 SSE 帧序列化 —— 无状态纯函数 (per ADR-0043 §2 贫血 + 纯函数)。
 *
 * 🚨 **不 import chat `sse.rules.ts`** (ADR-0055 范式复用 ≠ 代码 import; chat 帧含
 * web_search 专属 tool/sources 字段, 与 ideation 两相剧本无关)。按 chat `sse.rules.ts`
 * 结构**重写** ideation 自己的下行帧契约。纯函数, 无 DB / 无 side effect。
 *
 * 帧约定 (SSE `text/event-stream`, 与 mobile T014 解析双向对齐):
 * - **帧边界 = `\n\n`**; 每帧形如 `data:<payload>\n\n`。
 * - **token 帧** `{"token":"..."}` —— 提问步 (`ask_clarifying_question`) 的 `question`
 *   文本**逐帧流式** drip (契约 doc §4.7「question 文本可逐字渲」); 文本经 JSON.stringify
 *   转义, 内含换行/引号不破坏帧边界。
 * - **suggestion 帧** `{"suggestion":{...}}` —— chips/选项 **JSON 收口整出**一帧 (非逐字,
 *   契约 doc §4.7「chips 等 JSON 收口再整体出现」); payload 是归一化后的 `NormalizedSuggestion`
 *   (question/options/multi_select/allow_freetext)。两闸未过的轮**不发**此帧 (纯文本问题)。
 * - **DONE 帧** = `IDEATION_SSE_DONE` 哨兵, payload 为裸字面 `[DONE]` (非 JSON), 标流结束。
 * - **error 帧** `{"error":"..."}` —— provider 失败 (非 abort) 时写出 (契约 doc §4.3 /
 *   FR-010); assistant turn **不落** (split-tx, FR-010), 客户端展示错误态 + 重试。
 * - **tool_start 帧** `{"tool_start":"codeindex_retrieval"}` —— 接地检索发起指示 (034 FR-013,
 *   plan §Architecture Notes #4); 复用 030 chat tool_start 语义但**自有实现不 import** (ADR-0055)。
 * - **sources 帧** `{"sources":[{relPath,startLine,endLine,symbol?}...]}` —— 命中来源 JSON 收口
 *   整出一帧 (034 FR-002, **折叠上限 ≤5**); 每条仅出处坐标 (不含 chunk text)。
 * - **notice 帧** `{"notice":"grounding_degraded"}` —— 接地降级系统气泡 (034 FR-008); 端口不可达
 *   时与空命中严格分流 (FR-009), 仅气泡提示不阻断整轮。
 *
 * 字段判别: token 帧 `.token` / suggestion 帧 `.suggestion` / error 帧 `.error` /
 * tool_start 帧 `.tool_start` / sources 帧 `.sources` / notice 帧 `.notice` 互不重叠,
 * 解析端按字段分派 (前端 union 变体靠字段名判别)。
 */
import type { NormalizedSuggestion } from './suggestion-gate.rules.js';

/** 流正常结束哨兵帧。payload 为裸 `[DONE]` 字面 (非 JSON)。 */
export const IDEATION_SSE_DONE = 'data:[DONE]\n\n';

/**
 * token 增量帧: 把单段 `question` token 文本包成 `data:{"token":"..."}\n\n`。
 * 文本经 JSON.stringify 转义 (换行/引号/多字节安全), 解析端 `JSON.parse(payload).token`
 * 还原。复杂度 O(n), n = token 字符数。
 */
export function toSseTokenFrame(token: string): string {
  return `data:${JSON.stringify({ token })}\n\n`;
}

/**
 * suggestion 帧: chips/选项 JSON **收口整出**一帧 (契约 doc §4.7)。payload = 归一化后的
 * `NormalizedSuggestion`。两闸过且非第一问才写 (调用方决定); 纯文本问题不写本帧。
 * 整体 JSON.stringify 转义。复杂度 O(s), s = suggestion 总字符数。
 */
export function toSseSuggestionFrame(suggestion: NormalizedSuggestion): string {
  return `data:${JSON.stringify({ suggestion })}\n\n`;
}

/**
 * error 帧: provider 失败 (非 abort) 时写出 `data:{"error":"..."}\n\n` (契约 doc §4.3 /
 * FR-010)。assistant turn 不落半截。message 经 JSON.stringify 转义。复杂度 O(n)。
 */
export function toSseErrorFrame(message: string): string {
  return `data:${JSON.stringify({ error: message })}\n\n`;
}

/** 接地检索发起指示帧固定标识 (复用 030 chat tool_start 语义)。 */
export const CODEINDEX_RETRIEVAL_TOOL_NAME = 'codeindex_retrieval';

/** 接地降级 notice 固定标识 (FR-008; 前端据此渲一次性系统气泡)。 */
export const GROUNDING_DEGRADED_NOTICE = 'grounding_degraded';

/** 接地检索上限默认 ≤5 (FR-002 来源折叠 / Clarifications)。 */
export const MAX_SSE_SOURCES = 5;

/**
 * 单条来源出处坐标 (sources 帧 payload 元素)。形状 = 命中代码块的**出处坐标子集**
 * (无 chunk text)。`symbol` 可空则**省略**该键 (与既有可选字段处理一致, 见
 * `toSseSourcesFrame` 内 omit 逻辑)。T003 来源映射 / mobile 解析端复用此形状。
 */
export interface SseSourceRef {
  relPath: string;
  startLine: number;
  endLine: number;
  /** chunk 符号名 (整文件块可空; 空则序列化时省略本键)。 */
  symbol?: string;
}

/**
 * tool_start 帧: 接地检索发起指示, 固定 `data:{"tool_start":"codeindex_retrieval"}\n\n`
 * (034 FR-013)。无入参 (本期唯一接地工具)。判别键 `.tool_start` 与既有帧互不重叠。
 * 复杂度 O(1)。
 */
export function toSseToolStartFrame(): string {
  return `data:${JSON.stringify({ tool_start: CODEINDEX_RETRIEVAL_TOOL_NAME })}\n\n`;
}

/**
 * sources 帧: 命中来源 JSON **收口整出**一帧 (034 FR-002)。**截断 ≤5** (`MAX_SSE_SOURCES`,
 * 超出丢弃尾部); 每条只取 `{relPath, startLine, endLine, symbol?}` —— `symbol` 为
 * null/undefined 时**省略**该键 (避免前端拿到 null 误判)。整体 JSON.stringify 转义
 * (relPath 含引号/换行不破坏帧边界)。复杂度 O(min(n,5))。
 */
export function toSseSourcesFrame(sources: readonly SseSourceRef[]): string {
  const trimmed = sources.slice(0, MAX_SSE_SOURCES).map((s) => {
    const ref: SseSourceRef = {
      relPath: s.relPath,
      startLine: s.startLine,
      endLine: s.endLine,
    };
    // symbol 可空 → 仅非空时落键 (既有可选字段「缺省即省略」习惯)。
    if (s.symbol != null) ref.symbol = s.symbol;
    return ref;
  });
  return `data:${JSON.stringify({ sources: trimmed })}\n\n`;
}

/**
 * notice 帧: 接地降级系统气泡 (034 FR-008)。payload `{"notice":"grounding_degraded"}`;
 * notice 文本经 JSON.stringify 转义。端口不可达 (throw) 时发本帧 + 视空命中续问,
 * **不** abort/error 整轮 (与 error 帧语义区分)。复杂度 O(n)。
 */
export function toSseNoticeFrame(notice: string): string {
  return `data:${JSON.stringify({ notice })}\n\n`;
}
