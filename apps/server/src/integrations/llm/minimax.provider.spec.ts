import { describe, it, expect } from 'vitest';
import { MinimaxProvider } from './minimax.provider.js';
import type { Msg, LlmStreamEvent, LlmStreamOptions, ToolDef } from './llm-provider.port.js';
import { WEB_SEARCH_TOOL } from '../../chat/web-search.rules.js';

/**
 * 030 A1 T018 MinimaxProvider 单测 (hermetic, 不打真 MiniMax) — M3 接入 tool calling:
 * - `thinking:adaptive` (非 disabled, PoC: disabled 工具调用不可靠)。
 * - 传 tools → 透传 tools + tool_choice:'auto', 流式 tool_calls 累加 → 吐 {kind:'tool_call'}。
 * - 未传 tools → 纯 token (向后兼容)。
 * - adaptive 内联 <think>…</think> 流式剥离 (含跨 chunk 拆分)。
 * 测试 seam 同 deepseek.provider.spec (替换私有 client)。
 */

const MESSAGES: Msg[] = [{ role: 'user', content: '上海今天天气？' }];
const TOOLS: ToolDef[] = [WEB_SEARCH_TOOL as unknown as ToolDef];

const opts = (tools?: ToolDef[]): LlmStreamOptions => ({
  signal: new AbortController().signal,
  model: 'minimax',
  ...(tools ? { tools } : {}),
});

type ToolCallDelta = {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};
type Chunk = { choices: [{ delta: { content?: string | null; tool_calls?: ToolCallDelta[] } }] };

function providerWithChunks(chunks: Chunk[]): {
  provider: MinimaxProvider;
  getBody: () => Record<string, unknown> | undefined;
} {
  const provider = new MinimaxProvider({
    apiKey: 'test',
    baseUrl: 'https://api.minimaxi.com/v1',
  });
  let lastBody: Record<string, unknown> | undefined;
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: (body: Record<string, unknown>) => {
          lastBody = body;
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  };
  return { provider, getBody: () => lastBody };
}

async function drain(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('030 A1 MinimaxProvider (adaptive + tool calling + <think> 剥离)', () => {
  it('body 始终 thinking:adaptive', async () => {
    const { provider, getBody } = providerWithChunks([{ choices: [{ delta: { content: 'ok' } }] }]);
    await drain(provider.stream(MESSAGES, opts()));
    expect(getBody()!.thinking).toEqual({ type: 'adaptive' });
  });

  it('无 tools → 纯 token, body 不带 tools/tool_choice', async () => {
    const { provider, getBody } = providerWithChunks([
      { choices: [{ delta: { content: '你好' } }] },
      { choices: [{ delta: { content: '世界' } }] },
    ]);
    const events = await drain(provider.stream(MESSAGES, opts()));
    expect(events).toEqual([
      { kind: 'token', text: '你好' },
      { kind: 'token', text: '世界' },
    ]);
    expect(getBody()!.tools).toBeUndefined();
    expect(getBody()!.tool_choice).toBeUndefined();
  });

  it('传 tools + 模型流式 tool_call → 累加吐 {kind:"tool_call"}, body 带 tools+tool_choice', async () => {
    const { provider, getBody } = providerWithChunks([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search' } }] } },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '"上海天气"}' } }] } },
        ],
      },
    ]);
    const events = await drain(provider.stream(MESSAGES, opts(TOOLS)));
    expect(events).toEqual([
      {
        kind: 'tool_call',
        calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"上海天气"}' },
          },
        ],
      },
    ]);
    expect(getBody()!.tools).toEqual(TOOLS);
    expect(getBody()!.tool_choice).toBe('auto');
  });

  it('传 tools 但模型只吐文本(自决不检索)→ 仅 token, 无 tool_call', async () => {
    const { provider } = providerWithChunks([
      { choices: [{ delta: { content: '你好，' } }] },
      { choices: [{ delta: { content: '有什么可以帮你' } }] },
    ]);
    const events = await drain(provider.stream(MESSAGES, opts(TOOLS)));
    expect(events.every((e) => e.kind === 'token')).toBe(true);
    expect(events.some((e) => e.kind === 'tool_call')).toBe(false);
  });

  it('adaptive 内联 <think> → 剥离, 只吐可见正文', async () => {
    const { provider } = providerWithChunks([
      { choices: [{ delta: { content: '<think>推理</think>答案' } }] },
    ]);
    const events = await drain(provider.stream(MESSAGES, opts()));
    expect(events).toEqual([{ kind: 'token', text: '答案' }]);
  });

  it('<think> 跨 chunk 拆分 → 仍剥离干净', async () => {
    const { provider } = providerWithChunks([
      { choices: [{ delta: { content: '前<thi' } }] },
      { choices: [{ delta: { content: 'nk>密</think' } }] },
      { choices: [{ delta: { content: '>后' } }] },
    ]);
    const events = await drain(provider.stream(MESSAGES, opts()));
    expect(events.map((e) => (e.kind === 'token' ? e.text : '')).join('')).toBe('前后');
  });

  it('跳过空 content chunk (首/尾仅 role/finish_reason)', async () => {
    const { provider } = providerWithChunks([
      { choices: [{ delta: {} }] },
      { choices: [{ delta: { content: '正文' } }] },
      { choices: [{ delta: { content: null } }] },
    ]);
    const events = await drain(provider.stream(MESSAGES, opts()));
    expect(events).toEqual([{ kind: 'token', text: '正文' }]);
  });
});
