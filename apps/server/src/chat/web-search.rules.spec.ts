import { describe, it, expect } from 'vitest';
import {
  dedupAndNumber,
  topK,
  WEB_SEARCH_TOOL,
  DEFAULT_TOP_K,
  type NumberedSource,
} from './web-search.rules';
import type { SearchResult } from './search-provider.port';

/** 构造检索结果的小工厂 (只填关心的字段)。 */
function r(url: string, over: Partial<SearchResult> = {}): SearchResult {
  return { title: `T-${url}`, url, snippet: `S-${url}`, ...over };
}

describe('web-search.rules', () => {
  describe('topK', () => {
    it('默认截取 5 条 (DEFAULT_TOP_K)', () => {
      const results = Array.from({ length: 10 }, (_, i) => r(`u${i}`));
      expect(topK(results)).toHaveLength(DEFAULT_TOP_K);
      expect(topK(results).map((x) => x.url)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4']);
    });

    it('显式 k 截取', () => {
      const results = Array.from({ length: 10 }, (_, i) => r(`u${i}`));
      expect(topK(results, 2).map((x) => x.url)).toEqual(['u0', 'u1']);
    });

    it('结果不足 k → 原样返回', () => {
      const results = [r('a'), r('b')];
      expect(topK(results, 5)).toHaveLength(2);
    });

    it('k<=0 兜底回默认 5', () => {
      const results = Array.from({ length: 8 }, (_, i) => r(`u${i}`));
      expect(topK(results, 0)).toHaveLength(DEFAULT_TOP_K);
      expect(topK(results, -3)).toHaveLength(DEFAULT_TOP_K);
    });

    it('不修改入参', () => {
      const results = [r('a'), r('b'), r('c')];
      const snapshot = [...results];
      topK(results, 1);
      expect(results).toEqual(snapshot);
    });
  });

  describe('WEB_SEARCH_TOOL tool-def', () => {
    it('是 OpenAI function-calling 形状,name=web_search', () => {
      expect(WEB_SEARCH_TOOL.type).toBe('function');
      expect(WEB_SEARCH_TOOL.function.name).toBe('web_search');
    });

    it('query required,time_range 可选 enum', () => {
      const params = WEB_SEARCH_TOOL.function.parameters;
      expect(params.required).toEqual(['query']);
      expect(params.properties.query.type).toBe('string');
      expect(params.properties.time_range.type).toBe('string');
      expect(params.properties.time_range.enum).toContain('NoLimit');
    });
  });

  describe('dedupAndNumber', () => {
    it('空累计 + 一轮结果 → 1-based 顺序编号', () => {
      const out = dedupAndNumber([], [r('a'), r('b'), r('c')]);
      expect(out).toEqual<NumberedSource[]>([
        { index: 1, title: 'T-a', url: 'a' },
        { index: 2, title: 'T-b', url: 'b' },
        { index: 3, title: 'T-c', url: 'c' },
      ]);
    });

    it('多轮重叠 URL 去重,编号全局唯一稳定不串号 (FR-006)', () => {
      const round1 = dedupAndNumber([], [r('a'), r('b')]);
      // 第 2 轮:a 重复 (保留原 index=1), c/d 新增续号 3/4
      const round2 = dedupAndNumber(round1, [r('a'), r('c'), r('d')]);
      expect(round2.map((s) => [s.index, s.url])).toEqual([
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
        [4, 'd'],
      ]);
    });

    it('单轮内部重复 URL → 仅首次纳入', () => {
      const out = dedupAndNumber([], [r('a'), r('a'), r('b')]);
      expect(out.map((s) => s.url)).toEqual(['a', 'b']);
      expect(out.map((s) => s.index)).toEqual([1, 2]);
    });

    it('publishedAt 透传,缺省不带该字段', () => {
      const out = dedupAndNumber([], [r('a', { publishedAt: 123 }), r('b')]);
      expect(out[0]).toEqual({ index: 1, title: 'T-a', url: 'a', publishedAt: 123 });
      expect(out[1]).not.toHaveProperty('publishedAt');
    });

    it('content/snippet 不入持久化来源 (仅 index/title/url/publishedAt)', () => {
      const out = dedupAndNumber([], [r('a', { content: '长正文', snippet: 'snip' })]);
      expect(out[0]).not.toHaveProperty('content');
      expect(out[0]).not.toHaveProperty('snippet');
    });

    it('不修改入参 existing', () => {
      const existing: NumberedSource[] = [{ index: 1, title: 'T-a', url: 'a' }];
      const snapshot = JSON.parse(JSON.stringify(existing));
      dedupAndNumber(existing, [r('b')]);
      expect(existing).toEqual(snapshot);
    });

    it('全部重复 → 累计不变', () => {
      const round1 = dedupAndNumber([], [r('a'), r('b')]);
      const round2 = dedupAndNumber(round1, [r('a'), r('b')]);
      expect(round2).toEqual(round1);
    });
  });
});
