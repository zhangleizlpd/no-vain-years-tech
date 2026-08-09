// 027 T010 — SSE 帧解析纯函数（无状态、无 IO，per 测试分层 vitest=logic）。
//
// 帧契约 SoT = apps/server/src/chat/sse.rules.ts（双向对齐）：
// - 帧边界 = `\n\n`；每帧形如 `data:<payload>\n\n`。
// - token 帧 payload = JSON 对象 `{"token":"..."}`（server JSON.stringify 转义，内含
//   换行/引号不破坏帧边界）。
// - DONE 帧 payload = **裸字面 `[DONE]`**（非 JSON）→ 先按字面识别，禁对其 JSON.parse。
// - error 帧 payload = JSON 对象 `{"error":"..."}`。
//
// getReader() 的 chunk 边界不保证落在 `\n\n` 上 → 调用方负责把上次的 `rest` 拼到
// 下个 chunk 前面再传入。本函数只切「已闭合」帧，未闭合尾部原样回 `rest`。
//
// 030 联网工具帧（plan D5）—— **向后兼容扩展**：token/DONE/error 帧解析**不变**（027 契约稳定），
// 新增 4 类帧靠 **payload 字段判别**（`tool` / `degraded` / `sources`），与 token 帧 `.token`、
// error 帧 `.error` 字段不重叠 → 按字段分派不冲突。帧契约 SoT = apps/server/src/chat/sse.rules.ts。

/** tool_result 帧携带的摘要来源（仅 title/url，供「已阅读 N」中间态，非完整编号来源）。 */
export interface ToolResultSource {
  title: string;
  url: string;
}

/** sources 帧携带的完整编号来源（与 orval ChatSourceResponse 同构，供 [N]→源映射）。 */
export interface NumberedSource {
  index: number;
  title: string;
  url: string;
  publishedAt?: number | null;
}

/**
 * 一个已解析的 SSE 帧。027 token/done/error + 030 工具帧（tool_start/tool_result/degraded/sources）
 * 的判别联合（discriminated union），按 `type` 收窄。
 */
export type ParsedFrame =
  | { type: 'token'; token: string }
  | { type: 'done' }
  | { type: 'error'; error: string }
  | { type: 'tool_start'; query: string }
  | { type: 'tool_result'; count: number; sources: ToolResultSource[] }
  | { type: 'degraded' }
  | { type: 'sources'; sources: NumberedSource[] };

/** parseSseChunk 返回：本次切出的完整帧 + 未闭合的尾部 buffer（调用方下次拼前面）。 */
export interface ParseResult {
  frames: ParsedFrame[];
  rest: string;
}

/**
 * 把（已拼上上次 rest 的）buffer 按 `\n\n` 切帧并解析。复杂度 O(n)，n = buffer 长度。
 *
 * @param buffer 当前累积文本（调用方应传 `上次 rest + 本次 chunk`）。
 * @returns `{frames, rest}` —— frames = 本次闭合的帧；rest = 末尾未闭合片段，下次拼接。
 */
export function parseSseChunk(buffer: string): ParseResult {
  const frames: ParsedFrame[] = [];
  // 按帧边界切分；最后一段是未闭合尾部（buffer 不以 \n\n 结尾时非空）。
  const segments = buffer.split('\n\n');
  const rest = segments.pop() ?? '';

  for (const segment of segments) {
    if (segment.length === 0) continue; // 连续 \n\n 或前导空段，跳过。
    const frame = parseFrame(segment);
    if (frame) frames.push(frame);
  }

  return { frames, rest };
}

/**
 * 解析单帧文本（已去帧边界）。去 `data:` 前缀后按契约判别：
 * 先判裸 `[DONE]` → done；否则 JSON.parse，有 `.token` → 增量、有 `.error` → 错误。
 * 非法 / 未知 payload 返回 null（调用方忽略，容错非法心跳/注释行）。
 */
function parseFrame(segment: string): ParsedFrame | null {
  if (!segment.startsWith('data:')) return null;
  const payload = segment.slice('data:'.length).trimStart();

  // DONE 哨兵：裸字面，绝不 JSON.parse。
  if (payload === '[DONE]') return { type: 'done' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null; // 非法 JSON（如心跳/注释），忽略。
  }
  if (parsed === null || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;
  // 027 帧（契约稳定，先判）：token / error。
  if (typeof obj.token === 'string') return { type: 'token', token: obj.token };
  if (typeof obj.error === 'string') return { type: 'error', error: obj.error };
  // 030 工具帧（按 payload 字段判别，与上面字段不重叠）。
  if (obj.tool === 'web_search') return parseToolFrame(obj);
  if (obj.degraded === true) return { type: 'degraded' };
  if (Array.isArray(obj.sources))
    return { type: 'sources', sources: obj.sources as NumberedSource[] };
  return null;
}

/**
 * 解析 `web_search` 工具帧（`status` 二选一）：
 * - `start`  → tool_start（携 query）；
 * - `result` → tool_result（携 count 原始页数 + sources 摘要）。
 * 未知 status 返回 null（忽略，前向兼容 server 后续扩展）。
 */
function parseToolFrame(obj: Record<string, unknown>): ParsedFrame | null {
  if (obj.status === 'start' && typeof obj.query === 'string') {
    return { type: 'tool_start', query: obj.query };
  }
  if (obj.status === 'result' && typeof obj.count === 'number' && Array.isArray(obj.sources)) {
    return { type: 'tool_result', count: obj.count, sources: obj.sources as ToolResultSource[] };
  }
  return null;
}
