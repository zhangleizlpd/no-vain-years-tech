import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EASTMONEY_PROFILE } from './eastmoney.constraint-profile.js';
import { LIXINGER_PROFILE } from './lixinger.constraint-profile.js';
import { TransientVendorError, VendorHttpClient, VendorHttpError } from './vendor-http-client.js';

type FetchArgs = {
  url: string;
  init?: { headers?: Record<string, string>; body?: string; signal?: AbortSignal };
};

/** 可编程 fetch: 按 status 序列依次返回, 记录每次入参。 */
function makeFetch(statuses: number[], payload: unknown = { ok: 1 }) {
  const calls: FetchArgs[] = [];
  let i = 0;
  const fetch = vi.fn(async (url: string, init?: FetchArgs['init']) => {
    calls.push({ url, init });
    const status = statuses[Math.min(i, statuses.length - 1)];
    i++;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => payload,
    };
  });
  return { fetch, calls };
}

describe('VendorHttpClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('注入 profile 必需 header 并合并请求级 header, 成功返解析 JSON', async () => {
    const { fetch, calls } = makeFetch([200], { value: 42 });
    const client = new VendorHttpClient(LIXINGER_PROFILE, { fetch });

    const p = client.request<{ value: number }>({
      url: 'https://open.lixinger.com/api/cn/company',
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
      body: '{}',
    });
    await vi.runAllTimersAsync();
    const res = await p;

    expect(res).toEqual({ value: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip',
      Authorization: 'Bearer t', // 请求级 header 合并保留
    });
    expect(calls[0].init?.body).toBe('{}');
  });

  it('429 → 不向 caller 抛, 等 transientWait 后退避重试至成功', async () => {
    const { fetch, calls } = makeFetch([429, 200], { ok: true });
    const client = new VendorHttpClient(LIXINGER_PROFILE, { fetch });

    const p = client.request({ url: 'https://x' });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2); // 1 次 429 + 1 次重试成功
  });

  it('5xx → 瞬时错退避重试至成功', async () => {
    const { fetch, calls } = makeFetch([503, 200]);
    const client = new VendorHttpClient(EASTMONEY_PROFILE, { fetch });

    const p = client.request({ url: 'https://x' });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
  });

  it('持续瞬时错 → 耗尽重试后抛 TransientVendorError (maxAttempts+1 次)', async () => {
    const { fetch, calls } = makeFetch([503]);
    const client = new VendorHttpClient(LIXINGER_PROFILE, { fetch }); // maxAttempts=3

    const p = client.request({ url: 'https://x' });
    // 附 catch 防 unhandled rejection 在 timer 推进期间报警。
    const settled = p.then(
      () => ({ ok: true }),
      (e) => ({ err: e }),
    );
    await vi.runAllTimersAsync();
    const out = (await settled) as { err?: unknown };
    expect(out.err).toBeInstanceOf(TransientVendorError);
    expect(calls).toHaveLength(4); // 1 初次 + 3 重试
  });

  it('4xx (非 429) → 永久错立即抛 VendorHttpError, 不重试', async () => {
    const { fetch, calls } = makeFetch([400]);
    const client = new VendorHttpClient(LIXINGER_PROFILE, { fetch });

    const p = client.request({ url: 'https://x' });
    const settled = p.then(
      () => ({ ok: true }),
      (e) => ({ err: e }),
    );
    await vi.runAllTimersAsync();
    const out = (await settled) as { err?: unknown };
    expect(out.err).toBeInstanceOf(VendorHttpError);
    expect(calls).toHaveLength(1); // 永久错不重试
  });

  it('网络异常 (fetch reject) → 包成 TransientVendorError 并重试', async () => {
    let i = 0;
    const fetch = vi.fn(async () => {
      i++;
      if (i === 1) throw new Error('ECONNRESET');
      return { status: 200, ok: true, json: async () => ({ recovered: true }) };
    });
    const client = new VendorHttpClient(EASTMONEY_PROFILE, { fetch });

    const p = client.request({ url: 'https://x' });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ recovered: true });
    expect(i).toBe(2);
  });

  it('每请求带 profile.timeoutMs 的 AbortSignal (不传 = 静默倒向 Node 默认 300s)', async () => {
    const { fetch, calls } = makeFetch([200]);
    const client = new VendorHttpClient(LIXINGER_PROFILE, { fetch });

    const p = client.request({ url: 'https://open.lixinger.com/api/cn/company' });
    await vi.runAllTimersAsync();
    await p;

    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('超时 → abort 包成 TransientVendorError 并重试; 每次重试**新建** signal', async () => {
    // AbortSignal.timeout 走 Node 原生定时器, fake timers 拦不到 → 本例用真 timers +
    // 20ms 超时 (注入 sleep 抹掉退避等待, 全程 < 100ms)。
    vi.useRealTimers();
    const signals: AbortSignal[] = [];
    // 模拟真 fetch 的 abort 语义: 永不自然 resolve, 只在 signal abort 时 reject。
    const fetch = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          const signal = init!.signal!;
          signals.push(signal);
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const client = new VendorHttpClient(
      { ...EASTMONEY_PROFILE, timeoutMs: 20 },
      { fetch, sleep: async () => {} },
    );

    await expect(client.request({ url: 'https://x' })).rejects.toBeInstanceOf(TransientVendorError);
    // eastmoney maxAttempts=2 ⇒ 首次 + 2 次重试 = 3 次真的都发出去了。
    // 🚨 若 signal 被提到 request()/构造器复用, 第 2、3 次会被上一个已 abort 的 signal 当场
    // 掐死 —— 表现为 fetch 仍调 3 次但 signals 去重后只有 1 个。故两条断言缺一不可。
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new Set(signals).size).toBe(3);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
});
