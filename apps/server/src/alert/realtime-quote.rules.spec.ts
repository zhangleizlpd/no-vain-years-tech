import { describe, expect, it } from 'vitest';

import {
  decodeGbk,
  parseSinaRealtimeQuotes,
  parseTencentRealtimeQuotes,
  toVendorSymbol,
  UnsupportedRealtimeMarketError,
} from './realtime-quote.rules.js';

/**
 * 024 T006 实时行情解析纯函数红绿 (US1; ADR-0043 §4 rules 无副作用)。
 *
 * 锚点 = PoC §5.1 真实响应样本 (2026-06-08 盘后 darwin 本机真实请求, 字段下标程序化核实):
 *   - 腾讯 88 字段 `~` 分隔: name[1] code[2] price[3] prevClose[4] changePct[32] (涨跌%, idx31=涨跌额)
 *   - 新浪 33 字段 `,` 分隔: name[0] open[1] prevClose[2] price[3]; changePct 自算 (price-prevClose)/prevClose
 * 平安银行 (000001) 当日涨 (+0.46%), 贵州茅台 (600519) 当日跌 (-0.78%) → 覆盖涨跌双向。
 */

// 腾讯 qt.gtimg.cn?q=sz000001,sh600519 真实响应 (GBK 解码后)
const TENCENT_SAMPLE =
  'v_sz000001="51~平安银行~000001~11.03~10.98~10.97~1090926~569702~521224~11.02~11031~11.01~5383~11.00~2442~10.99~2857~10.98~4200~11.03~744~11.04~1932~11.05~5462~11.06~3039~11.07~7325~~20260608161442~0.05~0.46~11.10~10.96~11.03/1090926/1203946343~1090926~120395~0.56~4.97~~11.10~10.96~1.28~2140.44~2140.47~0.46~12.08~9.88~1.20~7411~11.04~3.68~5.02~~~0.40~120394.6343~0.0000~0~ ~GP-A~-3.33~0.36~5.42~7.91~0.71~13.09~10.43~3.28~-2.22~2.04~19405600653~19405918198~16.69~-4.20~19405600653~~~-0.65~0.09~~CNY~0~~11.10~-26486~";\n' +
  'v_sh600519="1~贵州茅台~600519~1262.98~1272.86~1272.00~30828~15602~15226~1262.98~2~1262.65~1~1262.31~1~1262.20~2~1262.03~2~1262.99~7~1263.00~44~1263.02~1~1263.20~2~1263.34~1~~20260608161427~-9.88~-0.78~1278.00~1260.00~1262.98/30828/3898027116~30828~389803~0.25~19.09~~1278.00~1260.00~1.41~15788.28~15788.28~5.89~1400.15~1145.57~0.78~-47~1264.43~14.49~19.18~~~0.34~389802.7116~0.0000~0~ ~GP-A~-8.29~-3.56~4.10~30.53~26.78~1568.00~1250.10~-1.78~-7.22~-9.91~1250081601~1250081601~-74.60~-13.29~1250081601~~~-13.19~0.17~~CNY~0~___D__F__N~1261.98~42~";\n';

// 新浪 hq.sinajs.cn?list=sz000001,sh600519 真实响应 (GBK 解码后, 须 Referer)
const SINA_SAMPLE =
  'var hq_str_sz000001="平安银行,10.970,10.980,11.030,11.100,10.960,11.020,11.030,109092646,1203946343.400,1103124,11.020,538300,11.010,244200,11.000,285700,10.990,420000,10.980,74408,11.030,193200,11.040,546200,11.050,303900,11.060,732500,11.070,2026-06-08,15:00:00,00";\n' +
  'var hq_str_sh600519="贵州茅台,1272.000,1272.860,1262.980,1278.000,1260.000,1262.980,1262.990,3082836,3898027116.000,175,1262.980,100,1262.650,100,1262.310,200,1262.200,200,1262.030,700,1262.990,4370,1263.000,100,1263.020,200,1263.200,100,1263.340,2026-06-08,15:00:03,00,";\n';

describe('decodeGbk', () => {
  it('GBK 字节串解码中文 (平安银行 = C6BD B0B2 D2F8 D0D0)', () => {
    const bytes = Uint8Array.from([0xc6, 0xbd, 0xb0, 0xb2, 0xd2, 0xf8, 0xd0, 0xd0]);
    expect(decodeGbk(bytes)).toBe('平安银行');
  });

  it('ASCII 字节透传不变', () => {
    expect(decodeGbk(Uint8Array.from([...'11.03'].map((c) => c.charCodeAt(0))))).toBe('11.03');
  });

  it('byte-level pipeline: GBK 字节 → 解码 → 解析腾讯报价 (含中文名)', () => {
    // 合成最小腾讯报文: ASCII 外壳 + GBK 编码的中文名, 验 decode∘parse 端到端
    const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
    const gbkName = [0xc6, 0xbd, 0xb0, 0xb2, 0xd2, 0xf8, 0xd0, 0xd0]; // 平安银行
    // 字段: [0]51 [1]name [2..32] 价格面 (price=11.03 idx3 / prevClose=10.98 idx4 / changePct=0.46 idx32)
    const tail = ['000001', '11.03', '10.98', ...Array(27).fill('0'), '0.46'].join('~');
    const bytes = Uint8Array.from([
      ...ascii('v_sz000001="51~'),
      ...gbkName,
      ...ascii(`~${tail}~";`),
    ]);
    const quotes = parseTencentRealtimeQuotes(decodeGbk(bytes));
    expect(quotes.get('sz000001')).toMatchObject({
      name: '平安银行',
      price: 11.03,
      prevClose: 10.98,
    });
  });
});

