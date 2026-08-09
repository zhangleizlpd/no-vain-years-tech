import { describe, it, expect } from 'vitest';
import {
  interviewToolsFor,
  toSourceRefs,
  TOOL_CODEINDEX_RETRIEVAL,
  TOOL_ASK_CLARIFYING_QUESTION,
} from './ideation-tools';
import type { CodeChunk } from '../integrations/codeindex/code-index.port';
import type { SseSourceRef } from './ideation-sse.rules';

describe('ideation-tools / interviewToolsFor (条件注册 FR-007)', () => {
  it('repo 非空 → 含 codeindex_retrieval + ask (检索工具给 LLM)', () => {
    const names = interviewToolsFor('mono').map((t) => t.function.name);
    expect(names).toEqual([TOOL_CODEINDEX_RETRIEVAL, TOOL_ASK_CLARIFYING_QUESTION]);
  });

  it('repo null → 仅 ask (未选仓不把 codeindex_retrieval 给 LLM)', () => {
    const names = interviewToolsFor(null).map((t) => t.function.name);
    expect(names).toEqual([TOOL_ASK_CLARIFYING_QUESTION]);
    expect(names).not.toContain(TOOL_CODEINDEX_RETRIEVAL);
  });

  it('repo 空串 → 视同未选仓, 仅 ask (空仓名不开检索)', () => {
    const names = interviewToolsFor('').map((t) => t.function.name);
    expect(names).toEqual([TOOL_ASK_CLARIFYING_QUESTION]);
  });

  it('repo 纯空白 → 视同未选仓, 仅 ask', () => {
    expect(interviewToolsFor('   ').map((t) => t.function.name)).toEqual([
      TOOL_ASK_CLARIFYING_QUESTION,
    ]);
  });
});

describe('ideation-tools / toSourceRefs (来源映射, 截 ≤5)', () => {
  function chunk(overrides: Partial<CodeChunk> = {}): CodeChunk {
    return {
      relPath: 'a/b.ts',
      kind: 'function',
      symbol: 'foo',
      startLine: 10,
      endLine: 20,
      score: 0.9,
      text: 'body',
      ...overrides,
    };
  }

  it('映射出 {relPath,startLine,endLine,symbol} —— 丢弃 kind/score/text', () => {
    const refs = toSourceRefs([chunk()]);
    const expected: SseSourceRef = {
      relPath: 'a/b.ts',
      startLine: 10,
      endLine: 20,
      symbol: 'foo',
    };
    expect(refs).toEqual([expected]);
    expect(refs[0]).not.toHaveProperty('kind');
    expect(refs[0]).not.toHaveProperty('score');
    expect(refs[0]).not.toHaveProperty('text');
  });

  it('symbol 为 null → 省略 symbol 键 (整文件块无符号名)', () => {
    const refs = toSourceRefs([chunk({ symbol: null })]);
    expect(refs[0]).not.toHaveProperty('symbol');
    expect(Object.keys(refs[0]).sort()).toEqual(['endLine', 'relPath', 'startLine']);
  });

  it('截断 ≤5: 8 命中只取前 5', () => {
    const many = Array.from({ length: 8 }, (_, i) => chunk({ relPath: `f${i}.ts` }));
    const refs = toSourceRefs(many);
    expect(refs).toHaveLength(5);
    expect(refs.map((r) => r.relPath)).toEqual(['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts']);
  });

  it('恰 5 → 全保留; 空 → 空', () => {
    expect(toSourceRefs(Array.from({ length: 5 }, () => chunk()))).toHaveLength(5);
    expect(toSourceRefs([])).toEqual([]);
  });
});
