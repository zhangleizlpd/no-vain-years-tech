import { describe, it, expect, vi } from 'vitest';
import type { VendorHttpClient, VendorRequest } from './vendor-http-client.js';
import { EastmoneySearchAdapter } from './eastmoney-search.adapter.js';

/**
 * 东财搜索 adapter mock 单测 (015 T012)。验请求 URL 结构 + MultiMatch 归一化 + 容错跳过坏项。
 * 真东财字段值/契约由 env-gated IT 校真 (SC-S08)。
 */
const BASE = 'https://searchapi.eastmoney.com';

function makeHttp(data: unknown): { http: VendorHttpClient; calls: VendorRequest[] } {
  const calls: VendorRequest[] = [];
  const request = vi.fn(async (req: VendorRequest) => {
    calls.push(req);
    return data;
  });
  return { http: { request } as unknown as VendorHttpClient, calls };
}

describe('EastmoneySearchAdapter', () => {
  it('QuotationCodeTable.Data → 归一化 canonical + name + type, 覆盖 A/HK/US', async () => {
    const { http, calls } = makeHttp({
      QuotationCodeTable: {
        Data: [
          { Code: '600519', Name: '贵州茅台', MktNum: '1', Classify: 'AStock' },
          { Code: '000001', Name: '平安银行', MktNum: '0', Classify: 'AStock' },
          { Code: '00700', Name: '腾讯控股', MktNum: '116', Classify: 'HKStock' },
          { Code: 'AAPL', Name: '苹果', MktNum: '105', Classify: 'USStock' },
        ],
      },
    });
    const out = await new EastmoneySearchAdapter(http, BASE).search('茅台');

    expect(out).toEqual([
      { symbol: 'cn:600519', name: '贵州茅台', type: 'stock' },
      { symbol: 'cn:000001', name: '平安银行', type: 'stock' },
      { symbol: 'hk:00700', name: '腾讯控股', type: 'stock' },
      { symbol: 'us:AAPL', name: '苹果', type: 'stock' },
    ]);
    // 请求 URL: suggest/get + input 编码 + type=14
    expect(calls[0].url).toContain(`${BASE}/api/suggest/get?input=${encodeURIComponent('茅台')}`);
    expect(calls[0].url).toContain('type=14');
  });

  it('ETF / index 类型映射', async () => {
    const { http } = makeHttp({
      QuotationCodeTable: {
        Data: [
          { Code: '510300', Name: '沪深300ETF', MktNum: '1', Classify: 'ETF' },
          { Code: '000300', Name: '沪深300', MktNum: '1', Classify: 'Index' },
        ],
      },
    });
    const out = await new EastmoneySearchAdapter(http, BASE).search('300');
    expect(out.map((h) => h.type)).toEqual(['etf', 'index']);
  });

  it('债券 (Classify=Bond) 剔除, 仅留股票/ETF/指数', async () => {
    // 真实采样: 平安银行搜出 1 股 (AStock) + N 债 (Bond, 751xxx 深市债券分销代码)。
    const { http } = makeHttp({
      QuotationCodeTable: {
        Data: [
          { Code: '000001', Name: '平安银行', MktNum: '0', Classify: 'AStock' },
          {
            Code: '751240',
            Name: '平安银行',
            MktNum: '1',
            Classify: 'Bond',
            SecurityTypeName: '债券',
          },
          {
            Code: '751453',
            Name: '平安银行',
            MktNum: '1',
            Classify: 'Bond',
            SecurityTypeName: '债券',
          },
        ],
      },
    });
    const out = await new EastmoneySearchAdapter(http, BASE).search('平安银行');
    expect(out).toEqual([{ symbol: 'cn:000001', name: '平安银行', type: 'stock' }]);
  });

  it('容错: 未知 MktNum / 缺字段的坏项跳过, 不整体失败', async () => {
    const { http } = makeHttp({
      QuotationCodeTable: {
        Data: [
          { Code: '600519', Name: '贵州茅台', MktNum: '1', Classify: 'AStock' },
          { Code: '999999', Name: '某板块', MktNum: '90' }, // 未知 MktNum → 跳过
          { Code: '', Name: '空代码', MktNum: '1' }, // 缺 code → 跳过
          { Name: '无代码', MktNum: '1' }, // 缺 Code → 跳过
        ],
      },
    });
    const out = await new EastmoneySearchAdapter(http, BASE).search('x');
    expect(out).toEqual([{ symbol: 'cn:600519', name: '贵州茅台', type: 'stock' }]);
  });

  it('无候选 / 响应结构异常 → 空数组 (非 error)', async () => {
    const { http: emptyHttp } = makeHttp({ QuotationCodeTable: { Data: [] } });
    expect(await new EastmoneySearchAdapter(emptyHttp, BASE).search('冷僻')).toEqual([]);

    const { http: weirdHttp } = makeHttp({ unexpected: true });
    expect(await new EastmoneySearchAdapter(weirdHttp, BASE).search('x')).toEqual([]);
  });

  it('空 query → 空数组, 不发请求', async () => {
    const { http, calls } = makeHttp({ QuotationCodeTable: { Data: [] } });
    expect(await new EastmoneySearchAdapter(http, BASE).search('   ')).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
