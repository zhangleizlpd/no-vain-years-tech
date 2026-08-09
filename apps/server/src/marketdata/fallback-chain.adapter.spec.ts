import { describe, it, expect, vi } from 'vitest';
import type { InstrumentSearchPort } from './instrument-search.port.js';
import type { InstrumentSearchHit } from './marketdata.types.js';
import { FallbackChainAdapter } from './fallback-chain.adapter.js';

/** FallbackChain 节点选择纯逻辑 (015 T014)。主命中短路 / 错误平移 / 空续试 / 全空返空。 */
function node(impl: (q: string) => Promise<InstrumentSearchHit[]>): InstrumentSearchPort {
  return { search: vi.fn(impl) };
}
const HIT = (symbol: string): InstrumentSearchHit => ({ symbol, name: symbol, type: 'stock' });

describe('FallbackChainAdapter', () => {
  it('主源非空 → 短路返回, 不打次源', async () => {
    const primary = node(async () => [HIT('cn:600519')]);
    const secondary = node(async () => [HIT('cn:000001')]);
    const chain = new FallbackChainAdapter([primary, secondary]);

    expect(await chain.search('茅台')).toEqual([HIT('cn:600519')]);
    expect(secondary.search).not.toHaveBeenCalled();
  });

  it('主源抛错 → 平移次源 (search fallback)', async () => {
    const primary = node(async () => {
      throw new Error('503');
    });
    const secondary = node(async () => [HIT('cn:600519')]);
    const chain = new FallbackChainAdapter([primary, secondary]);

    expect(await chain.search('茅台')).toEqual([HIT('cn:600519')]);
    expect(secondary.search).toHaveBeenCalledOnce();
  });

  it('主源空成功 → 续试次源', async () => {
    const primary = node(async () => []);
    const secondary = node(async () => [HIT('cn:600519')]);
    const chain = new FallbackChainAdapter([primary, secondary]);

    expect(await chain.search('茅台')).toEqual([HIT('cn:600519')]);
  });

  it('全部空/错 → 空数组 (both-empty, 非 throw)', async () => {
    const primary = node(async () => {
      throw new Error('timeout');
    });
    const secondary = node(async () => []);
    const chain = new FallbackChainAdapter([primary, secondary]);

    await expect(chain.search('冷僻')).resolves.toEqual([]);
  });

  it('全部节点抛错 → 空数组 (不上抛)', async () => {
    const chain = new FallbackChainAdapter([
      node(async () => {
        throw new Error('a');
      }),
      node(async () => {
        throw new Error('b');
      }),
    ]);
    await expect(chain.search('x')).resolves.toEqual([]);
  });
});
