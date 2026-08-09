import { describe, it, expect } from 'vitest';
import { DeepseekProvider } from './deepseek.provider.js';
import type { Msg, LlmStreamEvent, LlmStreamOptions, ToolDef } from './llm-provider.port.js';
import { WEB_SEARCH_TOOL } from '../../chat/web-search.rules.js';

/**
 * 030 T004 DeepseekProvider tool calling 单测 (hermetic) — 不打真 DeepSeek。
 *
 * 测试 seam: provider 构造后, 把私有 `client.chat.completions.create` 替换为返回
 * scripted `ChatCompletionChunk` 异步序列的 fake (DI / 真连通归 chat-streaming env-gated
 * IT 与 T005)。覆盖:
 *  - 无 tools → 纯 token 事件 (向后兼容, 不带 tools/tool_choice, 永不吐 tool_call) /
 *  - 传 tools → body 含 tools + tool_choice:'auto' (FR-002 模型自决) /
 *  - 结构化 tool_calls 分片按 index 累加 (id/name 取一次, arguments 拼接) /
 *  - 双形态: 结构化缺失但正文里命中工具调用文本 → 兜底解析为 tool_call /
 *  - 既无结构化也无文本模式 → 纯 token 收敛 (不误吐 tool_call)。
 */

const MESSAGES: Msg[] = [{ role: 'user', content: '今天北京天气' }];
const TOOLS: ToolDef[] = [WEB_SEARCH_TOOL as unknown as ToolDef];

const opts = (tools?: ToolDef[]): LlmStreamOptions => ({
  signal: new AbortController().signal,
  model: 'flash',
  ...(tools ? { tools } : {}),
});

/** 最小 ChatCompletionChunk 形状 (只填 provider 读取的字段)。 */
type Chunk = {
  choices: [
    {
      delta: {
        content?: string | null;
        tool_calls?: Array<{
          index: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string | null;
    },
  ];
};

/** 构造 DeepseekProvider 并把 create 替换为吐 scripted chunks 的 fake;返回 {provider, lastBody}。 */
function providerWithChunks(chunks: Chunk[]): {
  provider: DeepseekProvider;
  getBody: () => Record<string, unknown> | undefined;
} {
  const provider = new DeepseekProvider({
    apiKey: 'test',
    baseUrl: 'https://api.deepseek.com',
    model: 'flash',
  });
  let lastBody: Record<string, unknown> | undefined;
  // 替换私有 client (测试 seam, 仅本单测;真连通走 env-gated IT)。
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

const tokenChunk = (content: string): Chunk => ({ choices: [{ delta: { content } }] });

describe('030 DeepseekProvider tool calling', () => {
  it('无 tools → 纯 token 事件; body 不带 tools/tool_choice (027 零回归)', async () => {
    const { provider, getBody } = providerWithChunks([tokenChunk('你好'), tokenChunk('世界')]);
    const events = await drain(provider.stream(MESSAGES, opts()));
    expect(events).toEqual([
      { kind: 'token', text: '你好' },
      { kind: 'token', text: '世界' },
    ]);
    const body = getBody()!;
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('传 tools → body 含 tools + tool_choice:"auto" (FR-002 模型自决)', async () => {
    const { provider, getBody } = providerWithChunks([tokenChunk('ok')]);
    await drain(provider.stream(MESSAGES, opts(TOOLS)));
    const body = getBody()!;
    expect(body.tool_choice).toBe('auto');
    expect(Array.isArray(body.tools)).toBe(true);
    expect((body.tools as ToolDef[])[0]!.function.name).toBe('web_search');
  });

  it('结构化 tool_calls 分片按 index 累加 (id/name 取一次, arguments 拼接)', async () => {
    const chunks: Chunk[] = [
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'web_search' } }] } },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"que' } }] } }] },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"北京天气"}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    const { provider } = providerWithChunks(chunks);
    const events = await drain(provider.stream(MESSAGES, opts(TOOLS)));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('tool_call');
    const call = (
      events[0] as {
        kind: 'tool_call';
        calls: { id: string; function: { name: string; arguments: string } }[];
      }
    ).calls[0]!;
    expect(call.id).toBe('call_x');
    expect(call.function.name).toBe('web_search');
    expect(JSON.parse(call.function.arguments)).toEqual({ query: '北京天气' });
  });

  it('多个 tool_calls (不同 index) 各自累加, 按 index 升序收口', async () => {
    const chunks: Chunk[] = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'c0',
                  function: { name: 'web_search', arguments: '{"query":"a"}' },
                },
                {
                  index: 1,
                  id: 'c1',
                  function: { name: 'web_search', arguments: '{"query":"b"}' },
                },
              ],
            },
          },
        ],
      },
    ];
    const { provider } = providerWithChunks(chunks);
    const events = await drain(provider.stream(MESSAGES, opts(TOOLS)));
    const calls = (events[0] as { kind: 'tool_call'; calls: { id: string }[] }).calls;
    expect(calls.map((c) => c.id)).toEqual(['c0', 'c1']);
  });

  it('双形态兜底: 结构化缺失但正文 <tool_call> 标签包裹 → 解析为 tool_call', async () => {
    const text = '<tool_call>{"name":"web_search","arguments":{"query":"上证指数"}}</tool_call>';
    const { provider } = providerWithChunks([tokenChunk(text)]);
    const events = await drain(provider.stream(MESSAGES, opts(TOOLS)));
    // 正文 token 仍吐 (流式) + 末尾兜底 tool_call。
    const toolEvent = events.find((e) => e.kind === 'tool_call') as
      | { kind: 'tool_call'; calls: { function: { name: string; arguments: string } }[] }
      | undefined;
    expect(toolEvent).toBeDefined();
    expect(toolEvent!.calls[0]!.function.name).toBe('web_search');
    expect(JSON.parse(toolEvent!.calls[0]!.function.arguments)).toEqual({ query: '上证指数' });
  });

  it('双形态兜底: 裸 JSON 函数调用文本 (无标签) → 解析为 tool_call', async () => {
    // 分片吐出, 验跨 chunk 拼接后正则命中。
    const { provider } = providerWithChunks([
      tokenChunk('{"name":"web_search",'),
      tokenChunk('"arguments":{"query":"原油价格"}}'),
    ]);
    const events = await drain(provider.stream(MESSAGES, opts(TOOLS)));
    const toolEvent = events.find((e) => e.kind === 'tool_call') as
      | { kind: 'tool_call'; calls: { function: { arguments: string } }[] }
      | undefined;
    expect(toolEvent).toBeDefined();
    expect(JSON.parse(toolEvent!.calls[0]!.function.arguments)).toEqual({ query: '原油价格' });
  });

  it('纯正文 (无结构化无文本模式) → 不误吐 tool_call', async () => {
    const { provider } = providerWithChunks([tokenChunk('这是'), tokenChunk('普通回答')]);
    const events = await drain(provider.stream(MESSAGES, opts(TOOLS)));
    expect(events).toEqual([
      { kind: 'token', text: '这是' },
      { kind: 'token', text: '普通回答' },
    ]);
    expect(events.some((e) => e.kind === 'tool_call')).toBe(false);
  });
});
