import { describe, it, expect, vi } from 'vitest';
import { FutuRealtimeQuoteAdapter } from './futu-realtime-quote.adapter.js';
import { REALTIME_QUOTE_MAX_SYMBOLS } from './realtime-quote.port.js';
import type { VendorHttpClient, VendorRequest } from './vendor-http-client.js';

/**
 * 富途实时报价 adapter mock 单测 (061 T003)。
 *
 * 仿真行**逐字段照 shim `/option-snapshot` 的实测形态** (同
 * `futu-option-snapshot.adapter.spec.ts` 的 `_option_snapshot_row`), 只是本 adapter 只送正股
 * code、也只读 `last_price` 一列。
 *
 * 真端点契约由 env-gated 真 vendor IT 校真 (`marketdata.futu-shim.vendor`, `RUN_MARKETDATA_IT`)
 * —— ⚠️ 那道门恒 skip, 本文件全绿**不**构成真契约的证据。
 */
const BASE = 'http://10.89.0.1:8811';
const TOKEN = 'test-shim-token';
const AS_OF = '2026-08-17T20:19:48+00:00';

/**
 * 正股一行。**刻意带上 `pre_` / `after_` / `overnight_` 三族** —— 它们在真响应里就是这么回来的,
 * 而 FR-020 要的正是「登记但不消费」。
 */
function stockRow(code: string, extra: Record<string, unknown> = {}) {
  return {
    code,
    update_time: '2026-08-17 15:59:12',
    last_price: 148.21,
    prev_close_price: 147.5,
    volume: 4_120_355,
    turnover: 610_233_900.0,
    bid_price: 148.2,
    ask_price: 148.22,
    suspension: false,
    option_valid: false,
    pre_price: 146.02,
    pre_high_price: 146.9,
    after_price: 149.77,
    after_low_price: 148.9,
    overnight_price: 150.31,
    ...extra,
  };
}

function makeShim(rows: unknown[], envelope: Record<string, unknown> = {}) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const request = vi.fn(async (req: VendorRequest) => {
    calls.push({ url: req.url, auth: req.headers?.Authorization });
    return { as_of: AS_OF, count: rows.length, rows, ...envelope };
  });
  return { http: { request } as unknown as VendorHttpClient, calls, request };
}

const makeAdapter = (http: VendorHttpClient) => new FutuRealtimeQuoteAdapter(http, BASE, TOKEN);

