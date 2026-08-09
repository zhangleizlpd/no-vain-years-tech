// 032 T014 — ideation 澄清 SSE 帧解析纯逻辑单测（token 增量 / suggestion 收口 / [DONE] /
// error / 半帧缓冲 / 畸形忽略）。流 IO + 屏交互留 T017 e2e。
import { describe, expect, it } from 'vitest';
import { parseIdeationChunk, type NormalizedSuggestion } from './ideation-sse-parse';

const suggestion: NormalizedSuggestion = {
  question: '这个收藏功能面向谁？',
  options: [
    { label: '所有登录用户', recommended: true },
    { label: '仅 VIP' },
    { label: '我再想想', escapeHatch: true },
  ],
  multi_select: false,
  allow_freetext: true,
};

describe('parseIdeationChunk (T014)', () => {
  it('解析 token 帧（逐字符 drip 反问文本）', () => {
    const { frames, rest } = parseIdeationChunk('data:{"token":"想"}\n\ndata:{"token":"问"}\n\n');
    expect(frames).toEqual([
      { type: 'token', token: '想' },
      { type: 'token', token: '问' },
    ]);
    expect(rest).toBe('');
  });

  it('解析 suggestion 帧（过两闸整出一帧收口）', () => {
    const payload = `data:${JSON.stringify({ suggestion })}\n\n`;
    const { frames } = parseIdeationChunk(payload);
    expect(frames).toEqual([{ type: 'suggestion', suggestion }]);
  });

  it('解析 suggestion 帧含 option.fill（采纳整段推荐 chip）', () => {
    const withFill: NormalizedSuggestion = {
      question: '推荐成功标准如下…',
      options: [
        { label: '采纳（可再改）', recommended: true, fill: '1. 准确率100%\n2. ≤2步' },
        { label: '我要改', escapeHatch: true },
      ],
      multi_select: false,
      allow_freetext: true,
    };
    const { frames } = parseIdeationChunk(`data:${JSON.stringify({ suggestion: withFill })}\n\n`);
    // toEqual 深比含 option.fill → 断言 fill 字段原样往返 (server normalize → SSE → client parse)。
    expect(frames).toEqual([{ type: 'suggestion', suggestion: withFill }]);
  });

  it('解析 [DONE] 裸字面（不 JSON.parse）', () => {
    const { frames } = parseIdeationChunk('data:[DONE]\n\n');
    expect(frames).toEqual([{ type: 'done' }]);
  });

  it('解析 error 帧', () => {
    const { frames } = parseIdeationChunk('data:{"error":"provider 失败"}\n\n');
    expect(frames).toEqual([{ type: 'error', error: 'provider 失败' }]);
  });

  it('半帧缓冲：未闭合尾部原样回 rest（下个 chunk 拼前面）', () => {
    const first = parseIdeationChunk('data:{"token":"半');
    expect(first.frames).toEqual([]);
    expect(first.rest).toBe('data:{"token":"半');
    const second = parseIdeationChunk(first.rest + '帧"}\n\n');
    expect(second.frames).toEqual([{ type: 'token', token: '半帧' }]);
  });

  it('畸形 JSON / 未知 payload 忽略（容错心跳）', () => {
    const { frames } = parseIdeationChunk('data:not-json\n\ndata:{"unknown":1}\n\n: heartbeat\n\n');
    expect(frames).toEqual([]);
  });

  it('畸形 suggestion（缺 multi_select）忽略，不崩', () => {
    const bad = `data:${JSON.stringify({ suggestion: { question: 'q', options: [], allow_freetext: true } })}\n\n`;
    expect(parseIdeationChunk(bad).frames).toEqual([]);
  });

  it('混合帧 + token 在前 suggestion 在后顺序保持', () => {
    const payload = `data:{"token":"对焦"}\n\ndata:${JSON.stringify({ suggestion })}\n\ndata:[DONE]\n\n`;
    const { frames } = parseIdeationChunk(payload);
    expect(frames.map((f) => f.type)).toEqual(['token', 'suggestion', 'done']);
  });
});

describe('parseIdeationChunk · 034 接地三帧', () => {
  it('解析 tool_start 帧（检索开始指示）', () => {
    const { frames } = parseIdeationChunk('data:{"tool_start":"codeindex_retrieval"}\n\n');
    expect(frames).toEqual([{ type: 'tool_start', tool: 'codeindex_retrieval' }]);
  });

  it('解析 sources 帧（命中来源 ≤5，relPath/行号必有 + symbol 可选）', () => {
    const sources = [
      {
        relPath: 'apps/server/src/ideation/clarify-turn.usecase.ts',
        startLine: 294,
        endLine: 328,
        symbol: 'streamAskRound',
      },
      { relPath: 'services/code-index/src/query.ts', startLine: 5, endLine: 20 },
    ];
    const { frames } = parseIdeationChunk(`data:${JSON.stringify({ sources })}\n\n`);
    expect(frames).toEqual([{ type: 'sources', sources }]);
  });

  it('sources 帧剔除畸形项（缺 relPath / 行号非 number）+ ≤5 兜底', () => {
    const sources = [
      { relPath: 'a.ts', startLine: 1, endLine: 2 },
      { startLine: 1, endLine: 2 }, // 缺 relPath → 剔除
      { relPath: 'b.ts', startLine: 'x', endLine: 2 }, // 行号非 number → 剔除
      ...Array.from({ length: 6 }, (_v, i) => ({
        relPath: `f${i}.ts`,
        startLine: i,
        endLine: i + 1,
      })),
    ];
    const { frames } = parseIdeationChunk(`data:${JSON.stringify({ sources })}\n\n`);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'sources' });
    const parsed = frames[0] as { type: 'sources'; sources: unknown[] };
    expect(parsed.sources).toHaveLength(5); // 1 有效 + 4 凑满上限（剔 2 畸形后取前 5）
  });

  it('解析 notice 帧（降级系统气泡）', () => {
    const { frames } = parseIdeationChunk('data:{"notice":"grounding_degraded"}\n\n');
    expect(frames).toEqual([{ type: 'notice', notice: 'grounding_degraded' }]);
  });

  it('三帧与既有 token/suggestion/error 互不重叠，畸形帧返 null', () => {
    expect(parseIdeationChunk('data:{"sources":"not-array"}\n\n').frames).toEqual([]);
    expect(parseIdeationChunk('data:{"tool_start":123}\n\n').frames).toEqual([]);
    expect(parseIdeationChunk('data:{"notice":null}\n\n').frames).toEqual([]);
  });

  it('帧序 tool_start → sources → token → suggestion → done 顺序保持', () => {
    const sources = [{ relPath: 'a.ts', startLine: 1, endLine: 2 }];
    const payload =
      'data:{"tool_start":"codeindex_retrieval"}\n\n' +
      `data:${JSON.stringify({ sources })}\n\n` +
      'data:{"token":"据代码"}\n\n' +
      `data:${JSON.stringify({ suggestion })}\n\n` +
      'data:[DONE]\n\n';
    const { frames } = parseIdeationChunk(payload);
    expect(frames.map((f) => f.type)).toEqual([
      'tool_start',
      'sources',
      'token',
      'suggestion',
      'done',
    ]);
  });
});
