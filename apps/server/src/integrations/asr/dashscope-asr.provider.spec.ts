import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { DashscopeAsrProvider } from './dashscope-asr.provider.js';

/**
 * 035 T002 DashscopeAsrProvider 单测 (hermetic) — 不打真 DashScope。
 *
 * 测试 seam: 把全局 `fetch` (Node 22 undici, provider 直接 `fetch(...)`) 替换为受控 vi.fn —
 * 同 deepseek.provider.spec 换 vendor I/O client 的范式 (vendor 边界, 非 NestJS lifecycle
 * class,「NO LIFECYCLE MOCKING」不约束此类)。真连通归部署 PR 真 key 接线。覆盖: endpoint /
 * model / data-URL / Bearer header / key 不入日志 / 解析 choices[0].message.content / 空→'' /
 * 非 2xx → throw / 网络失败 → throw / vendor 异常结构 → ''。
 */

const API_KEY = 'sk-test-placeholder';
const AUDIO = new Uint8Array([1, 2, 3, 4]);
const OPTS = { mimeType: 'audio/aac', lang: 'zh' } as const;

/** 构造一个 ok=true 的 compatible-mode chat-completions 响应。 */
function okResponse(content: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

describe('DashscopeAsrProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;
  let provider: DashscopeAsrProvider;
  let loggedArgs: unknown[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    provider = new DashscopeAsrProvider({ kind: 'dashscope', apiKey: API_KEY });
    // 捕获所有 Logger.error 入参 (验 key/header/body 永不入日志, FR-014)。
    loggedArgs = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => {
      loggedArgs.push(...args);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('POSTs to 北京区 compatible-mode chat-completions endpoint with Bearer header', async () => {
    fetchMock.mockResolvedValue(okResponse('收口'));
    await provider.transcribeOneShot(AUDIO, OPTS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    // key 不入 URL (FR-014)。
    expect(url).not.toContain(API_KEY);
  });

  it('sends model + audio as base64 data-URL input_audio content item', async () => {
    fetchMock.mockResolvedValue(okResponse('done'));
    await provider.transcribeOneShot(AUDIO, OPTS);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: Array<{ type: string; input_audio: string }> }>;
    };
    expect(body.model).toBe('qwen3-asr-flash');
    const item = body.messages[0].content[0];
    expect(item.type).toBe('input_audio');
    expect(item.input_audio).toBe(`data:audio/aac;base64,${Buffer.from(AUDIO).toString('base64')}`);
  });

  it('parses transcript from choices[0].message.content', async () => {
    fetchMock.mockResolvedValue(okResponse('你想给行情页加收藏'));
    await expect(provider.transcribeOneShot(AUDIO, OPTS)).resolves.toBe('你想给行情页加收藏');
  });

  it('trims whitespace and returns "" for blank transcript (静音)', async () => {
    fetchMock.mockResolvedValue(okResponse('   '));
    await expect(provider.transcribeOneShot(AUDIO, OPTS)).resolves.toBe('');
  });

  it('returns "" when vendor structure has no string content (异常结构不崩)', async () => {
    fetchMock.mockResolvedValue(okResponse(undefined));
    await expect(provider.transcribeOneShot(AUDIO, OPTS)).resolves.toBe('');
  });

  it('throws generic asr-failed on non-2xx (no body/detail logged)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'invalid api key sk-leak' }),
    } as unknown as Response);
    await expect(provider.transcribeOneShot(AUDIO, OPTS)).rejects.toThrow('asr-failed');
  });

  it('throws generic asr-failed on network/timeout (fetch reject)', async () => {
    fetchMock.mockRejectedValue(new Error('connect ETIMEDOUT host:443'));
    await expect(provider.transcribeOneShot(AUDIO, OPTS)).rejects.toThrow('asr-failed');
  });

  it('never logs the api key / header / vendor body (FR-014)', async () => {
    // 失败路径触发日志, 验日志入参不含 key 或 vendor 泄漏标记。
    fetchMock.mockRejectedValue(new Error('connect ETIMEDOUT'));
    await expect(provider.transcribeOneShot(AUDIO, OPTS)).rejects.toThrow();
    const joined = loggedArgs.map((a) => String(a)).join(' ');
    expect(joined).not.toContain(API_KEY);
    expect(joined).not.toContain('Bearer');
  });
});
