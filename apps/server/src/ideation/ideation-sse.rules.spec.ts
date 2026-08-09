import { describe, it, expect } from 'vitest';
import {
  toSseTokenFrame,
  toSseSuggestionFrame,
  toSseErrorFrame,
  toSseToolStartFrame,
  toSseSourcesFrame,
  toSseNoticeFrame,
  type SseSourceRef,
} from './ideation-sse.rules';

/** 帧 payload = `data:<json>\n\n`，剥壳取裸 JSON 段断言。 */
function payload(frame: string): unknown {
  expect(frame.startsWith('data:')).toBe(true);
  expect(frame.endsWith('\n\n')).toBe(true);
  return JSON.parse(frame.slice('data:'.length, -2));
}

describe('ideation-sse.rules / toSseToolStartFrame', () => {
  it('序列化为 {"tool_start":"codeindex_retrieval"} 帧', () => {
    expect(toSseToolStartFrame()).toBe('data:{"tool_start":"codeindex_retrieval"}\n\n');
  });

  it('判别键 .tool_start 不与既有帧 (token/suggestion/error) 重叠', () => {
    const p = payload(toSseToolStartFrame()) as Record<string, unknown>;
    expect(p).toHaveProperty('tool_start');
    expect(p).not.toHaveProperty('token');
    expect(p).not.toHaveProperty('suggestion');
    expect(p).not.toHaveProperty('error');
    expect(p).not.toHaveProperty('sources');
    expect(p).not.toHaveProperty('notice');
  });
});

describe('ideation-sse.rules / toSseSourcesFrame', () => {
  function ref(overrides: Partial<SseSourceRef> = {}): SseSourceRef {
    return { relPath: 'a/b.ts', startLine: 1, endLine: 9, ...overrides };
  }

  it('整出一帧 {"sources":[...]}，每条仅 relPath/startLine/endLine(+可选 symbol)', () => {
    const frame = toSseSourcesFrame([ref({ symbol: 'foo' })]);
    const p = payload(frame) as { sources: SseSourceRef[] };
    expect(p.sources).toEqual([{ relPath: 'a/b.ts', startLine: 1, endLine: 9, symbol: 'foo' }]);
  });

  it('symbol 为 null/缺省 → 省略该键 (与既有可选字段处理一致)', () => {
    const p = payload(toSseSourcesFrame([ref()])) as { sources: SseSourceRef[] };
    expect(p.sources[0]).not.toHaveProperty('symbol');
    expect(Object.keys(p.sources[0]).sort()).toEqual(['endLine', 'relPath', 'startLine']);
  });

  it('截断 ≤5：超 5 条只保留前 5', () => {
    const many = Array.from({ length: 8 }, (_, i) => ref({ relPath: `f${i}.ts` }));
    const p = payload(toSseSourcesFrame(many)) as { sources: SseSourceRef[] };
    expect(p.sources).toHaveLength(5);
    expect(p.sources.map((s) => s.relPath)).toEqual(['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts']);
  });

  it('恰 5 条 → 全保留', () => {
    const five = Array.from({ length: 5 }, (_, i) => ref({ relPath: `f${i}.ts` }));
    const p = payload(toSseSourcesFrame(five)) as { sources: SseSourceRef[] };
    expect(p.sources).toHaveLength(5);
  });

  it('空列表 → {"sources":[]}', () => {
    const p = payload(toSseSourcesFrame([])) as { sources: SseSourceRef[] };
    expect(p.sources).toEqual([]);
  });

  it('relPath 含引号/换行 → JSON 转义不破坏帧边界', () => {
    const frame = toSseSourcesFrame([ref({ relPath: 'a"b\nc.ts' })]);
    // 帧内不得出现裸 \n\n 以外的换行 (转义为 \\n)
    expect(frame.slice(0, -2)).not.toContain('\n');
    const p = payload(frame) as { sources: SseSourceRef[] };
    expect(p.sources[0].relPath).toBe('a"b\nc.ts');
  });

  it('判别键 .sources 不与既有/同期帧重叠', () => {
    const p = payload(toSseSourcesFrame([ref()])) as Record<string, unknown>;
    expect(p).toHaveProperty('sources');
    expect(p).not.toHaveProperty('token');
    expect(p).not.toHaveProperty('suggestion');
    expect(p).not.toHaveProperty('error');
    expect(p).not.toHaveProperty('tool_start');
    expect(p).not.toHaveProperty('notice');
  });
});

describe('ideation-sse.rules / toSseNoticeFrame', () => {
  it('序列化为 {"notice":"grounding_degraded"} 帧', () => {
    expect(toSseNoticeFrame('grounding_degraded')).toBe('data:{"notice":"grounding_degraded"}\n\n');
  });

  it('notice 文本经 JSON 转义 (引号/换行安全)', () => {
    const frame = toSseNoticeFrame('a"b\nc');
    expect(frame.slice(0, -2)).not.toContain('\n');
    const p = payload(frame) as { notice: string };
    expect(p.notice).toBe('a"b\nc');
  });

  it('判别键 .notice 不与既有/同期帧重叠', () => {
    const p = payload(toSseNoticeFrame('grounding_degraded')) as Record<string, unknown>;
    expect(p).toHaveProperty('notice');
    expect(p).not.toHaveProperty('token');
    expect(p).not.toHaveProperty('suggestion');
    expect(p).not.toHaveProperty('error');
    expect(p).not.toHaveProperty('tool_start');
    expect(p).not.toHaveProperty('sources');
  });
});

describe('ideation-sse.rules / 既有帧判别键互斥回归', () => {
  it('token/suggestion/error/tool_start/sources/notice 判别键两两不重叠', () => {
    const keys = [
      Object.keys(JSON.parse(toSseTokenFrame('x').slice(5, -2))),
      Object.keys(JSON.parse(toSseSuggestionFrame({} as never).slice(5, -2))),
      Object.keys(JSON.parse(toSseErrorFrame('x').slice(5, -2))),
      Object.keys(JSON.parse(toSseToolStartFrame().slice(5, -2))),
      Object.keys(JSON.parse(toSseSourcesFrame([]).slice(5, -2))),
      Object.keys(JSON.parse(toSseNoticeFrame('x').slice(5, -2))),
    ].flat();
    expect(new Set(keys).size).toBe(keys.length);
  });
});
