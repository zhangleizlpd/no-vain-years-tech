import { describe, it, expect, vi } from 'vitest';
import type { InstrumentUniversePort } from './instrument-universe.port.js';
import type { UniverseEntry } from './marketdata.types.js';
import { UniverseFallbackChainAdapter } from './universe-fallback-chain.adapter.js';

/**
 * universe FallbackChain mock 单测 (ADR-0047 §4/§6)。验主源短路 / 主源失败(含熔断 open)平移
 * 备源 / 主源空平移 / 整链耗尽 fail-soft 返空不抛。
 */
const E = (code: string): UniverseEntry => ({ market: 'cn', code, name: code });
const US = (code: string): UniverseEntry => ({ market: 'us', code, name: code });

function node(impl: () => Promise<UniverseEntry[]>): InstrumentUniversePort {
  return { enumerate: vi.fn(impl) };
}

/** market-aware 节点 (S2-T2 per-market fallback 测): 按请求 markets 返对应市场 fixtures。 */
function marketNode(byMarket: Record<string, UniverseEntry[]>): InstrumentUniversePort {
  return {
    enumerate: vi.fn(async (markets: string[]) => markets.flatMap((m) => byMarket[m] ?? [])),
  };
}

describe('UniverseFallbackChainAdapter', () => {
  it('主源非空 → 返主源, 不调备源 (短路)', async () => {
    const primary = node(async () => [E('600519')]);
    const secondary = node(async () => [E('000001')]);
    const out = await new UniverseFallbackChainAdapter([primary, secondary]).enumerate(['cn']);
    expect(out).toEqual([E('600519')]);
    expect(secondary.enumerate).not.toHaveBeenCalled();
  });

  it('主源抛错 (含熔断 open BrokenCircuitError) → 平移备源', async () => {
    const primary = node(async () => {
      throw new Error('BrokenCircuitError');
    });
    const secondary = node(async () => [E('000001')]);
    const out = await new UniverseFallbackChainAdapter([primary, secondary]).enumerate(['cn']);
    expect(out).toEqual([E('000001')]);
    expect(secondary.enumerate).toHaveBeenCalledOnce();
  });

  it('主源返空 → 平移备源', async () => {
    const primary = node(async () => []);
    const secondary = node(async () => [E('000001')]);
    const out = await new UniverseFallbackChainAdapter([primary, secondary]).enumerate(['cn']);
    expect(out).toEqual([E('000001')]);
  });

  it('整链耗尽 (全失败) → 返空, 不抛 (不连坐其余维度)', async () => {
    const primary = node(async () => {
      throw new Error('lixinger down');
    });
    const secondary = node(async () => {
      throw new Error('eastmoney RST');
    });
    const out = await new UniverseFallbackChainAdapter([primary, secondary]).enumerate(['cn']);
    expect(out).toEqual([]);
  });

  it('整链全空 → 返空, 不抛', async () => {
    const primary = node(async () => []);
    const secondary = node(async () => []);
    const out = await new UniverseFallbackChainAdapter([primary, secondary]).enumerate(['cn']);
    expect(out).toEqual([]);
  });

  it('per-market fallback: cn 主源命中 + us 主源空落备源 → 聚合两市场 (S2-T2)', async () => {
    // 理杏仁 (primary) 只有 cn/hk (us 返空); 东财 (secondary) 有 us。
    const primary = marketNode({ cn: [E('600519')] });
    const secondary = marketNode({ us: [US('AAPL')] });
    const chain = new UniverseFallbackChainAdapter([primary, secondary]);
    const out = await chain.enumerate(['cn', 'us']);
    expect(out).toEqual([E('600519'), US('AAPL')]);
    // secondary 只为 us 触达 (cn 主源命中即停 → secondary 不被 cn 调用)。
    expect(secondary.enumerate).toHaveBeenCalledTimes(1);
    expect(secondary.enumerate).toHaveBeenCalledWith(['us']);
  });

  it('per-market: 某市场整链耗尽只影响该市场, 其余照常聚合 (fail-soft, S2-T2)', async () => {
    const primary = marketNode({ cn: [E('600519')] }); // hk 主源空
    const secondary = marketNode({}); // 备源全空 → hk 整链耗尽
    const out = await new UniverseFallbackChainAdapter([primary, secondary]).enumerate([
      'cn',
      'hk',
    ]);
    expect(out).toEqual([E('600519')]); // cn 保留, hk 空不连坐
  });
});
