import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type { MinimaxConfig } from '../../config/index.js';
import type { Msg, LlmProvider, LlmStreamEvent, LlmStreamOptions } from './llm-provider.port.js';
import {
  accumulateToolCall,
  createThinkStripper,
  draftsToToolCalls,
  toApiMessages,
  type ToolCallDraft,
} from './llm-stream.rules.js';

/**
 * MinimaxProvider (029 收口;030 A1 接 tool calling) — MiniMax M3 的 `LlmProvider` 实现。
 *
 * MiniMax 国内站 OpenAI 兼容: 复用官方 `openai` SDK, 仅换 `baseURL`
 * (`https://api.minimaxi.com/v1`, 经 MinimaxConfig 注入)。`chat.completions.create`
 * 与 DeepSeek 同款流式: 返回 `Stream<ChatCompletionChunk>` (AsyncIterable)。`opts.signal`
 * 透传 SDK request options → abort 时中断上游 HTTP (止付 token, 停止/断连语义)。
 *
 * key 仅 server env (`MINIMAX_API_KEY`), 经 MinimaxConfig 注入, 永不下发客户端。
 *
 * 逻辑 model 单一 (minimax → 真实 model id `MiniMax-M3`), `opts.model` 恒为 'minimax'
 * (由 RoutingLlmProvider 路由), provider 内不再分支。
 *
 * 🔄 **030 A1 (2026-06-19) — 接入 tool calling, 与 DeepSeek 统一联网**:
 * - M3 国内站实测**支持** OpenAI 兼容 function calling (PoC 2026-06-19)。调用方传 `opts.tools`
 *   → 透传 `tools` + `tool_choice:'auto'` (模型自决);流式按 `delta.tool_calls[index]` 累加,
 *   收口吐 `{kind:'tool_call'}`。未传 tools → 纯 token 流 (向后兼容)。
 * - ⚠️ `thinking:{type:'adaptive'}` (旧 `disabled`): PoC 实证 **disabled 下工具调用不可靠**
 *   (两跑一调一摆烂), adaptive 才稳 (需联网 6/6 触发、不需 9/9 不触发)。`thinking` 合法值
 *   仅 `adaptive`/`disabled`。
 * - ⚠️ adaptive 把推理**内联进 `content`** (`<think>…</think>`, 标签会被拆在 chunk 边界),
 *   故用 `createThinkStripper` 流式剥离, 只吐可见正文 (本 chat 不渲染思考过程)。代价: 首字
 *   延迟↑ + 多付思考 token (反转 029「关思考求首字快」的取舍, 为统一联网接受)。
 */

/** MiniMax M3 真实 model id (官方 OpenAI 兼容端点确认)。 */
const MINIMAX_MODEL = 'MiniMax-M3';

@Injectable()
export class MinimaxProvider implements LlmProvider {
  private readonly client: OpenAI;

  constructor(config: MinimaxConfig) {
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
    });
  }

  async *stream(messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    const withTools = opts.tools !== undefined && opts.tools.length > 0;
    const body = {
      model: MINIMAX_MODEL,
      messages: toApiMessages(messages),
      stream: true,
      // adaptive: tool calling 在 disabled 下不可靠 (A1 PoC 实证)。非 OpenAI SDK 标准字段,
      // 故整体 cast (运行时透传)。
      thinking: { type: 'adaptive' },
      // A1: 调用方传 tools 时附 tools + tool_choice:'auto' (模型自决);未传则不带 → 纯 token。
      ...(withTools ? { tools: opts.tools, tool_choice: 'auto' as const } : {}),
    } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

    const completion = await this.client.chat.completions.create(body, { signal: opts.signal });

    // index → tool_call 草稿 (流式分片累加);仅 withTools 时可能填充。
    const drafts = new Map<number, ToolCallDraft>();
    // adaptive 把推理内联进 content, 跨 chunk 剥离 <think>…</think>。
    const stripper = createThinkStripper();

    for await (const chunk of completion) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // 结构化 tool_calls 分片累加 (主路, 仅 withTools 时模型会吐)。
      if (withTools && delta.tool_calls) {
        for (const tc of delta.tool_calls) accumulateToolCall(drafts, tc);
      }

      // 正文 token: 先经 think 剥离, 只吐可见部分 (空串/全 think 的 chunk 不吐)。
      if (delta.content) {
        const visible = stripper.push(delta.content);
        if (visible) yield { kind: 'token', text: visible };
      }
    }

    // 收尾: 取回 think 剥离的缓冲尾部 (未完成开标签当字面量, 未闭合 think 丢弃)。
    const tail = stripper.flush();
    if (tail) yield { kind: 'token', text: tail };

    // 收口该轮 tool_call (M3 流式结构化 tool_calls, 无 DeepSeek「当文本吐」双形态问题)。
    if (withTools && drafts.size > 0) {
      yield { kind: 'tool_call', calls: draftsToToolCalls(drafts) };
    }
  }
}
