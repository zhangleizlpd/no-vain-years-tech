import { describe, it, expect, vi } from 'vitest';
import { MarketRoutedCalendarSource } from './market-routed-calendar-source.adapter.js';
import type { TradingCalendarSource } from './trading-calendar-source.port.js';

/**
 * 按市场路由的日历源单测 (sellput-viz Phase 1 #5)。要守住的是三条:
 * ① us 走自己的链, cn/hk 走另一条 —— 且**互不外呼**（这正是「不用一条大链」的收益：
 *    富途不会为了 cn/hk 每天各抛一次「不支持市场」，探针的「链首 = 该市场主源」读法成立）;
 * ② 结果**原样透传**（`servedBy` 传递环, FR-014）;
 * ③ 未登记市场 **fail-closed**（不默认落链）。
 */
function makeSource(servedBy: string): TradingCalendarSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchTradingDates: vi.fn(async (market: string, from: string, to: string) => {
      calls.push(`${market} ${from}..${to}`);
      return { dates: [from], servedBy };
    }),
  };
}

describe('MarketRoutedCalendarSource', () => {
  it('us 只打 us 链, cn/hk 只打 cnHk 链 (互不外呼)', async () => {
    const usChain = makeSource('futu');
    const cnHkChain = makeSource('tencent');
    const routed = new MarketRoutedCalendarSource({
      cn: cnHkChain,
      hk: cnHkChain,
      us: usChain,
    });

    await routed.fetchTradingDates('us', '2026-07-01', '2026-07-31');
    expect(usChain.calls).toEqual(['us 2026-07-01..2026-07-31']);
    expect(cnHkChain.calls).toHaveLength(0);

    await routed.fetchTradingDates('cn', '2026-07-01', '2026-07-31');
    await routed.fetchTradingDates('hk', '2026-07-01', '2026-07-31');
    expect(cnHkChain.calls).toEqual(['cn 2026-07-01..2026-07-31', 'hk 2026-07-01..2026-07-31']);
    expect(usChain.calls).toHaveLength(1); // 未被 cn/hk 连带
  });

  it('结果原样透传 (禁改写 servedBy —— FR-014 降级可观测的传递环)', async () => {
    const routed = new MarketRoutedCalendarSource({ us: makeSource('futu') });
    expect(await routed.fetchTradingDates('us', '2026-07-01', '2026-07-31')).toEqual({
      dates: ['2026-07-01'],
      servedBy: 'futu',
    });
  });

  it('未登记市场 → throw (fail-closed: 禁默认落链, 否则新市场会静默地只剩单源)', async () => {
    const routed = new MarketRoutedCalendarSource({ us: makeSource('futu') });
    await expect(routed.fetchTradingDates('jp', '2026-07-01', '2026-07-31')).rejects.toThrow(
      /未登记日历源路由/,
    );
  });

  it('链抛错原样冒泡 (由 syncRange 逐市场 catch → 心跳留痕, 不在此吞)', async () => {
    const boom: TradingCalendarSource = {
      fetchTradingDates: async () => {
        throw new Error('全链耗尽');
      },
    };
    const routed = new MarketRoutedCalendarSource({ us: boom });
    await expect(routed.fetchTradingDates('us', '2026-07-01', '2026-07-31')).rejects.toThrow(
      /全链耗尽/,
    );
  });
});
