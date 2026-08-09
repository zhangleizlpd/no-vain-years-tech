/**
 * SSE 帧序列化不变量 —— 无状态纯函数 (per ADR-0043 §2 贫血 + 纯函数)。
 *
 * chat 流式端点 (plan D3 / spec FR-003) 的 server 端帧编码契约。复用于 controller (T007)
 * `reply.raw.write(...)`,与 mobile 解析 (T010 `sse-parse.ts`) 双向对齐。纯函数,无 DB / 无 side effect。
 *
 * 帧约定 (SSE `text/event-stream`):
 * - **帧边界 = `\n\n`**;每帧形如 `data:<payload>\n\n`。
 * - **token 帧** payload = JSON 对象 `{"token":"..."}` —— token 文本经 `JSON.stringify` 转义,
 *   token 内含的换行/引号/反斜杠不会破坏帧边界 `\n\n`,解析端 `JSON.parse(payload).token` 还原原文。
 *   选 `{token}` 对象形状 (非裸字符串 JSON):语义自描述 + 留扩展位,mobile 解析读 `.token`。
 * - **DONE 帧** = `SSE_DONE` 哨兵,payload 为**裸字面 `[DONE]`** (非 JSON);解析端按字面识别流结束。
 * - **error 帧** payload = JSON 对象 `{"error":"..."}` (plan D3 失败分支);message 同样 JSON 转义。
 *   provider 失败时 controller 写出本帧让客户端展示错误态 (AI message 不落,FR-009)。
 *
 * 030 联网工具帧 (plan D5) —— **向后兼容扩展**:token/DONE/error 帧**不变** (027 契约稳定),
 * 新增 4 类帧靠 **payload 字段判别** (`tool` / `degraded` / `sources`), 与 token 帧 `.token`、
 * error 帧 `.error` 字段不重叠 → 解析端按字段分派, 不冲突。
 * - **tool_start 帧** `{"tool":"web_search","status":"start","query":"..."}` —— 模型自决检索开始。
 * - **tool_result 帧** `{"tool":"web_search","status":"result","count":N,"sources":[{title,url}]}`
 *   —— 一轮检索完成 (count=原始页数, sources=摘要供「已阅读 N」中间态)。
 * - **degraded 帧** `{"degraded":true}` —— 检索失败降级 (FR-009), 客户端标「本次未联网」。
 * - **sources 帧** `{"sources":[{index,title,url,publishedAt?}]}` —— 收尾前完整编号来源,
 *   供客户端 [N]→源映射 (FR-007)。
 */
import type { NumberedSource } from './web-search.rules.js';

/** 流正常结束哨兵帧。payload 为裸 `[DONE]` 字面 (非 JSON),与 token/error 帧的 JSON payload 区分。 */
export const SSE_DONE = 'data:[DONE]\n\n';

/**
 * token 增量帧:把单个 token 文本包成 `data:{"token":"..."}\n\n`。
 * token 经 `JSON.stringify` 转义 —— 内含换行/引号/反斜杠/多字节字符均安全,
 * 解析端去 `data:` 前缀后 `JSON.parse(...).token` 还原。复杂度 O(n),n = token 字符数。
 */
export function toSseFrame(token: string): string {
  return `data:${JSON.stringify({ token })}\n\n`;
}

/**
 * error 帧:把错误描述包成 `data:{"error":"..."}\n\n` (plan D3 provider 失败分支)。
 * message 经 `JSON.stringify` 转义,同 token 帧防破坏帧边界。复杂度 O(n),n = message 字符数。
 */
export function toSseErrorFrame(message: string): string {
  return `data:${JSON.stringify({ error: message })}\n\n`;
}

/**
 * tool_start 帧:模型自决发起一轮 `web_search` 检索时写出。
 * `query` 经 `JSON.stringify` 转义,内含换行/引号/多字节均安全。复杂度 O(n),n=query 字符数。
 */
export function toSseToolStartFrame(input: { query: string }): string {
  return `data:${JSON.stringify({ tool: 'web_search', status: 'start', query: input.query })}\n\n`;
}

/**
 * tool_result 帧:一轮检索完成时写出。`count` = 本轮原始页数 (贴「已阅读 N 个网页」中间态语义);
 * `sources` = 摘要 (仅 title/url,供中间态展示,非完整编号来源)。整体 `JSON.stringify` 转义。
 * 复杂度 O(s),s=sources 总字符数。
 */
export function toSseToolResultFrame(input: {
  count: number;
  sources: { title: string; url: string }[];
}): string {
  return `data:${JSON.stringify({
    tool: 'web_search',
    status: 'result',
    count: input.count,
    sources: input.sources,
  })}\n\n`;
}

/**
 * degraded 帧:检索失败降级 (FR-009) 时写出固定 payload,客户端据此标「本次未联网」。
 * 无参 —— 降级是布尔态,具体原因不下发客户端。
 */
export function toSseDegradedFrame(): string {
  return `data:${JSON.stringify({ degraded: true })}\n\n`;
}

/**
 * sources 帧:收尾 (SSE_DONE 前) 写出完整编号来源,供客户端 [N]→源映射 + 来源列表渲染 (FR-007)。
 * 与 `Message.metadata.sources` 同构 (`NumberedSource[]`)。整体 `JSON.stringify` 转义。
 * 复杂度 O(s),s=sources 总字符数。
 */
export function toSseSourcesFrame(sources: NumberedSource[]): string {
  return `data:${JSON.stringify({ sources })}\n\n`;
}
