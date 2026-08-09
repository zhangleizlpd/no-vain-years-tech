import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type { DeepseekConfig } from '../../config/index.js';
import type {
  Msg,
  ToolCall,
  LlmProvider,
  LlmStreamEvent,
  LlmStreamOptions,
} from './llm-provider.port.js';
import {
  accumulateToolCall,
  draftsToToolCalls,
  toApiMessages,
  type ToolCallDraft,
} from './llm-stream.rules.js';

/**
 * DeepseekProvider (027 T005, plan D7;030 T004 扩 tool calling) — 生产默认 `LlmProvider`
 * 实现。
 *
 * DeepSeek OpenAI 兼容: 复用官方 `openai` SDK,仅换 `baseURL` (`https://api.deepseek.com`)。
 * `chat.completions.create({stream:true}, {signal})` 返回 `Stream<ChatCompletionChunk>`
 * (AsyncIterable),逐 chunk 取 `delta.content` 吐 `{kind:'token'}`。`opts.signal` 透传 SDK
 * request options → abort 时中断上游 HTTP (止付 token,停止/断连语义)。
 *
 * 030 D3 tool calling:
 * - 调用方传 `opts.tools` → 透传 `tools` + `tool_choice:'auto'` (FR-002 模型自决);未传则
 *   不带这两个字段 → 模型纯文本作答, 永不吐 tool_call (027 行为零回归)。
 * - 流式 tool_calls 按 `delta.tool_calls[index]` 累加: `id` / `function.name` 取一次,
 *   `function.arguments` 分片**拼接**;`finish_reason==='tool_calls'` 收口该轮 → 吐
 *   `{kind:'tool_call'}`。
 * - **双形态兜底**: DeepSeek 偶发把 tool_call 当**正文**吐 (structured tool_calls 缺失,
 *   内容里出现工具调用文本)。流结束时若结构化 tool_calls 为空但累计正文里命中工具调用
 *   模式 → 兜底解析为 tool_call (固化正则)。两形态收敛到同一 `{kind:'tool_call'}`。
 *
 * key 仅 server env (FR-007),经 DeepseekConfig 注入,永不下发客户端。真连通
 * (env-gated RUN_LLM_IT) 在 T008 验证。
 *
 * ⚠️ 029 D6 / F1 权威 model id 映射 (2026-06-14 钉定): 逻辑名 → DeepSeek v4 双模式
 * 真实 model id。`deepseek-chat` / `deepseek-reasoner` 是 legacy (2026-07-24 deprecate,
 * 禁用), 不再作 model 来源 —— provider 按 send-message 传入的逻辑 model (opts.model)
 * 映射到 v4 id; 未知 / legacy 逻辑值兜底快速模式 (flash)。config.model 不再驱动路由
 * (保留 schema 字段供向后兼容, 但 stream 不读)。
 */

/** F1 权威映射 (029, 2026-06-14): 逻辑 model → DeepSeek v4 真实 model id。 */
const LOGICAL_TO_DEEPSEEK_MODEL: Record<string, string> = {
  flash: 'deepseek-v4-flash',
  pro: 'deepseek-v4-pro',
};
/** 未知 / legacy 逻辑值兜底真实 model (快速模式)。 */
const DEEPSEEK_FALLBACK_MODEL = LOGICAL_TO_DEEPSEEK_MODEL.flash;

/**
 * 双形态兜底正则 (030 D3): DeepSeek 偶发把 tool_call 当正文吐, 常见两种文本载体:
 * - `<tool_call>{"name":"web_search","arguments":{"query":"..."}}</tool_call>` (标签包裹)
 * - 裸 `{"name":"web_search","arguments":{...}}` (函数调用 JSON, 出现在正文流)
 * 仅在结构化 tool_calls 缺失时启用 (主路是 delta.tool_calls 累加)。
 */
const TEXT_TOOL_CALL_PATTERNS: RegExp[] = [
  /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/,
  /\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*(?:\{[\s\S]*?\}|"[\s\S]*?")\s*\}/,
];

