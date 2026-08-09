import { describe, it, expect, beforeEach } from 'vitest';
import { MockMarketDataAdapter } from './mock-market-data.adapter.js';

// 015 T003 verify: Mock adapter 8 端口返确定性 fixtures (零 env 默认)。
// (SEARCH 不在此 — kind=mock 下走 LocalInstrumentSearchAdapter 直查 Instrument 表。)
describe('MockMarketDataAdapter (8 端口确定性 fixtures)', () => {
  let mock: MockMarketDataAdapter;

  beforeEach(() => {
    mock = new MockMarketDataAdapter();
  });

  it('enumerate: 返 cn fixtures 含北交所 + 按请求 markets 过滤 (S2-T2)', async () => {
    const entries = await mock.enumerate(['cn', 'hk', 'us']);
    expect(entries).toContainEqual({ market: 'cn', code: '430047', name: '诺思格' });
    // mock 仅 cn fixtures → 只请求 hk/us 时空 (签名对齐, 不伪造多市场 mock 数据)。
    expect(await mock.enumerate(['hk'])).toEqual([]);
  });

  it('isTradingDay: 工作日 true / 周末 false (确定性)', async () => {
    expect(await mock.isTradingDay('cn', '2026-06-01')).toBe(true); // Mon
    expect(await mock.isTradingDay('cn', '2026-06-06')).toBe(false); // Sat
  });

  it('fetchTradingDates: [from,to] 内周一~周五 + servedBy=mock (与 isTradingDay 同口径, 排除周末)', async () => {
    // 2026-06-01(Mon)~06-07(Sun) → 05-01..05 工作日, 排除 06-06(Sat)/06-07(Sun)。
    expect(await mock.fetchTradingDates('cn', '2026-06-01', '2026-06-07')).toEqual({
      dates: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'],
      servedBy: 'mock', // 自报家门 (降级可观测, FR-014)
    });
  });

  it('getBars: 茅台返 1 行, adjust 透传, Decimal-string', async () => {
    const bars = await mock.getBars({ symbol: 'cn:600519', adjust: 'forward' });
    expect(bars).toHaveLength(1);
    expect(bars[0].adjust).toBe('forward');
    expect(bars[0].close).toBe('1700.0000');
    expect(typeof bars[0].close).toBe('string');
    expect(await mock.getBars({ symbol: 'cn:000001', adjust: 'none' })).toEqual([]);
  });

  it('getFundamentals: 仅命中 fixture symbol; 字段为 string|null', async () => {
    const fs = await mock.getFundamentals(['cn:600519', 'cn:000001']);
    expect(fs).toHaveLength(1);
    expect(fs[0].peTtm).toBe('25.5000');
  });

  it('getFinancials: 命中 fixture 返报告期', async () => {
    const fm = await mock.getFinancials(['cn:600519']);
    expect(fm[0].reportPeriod).toBe('2026Q1');
  });

  it('getCorporateActions: 茅台返分红行', async () => {
    const ca = await mock.getCorporateActions('cn:600519');
    expect(ca[0].type).toBe('dividend');
    expect(await mock.getCorporateActions('cn:000001')).toEqual([]);
  });

  it('getQuotes: 命中 hasData:true + 涨跌; 未命中 hasData:false 隔离', async () => {
    const quotes = await mock.getQuotes(['cn:600519', 'cn:000001']);
    expect(quotes[0]).toMatchObject({
      symbol: 'cn:600519',
      price: '1700.0000',
      hasData: true,
      priceKind: 'eod_close',
    });
    expect(quotes[1]).toMatchObject({ symbol: 'cn:000001', price: null, hasData: false });
  });
});
