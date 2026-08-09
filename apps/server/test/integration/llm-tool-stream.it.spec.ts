import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app/app.module';
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmStreamEvent,
  type LlmStreamOptions,
  type ToolDef,
} from '../../src/integrations/llm/llm-provider.port';
import { FakeLlmProvider } from '../../src/integrations/llm/fake-llm.provider';
import { WEB_SEARCH_TOOL } from '../../src/chat/web-search.rules';
import type { Msg, ToolCall } from '../../src/chat/chat-context.rules';

/**
 * 030 T005 provider tool 事件闭环 IT — 真 DI 容器 (全 boot `AppModule` 含 ChatModule) +
 * Testcontainers PG/Redis, per plan「NO LIFECYCLE MOCKING」: LLM_PROVIDER 经 **DI override**
 * 注入 FakeLlmProvider (绝不 `jest.mock` / 隔离 `new XxxProvider()`)。全 boot AppModule 而非
 * 裸 ChatModule, 因 ChatModule → AccountModule 依赖 AppModule 装配的全局 ThrottlerModule
 * (与既有 chat-streaming.it / chat-conversation.it 同款 AppModule boot)。本 IT 验**单 provider
 * 层**的 tool calling 闭环 (send-message ReAct loop 是 T009, 不在此):
 *
 *   ① 从真 DI 容器取出 LLM_PROVIDER (= 注入的 FakeLlmProvider, 经 ChatModule 装配)。
 *   ② scripted「第 1 轮吐 tool_call(web_search,query) → 喂回 tool result → 第 2 轮吐 text」:
 *      - round1: 传 tools, stream → 收到单个 {kind:'tool_call'}, calls[0] = web_search。
 *      - 模拟编排回灌: 把 assistant(toolCalls) + tool(result, toolCallId) 追加进 messages。
 *      - round2: 同一 provider 再 stream(回灌后的 messages) → 收到 text token 收敛。
 *   ③ 断言事件序列正确 + `Msg` tool 角色回灌 shape (assistant.toolCalls 与 tool.toolCallId 配对)。
 *
 * 为何全 boot ChatModule 而非裸 new FakeLlmProvider: 验证「FakeLlmProvider 能经真 DI 容器
 * 装配并以 LlmProvider 契约取出驱动」, 与既有 chat IT (chat-streaming.it) 同款 DI 注入路数,
 * 是 T009 send-message loop IT 的前置地基 (provider 事件契约先于编排锁定)。
 */
describe('030 provider tool 事件闭环 (AppModule 全 boot DI + Testcontainers PG/Redis)', () => {
  let moduleRef: TestingModule;
  let provider: LlmProvider;
  /** DI 注入的 swappable fake: 逐 test 换内核 script。 */
  let fake: SwappableFakeProvider;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    // AppModule 依赖 SecurityModule 的 config boot;给占位让 provider config .parse() 不炸。
    process.env.AUTH_JWT_SECRET = 'chat-t005-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'chat-t005-hmac-secret-min-32-bytes-zyxw';
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-placeholder-key';

    fake = new SwappableFakeProvider();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(fake)
      .compile();
    // 经真 DI 容器取出 LLM_PROVIDER 契约 (验装配, 非直接持 fake 引用)。
    provider = moduleRef.get<LlmProvider>(LLM_PROVIDER);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await stores.drop();
  });

  const TOOLS: ToolDef[] = [WEB_SEARCH_TOOL as unknown as ToolDef];

  async function drain(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
    const out: LlmStreamEvent[] = [];
    for await (const e of stream) out.push(e);
    return out;
  }

  it('scripted tool_call → 回灌 tool result → text 收敛 (provider 层闭环 + Msg tool 角色回灌 shape)', async () => {
    fake.setScript([
      { toolCall: { id: 'call_ws_1', name: 'web_search', args: { query: '今日上证指数' } } },
      { tokens: ['上证', '收', '于', '3000 点'] },
    ]);
    const controller = new AbortController();
    const baseMessages: Msg[] = [{ role: 'user', content: '今天上证指数多少' }];

    // ── round 1: 传 tools → 模型决定调 web_search ──────────────────────────────
    const round1 = await drain(
      provider.stream(baseMessages, { signal: controller.signal, model: 'flash', tools: TOOLS }),
    );
    expect(round1).toHaveLength(1);
    expect(round1[0]!.kind).toBe('tool_call');
    const calls = (round1[0] as { kind: 'tool_call'; calls: ToolCall[] }).calls;
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.function.name).toBe('web_search');
    expect(call.id).toBe('call_ws_1');
    expect(JSON.parse(call.function.arguments)).toEqual({ query: '今日上证指数' });

    // ── 编排回灌: assistant(toolCalls) + tool(result, toolCallId 与 call.id 配对) ──
    const toolResult = '上证指数今日收于 3000 点。';
    const messagesRound2: Msg[] = [
      ...baseMessages,
      { role: 'assistant', content: '', toolCalls: calls },
      { role: 'tool', content: toolResult, toolCallId: call.id },
    ];

    // Msg tool 角色回灌 shape 断言: assistant.toolCalls[0].id === tool.toolCallId (配对)。
    const assistantMsg = messagesRound2[1]!;
    const toolMsg = messagesRound2[2]!;
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.toolCalls?.[0]!.id).toBe('call_ws_1');
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.toolCallId).toBe(assistantMsg.toolCalls?.[0]!.id);

    // ── round 2: 同一 provider 喂回灌后的 messages → text 收敛 (无 tool_call) ──────
    const round2 = await drain(
      provider.stream(messagesRound2, {
        signal: controller.signal,
        model: 'flash',
        tools: TOOLS,
      }),
    );
    const tokens = round2
      .filter((e): e is { kind: 'token'; text: string } => e.kind === 'token')
      .map((e) => e.text);
    expect(tokens.join('')).toBe('上证收于3000 点');
    expect(round2.some((e) => e.kind === 'tool_call')).toBe(false);
  });

  it('零回归: 不传 tools → tool_call 轮降级空, 永不吐 tool_call (向后兼容铁律)', async () => {
    fake.setScript([
      { toolCall: { name: 'web_search', args: { query: 'x' } } },
      { tokens: ['纯', '文本'] },
    ]);
    const controller = new AbortController();
    const messages: Msg[] = [{ role: 'user', content: '你好' }];

    // round1 无 tools: tool_call 轮降级为空 (无事件)。
    const round1 = await drain(
      provider.stream(messages, { signal: controller.signal, model: 'flash' }),
    );
    expect(round1).toEqual([]);
    // round2: 纯 token。
    const round2 = await drain(
      provider.stream(messages, { signal: controller.signal, model: 'flash' }),
    );
    expect(round2).toEqual([
      { kind: 'token', text: '纯' },
      { kind: 'token', text: '文本' },
    ]);
  });
});

/**
 * 单 DI override fake, 内核 FakeLlmProvider 逐 test 经 setScript 重置 (轮次游标随之归零)。
 * 与 chat-streaming.it 的 SwappableFakeProvider 同款 (那里换 tokens, 这里换 script)。
 */
class SwappableFakeProvider implements LlmProvider {
  private inner = new FakeLlmProvider({ tokens: [] });

  setScript(script: ConstructorParameters<typeof FakeLlmProvider>[0]['script']): void {
    this.inner = new FakeLlmProvider({ script });
  }

  stream(messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    return this.inner.stream(messages, opts);
  }
}
