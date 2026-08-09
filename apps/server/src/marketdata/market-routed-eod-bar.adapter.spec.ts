import { describe, it, expect, vi } from 'vitest';
import type { EodBarPort } from './eod-bar.port.js';
import { MarketRoutedEodBarAdapter } from './market-routed-eod-bar.adapter.js';

/**
 * EOD 日线按市场路由单测。三条要守住：
 * ① cn/hk 与 us 各走各的 vendor 且**互不外呼**（理杏仁对 us 硬编码拒绝，路错了就是每只票都失败）；
 * ② 结果原样透传；
 * ③ 未登记市场 **fail-closed** —— 不默认落到某个 vendor 上。
 */
function makeSource(tag: string): EodBarPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getBars: vi.fn(async (query) => {
      calls.push(query.symbol);
      return [
        {
          tradeDate: '2026-07-30',
          adjust: query.adjust,
          open: tag,
          high: tag,
          low: tag,
          close: tag,
          changePct: null,
          prevClose: null,
          volume: null,
          amount: null,
          turnoverRate: null,
        },
      ];
    }),
  };
}

describe('MarketRoutedEodBarAdapter', () => {
  it('cn/hk 走理杏仁、us 走富途，互不外呼', async () => {
    const lixinger = makeSource('lix');
    const futu = makeSource('futu');
    const routed = new MarketRoutedEodBarAdapter({ cn: lixinger, hk: lixinger, us: futu });

    await routed.getBars({ symbol: 'cn:600519', adjust: 'none' });
    await routed.getBars({ symbol: 'hk:00700', adjust: 'none' });
    expect(lixinger.calls).toEqual(['cn:600519', 'hk:00700']);
    expect(futu.calls).toHaveLength(0);

    await routed.getBars({ symbol: 'us:PEP', adjust: 'none' });
    expect(futu.calls).toEqual(['us:PEP']);
    expect(lixinger.calls).toHaveLength(2); // 未被连带
  });

  it('结果原样透传（路由层不改写任何字段）', async () => {
    const futu = makeSource('futu');
    const routed = new MarketRoutedEodBarAdapter({ us: futu });
    const [point] = await routed.getBars({ symbol: 'us:PEP', adjust: 'none' });
    expect(point).toMatchObject({ close: 'futu', tradeDate: '2026-07-30', adjust: 'none' });
  });

  it('🚨 未登记市场 / 非 canonical symbol → throw（禁默认落某 vendor）', async () => {
    const routed = new MarketRoutedEodBarAdapter({ us: makeSource('futu') });
    for (const symbol of ['cn:600519', 'jp:7203', 'PEP', '']) {
      await expect(routed.getBars({ symbol, adjust: 'none' })).rejects.toThrow(/无对应市场路由/);
    }
  });

  it('被路由实现抛错原样冒泡（由维度执行层逐标的 catch 记 failedTargets）', async () => {
    const boom: EodBarPort = {
      getBars: async () => {
        throw new Error('vendor 挂了');
      },
    };
    const routed = new MarketRoutedEodBarAdapter({ us: boom });
    await expect(routed.getBars({ symbol: 'us:PEP', adjust: 'none' })).rejects.toThrow(
      /vendor 挂了/,
    );
  });
});