@Injectable()
export class DeepseekProvider implements LlmProvider {
  private readonly client: OpenAI;

  constructor(config: DeepseekConfig) {
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
    });
  }

  async *stream(messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    const withTools = opts.tools !== undefined && opts.tools.length > 0;
    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
      // 逻辑 model (flash/pro) → DeepSeek v4 真实 id; 未知/legacy 兜底 flash (F1)。
      model: LOGICAL_TO_DEEPSEEK_MODEL[opts.model] ?? DEEPSEEK_FALLBACK_MODEL,
      messages: toApiMessages(messages),
      stream: true,
      // 030 D3: 仅在调用方传 tools 时附 tools + tool_choice:'auto' (FR-002 模型自决);
      // 未传则不带这两个字段 → 027 纯文本路径零回归。
      ...(withTools ? { tools: opts.tools, tool_choice: 'auto' as const } : {}),
    };

    const completion = await this.client.chat.completions.create(body, { signal: opts.signal });

    // index → tool_call 草稿 (流式分片累加);仅 withTools 时可能填充。
    const drafts = new Map<number, ToolCallDraft>();
    let textAcc = '';

    for await (const chunk of completion) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // 结构化 tool_calls 分片累加 (主路, 仅 withTools 时模型会吐)。
      if (withTools && delta.tool_calls) {
        for (const tc of delta.tool_calls) accumulateToolCall(drafts, tc);
      }

      // 正文 token: delta.content 可能 undefined / null (首/尾 chunk 仅 role 或 finish_reason)。
      const token = delta.content;
      if (token) {
        textAcc += token;
        yield { kind: 'token', text: token };
      }
    }

    // 收口: 结构化 tool_calls 优先 (主路);缺失则正文双形态兜底 (DeepSeek 偶发当文本吐)。
    if (withTools) {
      const calls = collectToolCalls(drafts, textAcc);
      if (calls) yield { kind: 'tool_call', calls };
    }
  }
}

/**
 * 收口该轮的 tool_call (030 D3):
 * - 结构化 drafts 非空 → 主路 (按 index 累加好的 tool_calls)。
 * - drafts 空但正文命中工具调用模式 → 双形态兜底解析。
 * - 都没有 → null (纯文本作答, 不吐 tool_call)。
 */
function collectToolCalls(drafts: Map<number, ToolCallDraft>, textAcc: string): ToolCall[] | null {
  if (drafts.size > 0) return draftsToToolCalls(drafts);
  if (textAcc) {
    const parsed = parseTextToolCall(textAcc);
    if (parsed) return [parsed];
  }
  return null;
}

/**
 * 双形态兜底解析 (030 D3): 从正文文本里抽取 tool_call。命中 TEXT_TOOL_CALL_PATTERNS 之一
 * → 解析出 `{name, arguments}` → 归一为 ToolCall (arguments 统一序列化为 JSON 字符串)。
 * 解析失败 (无匹配 / JSON 坏 / 缺 name) → 返回 null (当作纯文本, 不吐 tool_call)。
 */
function parseTextToolCall(text: string): ToolCall | null {
  for (const pattern of TEXT_TOOL_CALL_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    // pattern[0] 是标签包裹的内层 JSON;pattern[1] 是裸 JSON 整体。
    const jsonText = pattern === TEXT_TOOL_CALL_PATTERNS[0] ? m[1] : m[0];
    try {
      const obj = JSON.parse(jsonText) as { name?: unknown; arguments?: unknown };
      if (typeof obj.name !== 'string' || obj.name.length === 0) continue;
      const args =
        typeof obj.arguments === 'string' ? obj.arguments : JSON.stringify(obj.arguments ?? {});
      return {
        id: `call_text_0`,
        type: 'function',
        function: { name: obj.name, arguments: args },
      };
    } catch {
      // JSON 坏 → 尝试下一个 pattern。
      continue;
    }
  }
  return null;
}
