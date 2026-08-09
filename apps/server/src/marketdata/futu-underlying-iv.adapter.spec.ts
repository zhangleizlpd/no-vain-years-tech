import { describe, it, expect, vi } from 'vitest';
import { FutuUnderlyingIvAdapter } from './futu-underlying-iv.adapter.js';
import { TransientVendorError, VendorHttpError } from './vendor-http-client.js';
import type { VendorHttpClient, VendorRequest } from './vendor-http-client.js';

/**
 * 富途标的级 IV adapter mock 单测 (046 T007)。
 *
 * 仿真行**逐字段照 SDK 列表**（`futu-api` 10.8.6808 的 `get_option_underlying_overview` /
 * `get_option_underlying_his_volatility` docstring）+ p3 2026-07-29 实测数值
 * （PEP iv_percentile 63.5 / iv_rank 51.5；VICI 72.6 / 50.2）。
 *
 * 真端点契约由 env-gated 真 vendor IT 校真（`marketdata.futu-shim.vendor`）——
 * ⚠️ 那道门恒 skip，本文件全绿**不**构成真契约的证据。
 */
const BASE = 'http://10.89.0.1:8811';
const TOKEN = 'test-shim-token';

/** 2026-07-29 实测的 US.PEP overview 行（20 列，照 SDK col_list 顺序）。 */
const REAL_OVERVIEW_ROW = {
  code: 'US.PEP',
  name: '百事可乐',
  call_volume: 12043,
  put_volume: 9821,
  call_open_interest: 183044,
  put_open_interest: 151298,
  iv: 24.8,
  iv_rank: 51.5,
  iv_percentile: 63.5,
  pre_iv: 25.1,
  hv_30d: 19.3,
  hv_30d_percentile: 44.2,
  hv_60d: 20.7,
  hv_60d_percentile: 47.8,
  hv_90d: 21.4,
  hv_90d_percentile: 49.1,
  hv_120d: 22.0,
  hv_120d_percentile: 50.6,
  hv_365d: 23.9,
  hv_365d_percentile: 55.3,
} as const;

function overviewRow(code: string, extra: Record<string, unknown> = {}) {
  return { ...REAL_OVERVIEW_ROW, code, ...extra };
}

/** `his_volatility` 一行（SDK col_list：code/name/time/timestamp/iv/hv/underlying_price）。 */
function volRow(time: string, iv: number, extra: Record<string, unknown> = {}) {
  return {
    code: 'US.PEP',
    name: '百事可乐',
    time,
    timestamp: 1_785_000_000.0,
    iv,
    hv: 19.3,
    underlying_price: 140.2,
    ...extra,
  };
}

function makeShim(rows: unknown[], countOverride?: number) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const request = vi.fn(async (req: VendorRequest) => {
    calls.push({ url: req.url, auth: req.headers?.Authorization });
    return { as_of: '2026-08-03T05:19:48+00:00', count: countOverride ?? rows.length, rows };
  });
  return { http: { request } as unknown as VendorHttpClient, calls };
}

/** 每次调用返回**不同**的一批行（验分批时各批各自解析、结果按批合并）。 */
function makeBatchingShim(rowsPerCall: unknown[][]) {
  const calls: { url: string }[] = [];
  const request = vi.fn(async (req: VendorRequest) => {
    const rows = rowsPerCall[calls.length] ?? [];
    calls.push({ url: req.url });
    return { as_of: '2026-08-03T05:19:48+00:00', count: rows.length, rows };
  });
  return { http: { request } as unknown as VendorHttpClient, calls };
}

const makeAdapter = (http: VendorHttpClient) => new FutuUnderlyingIvAdapter(http, BASE, TOKEN);

