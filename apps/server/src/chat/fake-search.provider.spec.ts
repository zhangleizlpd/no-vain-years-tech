import { describe, it, expect } from 'vitest';
import { FakeSearchProvider } from './fake-search.provider';
import type { SearchResult } from './search-provider.port';

const r = (url: string): SearchResult => ({ title: `T-${url}`, url, snippet: '' });

describe('FakeSearchProvider', () => {
  const sig = () => new AbortController().signal;

  it('scripted:按调用序返回每轮结果批', async () => {
    const p = new FakeSearchProvider({ results: [[r('a')], [r('b'), r('c')]] });
    expect(await p.search('q1', { signal: sig() })).toEqual([r('a')]);
    expect(await p.search('q2', { signal: sig() })).toEqual([r('b'), r('c')]);
  });

  it('超出 scripted 长度 → 零结果空数组 (非 error)', async () => {
    const p = new FakeSearchProvider({ results: [[r('a')]] });
    await p.search('q1', { signal: sig() });
    expect(await p.search('q2', { signal: sig() })).toEqual([]);
  });

  it('error=true → 每次 throw (模拟后端失败)', async () => {
    const p = new FakeSearchProvider({ error: true });
    await expect(p.search('q', { signal: sig() })).rejects.toThrow(/FAKE_SEARCH_ERROR/);
  });

  it('errorOnCall:仅第 N 次失败 (前轮成功后某轮降级)', async () => {
    const p = new FakeSearchProvider({ results: [[r('a')], [], []], errorOnCall: 1 });
    expect(await p.search('q1', { signal: sig() })).toEqual([r('a')]);
    await expect(p.search('q2', { signal: sig() })).rejects.toThrow(/FAKE_SEARCH_ERROR/);
  });

  it('已 abort 的 signal → 立即 throw', async () => {
    const c = new AbortController();
    c.abort();
    const p = new FakeSearchProvider({ results: [[r('a')]] });
    await expect(p.search('q', { signal: c.signal })).rejects.toThrow(/ABORTED/);
  });

  it('delay 期间 abort → throw (在途检索取消)', async () => {
    const c = new AbortController();
    const p = new FakeSearchProvider({ results: [[r('a')]], delayMs: 1000 });
    const promise = p.search('q', { signal: c.signal });
    c.abort();
    await expect(promise).rejects.toThrow(/ABORTED/);
  });

  it('空配置 → 零结果 (默认安全)', async () => {
    const p = new FakeSearchProvider();
    expect(await p.search('q', { signal: sig() })).toEqual([]);
  });

  // 030 T016 content-driven 降级:env 注入路无法 .overrideProvider 注 error, 按 query 标记自决。
  it('failOnQueryMarker:query 含标记 → throw (驱动 FR-009 降级)', async () => {
    const p = new FakeSearchProvider({ results: [[r('a')]], failOnQueryMarker: 'FAIL' });
    await expect(p.search('帮我查 FAIL 这个话题', { signal: sig() })).rejects.toThrow(
      /FAKE_SEARCH_ERROR/,
    );
  });

  it('failOnQueryMarker:query 不含标记 → 正常返结果 (向后兼容)', async () => {
    const p = new FakeSearchProvider({ results: [[r('a')]], failOnQueryMarker: 'FAIL' });
    expect(await p.search('普通查询', { signal: sig() })).toEqual([r('a')]);
  });
});
