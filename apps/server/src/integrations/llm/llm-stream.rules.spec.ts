import { describe, it, expect } from 'vitest';
import type { Msg } from './llm-provider.port.js';
import {
  accumulateToolCall,
  createThinkStripper,
  draftsToToolCalls,
  msgText,
  toApiMessages,
  type ToolCallDraft,
} from './llm-stream.rules.js';

/**
 * 030 A1 T018 — llm-stream.rules 纯函数单测。tool_call 累加 + Msg 映射(从 deepseek.provider
 * 抽出, 行为不变)+ createThinkStripper(MiniMax adaptive `<think>` 流式剥离, 重点覆盖跨 chunk
 * 边界拆分)。
 */

describe('accumulateToolCall + draftsToToolCalls', () => {
  it('单分片 → 完整 tool_call', () => {
    const drafts = new Map<number, ToolCallDraft>();
    accumulateToolCall(drafts, {
      index: 0,
      id: 'call_1',
      function: { name: 'web_search', arguments: '{"query":"上海天气"}' },
    });
    expect(draftsToToolCalls(drafts)).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'web_search', arguments: '{"query":"上海天气"}' },
      },
    ]);
  });

  it('arguments 多分片 → 按 index 拼接', () => {
    const drafts = new Map<number, ToolCallDraft>();
    accumulateToolCall(drafts, { index: 0, id: 'c1', function: { name: 'web_search' } });
    accumulateToolCall(drafts, { index: 0, function: { arguments: '{"que' } });
    accumulateToolCall(drafts, { index: 0, function: { arguments: 'ry":"x"}' } });
    expect(draftsToToolCalls(drafts)[0].function).toEqual({
      name: 'web_search',
      arguments: '{"query":"x"}',
    });
  });

  it('多 index → 按 index 升序输出, id 缺失兜底 call_<index>', () => {
    const drafts = new Map<number, ToolCallDraft>();
    accumulateToolCall(drafts, { index: 1, function: { name: 'b', arguments: '{}' } });
    accumulateToolCall(drafts, { index: 0, id: 'c0', function: { name: 'a', arguments: '{}' } });
    const calls = draftsToToolCalls(drafts);
    expect(calls.map((c) => [c.id, c.function.name])).toEqual([
      ['c0', 'a'],
      ['call_1', 'b'],
    ]);
  });
});

describe('toApiMessages', () => {
  it('映射 user/assistant/system/tool + assistant.toolCalls', () => {
    const msgs: Msg[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: '[result]', toolCallId: 'c1' },
      { role: 'assistant', content: '答案' },
    ];
    expect(toApiMessages(msgs)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: '[result]', tool_call_id: 'c1' },
      { role: 'assistant', content: '答案' },
    ]);
  });

  it('tool 角色缺 toolCallId → 兜底空串', () => {
    expect(toApiMessages([{ role: 'tool', content: 'r' }])).toEqual([
      { role: 'tool', content: 'r', tool_call_id: '' },
    ]);
  });

  // 036 T004: Msg.content 扩 string | MsgPart[]（OpenAI vision content parts）。
  it('036 string content → 旧形状原样不变（纯文本零回归, SC-005）', () => {
    const msgs: Msg[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '纯文本' },
      { role: 'assistant', content: '回答' },
    ];
    // 与扩 union 前完全一致：content 仍是 string。
    expect(toApiMessages(msgs)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '纯文本' },
      { role: 'assistant', content: '回答' },
    ]);
  });

  it('036 MsgPart[] content → 原样透传 OpenAI image_url + text content parts', () => {
    const msgs: Msg[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张图：1：左上角 2：右下角' },
          { type: 'image_url', image_url: { url: 'https://oss.example/ideation/1/burned.png' } },
        ],
      },
    ];
    expect(toApiMessages(msgs)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张图：1：左上角 2：右下角' },
          { type: 'image_url', image_url: { url: 'https://oss.example/ideation/1/burned.png' } },
        ],
      },
    ]);
  });
});

describe('036 msgText（content union → 纯文本提取，token 估算 / 关键字匹配用）', () => {
  it('string content → 原样返回', () => {
    expect(msgText('纯文本')).toBe('纯文本');
  });

  it('MsgPart[] content → 仅拼接 text part（image_url 不计文本）', () => {
    expect(
      msgText([
        { type: 'text', text: '一' },
        { type: 'image_url', image_url: { url: 'https://x/y.png' } },
        { type: 'text', text: '二' },
      ]),
    ).toBe('一二');
  });

  it('无 text part（仅图）→ 空串', () => {
    expect(msgText([{ type: 'image_url', image_url: { url: 'https://x/y.png' } }])).toBe('');
  });
});

describe('createThinkStripper', () => {
  // 把多段 push 的可见输出 + flush 拼起来, 便于断言最终可见正文。
  const run = (frags: string[]): string => {
    const s = createThinkStripper();
    let out = '';
    for (const f of frags) out += s.push(f);
    out += s.flush();
    return out;
  };

  it('无 think → 原样透传', () => {
    expect(run(['你好', '世界'])).toBe('你好世界');
  });

  it('单段内联 think → 剥离, 前后正文保留', () => {
    expect(run(['答案前<think>推理内容</think>答案后'])).toBe('答案前答案后');
  });

  it('开标签跨 chunk 拆分(<thi|nk>) → 仍剥离', () => {
    expect(run(['前<thi', 'nk>密<', '/think>后'])).toBe('前后');
  });

  it('闭标签跨 chunk 拆分(</thi|nk>) → 仍剥离', () => {
    expect(run(['<think>密文</thi', 'nk>可见'])).toBe('可见');
  });

  it('think 内容逐字符分片 → 全部吞掉', () => {
    expect(run([...'A<think>xyz</think>B'])).toBe('AB');
  });

  it('未闭合 think 到流尾 → 丢弃(不漏推理)', () => {
    expect(run(['可见<think>未闭合推理'])).toBe('可见');
  });

  it('流尾残留未完成开标签 → 当字面量吐出', () => {
    expect(run(['尾巴<thi'])).toBe('尾巴<thi');
  });

  it('似是而非的开标签前缀(<thinking)→ 非 think, 原样吐', () => {
    expect(run(['<thinking>不是think标签'])).toBe('<thinking>不是think标签');
  });

  it('多段 think → 全部剥离', () => {
    expect(run(['a<think>x</think>b<think>y</think>c'])).toBe('abc');
  });
});