describe('FutuUnderlyingIvAdapter', () => {
  describe('overview 请求结构', () => {
    it('GET <shim>/overview，codes 逗号拼接一批直通 + Bearer', async () => {
      const { http, calls } = makeShim([overviewRow('US.PEP'), overviewRow('US.VICI')]);
      await makeAdapter(http).getIvSnapshots(['us:PEP', 'us:VICI']);

      expect(calls).toHaveLength(1); // 🚨 批量端点的要点：12 只锚一轮是 1 次调用不是 12 次
      const url = new URL(calls[0].url);
      expect(url.pathname).toBe('/overview');
      expect(url.searchParams.get('codes')).toBe('US.PEP,US.VICI');
      expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
    });

    it('🚨 >500 codes 按 vendor 单批上限拆批，结果按批合并（不丢尾批）', async () => {
      const symbols = Array.from({ length: 501 }, (_, i) => `us:S${i}`);
      const { http, calls } = makeBatchingShim([
        symbols.slice(0, 500).map((s) => overviewRow(`US.${s.slice(3)}`)),
        [overviewRow('US.S500')],
      ]);
      const out = await makeAdapter(http).getIvSnapshots(symbols);

      expect(calls).toHaveLength(2);
      expect(new URL(calls[0].url).searchParams.get('codes')?.split(',')).toHaveLength(500);
      expect(new URL(calls[1].url).searchParams.get('codes')).toBe('US.S500');
      expect(out).toHaveLength(501);
      expect(out[500].symbol).toBe('us:S500');
    });

    it('恰好 500 codes 仍是单批（边界不多切一页）', async () => {
      const symbols = Array.from({ length: 500 }, (_, i) => `us:S${i}`);
      const { http, calls } = makeBatchingShim([
        symbols.map((s) => overviewRow(`US.${s.slice(3)}`)),
      ]);
      await makeAdapter(http).getIvSnapshots(symbols);
      expect(calls).toHaveLength(1);
    });

    it('非 us symbol → throw 且零外呼（不静默返空让管线记 0 行成功）', async () => {
      const { http, calls } = makeShim([]);
      for (const symbol of ['cn:600519', 'hk:00700', 'PEP', 'us:']) {
        await expect(makeAdapter(http).getIvSnapshots([symbol])).rejects.toThrow(/不支持 symbol/);
      }
      expect(calls).toHaveLength(0);
    });

    it('空 symbols → 空数组且零外呼', async () => {
      const { http, calls } = makeShim([]);
      expect(await makeAdapter(http).getIvSnapshots([])).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });

  describe('overview 字段映射', () => {
    it('20 列直映为 Decimal-safe string，code 反查回 canonical symbol', async () => {
      const { http } = makeShim([overviewRow('US.PEP')]);
      const [snap] = await makeAdapter(http).getIvSnapshots(['us:PEP']);

      expect(snap).toEqual({
        symbol: 'us:PEP',
        iv: '24.8',
        ivRank: '51.5',
        ivPercentile: '63.5',
        preIv: '25.1',
        hv30: '19.3',
        hv30Percentile: '44.2',
        hv60: '20.7',
        hv60Percentile: '47.8',
        hv90: '21.4',
        hv90Percentile: '49.1',
        hv120: '22',
        hv120Percentile: '50.6',
        hv365: '23.9',
        hv365Percentile: '55.3',
        callVolume: '12043',
        putVolume: '9821',
        callOi: '183044',
        putOi: '151298',
      });
    });

    it('🚨 缺失字段 → null 而非 0（IVP 上 0 的意思是「一年最低」，与「没有值」方向相反）', async () => {
      const { http } = makeShim([
        { code: 'US.PEP', iv: null, iv_rank: null, iv_percentile: null, hv_30d: 'n/a' },
      ]);
      const [snap] = await makeAdapter(http).getIvSnapshots(['us:PEP']);
      expect(snap.iv).toBeNull();
      expect(snap.ivPercentile).toBeNull();
      expect(snap.hv30).toBeNull();
      expect(snap.symbol).toBe('us:PEP');
    });

    it('无期权的标的整行缺席 → 结果短于请求，不抛（不是每个标的都有期权）', async () => {
      const { http } = makeShim([overviewRow('US.PEP')]);
      const out = await makeAdapter(http).getIvSnapshots(['us:PEP', 'us:VICI']);
      expect(out.map((s) => s.symbol)).toEqual(['us:PEP']);
    });

    it('🚨 返回了本批没请求过的 code → throw（批次错配会把 IV 记到别的标的名下）', async () => {
      const { http } = makeShim([overviewRow('US.AAPL')]);
      await expect(makeAdapter(http).getIvSnapshots(['us:PEP'])).rejects.toThrow(/不在本批请求内/);
    });

    it('🚨 缺 code 的行 → throw 而非跳过', async () => {
      const { http } = makeShim([{ iv: 24.8 }]);
      await expect(makeAdapter(http).getIvSnapshots(['us:PEP'])).rejects.toThrow(/不在本批请求内/);
    });
  });

  describe('his-vol 请求结构', () => {
    it('GET <shim>/his-vol，code + 区间透传 + Bearer', async () => {
      const { http, calls } = makeShim([volRow('2026-07-30', 24.8)]);
      await makeAdapter(http).getIvHistoryRange({
        symbol: 'us:PEP',
        from: '2026-01-01',
        to: '2026-06-01',
      });

      const url = new URL(calls[0].url);
      expect(url.pathname).toBe('/his-vol');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        code: 'US.PEP',
        start: '2026-01-01',
        end: '2026-06-01',
      });
      expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
    });

    it('from/to 省略时不带 start/end（由 vendor 定默认窗）', async () => {
      const { http, calls } = makeShim([volRow('2026-07-30', 24.8)]);
      await makeAdapter(http).getIvHistoryRange({ symbol: 'us:PEP' });
      const url = new URL(calls[0].url);
      expect(url.searchParams.has('start')).toBe(false);
      expect(url.searchParams.has('end')).toBe(false);
    });

    it('🚨 adapter 不切窗：3 年区间仍是 1 个请求（切分归回填侧，超限由 shim 400 说出来）', async () => {
      const { http, calls } = makeShim([volRow('2026-07-30', 24.8)]);
      await makeAdapter(http).getIvHistoryRange({
        symbol: 'us:PEP',
        from: '2023-08-01',
        to: '2026-08-01',
      });
      expect(calls).toHaveLength(1);
    });

    it('非 us symbol → throw 且零外呼', async () => {
      const { http, calls } = makeShim([]);
      await expect(makeAdapter(http).getIvHistoryRange({ symbol: 'cn:600519' })).rejects.toThrow(
        /不支持 symbol/,
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe('his-vol 字段映射', () => {
    it('time 取日期段（带/不带时间后缀都吃得下）+ iv/hv/标的价直映', async () => {
      const { http } = makeShim([volRow('2026-07-30 00:00:00', 24.8)]);
      const [point] = await makeAdapter(http).getIvHistoryRange({ symbol: 'us:PEP' });
      expect(point).toEqual({
        date: '2026-07-30',
        iv: '24.8',
        hv: '19.3',
        underlyingPrice: '140.2',
      });
    });

    it('🚨 vendor 按日期降序下发 → 端口按升序返回', async () => {
      const { http } = makeShim([
        volRow('2026-07-30', 3),
        volRow('2026-07-29', 2),
        volRow('2026-07-28', 1),
      ]);
      const out = await makeAdapter(http).getIvHistoryRange({ symbol: 'us:PEP' });
      expect(out.map((p) => p.date)).toEqual(['2026-07-28', '2026-07-29', '2026-07-30']);
    });

    it('iv/hv/标的价缺失 → null，不整体失败（date 是唯一必需项）', async () => {
      const { http } = makeShim([
        { time: '2026-07-30', iv: null, hv: null, underlying_price: null },
      ]);
      const [point] = await makeAdapter(http).getIvHistoryRange({ symbol: 'us:PEP' });
      expect(point).toEqual({ date: '2026-07-30', iv: null, hv: null, underlyingPrice: null });
    });

    it('🚨 坏行 → throw 而非跳过（少一行会让「窗口够不够 252 天」的分界悄悄挪位）', async () => {
      for (const badRow of [{ iv: 1 }, { time: '2026/07/30', iv: 1 }, 'garbage']) {
        const { http } = makeShim([badRow]);
        await expect(makeAdapter(http).getIvHistoryRange({ symbol: 'us:PEP' })).rejects.toThrow(
          /不合契约/,
        );
      }
    });

    it('区间无数据 → 空数组不抛', async () => {
      const { http } = makeShim([]);
      expect(await makeAdapter(http).getIvHistoryRange({ symbol: 'us:PEP' })).toEqual([]);
    });
  });

  describe('契约闸与 vendor 错误', () => {
    it('缺 rows[] → throw（两个端点各一次）', async () => {
      const http = { request: vi.fn(async () => ({ count: 0 })) } as unknown as VendorHttpClient;
      await expect(makeAdapter(http).getIvSnapshots(['us:PEP'])).rejects.toThrow(/rows/);
      await expect(makeAdapter(http).getIvHistoryRange({ symbol: 'us:PEP' })).rejects.toThrow(
        /rows/,
      );
    });

    it('🚨 信封 count 与实收行数不符 → throw（传输层截断对账）', async () => {
      const { http } = makeShim([overviewRow('US.PEP')], 12);
      await expect(makeAdapter(http).getIvSnapshots(['us:PEP'])).rejects.toThrow(/疑截断/);
    });

    it('🚨 vendor 4xx / 5xx / 超时一律原样上抛，不吞成空数组', async () => {
      // 分类由 VendorHttpClient + FUTU_SHIM_PROFILE 承担（4xx=永久 / 429·5xx·网络=瞬时），
      // adapter 的唯一义务是**不吞**：返空会被同步管线记成一次成功的空采集。
      // ⚠️ **超时就是下面那条 `'network'`**：`VendorHttpClient` 用 `AbortSignal.timeout` 掐，
      // fetch 抛出后被统一包成 `TransientVendorError(vendor, 'network')` —— 超时在这一层没有
      // 独立形态，另造一个"超时错误"去测只会测到一个真管道里不存在的东西。
      for (const err of [
        new VendorHttpError('futu-shim', 400),
        new VendorHttpError('futu-shim', 404),
        new TransientVendorError('futu-shim', 503),
        new TransientVendorError('futu-shim', 'network'),
      ]) {
        const http = {
          request: vi.fn(async () => {
            throw err;
          }),
        } as unknown as VendorHttpClient;
        await expect(makeAdapter(http).getIvSnapshots(['us:PEP'])).rejects.toThrow(err);
        await expect(makeAdapter(http).getIvHistoryRange({ symbol: 'us:PEP' })).rejects.toThrow(
          err,
        );
      }
    });

    it('🚨 分批中途失败 → 整体抛，不返回已成功的半批（半批会被记成「这批就这么多」）', async () => {
      const symbols = Array.from({ length: 501 }, (_, i) => `us:S${i}`);
      let call = 0;
      const http = {
        request: vi.fn(async () => {
          call += 1;
          if (call === 2) throw new TransientVendorError('futu-shim', 503);
          return { count: 0, rows: [] };
        }),
      } as unknown as VendorHttpClient;
      await expect(makeAdapter(http).getIvSnapshots(symbols)).rejects.toThrow(TransientVendorError);
    });
  });
});
