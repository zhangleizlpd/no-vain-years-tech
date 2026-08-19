import { describe, it, expect, vi } from 'vitest';
import type { VendorHttpClient, VendorRequest } from './vendor-http-client.js';
import { TencentCalendarAdapter } from './tencent-calendar.adapter.js';

/**
 * 腾讯指数日历源 adapter mock 单测 (044 T004)。**本 feature 的核心防线**: 4 条 Impl
 * Guardrail 落在此 adapter, 每条都由 prod 77 PoC 实证 (2026-07-16), 非推测:
 *
 * - **Guardrail 1** 分片 + 每片 `limit = 片内自然日数` (FR-016) — 30 天窗单片行为零变 /
 *   10yr 3 片 / 分片零丢失零重复零重叠。
 * - **Guardrail 3** 响应 key **回显** (`usDJI` → `us.DJI`) — 禁按请求参数查 key。
 * - **Guardrail 4** **`code:0` 不是成功信号** (FR-015) — 超限错误与正常响应共用 code 0,
 *   须按 shape 判 → throw 而非返空。
 *
 * 真端点 / symbol / 分片真调由 env-gated 真 vendor IT 校真
 * (`marketdata.tencent.vendor`, `RUN_MARKETDATA_IT`) —— 此处仅解析 / 分片逻辑
 * (沿 015 全 adapter「求证 + env-gated IT 校真值」范式)。
 */
const BASE = 'https://web.ifzq.gtimg.cn';
const DAY_MS = 86_400_000;

/** vendor `limit` 硬上限 (PoC 二分实证: 2000 ✓ / 2001 ✗) —— **仿真端**持有, 非我方常量。 */
const VENDOR_CAP = 2000;

interface ParsedParam {
  symbol: string;
  period: string;
  from: string;
  to: string;
  /** 省略 limit 时 undefined (PoC: 真端返空 —— 盲写陷阱之一)。 */
  limit: number | undefined;
}

/** 从 `param=<symbol>,day,<from>,<to>,<limit>` 解析请求四元组 (断言分片形态用)。 */
function parseParam(url: string): ParsedParam {
  const raw = /[?&]param=([^&]*)/.exec(url)?.[1] ?? '';
  const [symbol, period, from, to, limit] = raw.split(',');
  return {
    symbol,
    period,
    from,
    to,
    limit: limit === undefined || limit === '' ? undefined : Number(limit),
  };
}