describe('parseTencentRealtimeQuotes', () => {
  it('按 v_ 变量对齐解析现价/昨收/涨跌幅 + GBK 中文名', () => {
    const quotes = parseTencentRealtimeQuotes(TENCENT_SAMPLE);
    expect(quotes.get('sz000001')).toEqual({
      symbol: 'sz000001',
      name: '平安银行',
      price: 11.03,
      prevClose: 10.98,
      changePct: 0.46,
    });
    expect(quotes.get('sh600519')).toEqual({
      symbol: 'sh600519',
      name: '贵州茅台',
      price: 1262.98,
      prevClose: 1272.86,
      changePct: -0.78,
    });
  });

  it('涨跌幅口径: 涨为正 / 跌为负 (腾讯直给 idx32)', () => {
    const quotes = parseTencentRealtimeQuotes(TENCENT_SAMPLE);
    expect(quotes.get('sz000001')?.changePct).toBeGreaterThan(0); // 平安银行涨
    expect(quotes.get('sh600519')?.changePct).toBeLessThan(0); // 贵州茅台跌
  });

  it('无效码静默省略对齐: 缺标的不入 map, 有效标的不受影响', () => {
    // 腾讯对无效码返回空 payload, 或干脆省略该变量
    const partial =
      'v_sz000001="";\nv_sh600519="1~贵州茅台~600519~1262.98~1272.86~' +
      Array(27).fill('0').join('~') +
      '~-0.78~";\n';
    const quotes = parseTencentRealtimeQuotes(partial);
    expect(quotes.has('sz000001')).toBe(false); // 空 payload 跳过
    expect(quotes.get('sh600519')?.price).toBe(1262.98);
  });

  it('字段不足/不可解析现价 → 跳过, 不抛', () => {
    expect(() => parseTencentRealtimeQuotes('v_sz000001="1~名~000001~abc~";')).not.toThrow();
    expect(parseTencentRealtimeQuotes('v_sz000001="1~名~000001~abc~";').size).toBe(0);
  });

  it('空响应 → 空 map', () => {
    expect(parseTencentRealtimeQuotes('').size).toBe(0);
  });
});

describe('parseSinaRealtimeQuotes', () => {
  it('解析现价/昨收 + 自算涨跌幅 (与腾讯对拍价一致)', () => {
    const quotes = parseSinaRealtimeQuotes(SINA_SAMPLE);
    expect(quotes.get('sz000001')).toEqual({
      symbol: 'sz000001',
      name: '平安银行',
      price: 11.03,
      prevClose: 10.98,
      changePct: 0.46, // 自算 (11.03-10.98)/10.98 → 0.46, 对齐腾讯
    });
    expect(quotes.get('sh600519')).toEqual({
      symbol: 'sh600519',
      name: '贵州茅台',
      price: 1262.98,
      prevClose: 1272.86,
      changePct: -0.78, // 自算, 对齐腾讯
    });
  });

  it('无效码返回空 payload → 跳过', () => {
    const quotes = parseSinaRealtimeQuotes('var hq_str_sz999999="";\n');
    expect(quotes.has('sz999999')).toBe(false);
    expect(quotes.size).toBe(0);
  });

  it('昨收为 0 → 涨跌幅取 0 不除零', () => {
    const quotes = parseSinaRealtimeQuotes(
      'var hq_str_sz000001="名,0.000,0.000,11.030,0,0,0,0,0,0";\n',
    );
    expect(quotes.get('sz000001')?.changePct).toBe(0);
    expect(quotes.get('sz000001')?.price).toBe(11.03);
  });
});

describe('toVendorSymbol (024 T009 — (market,code) → 腾讯/新浪交易所前缀)', () => {
  it('沪市: 6 主板 / 688 科创 / 9 沪B / 5 沪基金 → sh', () => {
    expect(toVendorSymbol('cn', '600519')).toBe('sh600519');
    expect(toVendorSymbol('cn', '688981')).toBe('sh688981');
    expect(toVendorSymbol('cn', '900901')).toBe('sh900901');
    expect(toVendorSymbol('cn', '510300')).toBe('sh510300');
  });

  it('深市: 000 主板 / 002 中小 / 300 创业 → sz', () => {
    expect(toVendorSymbol('cn', '000001')).toBe('sz000001');
    expect(toVendorSymbol('cn', '002594')).toBe('sz002594');
    expect(toVendorSymbol('cn', '300750')).toBe('sz300750');
  });

  it('北交所: 83/87/88/43 + 920 新段 → bj (920 须先于 9 沪B 判定)', () => {
    expect(toVendorSymbol('cn', '830799')).toBe('bj830799');
    expect(toVendorSymbol('cn', '871396')).toBe('bj871396');
    expect(toVendorSymbol('cn', '430139')).toBe('bj430139');
    expect(toVendorSymbol('cn', '920819')).toBe('bj920819');
  });

  it('非 cn 市场 → 抛 UnsupportedRealtimeMarketError (盘中实时 V1 仅 A 股)', () => {
    expect(() => toVendorSymbol('hk', '00700')).toThrow(UnsupportedRealtimeMarketError);
    expect(() => toVendorSymbol('us', 'AAPL')).toThrow(UnsupportedRealtimeMarketError);
  });
});
