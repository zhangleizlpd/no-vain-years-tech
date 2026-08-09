import { describe, it, expect, vi } from 'vitest';
import { FutuUniverseAdapter } from './futu-universe.adapter.js';
import type { VendorHttpClient, VendorRequest } from './vendor-http-client.js';

/**
 * 富途 us universe adapter mock 单测 (sellput-viz Phase 1 #4)。
 *
 * 仿真端的行形态**逐字段照实测**（2026-07-31，经 77 → 隧道打真接口）：`code` 恒 `US.<ticker>`、
 * `name` 中英混合、`stock_type ∈ {STOCK, ETF}`、`delisting` 恒 false、`listing_date` 73% 是
 * `1970-01-01` 占位。这些不是编的形状 —— 编的形状测不出真陷阱。
 *
 * 真端点 / 全集规模 / 白名单覆盖由 env-gated 真 vendor IT 校真
 * (`marketdata.futu-shim.vendor`, `RUN_MARKETDATA_IT`)。
 */
const BASE = 'http://10.89.0.1:8811';
const TOKEN = 'test-shim-token';

/** 一行照实测形态（17 列里只有 code/name 被消费，其余原样带着以证明不会被误读）。 */
function row(code: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    code,
    name,
    delisting: false,
    exchange_type: 'US_NASDAQ',
    listing_date: '1970-01-01',
    lot_size: 1,
    stock_type: 'STOCK',
    stock_owner: '',
    ...extra,
  };
}

function makeShim(rows: unknown[], countOverride?: number) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const request = vi.fn(async (req: VendorRequest) => {
    calls.push({ url: req.url, auth: req.headers?.Authorization });
    return { as_of: '2026-07-31T09:44:00+00:00', count: countOverride ?? rows.length, rows };
  });
  return { http: { request } as unknown as VendorHttpClient, calls };
}

function makeAdapter(http: VendorHttpClient): FutuUniverseAdapter {
  return new FutuUniverseAdapter(http, BASE, TOKEN);
}

