import { describe, it, expect } from 'vitest';
import type { Msg, LlmProvider, LlmStreamEvent, LlmStreamOptions } from './llm-provider.port';
import { RoutingLlmProvider } from './llm-router.provider';

/**
 * 029 收口 RoutingLlmProvider — 纯逻辑 (按 opts.model 委托, 无 DB / 无外呼)。
 * 验: minimax → minimax delegate; flash/pro/未知 → deepseek delegate (兜底); 透传 model + tools。
 */

/** 记录被调 delegate 与传入 model/tools 的假 provider (吐自身 tag 作 token 便于断言)。 */
function recordingProvider(tag: string, calls: string[]): LlmProvider {
  return {
    async *stream(_messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
      calls.push(`${tag}:${opts.model}:tools=${opts.tools ? opts.tools.length : 0}`);
      yield { kind: 'token', text: tag };
    },
  };
}

async function drain(stream: AsyncIterable<LlmStreamEvent>): Promise<string[]> {
  const out: string[] = [];
  for await (const e of stream) {
    if (e.kind === 'token') out.push(e.text);
  }
  return out;
}

describe('029 RoutingLlmProvider (按逻辑 model 委托)', () => {
  const messages: Msg[] = [{ role: 'user', content: 'hi' }];
  const { signal } = new AbortController();

  it('minimax → minimax delegate (透传 model)', async () => {
    const calls: string[] = [];
    const router = new RoutingLlmProvider(
      recordingProvider('deepseek', calls),
      recordingProvider('minimax', calls),
    );
    const out = await drain(router.stream(messages, { signal, model: 'minimax' }));
    expect(out).toEqual(['minimax']);
    expect(calls).toEqual(['minimax:minimax:tools=0']);
  });

  it.each(['flash', 'pro', 'deepseek-chat', 'unknown'])(
    '%s → deepseek delegate (非 minimax 一律兜底 DeepSeek)',
    async (model) => {
      const calls: string[] = [];
      const router = new RoutingLlmProvider(
        recordingProvider('deepseek', calls),
        recordingProvider('minimax', calls),
      );
      const out = await drain(router.stream(messages, { signal, model }));
      expect(out).toEqual(['deepseek']);
      expect(calls).toEqual([`deepseek:${model}:tools=0`]);
    },
  );

  it('030: opts.tools 整体透传委托 (路由不动 tools)', async () => {
    const calls: string[] = [];
    const router = new RoutingLlmProvider(
      recordingProvider('deepseek', calls),
      recordingProvider('minimax', calls),
    );
    await drain(
      router.stream(messages, {
        signal,
        model: 'flash',
        tools: [{ type: 'function', function: { name: 'web_search' } }],
      }),
    );
    expect(calls).toEqual(['deepseek:flash:tools=1']);
  });
});
