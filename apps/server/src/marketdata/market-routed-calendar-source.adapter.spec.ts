import { describe, it, expect, vi } from 'vitest';
import {
  createForwardCalendarSource,
  MarketRoutedCalendarSource,
} from './market-routed-calendar-source.adapter.js';
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
      return { dates: [from], sessionKinds: {}, servedBy };
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
      sessionKinds: {},
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

/**
 * **前瞻路由**单测 (062 T003, `state_branch` 12, plan §D4)。与上面那组是同一个类的两个实例
 * —— 差别只在 routes map, 故断言面也只需盯住「谁被路由到哪条源」这一件事。
 *
 * 🚨 **腾讯 MUST NOT 出现在前瞻路由里** (Impl Guardrail 5): 它是「某指数当日有 bar ⟺ 当日
 * 开市」的**反推**源, 结构上答不了未来与当天。放进链首只会让 cn/hk 每天各多一条恒定的假失败
 * WARN —— 044 已论证过这种告警疲劳的代价。故前瞻路由只有两条: `us → 富途` / `cn,hk → 静态`。
 */
describe('createForwardCalendarSource (062 T003 — 前瞻路由)', () => {
  it('cn → 静态年历源 (腾讯不在链上)', async () => {
    const futu = makeSource('futu');
    const staticCal = makeSource('static');
    const forward = createForwardCalendarSource(futu, staticCal);

    expect(await forward.fetchTradingDates('cn', '2026-08-19', '2026-12-31')).toEqual({
      dates: ['2026-08-19'],
      sessionKinds: {},
      servedBy: 'static',
    });
    expect(staticCal.calls).toEqual(['cn 2026-08-19..2026-12-31']);
    expect(futu.calls).toHaveLength(0);
  });

  it('hk → 静态年历源 (与 cn 共用同一实例)', async () => {
    const futu = makeSource('futu');
    const staticCal = makeSource('static');
    const forward = createForwardCalendarSource(futu, staticCal);

    expect(await forward.fetchTradingDates('hk', '2026-08-19', '2026-12-31')).toEqual({
      dates: ['2026-08-19'],
      sessionKinds: {},
      servedBy: 'static',
    });
    expect(staticCal.calls).toEqual(['hk 2026-08-19..2026-12-31']);
    expect(futu.calls).toHaveLength(0);
  });

  it('us → 富途源 (静态表蓄意不覆盖 us, 见 static adapter 绊线)', async () => {
    const futu = makeSource('futu');
    const staticCal = makeSource('static');
    const forward = createForwardCalendarSource(futu, staticCal);

    expect(await forward.fetchTradingDates('us', '2026-08-19', '2026-12-31')).toEqual({
      dates: ['2026-08-19'],
      sessionKinds: {},
      servedBy: 'futu',
    });
    expect(futu.calls).toEqual(['us 2026-08-19..2026-12-31']);
    expect(staticCal.calls).toHaveLength(0);
  });

  it('未登记市场 → throw 且消息里列出已登记市场 (fail-closed, state_branch 12)', async () => {
    const forward = createForwardCalendarSource(makeSource('futu'), makeSource('static'));
    await expect(forward.fetchTradingDates('jp', '2026-08-19', '2026-12-31')).rejects.toThrow(
      /未登记日历源路由.*cn\/hk\/us/s,
    );
  });
});
