import { describe, expect, it, vi } from 'vitest';
import { VendorHttpClient, VendorHttpError } from '../marketdata/vendor-http-client';
import { FX_PAIRS, type FxPair } from './fx-rate.port';
import { SINA_FX_PROFILE, SINA_FX_REFERER } from './sina-fx.constraint-profile';
import { SinaFxAdapter } from './sina-fx.adapter';

/**
 * 085 T002 新浪汇率 adapter 单测 (Small: HTTP 以假 fetch 注入, 不打真网)。
 *
 * 🚨 夹具汇率一律**合成值**, 逐个避开 `0.8` / `0.6` / `1.2` ——
 * `scripts/checks/check-optionsdesk-rule-constants.ts` 不变量 #1 的扫描面含 `*.spec.ts`
 * (刻意不排除), 真实值 `0.8549` 会被当场判成「档位系数外溢」。
 *
 * 用**真 `VendorHttpClient` + 假 fetch**而不是把 client 整个 stub 掉: 臂④ 断言的是
 * 「请求头真的带上了 Referer」, 而 Referer 由 `SINA_FX_PROFILE` 经 client 注入 —— stub 掉
 * client 就把被测的那一段一起 stub 掉了。限频桶初始装满 (`DualWindowGate` 构造即 `tokens =
 * capacity`) ⇒ 每个用例 ≤ 4 发不会触发排队 sleep, 无需假时钟。
 *
 * 定向变异 (out-of-test sabotage, per tasks.md T002 条 c) 留档见文末。
 */

/** 合成汇率 —— 与主源夹具**取不同值**, 好让 FallbackChain 的「结果来自谁」可分辨。 */
const SINA_RATE: Record<FxPair, string> = {
  USDCNY: '7.3300',
  HKDCNY: '0.9700',
  USDHKD: '2.7000',
};

/**
 * 新浪 `fx_s<pair>` 响应一行 —— `,` 分隔, 只有 `idx3` 被消费。
 * `idx1` / `idx2` / `idx8` 给互不相同的诱饵值 (买卖价一族, 取错当场红)。
 */
function sinaLine(pair: FxPair, idx3: string): string {
  const seg = new Array<string>(12).fill('0');
  seg[0] = '20260917094811';
  seg[1] = '5.5555';
  seg[2] = '4.4444';
  seg[3] = idx3;
  seg[8] = '3.3333';
  return `var hq_str_fx_s${pair.toLowerCase()}="${seg.join(',')}";`;
}

const SINA_ALL_THREE = FX_PAIRS.map((pair) => sinaLine(pair, SINA_RATE[pair])).join('\n');

/** 显式建一个真 `ArrayBuffer` —— `Uint8Array.buffer` 的静态类型是 `ArrayBufferLike`。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

type FetchCall = { url: string; headers?: Record<string, string> };

/** 假 fetch: 按 status 返回, 记录每次入参 (含 header, 臂④ 的断言落点)。 */
function makeFetch(body: string, status = 200) {
  const calls: FetchCall[] = [];
  const bytes = new TextEncoder().encode(body);
  const fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => ({}),
      arrayBuffer: async () => toArrayBuffer(bytes),
    };
  });
  return { fetch, calls };
}

const BASE = 'https://sina.test';

function makeAdapter(body: string, status = 200, now: () => Date = () => new Date()) {
  const { fetch, calls } = makeFetch(body, status);
  const client = new VendorHttpClient(SINA_FX_PROFILE, { fetch });
  return { adapter: new SinaFxAdapter(client, BASE, now), calls, fetch };
}

describe('SinaFxAdapter —— 新浪 fx_s 备源 (取 idx3)', () => {
  it('正常响应 ⇒ 三对齐出, idx3 值逐字正确 (🚫 idx1 / idx2 / idx8 那一族)', async () => {
    const { adapter } = makeAdapter(SINA_ALL_THREE);

    const rates = await adapter.fetchRates();

    expect(rates).toHaveLength(3);
    for (const pair of FX_PAIRS) {
      // 逐字比较而非 `.equals()`: 后者对「解出来是别的字段但数值凑巧」无鉴别力。
      expect(rates.find((r) => r.pair === pair)?.rate.toFixed(4)).toBe(SINA_RATE[pair]);
    }
  });

  it('④ 请求头含 Referer —— 漏了就是 403, 这条是它唯一的机器化落点', async () => {
    const { adapter, calls } = makeAdapter(SINA_ALL_THREE);

    await adapter.fetchRates();

    expect(calls).toHaveLength(1);
    expect(calls[0].headers).toMatchObject({ Referer: SINA_FX_REFERER });
  });

  it('请求三个正向小写码, 且不含任何反向码 (反向由 invertRate 取倒数, 不问 vendor)', async () => {
    const { adapter, calls } = makeAdapter(SINA_ALL_THREE);

    await adapter.fetchRates();

    expect(calls[0].url).toBe(`${BASE}/list=fx_susdcny,fx_shkdcny,fx_susdhkd`);
    for (const reverse of ['cnyhkd', 'hkdusd', 'cnyusd']) {
      expect(calls[0].url).not.toContain(reverse);
    }
  });

  it('capturedAt 取注入时钟 (我们的采集时刻), 与响应里的 vendor 时间戳无关', async () => {
    const ours = new Date('2026-09-17T02:00:00.000Z');
    const { adapter } = makeAdapter(SINA_ALL_THREE, 200, () => ours);

    const rates = await adapter.fetchRates();

    for (const rate of rates) expect(rate.capturedAt).toEqual(ours);
  });

  it('403 (漏 Referer 的真实后果) ⇒ 永久错上抛给 FallbackChain, 不重试', async () => {
    const { adapter, fetch } = makeAdapter('', 403);

    await expect(adapter.fetchRates()).rejects.toBeInstanceOf(VendorHttpError);
    expect(fetch).toHaveBeenCalledTimes(1); // 4xx 非 429 = 永久错
  });

  it('少一对 ⇒ 抛 (解析契约①: 静默少一对会让那一屏悄悄走降级路径)', async () => {
    const partial = [sinaLine('USDCNY', SINA_RATE.USDCNY), sinaLine('HKDCNY', SINA_RATE.HKDCNY)];
    const { adapter } = makeAdapter(partial.join('\n'));

    await expect(adapter.fetchRates()).rejects.toThrow(/USDHKD/);
  });
});
