import { describe, it, expect } from 'vitest';
import {
  toSseFrame,
  toSseErrorFrame,
  SSE_DONE,
  toSseToolStartFrame,
  toSseToolResultFrame,
  toSseDegradedFrame,
  toSseSourcesFrame,
} from './sse.rules';
import type { NumberedSource } from './web-search.rules';

describe('sse.rules', () => {
  describe('SSE_DONE 哨兵', () => {
    it('是裸 [DONE] 字面 (非 JSON) + 帧边界 \\n\\n', () => {
      expect(SSE_DONE).toBe('data:[DONE]\n\n');
    });
  });

  describe('toSseFrame', () => {
    it('普通 token: payload = {"token":"..."} 包成单帧, 以 \\n\\n 结尾', () => {
      expect(toSseFrame('hi')).toBe('data:{"token":"hi"}\n\n');
    });

    it('token 含双引号: JSON 序列化转义, 不破坏 SSE payload', () => {
      // 内含引号经 JSON.stringify 转义为 \" —— 解析端 JSON.parse 可还原
      expect(toSseFrame('say "hi"')).toBe('data:{"token":"say \\"hi\\""}\n\n');
    });

    it('token 含换行: JSON 序列化转义为 \\n, 不引入裸换行破坏帧边界 \\n\\n', () => {
      const frame = toSseFrame('line1\nline2');
      expect(frame).toBe('data:{"token":"line1\\nline2"}\n\n');
      // 关键不变量: 帧内唯一的裸 \n\n 是末尾边界, 中间换行已转义不会被解析端误切帧
      expect(frame.indexOf('\n\n')).toBe(frame.length - 2);
    });

    it('多字节中文 token: JSON 序列化 + 还原往返一致', () => {
      const frame = toSseFrame('你好世界');
      expect(frame).toBe('data:{"token":"你好世界"}\n\n');
      // 解析端往返: 去 data: 前缀 + JSON.parse 取回原 token
      const payload = frame.slice('data:'.length, -2);
      expect(JSON.parse(payload).token).toBe('你好世界');
    });

    it('空字符串 token: 仍产合法帧', () => {
      expect(toSseFrame('')).toBe('data:{"token":""}\n\n');
    });

    it('token 含反斜杠: 正确转义', () => {
      expect(toSseFrame('a\\b')).toBe('data:{"token":"a\\\\b"}\n\n');
    });
  });

  describe('toSseErrorFrame', () => {
    it('error message: payload = {"error":"..."} 包成单帧', () => {
      expect(toSseErrorFrame('上游超时')).toBe('data:{"error":"上游超时"}\n\n');
    });

    it('error message 含引号/换行: JSON 转义', () => {
      const frame = toSseErrorFrame('boom\n"x"');
      expect(frame).toBe('data:{"error":"boom\\n\\"x\\""}\n\n');
      expect(frame.indexOf('\n\n')).toBe(frame.length - 2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 030 联网工具帧 (plan D5) —— 向后兼容: token/DONE/error 帧不变, 新帧靠 payload
  // 字段 (tool/degraded/sources) 区分, 解析端按字段分派。
  // ───────────────────────────────────────────────────────────────────────────

  describe('toSseToolStartFrame', () => {
    it('包成 {"tool":"web_search","status":"start","query":"..."} 单帧', () => {
      expect(toSseToolStartFrame({ query: '今日天气' })).toBe(
        'data:{"tool":"web_search","status":"start","query":"今日天气"}\n\n',
      );
    });

    it('query 含引号/换行: JSON 转义, 不破坏帧边界', () => {
      const frame = toSseToolStartFrame({ query: 'a\n"b"' });
      expect(frame).toBe('data:{"tool":"web_search","status":"start","query":"a\\n\\"b\\""}\n\n');
      expect(frame.indexOf('\n\n')).toBe(frame.length - 2);
    });
  });

  describe('toSseToolResultFrame', () => {
    it('包成 {"tool":...,"status":"result","count":N,"sources":[{title,url}]} 单帧', () => {
      const frame = toSseToolResultFrame({
        count: 2,
        sources: [
          { title: 'T1', url: 'https://a' },
          { title: 'T2', url: 'https://b' },
        ],
      });
      expect(frame).toBe(
        'data:{"tool":"web_search","status":"result","count":2,' +
          '"sources":[{"title":"T1","url":"https://a"},{"title":"T2","url":"https://b"}]}\n\n',
      );
    });

    it('count=0 + 空 sources 仍产合法帧', () => {
      expect(toSseToolResultFrame({ count: 0, sources: [] })).toBe(
        'data:{"tool":"web_search","status":"result","count":0,"sources":[]}\n\n',
      );
    });

    it('source title/url 含引号: JSON 转义, 边界唯一', () => {
      const frame = toSseToolResultFrame({
        count: 1,
        sources: [{ title: 'say "hi"', url: 'https://x?q="y"' }],
      });
      expect(frame.startsWith('data:')).toBe(true);
      expect(frame.indexOf('\n\n')).toBe(frame.length - 2);
      const parsed = JSON.parse(frame.slice('data:'.length, -2));
      expect(parsed.sources[0].title).toBe('say "hi"');
      expect(parsed.sources[0].url).toBe('https://x?q="y"');
    });
  });

  describe('toSseDegradedFrame', () => {
    it('固定 {"degraded":true} 单帧', () => {
      expect(toSseDegradedFrame()).toBe('data:{"degraded":true}\n\n');
    });
  });

  describe('toSseSourcesFrame', () => {
    it('完整编号来源 {"sources":[{index,title,url}]} 供 [N]→源映射', () => {
      const sources: NumberedSource[] = [
        { index: 1, title: 'T1', url: 'https://a' },
        { index: 2, title: 'T2', url: 'https://b', publishedAt: 123 },
      ];
      const frame = toSseSourcesFrame(sources);
      expect(frame.startsWith('data:{"sources":[')).toBe(true);
      expect(frame.indexOf('\n\n')).toBe(frame.length - 2);
      const parsed = JSON.parse(frame.slice('data:'.length, -2));
      expect(parsed.sources).toEqual(sources);
    });

    it('空来源 → {"sources":[]} 合法帧', () => {
      expect(toSseSourcesFrame([])).toBe('data:{"sources":[]}\n\n');
    });
  });

  describe('帧分派不冲突 (向后兼容)', () => {
    it('新帧 payload 含 tool/degraded/sources 字段, 与 token/error 帧字段不重叠', () => {
      const toolStart = JSON.parse(toSseToolStartFrame({ query: 'q' }).slice('data:'.length, -2));
      const toolResult = JSON.parse(
        toSseToolResultFrame({ count: 0, sources: [] }).slice('data:'.length, -2),
      );
      const degraded = JSON.parse(toSseDegradedFrame().slice('data:'.length, -2));
      const sources = JSON.parse(toSseSourcesFrame([]).slice('data:'.length, -2));
      const token = JSON.parse(toSseFrame('x').slice('data:'.length, -2));
      const err = JSON.parse(toSseErrorFrame('e').slice('data:'.length, -2));

      // token 帧靠 .token / error 帧靠 .error 识别 → 新帧均无这两字段
      for (const p of [toolStart, toolResult, degraded, sources]) {
        expect(p).not.toHaveProperty('token');
        expect(p).not.toHaveProperty('error');
      }
      // 各新帧有专属判别字段
      expect(toolStart).toHaveProperty('tool');
      expect(toolResult).toHaveProperty('tool');
      expect(degraded.degraded).toBe(true);
      expect(sources).toHaveProperty('sources');
      // 旧帧字段保持
      expect(token).toHaveProperty('token');
      expect(err).toHaveProperty('error');
    });

    it('DONE 帧仍是裸 [DONE], 与所有 JSON 帧字面可区分', () => {
      expect(SSE_DONE).toBe('data:[DONE]\n\n');
    });
  });
});
