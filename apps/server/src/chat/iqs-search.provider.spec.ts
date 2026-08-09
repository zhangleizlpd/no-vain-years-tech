import { describe, it, expect, vi } from 'vitest';
import { IqsSearchProvider, normalizeIqsResponse, type FetchFn } from './iqs-search.provider';
import type { IqsConfig } from '../config/iqs.config';

const ALIYUN: IqsConfig = {
  kind: 'aliyun',
  apiKey: 'key-123',
  baseUrl: 'https://iqs.example.com',
};

/** 返回固定 JSON 的 stub fetch (ok=true)。 */
function okFetch(json: unknown): FetchFn {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => json }));
}

describe('normalizeIqsResponse', () => {
  it('pageItems[] → SearchResult[] 字段映射 (link→url / publishTime→publishedAt / markdownText→content)', () => {
    const out = normalizeIqsResponse({
      pageItems: [
        {
          title: 'T1',
          link: 'https://a.com',
          snippet: 's1',
          publishTime: 1700000000000,
          markdownText: 'md-body',
        },
      ],
    });
    expect(out).toEqual([
      {
        title: 'T1',
        url: 'https://a.com',
        snippet: 's1',
        publishedAt: 1700000000000,
        content: 'md-body',
      },
    ]);
  });

  it('content 回退 mainText (markdownText 缺省时)', () => {
    const out = normalizeIqsResponse({
      pageItems: [{ link: 'https://a.com', mainText: 'plain-body' }],
    });
    expect(out[0].content).toBe('plain-body');
  });

  it('丢弃无 link 的条目 (url 是去重主键)', () => {
    const out = normalizeIqsResponse({
      pageItems: [{ title: '无链接' }, { link: 'https://b.com' }],
    });
    expect(out.map((r) => r.url)).toEqual(['https://b.com']);
  });

  it('publishTime 字符串可 Date.parse → epoch ms;非法则不带', () => {
    const out = normalizeIqsResponse({
      pageItems: [
        { link: 'https://a.com', publishTime: '2023-11-14T00:00:00Z' },
        { link: 'https://b.com', publishTime: '不是日期' },
      ],
    });
    expect(out[0].publishedAt).toBe(Date.parse('2023-11-14T00:00:00Z'));
    expect(out[1]).not.toHaveProperty('publishedAt');
  });

  it('pageItems 缺省 / 非数组 → 空数组', () => {
    expect(normalizeIqsResponse({})).toEqual([]);
    expect(normalizeIqsResponse({ pageItems: null })).toEqual([]);
    expect(normalizeIqsResponse(null)).toEqual([]);
  });

  it('title 缺省回退 url,snippet 缺省空串', () => {
    const out = normalizeIqsResponse({ pageItems: [{ link: 'https://a.com' }] });
    expect(out[0]).toEqual({ title: 'https://a.com', url: 'https://a.com', snippet: '' });
  });
});

describe('IqsSearchProvider.search', () => {
  const ac = () => new AbortController();

  it('mock 配置被调用 → throw (误配:未启用 aliyun 也未走 Fake)', async () => {
    const p = new IqsSearchProvider({ kind: 'mock' }, okFetch({ pageItems: [] }));
    await expect(p.search('q', { signal: ac().signal })).rejects.toThrow(/not configured/);
  });

  it('aliyun:GET genericSearch?query=... + X-API-Key,query 转义,归一化返回', async () => {
    const fetchFn = okFetch({ pageItems: [{ link: 'https://a.com', title: 'A' }] });
    const p = new IqsSearchProvider(ALIYUN, fetchFn);
    const out = await p.search('上海天气', { signal: ac().signal });
    expect(out).toHaveLength(1);
    const [calledUrl, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    // GET + URL 含 query 参数 (中文 URL 编码)。
    expect(init.method).toBe('GET');
    expect(init.headers['X-API-Key']).toBe('key-123');
    expect(calledUrl).toContain('https://iqs.example.com/search/genericSearch?query=');
    expect(calledUrl).toContain(encodeURIComponent('上海天气').replace(/%20/g, '+'));
    // GET 无 body。
    expect(init).not.toHaveProperty('body');
  });

  it('maxResults 截取 top-K (控 context 预算)', async () => {
    const fetchFn = okFetch({
      pageItems: Array.from({ length: 18 }, (_, i) => ({ link: `https://a.com/${i}` })),
    });
    const p = new IqsSearchProvider(ALIYUN, fetchFn);
    expect(await p.search('q', { signal: ac().signal, maxResults: 5 })).toHaveLength(5);
    // 无 maxResults → 不截取。
    const fetchFn2 = okFetch({
      pageItems: Array.from({ length: 18 }, (_, i) => ({ link: `https://b.com/${i}` })),
    });
    const p2 = new IqsSearchProvider(ALIYUN, fetchFn2);
    expect(await p2.search('q', { signal: ac().signal })).toHaveLength(18);
  });

  it('HTTP !ok → throw HTTP 错误', async () => {
    const fetchFn: FetchFn = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));
    const p = new IqsSearchProvider(ALIYUN, fetchFn);
    await expect(p.search('q', { signal: ac().signal })).rejects.toThrow(/HTTP 503/);
  });

  it('硬超时触发 → throw timed out (注小 timeoutMs 验映射,不等 8s)', async () => {
    // hanging fetch:仅在 signal abort 时 reject,模拟真 fetch 被 AbortSignal 中断。
    const hanging: FetchFn = (_i, init) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
      });
    const p = new IqsSearchProvider(ALIYUN, hanging, 15);
    await expect(p.search('q', { signal: ac().signal })).rejects.toThrow(/timed out/);
  });

  it('调用方 signal abort → 透传中断 (非超时错误)', async () => {
    const hanging: FetchFn = (_i, init) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(new Error('caller-abort')), { once: true });
      });
    const controller = ac();
    const p = new IqsSearchProvider(ALIYUN, hanging, 5000);
    const promise = p.search('q', { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow(/caller-abort/);
  });
});
