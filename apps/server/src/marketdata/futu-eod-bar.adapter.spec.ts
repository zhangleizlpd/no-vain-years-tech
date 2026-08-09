import { describe, it, expect, vi } from 'vitest';
import { FutuEodBarAdapter } from './futu-eod-bar.adapter.js';
import type { VendorHttpClient, VendorRequest } from './vendor-http-client.js';

/**
 * 富途 us 日线 adapter mock 单测。
 *
 * 仿真行**逐字段照实测**（2026-07-31，US.PEP 经隧道打真接口）：`time_key` 带 ` 00:00:00`
 * 后缀、`turnover_rate` 是**分数**（0.00607 ≈ 0.6%）、`last_close` 有真值、`change_rate`
 * 是**原始差**（除权日实测与 `(close−last_close)/last_close` 逐位相等）。
 *
 * 真端点 / 历史视野边界由 env-gated 真 vendor IT 校真。
 */
const BASE = 'http://10.89.0.1:8811';
const TOKEN = 'test-shim-token';

/**
 * 2026-07-30 US.PEP 的**真实返回行**（PoC 原样抄下，13 列）。
 * ⚠️ 数值写字面量、不用算术推导 —— `140.2 + 2.3` 在 IEEE754 下是 `142.50000000000003`，
 * 拿它当期望值只会测出浮点噪音，测不出映射对不对。
 */
const REAL_ROW = {
  code: 'US.PEP',
  name: '百事可乐',
  time_key: '2026-07-30 00:00:00',
  open: 141.1,
  close: 140.2,
  high: 142.52,
  low: 139.42,
  last_close: 143.5,
  change_rate: -2.2996515679442586,
  pe_ratio: 23.366,
  turnover_rate: 0.00607,
  volume: 8257463.0,
  turnover: 1158029975.0,
} as const;

/** 换日期/收盘价，其余保持实测形态。 */
function bar(day: string, close: number, extra: Record<string, unknown> = {}) {
  return { ...REAL_ROW, time_key: `${day} 00:00:00`, close, ...extra };
}

function makeShim(rows: unknown[], countOverride?: number) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const request = vi.fn(async (req: VendorRequest) => {
    calls.push({ url: req.url, auth: req.headers?.Authorization });
    return { as_of: '2026-07-31T09:44:00+00:00', count: countOverride ?? rows.length, rows };
  });
  return { http: { request } as unknown as VendorHttpClient, calls };
}

const makeAdapter = (http: VendorHttpClient) => new FutuEodBarAdapter(http, BASE, TOKEN);

