// 027 T010 — SSE 帧解析纯函数红绿。
// 帧契约 SoT = apps/server/src/chat/sse.rules.ts（token / [DONE] / error 三类）。
// 最易错点 = 跨 chunk 半帧缓冲（getReader chunk 边界不保证落在 \n\n 上）。
import { describe, expect, it } from 'vitest';
import { parseSseChunk } from './sse-parse';

describe('parseSseChunk', () => {
  it('单帧 token：一个完整 data 帧 → 一个 token frame、rest 空', () => {
    const { frames, rest } = parseSseChunk('data:{"token":"你好"}\n\n');
    expect(frames).toEqual([{ type: 'token', token: '你好' }]);
    expect(rest).toBe('');
  });

  it('多帧一次到：两个完整帧 → 两个 token frame 按序', () => {
    const { frames, rest } = parseSseChunk('data:{"token":"a"}\n\ndata:{"token":"b"}\n\n');
    expect(frames).toEqual([
      { type: 'token', token: 'a' },
      { type: 'token', token: 'b' },
    ]);
    expect(rest).toBe('');
  });

  it('跨 chunk 半帧缓冲（核心）：未闭合尾部进 rest，下次拼接补全', () => {
    // chunk1 收到一个完整帧 + 半个帧（无 \n\n 结尾）。
    const first = parseSseChunk('data:{"token":"a"}\n\ndata:{"tok');
    expect(first.frames).toEqual([{ type: 'token', token: 'a' }]);
    expect(first.rest).toBe('data:{"tok');

    // chunk2 拼上 rest 后补全前一帧 + 带新完整帧。
    const second = parseSseChunk(first.rest + 'en":"b"}\n\ndata:{"token":"c"}\n\n');
    expect(second.frames).toEqual([
      { type: 'token', token: 'b' },
      { type: 'token', token: 'c' },
    ]);
    expect(second.rest).toBe('');
  });

  it('DONE 哨兵：data:[DONE] → done frame，不对其 JSON.parse', () => {
    const { frames, rest } = parseSseChunk('data:[DONE]\n\n');
    expect(frames).toEqual([{ type: 'done' }]);
    expect(rest).toBe('');
  });

  it('token 帧 + DONE 一次到：先 token 后 done', () => {
    const { frames } = parseSseChunk('data:{"token":"末"}\n\ndata:[DONE]\n\n');
    expect(frames).toEqual([{ type: 'token', token: '末' }, { type: 'done' }]);
  });

  it('error 帧：payload 含 .error → error frame', () => {
    const { frames } = parseSseChunk('data:{"error":"上游超时"}\n\n');
    expect(frames).toEqual([{ type: 'error', error: '上游超时' }]);
  });

  it('中文多字节：token 含多字节字符 JSON 转义后还原', () => {
    const { frames } = parseSseChunk('data:{"token":"中文😀混排"}\n\n');
    expect(frames).toEqual([{ type: 'token', token: '中文😀混排' }]);
  });

  it('token 内含换行/引号：JSON 转义不破坏帧边界', () => {
    // server 端 JSON.stringify({token}) 保证内含 \n 不出现裸 \n\n。
    const payload = JSON.stringify({ token: 'line1\nline2"q"' });
    const { frames } = parseSseChunk(`data:${payload}\n\n`);
    expect(frames).toEqual([{ type: 'token', token: 'line1\nline2"q"' }]);
  });

  it('空 chunk：无帧、rest 空', () => {
    const { frames, rest } = parseSseChunk('');
    expect(frames).toEqual([]);
    expect(rest).toBe('');
  });

  it('纯半帧 chunk：无完整帧、整段进 rest', () => {
    const { frames, rest } = parseSseChunk('data:{"tok');
    expect(frames).toEqual([]);
    expect(rest).toBe('data:{"tok');
  });

  // 030 联网工具帧（plan D5）—— 按 payload 字段判别，与 token/error 帧不重叠。
  describe('030 联网工具帧', () => {
    it('tool_start 帧：{tool,status:start,query} → tool_start frame', () => {
      const payload = JSON.stringify({ tool: 'web_search', status: 'start', query: '今天天气' });
      const { frames } = parseSseChunk(`data:${payload}\n\n`);
      expect(frames).toEqual([{ type: 'tool_start', query: '今天天气' }]);
    });

    it('tool_result 帧：{tool,status:result,count,sources} → tool_result frame（带原始页数 + 摘要源）', () => {
      const payload = JSON.stringify({
        tool: 'web_search',
        status: 'result',
        count: 5,
        sources: [
          { title: 'A', url: 'https://a.com' },
          { title: 'B', url: 'https://b.com' },
        ],
      });
      const { frames } = parseSseChunk(`data:${payload}\n\n`);
      expect(frames).toEqual([
        {
          type: 'tool_result',
          count: 5,
          sources: [
            { title: 'A', url: 'https://a.com' },
            { title: 'B', url: 'https://b.com' },
          ],
        },
      ]);
    });

    it('degraded 帧：{degraded:true} → degraded frame', () => {
      const { frames } = parseSseChunk('data:{"degraded":true}\n\n');
      expect(frames).toEqual([{ type: 'degraded' }]);
    });

    it('degraded:false → 不产 degraded frame（仅 true 判降级）', () => {
      const { frames } = parseSseChunk('data:{"degraded":false}\n\n');
      expect(frames).toEqual([]);
    });

    it('sources 帧：{sources:[{index,title,url,publishedAt?}]} → sources frame（完整编号来源）', () => {
      const payload = JSON.stringify({
        sources: [
          { index: 1, title: 'A', url: 'https://a.com', publishedAt: 1700000000000 },
          { index: 2, title: 'B', url: 'https://b.com' },
        ],
      });
      const { frames } = parseSseChunk(`data:${payload}\n\n`);
      expect(frames).toEqual([
        {
          type: 'sources',
          sources: [
            { index: 1, title: 'A', url: 'https://a.com', publishedAt: 1700000000000 },
            { index: 2, title: 'B', url: 'https://b.com' },
          ],
        },
      ]);
    });

    it('工具帧不破坏 027：token + tool_start + tool_result + sources + DONE 一次到，按序', () => {
      const buf = [
        'data:{"token":"答"}',
        JSON.stringify({ tool: 'web_search', status: 'start', query: 'q' }).replace(/^/, 'data:'),
        JSON.stringify({ tool: 'web_search', status: 'result', count: 2, sources: [] }).replace(
          /^/,
          'data:',
        ),
        JSON.stringify({ sources: [{ index: 1, title: 'T', url: 'https://t.com' }] }).replace(
          /^/,
          'data:',
        ),
        'data:[DONE]',
        '',
      ].join('\n\n');
      const { frames } = parseSseChunk(buf);
      expect(frames).toEqual([
        { type: 'token', token: '答' },
        { type: 'tool_start', query: 'q' },
        { type: 'tool_result', count: 2, sources: [] },
        { type: 'sources', sources: [{ index: 1, title: 'T', url: 'https://t.com' }] },
        { type: 'done' },
      ]);
    });

    it('未知 tool status（既非 start 也非 result）→ 忽略，不崩', () => {
      const payload = JSON.stringify({ tool: 'web_search', status: 'weird' });
      const { frames } = parseSseChunk(`data:${payload}\n\n`);
      expect(frames).toEqual([]);
    });
  });
});
