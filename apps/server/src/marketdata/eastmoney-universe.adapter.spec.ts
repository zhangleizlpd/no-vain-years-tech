import { describe, it, expect, vi } from 'vitest';
import type { VendorHttpClient, VendorRequest } from './vendor-http-client.js';
import { EastmoneyUniverseAdapter } from './eastmoney-universe.adapter.js';

/**
 * 东财 universe adapter mock 单测 (016 T007)。验 clist 解析 (含北交所) + canonical 归一化 +
 * 分页翻页 + 板块重叠去重 + 容错跳过坏项。真东财字段值/契约由 env-gated IT 校真 (SC-S08)。
 */
const BASE = 'https://push2.eastmoney.com';

/** 每次调用按 pn 返回对应页 (key=pn)。 */
function makePagedHttp(pages: Record<number, unknown>): {
  http: VendorHttpClient;
  calls: VendorRequest[];
} {
  const calls: VendorRequest[] = [];
  const request = vi.fn(async (req: VendorRequest) => {
    calls.push(req);
    const pn = Number(new URL(req.url).searchParams.get('pn') ?? '1');
    return pages[pn] ?? { data: { total: 0, diff: [] } };
  });
  return { http: { request } as unknown as VendorHttpClient, calls };
}

describe('EastmoneyUniverseAdapter', () => {
  it('clist diff → 归一化 canonical {market,code,name}, 含北交所 (m:0)', async () => {
    const { http, calls } = makePagedHttp({
      1: {
        data: {
          total: 3,
          diff: [
            { f12: '600519', f13: 1, f14: '贵州茅台' }, // 沪
            { f12: '000001', f13: 0, f14: '平安银行' }, // 深
            { f12: '830799', f13: 0, f14: '艾融软件' }, // 北交所 (深市场号 0)
          ],
        },
      },
    });
    const out = await new EastmoneyUniverseAdapter(http, BASE).enumerate(['cn']);

    expect(out).toEqual([
      { market: 'cn', code: '600519', name: '贵州茅台' },
      { market: 'cn', code: '000001', name: '平安银行' },
      { market: 'cn', code: '830799', name: '艾融软件' },
    ]);
    // 请求 URL: clist/get + 分页 + fs 板块过滤 + fields
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain(`${BASE}/api/qt/clist/get`);
    expect(calls[0].url).toContain('fields=f12,f13,f14');
    expect(calls[0].url).toContain('m:0+t:81+s:2048'); // 北交所板块在 fs (字面 `+`, 不 encode — 否则东财忽略 fs)
  });

  it('total > pz → 按 total 翻页直到覆盖全集', async () => {
    // total=2 但单页只给 1 条 → 必须翻到第 2 页 ((pn-1)*500 < 2 仅 pn=1, 故验小 total 单页即停)。
    // 用大 total 驱动多页: 页1/页2 各 1 条, total=501 (> PAGE_SIZE) 强制翻页。
    const { http, calls } = makePagedHttp({
      1: { data: { total: 501, diff: [{ f12: '600000', f13: 1, f14: '浦发银行' }] } },
      2: { data: { total: 501, diff: [{ f12: '000002', f13: 0, f14: '万科A' }] } },
    });
    const out = await new EastmoneyUniverseAdapter(http, BASE).enumerate(['cn']);

    expect(calls.map((c) => new URL(c.url).searchParams.get('pn'))).toEqual(['1', '2']);
    expect(out).toEqual([
      { market: 'cn', code: '600000', name: '浦发银行' },
      { market: 'cn', code: '000002', name: '万科A' },
    ]);
  });

  it('板块重叠收录同标的 → canonical 去重', async () => {
    const { http } = makePagedHttp({
      1: {
        data: {
          total: 2,
          diff: [
            { f12: '600519', f13: 1, f14: '贵州茅台' },
            { f12: '600519', f13: 1, f14: '贵州茅台' }, // 重复 → 去重
          ],
        },
      },
    });
    const out = await new EastmoneyUniverseAdapter(http, BASE).enumerate(['cn']);
    expect(out).toEqual([{ market: 'cn', code: '600519', name: '贵州茅台' }]);
  });

  it('容错: 未知 MktNum / 缺字段坏项跳过, 不整体失败', async () => {
    const { http } = makePagedHttp({
      1: {
        data: {
          total: 4,
          diff: [
            { f12: '600519', f13: 1, f14: '贵州茅台' },
            { f12: '999999', f13: 90, f14: '某板块' }, // 未知 MktNum → 跳过
            { f12: '', f13: 1, f14: '空代码' }, // 缺 code → 跳过
            { f12: '600000', f14: '无市场号' }, // 缺 f13 → 跳过
          ],
        },
      },
    });
    const out = await new EastmoneyUniverseAdapter(http, BASE).enumerate(['cn']);
    expect(out).toEqual([{ market: 'cn', code: '600519', name: '贵州茅台' }]);
  });

  it('diff 旧版 index-keyed 对象形态 → 归一化成数组解析', async () => {
    const { http } = makePagedHttp({
      1: {
        data: {
          total: 1,
          diff: { '0': { f12: '600519', f13: 1, f14: '贵州茅台' } },
        },
      },
    });
    const out = await new EastmoneyUniverseAdapter(http, BASE).enumerate(['cn']);
    expect(out).toEqual([{ market: 'cn', code: '600519', name: '贵州茅台' }]);
  });

  it('空 diff → 空数组 (非 error)', async () => {
    const { http } = makePagedHttp({ 1: { data: { total: 0, diff: [] } } });
    expect(await new EastmoneyUniverseAdapter(http, BASE).enumerate(['cn'])).toEqual([]);

    const { http: weird } = makePagedHttp({ 1: { unexpected: true } });
    expect(await new EastmoneyUniverseAdapter(weird, BASE).enumerate(['cn'])).toEqual([]);
  });

  it('enumerate(["hk"]) → fs=m:116 港股, MktNum 116 → hk:code (S2-T2)', async () => {
    const { http, calls } = makePagedHttp({
      1: {
        data: {
          total: 2,
          diff: [
            { f12: '00700', f13: 116, f14: '腾讯控股' },
            { f12: '09988', f13: 116, f14: '阿里巴巴-W' },
          ],
        },
      },
    });
    const out = await new EastmoneyUniverseAdapter(http, BASE).enumerate(['hk']);
    expect(out).toEqual([
      { market: 'hk', code: '00700', name: '腾讯控股' },
      { market: 'hk', code: '09988', name: '阿里巴巴-W' },
    ]);
    expect(calls[0].url).toContain('fs=m:116'); // 港股板块码 (字面, 不 encode)
  });

  // 🪦 us 路径已退役 (2026-07-31, Phase 1 #4 换源富途) —— 原「enumerate(["us"]) →
  //    fs=m:105,m:106,m:107」用例随之删除。退役理由见 adapter 的 MARKET_TO_FS 注释
  //    (服务端 100 条硬封顶 × 500 游标 = 静默只收 2800/13683)。下面这条守住"真的退了"。
  it('🚨 enumerate(["us"]) → 静默跳过且零外呼 (us 路径已退役, 禁悄悄加回残缺源)', async () => {
    const { http, calls } = makePagedHttp({
      1: { data: { total: 1, diff: [{ f12: 'AAPL', f13: 105, f14: '苹果' }] } },
    });
    const out = await new EastmoneyUniverseAdapter(http, BASE).enumerate(['us']);
    // 加回 us 会让链上多一个"非空但残缺"的节点 → 富途一挂就被它静默接住 (chain 只在返空时平移)。
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('不支持市场 (无 fs 映射) → 静默跳过不外呼 (S2-T2)', async () => {
    const { http, calls } = makePagedHttp({
      1: { data: { total: 1, diff: [{ f12: '600519', f13: 1, f14: '贵州茅台' }] } },
    });
    const out = await new EastmoneyUniverseAdapter(http, BASE).enumerate(['cn', 'jp']);
    expect(out).toEqual([{ market: 'cn', code: '600519', name: '贵州茅台' }]);
    // 'jp' 无 fs → 零请求 (仅 cn pn=1 一次)。
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('fs=m:1');
  });
});
