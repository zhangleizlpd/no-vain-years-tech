import { BrokenCircuitError } from 'cockatiel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EASTMONEY_PROFILE } from './eastmoney.constraint-profile.js';
import { FUTU_SHIM_OPTION_CHAIN_PROFILE } from './futu-shim.constraint-profile.js';
import { LIXINGER_PROFILE } from './lixinger.constraint-profile.js';
import {
  TransientVendorError,
  VendorHttpClient,
  VendorHttpError,
  parseRetryAfterMs,
} from './vendor-http-client.js';

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

/**
 * 同 {@link makeFetch}, 但**造了 `text()`** —— 真 `Response` 两个都有, 而上面那个刻意只造
 * `json()`(仓内既有假 fetch 的形状)。两个并存是负控制: 缺 `text()` 的通路必须逐字不变。
 */
function makeFetchWithBody(statuses: number[], bodyText: string) {
  const calls: FetchArgs[] = [];
  let i = 0;
  const fetch = vi.fn(async (url: string, init?: FetchArgs['init']) => {
    calls.push({ url, init });
    const status = statuses[Math.min(i, statuses.length - 1)];
    i++;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => ({ ok: 1 }),
      text: async () => bodyText,
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

  // ── #199: 5xx 的响应体必须进 message ────────────────────────────────────────────────────
  // 「502」三个字自己什么都不说明。futu-shim 把**任何** vendor ret 都映射成 502 并把原文放进
  // body, 而本类此前只留 status ⇒ `sync_run.findings` 里就是一个光秃秃的 502, 一条确定性的
  // 永久错(「未知股票」) 与「网关真挂了」不可分辨, 取证要靠人去港机翻日志。
  const SHIM_502_BODY =
    '{"detail":"get_market_snapshot(400 codes): 未知股票 ALB260828C100000","error":"vendor_error"}';

  it('🚨 5xx → vendor 响应体进 TransientVendorError.message (光一个状态码取证不了)', async () => {
    const { fetch } = makeFetchWithBody([502], SHIM_502_BODY);
    const client = new VendorHttpClient(LIXINGER_PROFILE, { fetch });

    const p = client.request({ url: 'https://x' });
    const settled = p.then(
      () => ({ err: undefined }),
      (e: unknown) => ({ err: e }),
    );
    await vi.runAllTimersAsync();
    const { err } = await settled;

    expect(err).toBeInstanceOf(TransientVendorError);
    expect(String(err)).toContain('transient vendor failure: 502');
    // 承重断言: vendor 的原话必须能被 `String(err)` 带出去 —— findings 存的就是它。
    expect(String(err)).toContain('未知股票 ALB260828C100000');
  });

  it('响应体折成单行并截断 (findings / 摘要按单行读; 网关吐整页 HTML 不得灌进去)', async () => {
    const body = `line1\n  line2\t${'x'.repeat(1000)}`;
    const { fetch } = makeFetchWithBody([503], body);
    const client = new VendorHttpClient(LIXINGER_PROFILE, { fetch });

    const p = client.request({ url: 'https://x' });
    const settled = p.then(
      () => ({ err: undefined }),
      (e: unknown) => ({ err: e }),
    );
    await vi.runAllTimersAsync();
    const msg = String((await settled).err);

    expect(msg).not.toMatch(/[\n\t]/);
    expect(msg).toContain('line1 line2 xxx');
    expect(msg).toContain('…'); // 截断留标记, 别假装这就是全部
    expect(msg.length).toBeLessThan(400);
  });

  it('负控制: 假 fetch 没有 text() → message 逐字不变 (几十个既有用例的形状)', async () => {
    const { fetch } = makeFetch([503]);
    const client = new VendorHttpClient(EASTMONEY_PROFILE, { fetch });

    const p = client.request({ url: 'https://x' });
    const settled = p.then(
      () => ({ err: undefined }),
      (e: unknown) => ({ err: e }),
    );
    await vi.runAllTimersAsync();

    expect(String((await settled).err)).toBe(
      `TransientVendorError: [${EASTMONEY_PROFILE.vendor}] transient vendor failure: 503`,
    );
  });

  it('负控制: text() 自己抛 → 退回无 detail, MUST NOT 把读 body 的失败盖掉真正的 5xx', async () => {
    const fetch = vi.fn(async () => ({
      status: 500,
      ok: false,
      json: async () => ({}),
      text: async () => {
        throw new Error('body 读到一半连接断了');
      },
    }));
    const client = new VendorHttpClient(EASTMONEY_PROFILE, { fetch });

    const p = client.request({ url: 'https://x' });
    const settled = p.then(
      () => ({ err: undefined }),
      (e: unknown) => ({ err: e }),
    );
    await vi.runAllTimersAsync();
    const { err } = await settled;

    expect(err).toBeInstanceOf(TransientVendorError);
    expect((err as TransientVendorError).status).toBe(500);
    expect(String(err)).toBe(
      `TransientVendorError: [${EASTMONEY_PROFILE.vendor}] transient vendor failure: 500`,
    );
  });

  it('空 body → 不挂一个说不出话的后缀 (message 逐字不变)', async () => {
    const { fetch } = makeFetchWithBody([503], '   \n  ');
    const client = new VendorHttpClient(EASTMONEY_PROFILE, { fetch });

    const p = client.request({ url: 'https://x' });
    const settled = p.then(
      () => ({ err: undefined }),
      (e: unknown) => ({ err: e }),
    );
    await vi.runAllTimersAsync();

    expect(String((await settled).err)).toBe(
      `TransientVendorError: [${EASTMONEY_PROFILE.vendor}] transient vendor failure: 503`,
    );
  });

  it('负控制: 429 不回读 body —— 它自带 Retry-After 语义, 读了只是白烧一次 I/O', async () => {
    const { fetch } = makeFetchWithBody([429], '{"error":"rate_limited","retry_after_s":29}');
    const client = new VendorHttpClient(LIXINGER_PROFILE, { fetch });

    const p = client.request({ url: 'https://x' });
    const settled = p.then(
      () => ({ err: undefined }),
      (e: unknown) => ({ err: e }),
    );
    await vi.runAllTimersAsync();

    expect(String((await settled).err)).toBe(
      `TransientVendorError: [${LIXINGER_PROFILE.vendor}] transient vendor failure: 429`,
    );
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

describe('parseRetryAfterMs (纯函数)', () => {
  it('delta-seconds 形态 → ms', () => {
    expect(parseRetryAfterMs('29', 0)).toBe(29_000);
    expect(parseRetryAfterMs('  29  ', 0)).toBe(29_000);
  });

  it('HTTP-date 形态 → 距 now 的 ms (只解秒会静默回落兜底值, 那正是要修的那类塌法)', () => {
    expect(parseRetryAfterMs(new Date(30_000).toUTCString(), 0)).toBe(30_000);
  });

  it('缺失 / 空 / 非法 / 非正数 → null (交调用方回落)', () => {
    expect(parseRetryAfterMs(null, 0)).toBeNull();
    expect(parseRetryAfterMs(undefined, 0)).toBeNull();
    expect(parseRetryAfterMs('', 0)).toBeNull();
    expect(parseRetryAfterMs('soon', 0)).toBeNull();
    expect(parseRetryAfterMs('0', 0)).toBeNull();
    expect(parseRetryAfterMs('-5', 0)).toBeNull(); // 带符号非 delta-seconds, date 分支也拒
    expect(parseRetryAfterMs(new Date(30_000).toUTCString(), 60_000)).toBeNull(); // 已过期
  });
});

describe('VendorHttpClient — 429 等待时长 (Retry-After)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** 可编程 fetch, 可给响应挂 `Retry-After`。 */
  function makeFetchWithRetryAfter(statuses: number[], retryAfter?: string) {
    let i = 0;
    return vi.fn(async () => {
      const status = statuses[Math.min(i, statuses.length - 1)];
      i++;
      return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => ({ ok: true }),
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'retry-after' && retryAfter !== undefined ? retryAfter : null,
        },
      };
    });
  }

  /** 跑一次「429 → 重试成功」, 返回本次记录到的所有 sleep 时长。 */
  async function sleepsFor(
    profile: typeof LIXINGER_PROFILE,
    retryAfter: string | undefined,
    random = () => 0,
  ): Promise<number[]> {
    const sleeps: number[] = [];
    const client = new VendorHttpClient(profile, {
      fetch: makeFetchWithRetryAfter([429, 200], retryAfter),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random,
    });
    const p = client.request({ url: 'https://x' });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: true });
    return sleeps;
  }

  it('🚨 采信 vendor 的 Retry-After, 而不是固定 transientWaitMs (2026-08-09 prod bug 的回归闸)', async () => {
    // 富途链画像 transientWaitMs=2s, 而上游 30s 窗实测报 `Retry-After: 29`。
    // 只等 2s ⇒ 三次重试共约 7.8s < 29s ⇒ 结构上熬不过一次限频窗, 必然升级 budgetExhausted。
    expect(await sleepsFor(FUTU_SHIM_OPTION_CHAIN_PROFILE, '29')).toContain(29_000);
  });

  it('🚨 transientWaitMs 是**下界**不是兜底: vendor 报得更短时不抹掉 profile 的保守', async () => {
    // 理杏仁 429 = 分钟级封禁 ⇒ profile 取 ≥60s。vendor 报 29s 也不该缩短。
    const sleeps = await sleepsFor(LIXINGER_PROFILE, '29');
    expect(sleeps).toContain(LIXINGER_PROFILE.transientWaitMs);
    expect(sleeps).not.toContain(29_000);
  });

  it('Retry-After 超上限 (分钟级以上) → 不采信, 回落 transientWaitMs 让上层顺延接管', async () => {
    expect(await sleepsFor(FUTU_SHIM_OPTION_CHAIN_PROFILE, '3600')).toContain(
      FUTU_SHIM_OPTION_CHAIN_PROFILE.transientWaitMs,
    );
  });

  it('jitter 只加不减 —— Retry-After 是 vendor 给的下界, 减了必然再撞一次 429', async () => {
    const sleeps = await sleepsFor(FUTU_SHIM_OPTION_CHAIN_PROFILE, '29', () => 1);
    const waited = sleeps.find((ms) => ms >= 29_000);
    expect(waited).toBe(29_000 + 2_900); // base + base × 10% × random(=1)
  });

  it('负控制: 响应无 headers (仓内既有假 fetch 的形状) → 行为与本改动前逐字节一致', async () => {
    const sleeps: number[] = [];
    const client = new VendorHttpClient(LIXINGER_PROFILE, {
      fetch: makeFetch([429, 200]).fetch, // 该 helper 不造 headers
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
    });
    const p = client.request({ url: 'https://x' });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(sleeps).toContain(LIXINGER_PROFILE.transientWaitMs);
  });
});