describe('FutuRealtimeQuoteAdapter', () => {
  describe('请求形态', () => {
    it('GET <shim>/option-snapshot?codes=… + Bearer, **只送正股 code**', async () => {
      const { http, calls } = makeShim([stockRow('US.PEP'), stockRow('US.AAPL')]);
      await makeAdapter(http).fetchQuotes(['us:PEP', 'us:AAPL']);

      expect(calls).toHaveLength(1);
      const url = new URL(calls[0].url);
      expect(url.pathname).toBe('/option-snapshot');
      expect(url.searchParams.get('codes')).toBe('US.PEP,US.AAPL');
      expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
    });

    it('未登记市场 → 直接抛且**零外呼** (静默返空会被记成「该标的今天没有报价」)', async () => {
      const { http, request } = makeShim([stockRow('US.PEP')]);
      await expect(makeAdapter(http).fetchQuotes(['cn:600519'])).rejects.toThrow(/仅承担 us \/ hk/);
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('🚨 批量上限前置拒绝 (Guardrail 17: 切批是调用方的事)', () => {
    it('超上限 → 前置拒绝且零外呼 (不烧限频配额去换一个 400)', async () => {
      const { http, request } = makeShim([stockRow('US.PEP')]);
      const symbols = Array.from(
        { length: REALTIME_QUOTE_MAX_SYMBOLS + 1 },
        (_, i) => `us:SYM${i}`,
      );

      await expect(makeAdapter(http).fetchQuotes(symbols)).rejects.toThrow(/超上限/);
      expect(request).not.toHaveBeenCalled();
    });

    it('恰好等于上限 → 照常发 (边界闭, 少发一个就是白丢一只锚)', async () => {
      const symbols = Array.from({ length: REALTIME_QUOTE_MAX_SYMBOLS }, (_, i) => `us:SYM${i}`);
      const { http, request } = makeShim(symbols.map((s) => stockRow(`US.${s.slice(3)}`)));

      await makeAdapter(http).fetchQuotes(symbols);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('空批 → 前置拒绝且零外呼 (工作集为空时本就不该调用)', async () => {
      const { http, request } = makeShim([]);
      await expect(makeAdapter(http).fetchQuotes([])).rejects.toThrow(/为空/);
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('字段映射', () => {
    it('键 = 入参的 canonical symbol 原样, 价恒 string (Decimal-safe), 时刻 = 信封 as_of', async () => {
      const { http } = makeShim([stockRow('US.PEP')]);
      const quotes = await makeAdapter(http).fetchQuotes(['us:PEP']);

      expect([...quotes.keys()]).toEqual(['us:PEP']);
      expect(quotes.get('us:PEP')).toEqual({
        price: '148.21',
        capturedAt: new Date(AS_OF),
        // `15:59:12` 是 **ET**(夏令 = UTC−4), 不是 UTC —— 当 UTC 解析会整体偏 4 小时且不会红。
        vendorUpdateTime: new Date('2026-08-17T19:59:12Z'),
      });
    });

    it('🚨 采集墙钟取信封 as_of, **不取行内 update_time** (后者是最后成交时刻, 盘中滞后 p95 292 s)', async () => {
      // update_time 换成一个明显不同的时刻: 若实现改读它, 这条立刻红。
      const { http } = makeShim([stockRow('US.PEP', { update_time: '2026-08-17 09:31:00' })]);
      const quotes = await makeAdapter(http).fetchQuotes(['us:PEP']);
      expect(quotes.get('us:PEP')?.capturedAt).toEqual(new Date(AS_OF));
    });

    it('🚨 两个时间戳**并存且不互相顶替** (063 Phase 3.4): as_of 是判据, update_time 是证据', async () => {
      const { http } = makeShim([stockRow('US.PEP', { update_time: '2026-08-17 09:31:00' })]);
      const quote = await makeAdapter(http).fetchQuotes(['us:PEP']);

      // 判据侧: 采集墙钟, 一格不动。
      expect(quote.get('us:PEP')?.capturedAt).toEqual(new Date(AS_OF));
      // 证据侧: vendor 说这个价是 09:31 ET 的 —— 与采集时刻的差就是 061 那次一次性探测
      // (滞后中位 40 s / p95 292 s) 想要监控的量, 现在每一拍都留了痕。
      expect(quote.get('us:PEP')?.vendorUpdateTime).toEqual(new Date('2026-08-17T13:31:00Z'));
    });

    it('update_time 缺失 / 坏形态 → `null`, **不阻断这一拍** (它不参与任何判据)', async () => {
      const { http } = makeShim([
        stockRow('US.PEP', { update_time: undefined }),
        stockRow('US.AAPL', { update_time: 'not-a-time' }),
      ]);
      const quotes = await makeAdapter(http).fetchQuotes(['us:PEP', 'us:AAPL']);

      expect(quotes.get('us:PEP')?.vendorUpdateTime).toBeNull();
      expect(quotes.get('us:AAPL')?.vendorUpdateTime).toBeNull();
      expect(quotes.get('us:PEP')?.price).toBe('148.21'); // 价照落
    });

    it('缺某标的 → **省略不抛** (停牌 / 刚摘牌; 上游据此保留旧值)', async () => {
      const { http } = makeShim([stockRow('US.PEP')]);
      const quotes = await makeAdapter(http).fetchQuotes(['us:PEP', 'us:AAPL']);

      expect(quotes.size).toBe(1);
      expect(quotes.has('us:AAPL')).toBe(false);
    });

    it('行在但 last_price 缺失 → 同样省略 (不落 0 冒充一个真价)', async () => {
      const { http } = makeShim([stockRow('US.PEP'), stockRow('US.AAPL', { last_price: null })]);
      const quotes = await makeAdapter(http).fetchQuotes(['us:PEP', 'us:AAPL']);

      expect(quotes.has('us:AAPL')).toBe(false);
      expect(quotes.get('us:PEP')?.price).toBe('148.21');
    });

    it('响应里的多余行 (未请求的 code) → 忽略, 不混进结果', async () => {
      const { http } = makeShim([stockRow('US.PEP'), stockRow('US.MSFT')]);
      const quotes = await makeAdapter(http).fetchQuotes(['us:PEP']);
      expect([...quotes.keys()]).toEqual(['us:PEP']);
    });
  });

  describe('🚨 FR-020: 只读 last_price, 盘前 / 盘后 / 夜盘三族登记但不消费', () => {
    it('三族字段一个都没被读取过 (要不要呈现盘后价是独立产品决策)', async () => {
      const touched: string[] = [];
      /** 记录属性访问的行代理 —— 比扫源码强: 它证明的是「这次运行真的没读」。 */
      const spyRow = new Proxy(stockRow('US.PEP') as Record<string, unknown>, {
        get(target, prop, receiver) {
          if (typeof prop === 'string') touched.push(prop);
          return Reflect.get(target, prop, receiver);
        },
      });
      const { http } = makeShim([spyRow]);

      const quotes = await makeAdapter(http).fetchQuotes(['us:PEP']);

      expect(quotes.get('us:PEP')?.price).toBe('148.21');
      // 正向: 确实读了它该读的两列 (否则本断言会因「什么都没读」而假绿)。
      expect(touched).toContain('code');
      expect(touched).toContain('last_price');
      expect(touched.filter((k) => /^(pre_|after_|overnight_)/.test(k))).toEqual([]);
    });
  });

  describe('信封校验', () => {
    it('as_of 不可解析 → 抛 (拿本机时钟顶替 = 把采集时刻换成代码跑到那一句的时刻)', async () => {
      const { http } = makeShim([stockRow('US.PEP')], { as_of: undefined });
      await expect(makeAdapter(http).fetchQuotes(['us:PEP'])).rejects.toThrow(/as_of/);
    });

    it('全空 (一条可用报价都没有) → 抛, 供上游熔断计数', async () => {
      const { http } = makeShim([]);
      await expect(makeAdapter(http).fetchQuotes(['us:PEP'])).rejects.toThrow(/一条可用报价/);
    });

    it('请求的标的全部只回了不可用的行 → 同样算全空 (抛)', async () => {
      const { http } = makeShim([stockRow('US.PEP', { last_price: null })]);
      await expect(makeAdapter(http).fetchQuotes(['us:PEP'])).rejects.toThrow(/一条可用报价/);
    });

    it('count 与实收行数不符 → 抛 (疑传输截断, 不返回半份数据)', async () => {
      const { http } = makeShim([stockRow('US.PEP')], { count: 7 });
      await expect(makeAdapter(http).fetchQuotes(['us:PEP'])).rejects.toThrow(/疑截断/);
    });

    it('缺 rows[] → 抛 (契约变更)', async () => {
      const { http } = makeShim([], { rows: undefined });
      await expect(makeAdapter(http).fetchQuotes(['us:PEP'])).rejects.toThrow(/rows/);
    });
  });

  describe('🚨 失败一律原样上抛, 不映射具名错误', () => {
    it('传输层错误穿透 (调用方对任何「取不到」的处置一致: fail-closed + 计失败)', async () => {
      const boom = new Error('tunnel down');
      const http = {
        request: vi.fn(async () => {
          throw boom;
        }),
      } as unknown as VendorHttpClient;

      await expect(makeAdapter(http).fetchQuotes(['us:PEP'])).rejects.toBe(boom);
    });
  });
});

// ---------------------------------------------------------------------------
// 066 T10 — 港股 (hk) 实时报价 (FR-003, plan §A7)
// ---------------------------------------------------------------------------
/**
 * 补上前缀之前, 港股锚在每 30 秒的盘中 tick 里恒落 `unsupported-market` (无实时源路由) ⇒
 * 恒为收盘档。⚠️ 前缀只是这条路的一半, 另一半是 `marketdata.module.ts` 的 hk 槽位 ——
 * 那半的回归钉在 `market-routed-realtime-quote.adapter.spec.ts` 的「module 接线」段。
 */
describe('066 T10 FutuRealtimeQuoteAdapter — 港股 (hk) 实时报价', () => {
  it('hk symbol → `HK.` 前缀; 结果键原样回传 canonical (state_branches 16 的适配器半)', async () => {
    const { http, calls } = makeShim([stockRow('HK.00700', { last_price: 457 })]);
    const quotes = await makeAdapter(http).fetchQuotes(['hk:00700']);

    expect(new URL(calls[0].url).searchParams.get('codes')).toBe('HK.00700');
    expect(quotes.get('hk:00700')?.price).toBe('457');
  });

  it('混批 us + hk → 一发两前缀 (同一个 shim 端点, 不为每个市场各打一发)', async () => {
    const { http, calls } = makeShim([stockRow('US.PEP'), stockRow('HK.00700')]);
    const quotes = await makeAdapter(http).fetchQuotes(['us:PEP', 'hk:00700']);

    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).searchParams.get('codes')).toBe('US.PEP,HK.00700');
    expect([...quotes.keys()].sort()).toEqual(['hk:00700', 'us:PEP']);
  });

  it('🚨 hk 行的 update_time 按**港股当地**解析 (066 T17 的联动: 两个 adapter 共用一份解析)', async () => {
    // vendor 给的 15:59:12 是港股当地 ⇒ 07:59:12Z (港股恒 UTC+8 无 DST); 按美东读会偏 12 小时。
    const { http } = makeShim([stockRow('HK.00700')]);
    const quotes = await makeAdapter(http).fetchQuotes(['hk:00700']);

    expect(quotes.get('hk:00700')?.vendorUpdateTime).toEqual(new Date('2026-08-17T07:59:12Z'));
  });
});
