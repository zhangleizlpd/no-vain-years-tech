import { describe, expect, it } from 'vitest';
import { FakeLlmProvider } from './fake-llm.provider.js';
import type { Msg, LlmStreamEvent, LlmStreamOptions, ToolDef } from './llm-provider.port.js';
import { WEB_SEARCH_TOOL } from '../../chat/web-search.rules.js';

const MESSAGES: Msg[] = [{ role: 'user', content: '你好' }];
const TOOLS: ToolDef[] = [WEB_SEARCH_TOOL as unknown as ToolDef];

/** stream opts helper — fake 不读 model, 给任意有效逻辑值占位 (029: LlmStreamOptions.model 必填)。 */
const opts = (signal: AbortSignal, tools?: ToolDef[]): LlmStreamOptions => ({
  signal,
  model: 'flash',
  ...(tools ? { tools } : {}),
});

/** drain 事件流到数组,便于断言序列。 */
async function drainEvents(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/** drain 只取 token 文本 (027 等价断言:无 tools 时纯 token)。 */
async function drainTokens(stream: AsyncIterable<LlmStreamEvent>): Promise<string[]> {
  const out: string[] = [];
  for await (const e of stream) {
    if (e.kind === 'token') out.push(e.text);
  }
  return out;
}

describe('FakeLlmProvider', () => {
  describe('027 单轮 tokens (向后兼容: 无 tools = 纯 token 事件)', () => {
    it('吐出构造时给定的 scripted token 序列 (确定性,供 IT)', async () => {
      const provider = new FakeLlmProvider({ tokens: ['你', '好', '世界'] });
      const tokens = await drainTokens(
        provider.stream(MESSAGES, opts(new AbortController().signal)),
      );
      expect(tokens).toEqual(['你', '好', '世界']);
    });

    it('零回归: 无 tools 时只产 {kind:"token"} 事件 (永不吐 tool_call)', async () => {
      const provider = new FakeLlmProvider({ tokens: ['a', 'b'] });
      const events = await drainEvents(
        provider.stream(MESSAGES, opts(new AbortController().signal)),
      );
      expect(events).toEqual([
        { kind: 'token', text: 'a' },
        { kind: 'token', text: 'b' },
      ]);
      expect(events.every((e) => e.kind === 'token')).toBe(true);
    });

    it('空 tokens → 空迭代 (不抛)', async () => {
      const provider = new FakeLlmProvider({ tokens: [] });
      const tokens = await drainTokens(
        provider.stream(MESSAGES, opts(new AbortController().signal)),
      );
      expect(tokens).toEqual([]);
    });

    it('已 abort 的 signal → 迭代立即停止,不吐任何 token (模拟客户端断连)', async () => {
      const controller = new AbortController();
      controller.abort();
      const provider = new FakeLlmProvider({ tokens: ['a', 'b', 'c'] });
      const tokens = await drainTokens(provider.stream(MESSAGES, opts(controller.signal)));
      expect(tokens).toEqual([]);
    });

    it('迭代途中 abort → 在该点停止,只吐 abort 前的 token (模拟流中途停止)', async () => {
      const controller = new AbortController();
      const provider = new FakeLlmProvider({ tokens: ['a', 'b', 'c', 'd'] });
      const out: string[] = [];
      for await (const e of provider.stream(MESSAGES, opts(controller.signal))) {
        if (e.kind === 'token') out.push(e.text);
        if (out.length === 2) controller.abort();
      }
      expect(out).toEqual(['a', 'b']);
    });

    it('errorAfter=N → 吐 N 个 token 后抛出注入的 error (模拟 provider 失败)', async () => {
      const provider = new FakeLlmProvider({ tokens: ['a', 'b', 'c'], errorAfter: 1 });
      const out: string[] = [];
      await expect(async () => {
        for await (const e of provider.stream(MESSAGES, opts(new AbortController().signal))) {
          if (e.kind === 'token') out.push(e.text);
        }
      }).rejects.toThrow('FAKE_PROVIDER_ERROR');
      expect(out).toEqual(['a']);
    });

    it('errorAfter=0 → 第一 token 前即抛 (模拟 TTFT 前失败,无 token)', async () => {
      const provider = new FakeLlmProvider({ tokens: ['a', 'b'], errorAfter: 0 });
      const out: string[] = [];
      await expect(async () => {
        for await (const e of provider.stream(MESSAGES, opts(new AbortController().signal))) {
          if (e.kind === 'token') out.push(e.text);
        }
      }).rejects.toThrow('FAKE_PROVIDER_ERROR');
      expect(out).toEqual([]);
    });

    it('delayMs → 每 token 间引入延迟 (模拟慢流/超时,供停止/断连测时窗)', async () => {
      const provider = new FakeLlmProvider({ tokens: ['a', 'b'], delayMs: 20 });
      const start = Date.now();
      const tokens = await drainTokens(
        provider.stream(MESSAGES, opts(new AbortController().signal)),
      );
      const elapsed = Date.now() - start;
      expect(tokens).toEqual(['a', 'b']);
      // 2 token × 20ms ≈ ≥40ms (留宽松下界避抖动误判)。
      expect(elapsed).toBeGreaterThanOrEqual(30);
    });

    it('delayMs + 等待期间 abort → 停止迭代 (delay 期间也尊重 signal)', async () => {
      const controller = new AbortController();
      const provider = new FakeLlmProvider({ tokens: ['a', 'b', 'c'], delayMs: 50 });
      setTimeout(() => controller.abort(), 10);
      const tokens = await drainTokens(provider.stream(MESSAGES, opts(controller.signal)));
      // 首 token 在 ~10ms abort 前可能尚未吐 (delay 50ms 先于首 token),允许 0 或 1。
      expect(tokens.length).toBeLessThanOrEqual(1);
    });

    it('实现 LlmProvider port 契约 (stream 返回 AsyncIterable<LlmStreamEvent>)', () => {
      const provider = new FakeLlmProvider({ tokens: ['x'] });
      const stream = provider.stream(MESSAGES, opts(new AbortController().signal));
      expect(typeof stream[Symbol.asyncIterator]).toBe('function');
    });
  });

  describe('030 script 多轮 (tool_call → text 收敛 loop 编排)', () => {
    it('第 1 轮吐 tool_call(web_search,query) → 第 2 轮吐 text (传 tools)', async () => {
      const provider = new FakeLlmProvider({
        script: [
          { toolCall: { name: 'web_search', args: { query: '今日天气' } } },
          { tokens: ['今天', '晴'] },
        ],
      });
      const controller = new AbortController();

      // 第 1 轮: tool_call 事件 (传 tools)。
      const round1 = await drainEvents(provider.stream(MESSAGES, opts(controller.signal, TOOLS)));
      expect(round1).toHaveLength(1);
      expect(round1[0]!.kind).toBe('tool_call');
      const tc = (round1[0] as { kind: 'tool_call'; calls: unknown[] }).calls[0] as {
        function: { name: string; arguments: string };
      };
      expect(tc.function.name).toBe('web_search');
      expect(JSON.parse(tc.function.arguments)).toEqual({ query: '今日天气' });

      // 第 2 轮: text 收敛。
      const round2 = await drainTokens(provider.stream(MESSAGES, opts(controller.signal, TOOLS)));
      expect(round2).toEqual(['今天', '晴']);
    });

    it('script tool_call 轮但调用方未传 tools → 降级空轮 (向后兼容:无 tools 不吐 tool_call)', async () => {
      const provider = new FakeLlmProvider({
        script: [{ toolCall: { name: 'web_search', args: { query: 'x' } } }, { tokens: ['答'] }],
      });
      const controller = new AbortController();
      // 第 1 轮无 tools → 空 (不吐 tool_call)。
      const round1 = await drainEvents(provider.stream(MESSAGES, opts(controller.signal)));
      expect(round1).toEqual([]);
    });

    it('script 越界轮 → 空 token 轮 (收敛, 不再吐)', async () => {
      const provider = new FakeLlmProvider({ script: [{ tokens: ['仅一轮'] }] });
      const controller = new AbortController();
      await drainEvents(provider.stream(MESSAGES, opts(controller.signal)));
      const beyond = await drainEvents(provider.stream(MESSAGES, opts(controller.signal)));
      expect(beyond).toEqual([]);
    });

    it('tool_call 自动生成 id (未显式给 id)', async () => {
      const provider = new FakeLlmProvider({
        script: [{ toolCall: { name: 'web_search', args: { query: 'q' } } }],
      });
      const events = await drainEvents(
        provider.stream(MESSAGES, opts(new AbortController().signal, TOOLS)),
      );
      const call = (events[0] as { kind: 'tool_call'; calls: { id: string }[] }).calls[0]!;
      expect(call.id).toMatch(/^call_/);
    });
  });

  describe('030 T016 content-driven (env 注入路契约冒烟: tokens + webSearchKeyword 自决联网)', () => {
    const KW = 'WebSrch';
    const withKw: Msg[] = [{ role: 'user', content: 'WebSrch请联网查一下今天的新闻' }];
    const withoutKw: Msg[] = [{ role: 'user', content: '帮我分析一下贵州茅台' }];
    // 检索结果回灌后的对话 (含 role:'tool') —— 命中关键字但已回灌 → 转吐正文收敛。
    const afterToolFeedback: Msg[] = [
      { role: 'user', content: 'WebSrch请联网查一下今天的新闻' },
      { role: 'assistant', content: '', toolCalls: [] },
      { role: 'tool', content: '[]', toolCallId: 'call_0' },
    ];

    it('命中关键字 + 传 tools + 尚未回灌 → 吐 tool_call(web_search, query=user 文本)', async () => {
      const provider = new FakeLlmProvider({ tokens: ['答'], webSearchKeyword: KW });
      const events = await drainEvents(
        provider.stream(withKw, opts(new AbortController().signal, TOOLS)),
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe('tool_call');
      const tc = (events[0] as { kind: 'tool_call'; calls: unknown[] }).calls[0] as {
        function: { name: string; arguments: string };
      };
      expect(tc.function.name).toBe('web_search');
      expect(JSON.parse(tc.function.arguments)).toEqual({ query: withKw[0]!.content });
    });

    it('检索结果回灌后 (messages 含 role:tool) → 转吐 tokens 正文收敛 (无 tool_call)', async () => {
      const provider = new FakeLlmProvider({ tokens: ['今', '天', '晴'], webSearchKeyword: KW });
      const tokens = await drainTokens(
        provider.stream(afterToolFeedback, opts(new AbortController().signal, TOOLS)),
      );
      expect(tokens).toEqual(['今', '天', '晴']);
    });

    it('向后兼容: 命中关键字但未传 tools → 纯 token (不吐 tool_call)', async () => {
      const provider = new FakeLlmProvider({ tokens: ['答'], webSearchKeyword: KW });
      const events = await drainEvents(provider.stream(withKw, opts(new AbortController().signal)));
      expect(events).toEqual([{ kind: 'token', text: '答' }]);
    });

    it('向后兼容: 传 tools 但消息无关键字 → 纯 token (不吐 tool_call)', async () => {
      const provider = new FakeLlmProvider({ tokens: ['答'], webSearchKeyword: KW });
      const events = await drainEvents(
        provider.stream(withoutKw, opts(new AbortController().signal, TOOLS)),
      );
      expect(events).toEqual([{ kind: 'token', text: '答' }]);
    });

    it('向后兼容: 未配 webSearchKeyword → 纯 tokens 行为不变 (即便传 tools + 关键字)', async () => {
      const provider = new FakeLlmProvider({ tokens: ['答'] });
      const events = await drainEvents(
        provider.stream(withKw, opts(new AbortController().signal, TOOLS)),
      );
      expect(events).toEqual([{ kind: 'token', text: '答' }]);
    });
  });

  describe('031 T011 content-driven 系统提示回显 (env 注入路契约冒烟: systemEchoKeyword 回显 system 段)', () => {
    const ECHO = 'SysEcho';
    const SYSTEM =
      '你是「不负光阴」App 的 AI 助手。<<<USER_CUSTOM>>>\n请用沪语回答\n<<<END_USER_CUSTOM>>>';
    const withEchoKw: Msg[] = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'SysEcho 帮我分析一下' },
    ];

    it('命中回显关键字 + 含 system 段 → 把 system 段原文吐成单 token (落库 = 系统提示原文)', async () => {
      const provider = new FakeLlmProvider({ tokens: ['不该出现'], systemEchoKeyword: ECHO });
      const tokens = await drainTokens(
        provider.stream(withEchoKw, opts(new AbortController().signal)),
      );
      expect(tokens).toEqual([SYSTEM]);
    });

    it('回显优先于 scripted tokens (命中时不吐 tokens)', async () => {
      const provider = new FakeLlmProvider({
        tokens: ['你好', '世界'],
        systemEchoKeyword: ECHO,
      });
      const tokens = await drainTokens(
        provider.stream(withEchoKw, opts(new AbortController().signal)),
      );
      expect(tokens.join('')).toBe(SYSTEM);
    });

    it('命中关键字但本次无 system 段 → 走常规 tokens (无可回显)', async () => {
      const provider = new FakeLlmProvider({ tokens: ['答'], systemEchoKeyword: ECHO });
      const noSystem: Msg[] = [{ role: 'user', content: 'SysEcho 帮我分析' }];
      const tokens = await drainTokens(
        provider.stream(noSystem, opts(new AbortController().signal)),
      );
      expect(tokens).toEqual(['答']);
    });

    it('向后兼容: 配了 systemEchoKeyword 但 user 文本无关键字 → 走常规 tokens (即便有 system 段)', async () => {
      const provider = new FakeLlmProvider({ tokens: ['答'], systemEchoKeyword: ECHO });
      const noKw: Msg[] = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: '帮我分析一下' },
      ];
      const tokens = await drainTokens(provider.stream(noKw, opts(new AbortController().signal)));
      expect(tokens).toEqual(['答']);
    });

    it('向后兼容: 未配 systemEchoKeyword → 纯 tokens 行为不变 (即便含 system 段 + 关键字)', async () => {
      const provider = new FakeLlmProvider({ tokens: ['答'] });
      const tokens = await drainTokens(
        provider.stream(withEchoKw, opts(new AbortController().signal)),
      );
      expect(tokens).toEqual(['答']);
    });
  });
});
