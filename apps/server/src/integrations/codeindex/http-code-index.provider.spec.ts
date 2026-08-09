import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpCodeIndexProvider } from './http-code-index.provider.js';
import type { CodeChunk, RepoCatalogEntry } from './code-index.port.js';

const CFG = {
  kind: 'http' as const,
  baseUrl: 'http://code-index:7700',
  serviceToken: 'secret-tok-xyz',
};

const hit: CodeChunk = {
  relPath: 'src/a.ts',
  kind: 'function',
  symbol: 'doA',
  startLine: 1,
  endLine: 5,
  score: 0.88,
  text: 'fn',
};
const repo: RepoCatalogEntry = {
  repo: 'mono',
  lastSha: 'sha',
  indexedAt: '2026-06-23T00:00:00.000Z',
  chunkCount: 3,
  status: 'ready',
};

/** 构造一个最小 Response 替身 (ok/status/json)。 */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('HttpCodeIndexProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('search', () => {
    it('POSTs /search with {repo,query,topK}, Bearer header, unwraps .results', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { results: [hit] }));
      const p = new HttpCodeIndexProvider(CFG);

      const out = await p.search('mono', 'how login');

      expect(out).toEqual([hit]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      // URL 拼接 (baseUrl 去尾斜杠 + /search)。
      expect(url).toBe('http://code-index:7700/search');
      expect(init.method).toBe('POST');
      // Authorization: Bearer <token> — token 真注入 header。
      expect(init.headers.authorization).toBe('Bearer secret-tok-xyz');
      expect(init.headers['content-type']).toBe('application/json');
      expect(JSON.parse(init.body)).toMatchObject({ repo: 'mono', query: 'how login' });
      expect(JSON.parse(init.body).topK).toBeGreaterThan(0);
      // AbortSignal 透传 (超时 / 上游合并)。
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('strips trailing slash from baseUrl (no //search)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { results: [] }));
      const p = new HttpCodeIndexProvider({ ...CFG, baseUrl: 'http://code-index:7700/' });
      await p.search('mono', 'q');
      expect(fetchMock.mock.calls[0][0]).toBe('http://code-index:7700/search');
    });

    it('returns [] when results field absent', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
      const p = new HttpCodeIndexProvider(CFG);
      await expect(p.search('mono', 'q')).resolves.toEqual([]);
    });

    it('throws on non-2xx (401 token error)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }));
      const p = new HttpCodeIndexProvider(CFG);
      await expect(p.search('mono', 'q')).rejects.toThrow(/HTTP 401/);
    });

    it('throws on 5xx', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'down' }));
      const p = new HttpCodeIndexProvider(CFG);
      await expect(p.search('mono', 'q')).rejects.toThrow(/HTTP 503/);
    });

    it('throws on network error (fetch rejects)', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
      const p = new HttpCodeIndexProvider(CFG);
      await expect(p.search('mono', 'q')).rejects.toThrow(/fetch failed/);
    });

    it('aborts via merged upstream signal (timeout/stop semantics) → throws', async () => {
      // fetch 实现尊重 signal：abort 即 reject AbortError。
      fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
      });
      const p = new HttpCodeIndexProvider(CFG);
      const ctrl = new AbortController();
      const pending = p.search('mono', 'q', ctrl.signal);
      ctrl.abort();
      await expect(pending).rejects.toThrow(/aborted/);
    });

    it('never includes the token in thrown error message', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
      const p = new HttpCodeIndexProvider(CFG);
      await expect(p.search('mono', 'q')).rejects.toThrow(
        expect.not.stringContaining('secret-tok-xyz'),
      );
    });
  });

  describe('listRepos', () => {
    it('GETs /repos with Bearer header, unwraps .repos', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { repos: [repo] }));
      const p = new HttpCodeIndexProvider(CFG);

      const out = await p.listRepos();

      expect(out).toEqual([repo]);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://code-index:7700/repos');
      expect(init.method).toBe('GET');
      expect(init.headers.authorization).toBe('Bearer secret-tok-xyz');
      // GET 无 body → 不带 content-type。
      expect(init.headers['content-type']).toBeUndefined();
      expect(init.body).toBeUndefined();
    });

    it('returns [] when repos field absent', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
      const p = new HttpCodeIndexProvider(CFG);
      await expect(p.listRepos()).resolves.toEqual([]);
    });

    it('throws on non-2xx', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(502, {}));
      const p = new HttpCodeIndexProvider(CFG);
      await expect(p.listRepos()).rejects.toThrow(/HTTP 502/);
    });
  });
});
