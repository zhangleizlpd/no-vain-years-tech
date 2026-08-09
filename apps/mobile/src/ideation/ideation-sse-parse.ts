// 032 T014 — ideation 澄清 SSE 帧解析纯函数（无状态、无 IO，per 测试分层 vitest=logic）。
// 复用 027 chat sse-parse 范式（帧边界 `\n\n`、`data:` 前缀、`[DONE]` 裸字面）。
//
// 帧契约 SoT = apps/server/src/ideation/clarify-stream（T008 服务端定）：
// - 帧边界 = `\n\n`；每帧形如 `data:<payload>\n\n`。
// - token 帧 payload = JSON `{"token":"..."}`（逐字符 drip 反问文本）。
// - suggestion 帧 payload = JSON `{"suggestion":{NormalizedSuggestion}}`（过两闸才发，整出一帧收口）。
// - DONE 帧 payload = 裸字面 `[DONE]`（非 JSON）→ 先按字面识别，禁 JSON.parse。
// - error 帧 payload = JSON `{"error":"..."}`。
//
// getReader() chunk 边界不保证落在 `\n\n` 上 → 调用方负责把上次 `rest` 拼到下个 chunk 前面。

/** 建议式选项的单个选项（契约 §4.5）。recommended「（推荐）」标 / escapeHatch 末位逃生。 */
export interface SuggestionOption {
  label: string;
  recommended?: boolean;
  escapeHatch?: boolean;
  /** 点选填入草稿的正文（缺省 → 用 label）。「采纳整段推荐」类 chip：label 短、fill 装完整正文。 */
  fill?: string;
}

/** 归一建议式选项（一轮 chips）。multi_select 多选 / allow_freetext 自由文本永驻。 */
export interface NormalizedSuggestion {
  question: string;
  options: SuggestionOption[];
  multi_select: boolean;
  allow_freetext: boolean;
}

/**
 * 034 接地：命中来源单条（`sources` 帧内一项）。relPath + 行号必有；symbol 可选。
 * 形状对齐 server SSE `sources` 帧（plan §4）。
 */
export interface IdeationSource {
  relPath: string;
  startLine: number;
  endLine: number;
  symbol?: string;
}

/** 一个已解析的澄清 SSE 帧（按 `type` 收窄的判别联合）。 */
export type IdeationFrame =
  | { type: 'token'; token: string }
  | { type: 'suggestion'; suggestion: NormalizedSuggestion }
  | { type: 'done' }
  | { type: 'error'; error: string }
  // 034 接地三帧（与上方 token/suggestion/error 字段互不重叠）：
  | { type: 'tool_start'; tool: string } // 检索开始指示（「正在检索代码…」）。
  | { type: 'sources'; sources: IdeationSource[] } // 命中来源（≤5，挂对应 assistant turn）。
  | { type: 'notice'; notice: string }; // 降级系统气泡（FR-008，T011 渲染）。

/** parseIdeationChunk 返回：本次切出的完整帧 + 未闭合的尾部 buffer（调用方下次拼前面）。 */
export interface IdeationParseResult {
  frames: IdeationFrame[];
  rest: string;
}

/**
 * 把（已拼上上次 rest 的）buffer 按 `\n\n` 切帧并解析。复杂度 O(n)，n = buffer 长度。
 *
 * @param buffer 当前累积文本（调用方应传 `上次 rest + 本次 chunk`）。
 * @returns `{frames, rest}` —— frames = 本次闭合的帧；rest = 末尾未闭合片段，下次拼接。
 */
export function parseIdeationChunk(buffer: string): IdeationParseResult {
  const frames: IdeationFrame[] = [];
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
 * 解析单帧文本（已去帧边界）。去 `data:` 前缀后：先判裸 `[DONE]`；否则 JSON.parse 后
 * 按字段判别（`.token` / `.suggestion` / `.error`，互不重叠）。非法 / 未知 payload 返回
 * null（调用方忽略，容错心跳/注释行）。
 */
function parseFrame(segment: string): IdeationFrame | null {
  if (!segment.startsWith('data:')) return null;
  const payload = segment.slice('data:'.length).trimStart();

  if (payload === '[DONE]') return { type: 'done' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null; // 非法 JSON（如心跳/注释），忽略。
  }
  if (parsed === null || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.token === 'string') return { type: 'token', token: obj.token };
  if (typeof obj.error === 'string') return { type: 'error', error: obj.error };
  // 034 接地三帧（字段判别，与 token/error 互不重叠）：
  if (typeof obj.tool_start === 'string') return { type: 'tool_start', tool: obj.tool_start };
  if (typeof obj.notice === 'string') return { type: 'notice', notice: obj.notice };
  if (Array.isArray(obj.sources)) {
    return { type: 'sources', sources: parseSources(obj.sources) };
  }
  if (isNormalizedSuggestion(obj.suggestion)) {
    return { type: 'suggestion', suggestion: obj.suggestion };
  }
  return null;
}

/**
 * 解析 `sources` 帧内每项（畸形项剔除，不崩）。relPath:string + startLine/endLine:number 必有；
 * symbol 可选 string。上限 ≤5（server 已收口，前端再兜底防异常长列表）。
 */
function parseSources(raw: unknown[]): IdeationSource[] {
  const out: IdeationSource[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (
      typeof o.relPath === 'string' &&
      typeof o.startLine === 'number' &&
      typeof o.endLine === 'number'
    ) {
      const src: IdeationSource = {
        relPath: o.relPath,
        startLine: o.startLine,
        endLine: o.endLine,
      };
      if (typeof o.symbol === 'string') src.symbol = o.symbol;
      out.push(src);
    }
    if (out.length >= 5) break; // ≤5 兜底（FR-002）。
  }
  return out;
}

/** suggestion payload 结构校验（防畸形帧崩溃；不满足返回 false → 帧忽略）。 */
function isNormalizedSuggestion(v: unknown): v is NormalizedSuggestion {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.question === 'string' &&
    Array.isArray(o.options) &&
    o.options.every(
      (opt) =>
        opt !== null &&
        typeof opt === 'object' &&
        typeof (opt as { label?: unknown }).label === 'string',
    ) &&
    typeof o.multi_select === 'boolean' &&
    typeof o.allow_freetext === 'boolean'
  );
}