/** 闭区间 [from,to] 内工作日 (仿真端「交易日」基准; 周末天然排除)。 */
function weekdaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let ms = Date.parse(`${from}T00:00:00Z`); ms <= end; ms += DAY_MS) {
    const dow = new Date(ms).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

/** 🚨 响应 key **回显**变形 (PoC 实证: 请求 `usDJI` → 响应 key `us.DJI`)。 */
function echoKey(symbol: string): string {
  return symbol.startsWith('us') ? `us.${symbol.slice(2)}` : symbol;
}

/**
 * 腾讯 vendor 仿真 (PoC 实证语义, 逐条对齐 plan Decision 2 实测表):
 * - `limit` = **取最近 N 条**截断器 (limit=5 → 最近 5 天);
 * - **省略 limit → 返空** (`day: []`);
 * - **`limit > 2000` → `{"code":0,"msg":"param error","data":[]}`** (成功码 + 错误消息 + 空数组);
 * - 响应 key 回显变形 (见 `echoKey`)。
 */
function makeFakeVendor(): { http: VendorHttpClient; calls: ParsedParam[] } {
  const calls: ParsedParam[] = [];
  const request = vi.fn(async (req: VendorRequest) => {
    const p = parseParam(req.url);
    calls.push(p);
    // 超限 → 成功码 + 错误消息 + 空数组 (与正常响应共用 code 0)。
    if (p.limit !== undefined && p.limit > VENDOR_CAP) {
      return { code: 0, msg: 'param error', data: [] };
    }
    const all = weekdaysBetween(p.from, p.to);
    // 省略 limit → 空; 否则取最近 N 条 (老端截断)。
    const bars = p.limit === undefined ? [] : all.slice(Math.max(0, all.length - p.limit));
    return {
      code: 0,
      msg: '',
      data: { [echoKey(p.symbol)]: { day: bars.map((d) => [d, '1', '2', '3', '4', '5']) } },
    };
  });
  return { http: { request } as unknown as VendorHttpClient, calls };
}

/** 定值 http (错误形态断言用)。 */
function makeHttp(payload: unknown): VendorHttpClient {
  return { request: vi.fn(async () => payload) } as unknown as VendorHttpClient;
}

/** 闭区间自然日数 (含首尾) —— 期望值独立算, 不复用被测实现。 */
function naturalDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

describe('TencentCalendarAdapter', () => {
  describe('symbol 映射 + 请求结构', () => {
    it('cn: GET kline/kline + param=sh000001,day,<from>,<to>,<limit> (上证综指)', async () => {
      const { http, calls } = makeFakeVendor();
      const out = await new TencentCalendarAdapter(http, BASE).fetchTradingDates(
        'cn',
        '2026-07-01',
        '2026-07-14',
      );

      expect(out.servedBy).toBe('tencent'); // 自报家门 (降级可观测, FR-014)
      expect(out.dates).toEqual(weekdaysBetween('2026-07-01', '2026-07-14'));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ symbol: 'sh000001', period: 'day' });
    });

    it('hk: symbol=hkHSI (恒生指数)', async () => {
      const { http, calls } = makeFakeVendor();
      const out = await new TencentCalendarAdapter(http, BASE).fetchTradingDates(
        'hk',
        '2026-06-25',
        '2026-06-25',
      );
      expect(out).toEqual({ dates: ['2026-06-25'], sessionKinds: {}, servedBy: 'tencent' });
      expect(calls[0].symbol).toBe('hkHSI');
    });

    it('us: symbol=usDJI (道琼斯)', async () => {
      const { http, calls } = makeFakeVendor();
      const out = await new TencentCalendarAdapter(http, BASE).fetchTradingDates(
        'us',
        '2026-06-25',
        '2026-06-25',
      );
      expect(out).toEqual({ dates: ['2026-06-25'], sessionKinds: {}, servedBy: 'tencent' });
      expect(calls[0].symbol).toBe('usDJI');
    });

    it('请求打 kline/kline 端点 (baseUrl + /appstock/app/kline/kline)', async () => {
      const urls: string[] = [];
      const http = {
        request: vi.fn(async (req: VendorRequest) => {
          urls.push(req.url);
          return { code: 0, msg: '', data: { sh000001: { day: [] } } };
        }),
      } as unknown as VendorHttpClient;
      await new TencentCalendarAdapter(http, BASE).fetchTradingDates(
        'cn',
        '2026-07-01',
        '2026-07-02',
      );
      expect(urls[0]).toContain(`${BASE}/appstock/app/kline/kline?param=`);
    });

    it('未支持市场 → 明确抛 (不静默返空致整市场日历漏填)', async () => {
      const { http } = makeFakeVendor();
      await expect(
        new TencentCalendarAdapter(http, BASE).fetchTradingDates('jp', '2026-07-01', '2026-07-02'),
      ).rejects.toThrow(/不支持市场/);
    });

    it('非法日期 → 抛 (禁 NaN 静默退化成零分片 → 无声返空)', async () => {
      const { http, calls } = makeFakeVendor();
      await expect(
        new TencentCalendarAdapter(http, BASE).fetchTradingDates('cn', '2026/07/01', '2026-07-02'),
      ).rejects.toThrow(/日期/);
      expect(calls).toHaveLength(0);
    });
  });

  // 🚨 Guardrail 1 (FR-016): limit 是截断器 + 硬上限 2000 → 分片 + 每片 limit = 片内自然日数。
  describe('分片规约 (Guardrail 1 / FR-016)', () => {
    it('日常 30 天窗 → 单片且 limit == 30 (行为零变)', async () => {
      const { http, calls } = makeFakeVendor();
      const out = await new TencentCalendarAdapter(http, BASE).fetchTradingDates(
        'cn',
        '2026-06-17',
        '2026-07-16',
      );

      expect(naturalDays('2026-06-17', '2026-07-16')).toBe(30); // 前提自检
      expect(calls).toHaveLength(1); // 单片 → 与改造前同构, 行为零变
      expect(calls[0]).toMatchObject({ from: '2026-06-17', to: '2026-07-16', limit: 30 });
      expect(out.dates).toEqual(weekdaysBetween('2026-06-17', '2026-07-16')); // 未被截断
    });

    it('10yr 窗 → 3 片; 每片 limit ≤ 1800 且 == 片内自然日数; 片连续覆盖全区间', async () => {
      const { http, calls } = makeFakeVendor();
      const from = '2016-07-16';
      const to = '2026-07-16';
      await new TencentCalendarAdapter(http, BASE).fetchTradingDates('cn', from, to);

      expect(naturalDays(from, to)).toBe(3653); // 前提自检
      expect(calls).toHaveLength(3); // plan 实证: 1800 + 1800 + 53
      expect(calls.map((c) => c.limit)).toEqual([1800, 1800, 53]);

      for (const c of calls) {
        // 🚨 limit == 片内自然日数 ⇒「交易日数 ≤ 自然日数」由构造保证永不截断。
        expect(c.limit).toBe(naturalDays(c.from, c.to));
        expect(c.limit as number).toBeLessThanOrEqual(1800); // SAFE_CHUNK
        expect(c.limit as number).toBeLessThanOrEqual(VENDOR_CAP); // 永不触 vendor 硬上限
        // 🚨 禁传 0 (真端返 1 天) / 禁省略 (真端返空)。
        expect(c.limit).toBeGreaterThan(0);
      }

      // 片连续、无缝覆盖 [from, to]。
      expect(calls[0].from).toBe(from);
      expect(calls[calls.length - 1].to).toBe(to);
      for (let i = 1; i < calls.length; i++) {
        const prevEnd = Date.parse(`${calls[i - 1].to}T00:00:00Z`);
        expect(calls[i].from).toBe(new Date(prevEnd + DAY_MS).toISOString().slice(0, 10));
      }
    });

    it('🚨 禁 limit = min(windowDays, CAP): 超 CAP 的宽窗不得单片直发 (会被静默截断)', async () => {
      const { http, calls } = makeFakeVendor();
      // 2yr+ 窗自然日数 2558 > CAP 2000 —— 单片直发必被 vendor 判 param error (PoC 实证)。
      await new TencentCalendarAdapter(http, BASE).fetchTradingDates(
        'cn',
        '2019-07-16',
        '2026-07-16',
      );
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.every((c) => (c.limit as number) <= VENDOR_CAP)).toBe(true);
    });

    it('分片结果 concat 去重后与单片等价: 零丢失 / 零重复 / 片间零重叠 (SC-008)', async () => {
      const { http, calls } = makeFakeVendor();
      const from = '2019-07-16'; // 7yr —— PoC 等价性实证同形 (单次 1725 vs 2 片 1725)
      const to = '2026-07-16';
      const { dates } = await new TencentCalendarAdapter(http, BASE).fetchTradingDates(
        'cn',
        from,
        to,
      );

      expect(calls).toHaveLength(2);
      // ① 零丢失: 分片拼接 == 整区间真值 (同一仿真端生成, 等价于「单片能返回的全集」)。
      expect(dates).toEqual(weekdaysBetween(from, to));
      // ② 零重复。
      expect(new Set(dates).size).toBe(dates.length);
      // ③ 片间零重叠 (后片 from 严格晚于前片 to)。
      expect(Date.parse(calls[1].from)).toBeGreaterThan(Date.parse(calls[0].to));
    });
  });

  // 🚨🚨 Guardrail 4 (FR-015): code:0 不是成功信号 —— 本 feature 的核心防线。
  describe('响应 shape 判据 (Guardrail 4 / FR-015)', () => {
    it('🚨 {"code":0,"msg":"param error","data":[]} → throw 而非返空 (禁把 code 当成功)', async () => {
      const http = makeHttp({ code: 0, msg: 'param error', data: [] });
      const call = new TencentCalendarAdapter(http, BASE).fetchTradingDates(
        'cn',
        '2026-07-01',
        '2026-07-14',
      );
      // 返空 = 链降不了级 = 再造一个 push2delay 毒饵 ⇒ 必须 throw。
      await expect(call).rejects.toThrow(/非成功形态/);
    });

    it('data 为空对象 (无 symbol 块) → throw (Object.values([])[0] === undefined 陷阱)', async () => {
      const http = makeHttp({ code: 0, msg: '', data: {} });
      await expect(
        new TencentCalendarAdapter(http, BASE).fetchTradingDates('cn', '2026-07-01', '2026-07-14'),
      ).rejects.toThrow(/symbol 块/);
    });

    it('缺 day[] (vendor 改 schema) → throw 而非静默返空', async () => {
      const http = makeHttp({ code: 0, msg: '', data: { sh000001: { qfqday: [] } } });
      await expect(
        new TencentCalendarAdapter(http, BASE).fetchTradingDates('cn', '2026-07-01', '2026-07-14'),
      ).rejects.toThrow(/day/);
    });

    it('data 为 null / msg 非空 → throw', async () => {
      await expect(
        new TencentCalendarAdapter(
          makeHttp({ code: 0, msg: '', data: null }),
          BASE,
        ).fetchTradingDates('cn', '2026-07-01', '2026-07-14'),
      ).rejects.toThrow(/非成功形态/);
      await expect(
        new TencentCalendarAdapter(
          makeHttp({ code: 0, msg: 'anything', data: { sh000001: { day: [] } } }),
          BASE,
        ).fetchTradingDates('cn', '2026-07-01', '2026-07-14'),
      ).rejects.toThrow(/非成功形态/);
    });

    it('day 空数组 (区间确无交易日) → 空 dates (非 error, 由 T010 合理性闸兜底)', async () => {
      const http = makeHttp({ code: 0, msg: '', data: { sh000001: { day: [] } } });
      expect(
        await new TencentCalendarAdapter(http, BASE).fetchTradingDates(
          'cn',
          '2026-07-01',
          '2026-07-14',
        ),
      ).toEqual({ dates: [], sessionKinds: {}, servedBy: 'tencent' });
    });
  });

  // 🚨 Guardrail 3: 响应 key 回显 ≠ 请求参数。
  describe('响应 key 回显 (Guardrail 3)', () => {
    it('🚨 请求 usDJI → 响应 key 回显 us.DJI 仍能正确解析 (禁按请求参数查 key)', async () => {
      const http = makeHttp({
        code: 0,
        msg: '',
        // 实证形态: 请求 `usDJI`, 响应 key 是 `us.DJI` —— 按请求参数查 key 会静默返空。
        data: { 'us.DJI': { day: [['2026-07-06', '1', '2', '3', '4', '5']] } },
      });
      expect(
        await new TencentCalendarAdapter(http, BASE).fetchTradingDates(
          'us',
          '2026-07-01',
          '2026-07-07',
        ),
      ).toEqual({ dates: ['2026-07-06'], sessionKinds: {}, servedBy: 'tencent' });
    });

    it('容错: day[] 内非数组 / 坏日期格式坏项跳过, 不整体失败', async () => {
      const http = makeHttp({
        code: 0,
        msg: '',
        data: {
          sh000001: {
            day: [
              ['2026-07-01', '1'],
              'garbage', // 非数组 → 跳过
              [123, '1'], // 首元素非字符串 → 跳过
              ['2026/07/02', '1'], // 错格式 (斜杠) → 跳过
              ['2026-07-03', '1'],
            ],
          },
        },
      });
      expect(
        await new TencentCalendarAdapter(http, BASE).fetchTradingDates(
          'cn',
          '2026-07-01',
          '2026-07-14',
        ),
      ).toEqual({ dates: ['2026-07-01', '2026-07-03'], sessionKinds: {}, servedBy: 'tencent' });
    });
  });
});