describe('FutuUniverseAdapter', () => {
  describe('请求结构 + 市场映射', () => {
    it('GET <shim>/universe?market=US + Bearer 鉴权; 单次调用取全集 (无分页)', async () => {
      const { http, calls } = makeShim([row('US.AAPL', '苹果'), row('US.PEP', '百事可乐')]);
      const out = await makeAdapter(http).enumerate(['us']);

      expect(calls).toHaveLength(1); // 🚨 换源的决定性收益: 1 次请求 vs 东财 137 次
      expect(calls[0].url).toBe(`${BASE}/universe?market=US`);
      expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
      expect(out).toEqual([
        { market: 'us', code: 'AAPL', name: '苹果' },
        { market: 'us', code: 'PEP', name: '百事可乐' },
      ]);
    });

    it('非 us 市场静默跳过、零外呼 (由链平移下一节点, 不是错误)', async () => {
      const { http, calls } = makeShim([row('US.AAPL', '苹果')]);
      const out = await makeAdapter(http).enumerate(['cn', 'hk']);

      expect(out).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it('混合市场: 只为 us 发一次请求, 其余跳过', async () => {
      const { http, calls } = makeShim([row('US.AAPL', '苹果')]);
      const out = await makeAdapter(http).enumerate(['cn', 'us', 'hk']);

      expect(calls).toHaveLength(1);
      expect(out.map((e) => e.code)).toEqual(['AAPL']);
    });
  });

  describe('canonical 归一', () => {
    it('code 去掉 US. 前缀 → canonical us:<ticker>', async () => {
      const { http } = makeShim([row('US.VICI', 'VICI Properties', { stock_type: 'ETF' })]);
      expect(await makeAdapter(http).enumerate(['us'])).toEqual([
        { market: 'us', code: 'VICI', name: 'VICI Properties' },
      ]);
    });

    it('🚨 VICI 被富途分类成 ETF 仍照常收录 (STOCK ∪ ETF 并集在 shim 侧完成)', async () => {
      // 只取 STOCK 会静默丢掉我们自己的锚 —— 这条断言守的是「并集」这个前提没被谁改掉。
      const { http } = makeShim([
        row('US.AAPL', '苹果', { stock_type: 'STOCK' }),
        row('US.VICI', 'VICI Properties', { stock_type: 'ETF' }),
      ]);
      const out = await makeAdapter(http).enumerate(['us']);
      expect(out.map((e) => e.code).sort()).toEqual(['AAPL', 'VICI']);
    });

    it('🚨 带 `*` 的 ticker 原样透传, 禁剥星号 (实测 11 个带*票的基础票并存 → 剥了会撞车覆盖真票)', async () => {
      const { http } = makeShim([
        row('US.BHVN', 'Biohaven'),
        row('US.BHVN*', 'BIOHAVEN LTD', { exchange_type: 'US_NYSE' }),
      ]);
      const out = await makeAdapter(http).enumerate(['us']);

      expect(out.map((e) => e.code)).toEqual(['BHVN', 'BHVN*']);
      // 两条 canonical 必须彼此独立 —— 塌成一条 = 真票的 name 被壳票覆盖且无人知晓。
      expect(new Set(out.map((e) => e.code)).size).toBe(2);
    });

    it('数字型 ticker (US.1061) 照常收录', async () => {
      const { http } = makeShim([row('US.1061', 'FALCONS BEYOND GLOBAL INC')]);
      expect((await makeAdapter(http).enumerate(['us']))[0]).toMatchObject({ code: '1061' });
    });

    it('不映射 status / listDate / listingStatus (实测: delisting 恒 false、listing_date 73% 是占位)', async () => {
      const { http } = makeShim([row('US.AAPL', '苹果', { listing_date: '1980-12-12' })]);
      const [entry] = await makeAdapter(http).enumerate(['us']);
      // 契约面只有三个字段 —— 多映射一个 73% 是垃圾的 listDate 等于往库里伪造 IPO 日。
      expect(Object.keys(entry).sort()).toEqual(['code', 'market', 'name']);
    });
  });

  describe('契约与截断闸', () => {
    it('缺 rows[] → throw (禁静默返空: 返空会让链以为「该市场无候选」而平移)', async () => {
      const http = { request: vi.fn(async () => ({ count: 0 })) } as unknown as VendorHttpClient;
      await expect(makeAdapter(http).enumerate(['us'])).rejects.toThrow(/rows/);
    });

    it('🚨 信封 count 与实收行数不符 → throw (东财 F1 静默截断的对账防线)', async () => {
      const { http } = makeShim([row('US.AAPL', '苹果')], 13683);
      await expect(makeAdapter(http).enumerate(['us'])).rejects.toThrow(/疑截断/);
    });

    it('count 与行数一致时放行 (对账不误伤正常响应)', async () => {
      const { http } = makeShim([row('US.AAPL', '苹果'), row('US.PEP', '百事')], 2);
      expect(await makeAdapter(http).enumerate(['us'])).toHaveLength(2);
    });

    it('🚨 坏行 → throw 而非跳过 (静默丢行 = 静默丢标的, 正是 F1 的形状)', async () => {
      for (const bad of [
        { name: '缺 code' },
        row('AAPL', '缺 US. 前缀'),
        row('CN.600519', '前缀不是请求的市场'),
        row('US.', '前缀之后空 ticker'),
        row('US.AAPL', '   '), // 空白 name
        'garbage',
      ]) {
        const { http } = makeShim([bad]);
        await expect(makeAdapter(http).enumerate(['us'])).rejects.toThrow(/不合契约/);
      }
    });

    it('空全集 → 空数组不抛 (由链 fail-soft 处理; 与「坏行」是两回事)', async () => {
      const { http } = makeShim([]);
      expect(await makeAdapter(http).enumerate(['us'])).toEqual([]);
    });
  });
});