describe('FutuEodBarAdapter', () => {
  describe('请求结构', () => {
    it('GET <shim>/kline，恒 ktype=K_DAY & autype=NONE，区间透传 + Bearer', async () => {
      const { http, calls } = makeShim([bar('2026-07-30', 140.2)]);
      await makeAdapter(http).getBars({
        symbol: 'us:PEP',
        adjust: 'none',
        from: '2026-07-01',
        to: '2026-07-31',
      });

      expect(calls).toHaveLength(1); // 分页在 shim 内部，此处恒 1 个请求
      const url = new URL(calls[0].url);
      expect(url.pathname).toBe('/kline');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        code: 'US.PEP',
        ktype: 'K_DAY',
        autype: 'NONE',
        start: '2026-07-01',
        end: '2026-07-31',
      });
      expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
    });

    it('from/to 省略时不带 start/end（由 vendor 定默认窗）', async () => {
      const { http, calls } = makeShim([bar('2026-07-30', 140.2)]);
      await makeAdapter(http).getBars({ symbol: 'us:PEP', adjust: 'none' });
      const url = new URL(calls[0].url);
      expect(url.searchParams.has('start')).toBe(false);
      expect(url.searchParams.has('end')).toBe(false);
    });

    it('非 us symbol → throw 且零外呼（不静默返空让管线记 0 行成功）', async () => {
      const { http, calls } = makeShim([]);
      for (const symbol of ['cn:600519', 'hk:00700', 'PEP', 'us:']) {
        await expect(makeAdapter(http).getBars({ symbol, adjust: 'none' })).rejects.toThrow(
          /不支持 symbol/,
        );
      }
      expect(calls).toHaveLength(0);
    });

    it('🚨 adjust ≠ none → throw 且零外呼（raw 槽 + 读时复权，塞复权价会二次复权）', async () => {
      const { http, calls } = makeShim([]);
      for (const adjust of ['forward', 'backward'] as const) {
        await expect(makeAdapter(http).getBars({ symbol: 'us:PEP', adjust })).rejects.toThrow(
          /只支持 adjust='none'/,
        );
      }
      expect(calls).toHaveLength(0);
    });
  });

  describe('字段映射', () => {
    it('time_key 取日期段；OHLC / volume / turnover / turnover_rate 直映', async () => {
      const { http } = makeShim([bar('2026-07-30', 140.2)]);
      const [point] = await makeAdapter(http).getBars({ symbol: 'us:PEP', adjust: 'none' });

      expect(point).toEqual({
        tradeDate: '2026-07-30', // ← ` 00:00:00` 被切掉
        adjust: 'none',
        open: '141.1',
        high: '142.52',
        low: '139.42',
        close: '140.2',
        changePct: null,
        prevClose: '143.5',
        volume: '8257463',
        amount: '1158029975',
        turnoverRate: '0.00607',
      });
    });

    it('🚨 changePct 恒 null，即便 vendor 给了 change_rate（列语义是"官方口径"，富途给的是原始差）', async () => {
      const { http } = makeShim([bar('2026-07-30', 140.2, { change_rate: -2.2996515679442586 })]);
      const [point] = await makeAdapter(http).getBars({ symbol: 'us:PEP', adjust: 'none' });
      expect(point.changePct).toBeNull();
    });

    it('🚨 turnoverRate 不做 ×100（两边同为分数口径，乘了会比 cn 大两个数量级）', async () => {
      const { http } = makeShim([bar('2026-07-30', 140.2, { turnover_rate: 0.00607 })]);
      const [point] = await makeAdapter(http).getBars({ symbol: 'us:PEP', adjust: 'none' });
      expect(point.turnoverRate).toBe('0.00607');
    });

    it('prevClose 落真值（us 是第一个真有它的市场；cn 侧恒 null）', async () => {
      const { http } = makeShim([bar('2026-07-30', 140.2, { last_close: 143.5 })]);
      const [point] = await makeAdapter(http).getBars({ symbol: 'us:PEP', adjust: 'none' });
      expect(point.prevClose).toBe('143.5');
    });

    it('可缺字段缺失 → null，不整体失败（close 是唯一必需的价格）', async () => {
      const rows = [
        {
          time_key: '2026-07-30 00:00:00',
          close: 140.2,
          open: null,
          high: null,
          low: null,
          last_close: null,
          volume: null,
          turnover: null,
          turnover_rate: null,
        },
      ];
      const [point] = await makeAdapter(makeShim(rows).http).getBars({
        symbol: 'us:PEP',
        adjust: 'none',
      });
      expect(point).toMatchObject({
        close: '140.2',
        open: '140.2', // 缺 OHL → 回落到 close，不编 0
        prevClose: null,
        volume: null,
        turnoverRate: null,
      });
    });

    it('结果按 tradeDate 升序（port 契约）', async () => {
      const { http } = makeShim([bar('2026-07-30', 3), bar('2026-07-28', 1), bar('2026-07-29', 2)]);
      const out = await makeAdapter(http).getBars({ symbol: 'us:PEP', adjust: 'none' });
      expect(out.map((p) => p.tradeDate)).toEqual(['2026-07-28', '2026-07-29', '2026-07-30']);
    });
  });

  describe('契约与截断闸', () => {
    it('缺 rows[] → throw', async () => {
      const http = { request: vi.fn(async () => ({ count: 0 })) } as unknown as VendorHttpClient;
      await expect(makeAdapter(http).getBars({ symbol: 'us:PEP', adjust: 'none' })).rejects.toThrow(
        /rows/,
      );
    });

    it('🚨 信封 count 与实收行数不符 → throw（传输层截断对账）', async () => {
      const { http } = makeShim([bar('2026-07-30', 140.2)], 250);
      await expect(makeAdapter(http).getBars({ symbol: 'us:PEP', adjust: 'none' })).rejects.toThrow(
        /疑截断/,
      );
    });

    it('🚨 坏行 → throw 而非跳过（静默丢一行 = 库里凭空少一个交易日）', async () => {
      for (const badRow of [
        { close: 1 }, // 缺 time_key
        { time_key: '2026/07/30 00:00:00', close: 1 }, // 日期格式不合
        { time_key: '2026-07-30 00:00:00' }, // 缺 close
        { time_key: '2026-07-30 00:00:00', close: 'n/a' }, // close 非数值
        'garbage',
      ]) {
        const { http } = makeShim([badRow]);
        await expect(
          makeAdapter(http).getBars({ symbol: 'us:PEP', adjust: 'none' }),
        ).rejects.toThrow(/不合契约/);
      }
    });

    it('空区间 → 空数组不抛（区间确无交易日是合法结果）', async () => {
      const { http } = makeShim([]);
      expect(await makeAdapter(http).getBars({ symbol: 'us:PEP', adjust: 'none' })).toEqual([]);
    });
  });
});