describe('VendorHttpClient — 熔断口径: 背压 ≠ 故障', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // 链画像 maxAttempts=2 ⇒ 单次 request 最多打 3 发; ConsecutiveBreaker 阈值 5
  // ⇒ 两次 request 就足以越过阈值, 无需构造几十发。

  /** 跑一次请求, 返回它最终抛出的错 (不抛 → null)。附 catch 防推进 timer 时 unhandled rejection。 */
  async function failureOf(client: VendorHttpClient): Promise<unknown> {
    const settled = client.request({ url: 'https://x' }).then(
      () => null,
      (e: unknown) => e,
    );
    await vi.runAllTimersAsync();
    return settled;
  }

  it('🚨 连续 429 越过 ConsecutiveBreaker 阈值也不开闸 (背压不是故障)', async () => {
    const { fetch, calls } = makeFetch([429, 429, 429, 429, 429, 429, 200]);
    const client = new VendorHttpClient(FUTU_SHIM_OPTION_CHAIN_PROFILE, { fetch });

    // 6 发连续 429 > 阈值 5, 但两次都必须照常收敛到 TransientVendorError —— **不能**是
    // BrokenCircuitError: 后者不被 adapter 那条「429 → OptionChainBudgetExhaustedError」
    // 映射认识, 会把一次纯限频记成该标的的 failed + 触发降级告警。
    expect(await failureOf(client)).toBeInstanceOf(TransientVendorError);
    expect(await failureOf(client)).toBeInstanceOf(TransientVendorError);

    // 第 7 发 200: 熔断若已开, 这次会被当场拒、根本到不了 fetch。
    const p = client.request({ url: 'https://x' });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(7);
  });

  it('负控制: 连续 5xx 照常熔断 —— 本改动只摘掉 429, 没把熔断废掉', async () => {
    const { fetch, calls } = makeFetch([503]);
    const client = new VendorHttpClient(FUTU_SHIM_OPTION_CHAIN_PROFILE, { fetch });

    expect(await failureOf(client)).toBeInstanceOf(TransientVendorError); // 故障 1–3
    // 第 4、5 发把连续计数推到阈值 → 开闸, 本次即以 BrokenCircuitError 收场。
    expect(await failureOf(client)).toBeInstanceOf(BrokenCircuitError);
    expect(calls).toHaveLength(5); // 开闸后不再打 vendor
  });

  it('🚨 负控制: 429 对故障计数是**透明**的, 不当 success 清零 (否则 5xx 夹 429 永远熔不断)', async () => {
    // cockatiel 对「过滤器不认」的错是原样 throw (既不 failure 也不 success)。若它改走
    // success 分支, 下面这串里的 429 会把已累积的 4 次故障清零 ⇒ 熔断永不开。
    const { fetch } = makeFetch([503, 503, 503, 503, 429, 503]);
    const client = new VendorHttpClient(FUTU_SHIM_OPTION_CHAIN_PROFILE, { fetch });

    expect(await failureOf(client)).toBeInstanceOf(TransientVendorError); // 故障 1–3
    expect(await failureOf(client)).toBeInstanceOf(TransientVendorError); // 故障 4, 429, 故障 5 → 开闸
    expect(await failureOf(client)).toBeInstanceOf(BrokenCircuitError);
  });
});
