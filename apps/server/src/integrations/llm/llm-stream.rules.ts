/**
 * llm-stream.rules.ts (030 A1 T018) — OpenAI 兼容 provider 的流式解析纯函数。
 *
 * DeepSeek 与 MiniMax M3 都是 OpenAI 兼容端点, 流式 tool_calls 累加 + `Msg[]`→API messages
 * 映射逻辑**完全一致** —— 抽到此共享 `*.rules.ts`(ADR-0043 纯函数)避免两 provider 各持一份
 * 漂移。`createThinkStripper` 为 MiniMax adaptive 模式新增(把推理内联进 `content` 的
 * `<think>…</think>` 流式剥离), DeepSeek 不用但同属流式解析逻辑, 一并归此。
 */
import OpenAI from 'openai';
import type { Msg, MsgPart, ToolCall } from './llm-provider.port.js';

/**
 * content union → 纯文本提取 (036 T004): string 原样返回; `MsgPart[]` 仅拼接 `text` part
 * (image_url 不计入)。token 估算 / content-driven 关键字匹配等只关心文本的调用方用此,
 * 避免各处自行 `typeof` 分支漂移。
 */
export function msgText(content: string | MsgPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<MsgPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/**
 * 流式 tool_call 分片的结构子集(vendor-agnostic) —— OpenAI `delta.tool_calls[i]` 结构兼容,
 * 但不直接耦合 SDK 类型, 便于纯函数测试。
 */
export interface StreamedToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** 流式累加中的单个 tool_call 草稿(按 index 聚合, arguments 分片拼接)。 */
export interface ToolCallDraft {
  id: string;
  name: string;
  args: string;
}

/**
 * 累加一个流式 tool_call 分片到 drafts(按 index 聚合):`id` / `function.name` 取首次出现,
 * `function.arguments` 逐片**拼接**(OpenAI 流式 tool_calls 协议:arguments 分多 chunk 吐)。
 */
export function accumulateToolCall(
  drafts: Map<number, ToolCallDraft>,
  tc: StreamedToolCallDelta,
): void {
  const index = tc.index;
  const draft = drafts.get(index) ?? { id: '', name: '', args: '' };
  if (tc.id) draft.id = tc.id;
  if (tc.function?.name) draft.name = tc.function.name;
  if (tc.function?.arguments) draft.args += tc.function.arguments;
  drafts.set(index, draft);
}

/** drafts(按 index 升序)→ ToolCall[]; id 缺失兜底 `call_<index>`。 */
export function draftsToToolCalls(drafts: Map<number, ToolCallDraft>): ToolCall[] {
  return [...drafts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, d]) => ({
      id: d.id || `call_${index}`,
      type: 'function' as const,
      function: { name: d.name, arguments: d.args },
    }));
}

/**
 * user content union → OpenAI 形态 (036 T004): string 原样维持旧映射 (零回归);`MsgPart[]`
 * 原样透传为 OpenAI vision content parts (本 MsgPart 结构与 SDK `ChatCompletionContentPart`
 * 兼容,贫血透传)。**仅 user 轮可携带 image** —— OpenAI 类型上 assistant/system/tool content
 * 不接受 image part (assistant 仅 text/refusal),且我们带图 turn 只在 user 注入,故其余角色
 * 一律经 `msgText` 收敛为 string (纯文本恒等)。
 */
function toApiUserContent(
  content: string | MsgPart[],
): string | OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  if (typeof content === 'string') return content;
  return content as OpenAI.Chat.Completions.ChatCompletionContentPart[];
}

/**
 * Msg[] → OpenAI chat messages(030 D3): 透传 tool/system 角色 + assistant.toolCalls +
 * tool.toolCallId。贫血映射, 与 SDK 类型对齐。DeepSeek / MiniMax 共用。
 *
 * 036 T004: **user content** 为 `MsgPart[]` 时原样透传 OpenAI vision content parts (带图轮);
 * 为 string 时维持旧形状 (纯文本零回归)。assistant/system/tool content 必为 string (SDK 要求
 * + 我们仅在 user 注图),防御性经 `msgText` 收敛 (纯文本恒等于原 string)。
 */
export function toApiMessages(
  messages: Msg[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: msgText(m.content), tool_call_id: m.toolCallId ?? '' };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: msgText(m.content),
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      };
    }
    if (m.role === 'system') {
      return { role: 'system', content: msgText(m.content) };
    }
    if (m.role === 'assistant') {
      return { role: 'assistant', content: msgText(m.content) };
    }
    return { role: 'user', content: toApiUserContent(m.content) };
  });
}

// --- <think>…</think> 流式剥离 (030 A1: MiniMax adaptive 把推理内联进 content) ---

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** s 末尾能作为 tag **真前缀**的最长后缀长度(用于判断 chunk 边界处可能被截断的标签)。 */
function partialTagSuffixLen(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (tag.startsWith(s.slice(s.length - k))) return k;
  }
  return 0;
}

/**
 * 跨 chunk 缓冲的 `<think>…</think>` 剥离状态机。MiniMax M3 `thinking:adaptive` 会把推理
 * 文本内联进流式 `content`, 且标签会被**拆在 chunk 边界**(PoC 实证如 `"I shoulduse"`)。
 * `push` 喂入一段 content 分片, 返回应吐给用户的**可见正文**(think 内容被吞);流结束调
 * `flush` 取回缓冲尾部(未闭合 think → 丢弃;未完成的开标签 → 当字面量吐出)。
 */
export interface ThinkStripper {
  push(fragment: string): string;
  flush(): string;
}

export function createThinkStripper(): ThinkStripper {
  let inThink = false;
  let pending = '';

  function drain(final: boolean): string {
    let out = '';
    for (;;) {
      if (!inThink) {
        const i = pending.indexOf(THINK_OPEN);
        if (i !== -1) {
          out += pending.slice(0, i);
          pending = pending.slice(i + THINK_OPEN.length);
          inThink = true;
          continue;
        }
        if (final) {
          out += pending;
          pending = '';
          break;
        }
        // 无完整开标签: 吐出除「可能被截断的开标签后缀」外的全部, 后缀留待下次。
        const keep = partialTagSuffixLen(pending, THINK_OPEN);
        out += pending.slice(0, pending.length - keep);
        pending = keep > 0 ? pending.slice(pending.length - keep) : '';
        break;
      }
      const i = pending.indexOf(THINK_CLOSE);
      if (i !== -1) {
        // 丢弃 think 内容直到闭标签(含)后。
        pending = pending.slice(i + THINK_CLOSE.length);
        inThink = false;
        continue;
      }
      if (final) {
        pending = '';
        break;
      }
      // think 中: 丢弃全部, 仅留可能被截断的闭标签后缀。
      const keep = partialTagSuffixLen(pending, THINK_CLOSE);
      pending = keep > 0 ? pending.slice(pending.length - keep) : '';
      break;
    }
    return out;
  }

  return {
    push: (fragment: string) => {
      pending += fragment;
      return drain(false);
    },
    flush: () => drain(true),
  };
}
