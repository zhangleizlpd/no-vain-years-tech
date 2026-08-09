import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetQuotesUseCase } from './get-quotes.usecase.js';
import type { QuotePort } from './quote.port.js';
import type { QuoteSnapshot } from './marketdata.types.js';

function quote(symbol: string, hasData = true): QuoteSnapshot {
  return hasData
    ? {
        symbol,
        name: '贵州茅台',
        price: '1700.0000',
        change: '10.0000',
        changePct: '0.5917',
        asOf: '2026-06-01',
        priceKind: 'eod_close',
        hasData: true,
      }
    : {
        symbol,
        name: null,
        price: null,
        change: null,
        changePct: null,
        asOf: null,
        priceKind: 'eod_close',
        hasData: false,
      };
}

/** ioredis 子集 fake: MGET / SET(EX) 走内存 map, 透出真实读写以断言惊群保护语义。 */
class FakeRedis {
  store = new Map<string, string>();
  mget = vi.fn(async (...keys: string[]) => keys.map((k) => this.store.get(k) ?? null));
  set = vi.fn(async (k: string, v: string) => {
    this.store.set(k, v);
    return 'OK';
  });
}

describe('GetQuotesUseCase — Redis 热快照', () => {
  let redis: FakeRedis;
  let port: { getQuotes: ReturnType<typeof vi.fn> };
  let uc: GetQuotesUseCase;

  beforeEach(() => {
    redis = new FakeRedis();
    port = { getQuotes: vi.fn(async (symbols: string[]) => symbols.map((s) => quote(s))) };
    uc = new GetQuotesUseCase(port as unknown as QuotePort, redis as never);
  });

  it('全 miss → 过端口取数 + 回写 Redis', async () => {
    const out = await uc.execute(['cn:600519', 'cn:000001']);
    expect(out.map((q) => q.symbol)).toEqual(['cn:600519', 'cn:000001']);
    expect(port.getQuotes).toHaveBeenCalledWith(['cn:600519', 'cn:000001']);
    expect(redis.store.has('quote:cn:600519')).toBe(true);
    expect(redis.set).toHaveBeenCalledTimes(2);
  });

  it('二次请求命中热快照 → 不重打端口', async () => {
    await uc.execute(['cn:600519']);
    port.getQuotes.mockClear();
    const out = await uc.execute(['cn:600519']);
    expect(port.getQuotes).not.toHaveBeenCalled();
    expect(out[0].price).toBe('1700.0000');
  });

  it('部分命中 → 端口仅收 miss 子集 (不重取已缓存项)', async () => {
    await uc.execute(['cn:600519']); // 预热
    port.getQuotes.mockClear();
    await uc.execute(['cn:600519', 'cn:000001']);
    expect(port.getQuotes).toHaveBeenCalledWith(['cn:000001']);
  });

  it('保留入参顺序与重复行 (自选列表逐行消费)', async () => {
    const out = await uc.execute(['cn:000001', 'cn:600519', 'cn:000001']);
    expect(out.map((q) => q.symbol)).toEqual(['cn:000001', 'cn:600519', 'cn:000001']);
    // 去重后端口只收一次 cn:000001。
    expect(port.getQuotes).toHaveBeenCalledWith(['cn:000001', 'cn:600519']);
  });

  it('no-data 项亦缓存 (避免未知 symbol 反复回源)', async () => {
    port.getQuotes.mockResolvedValueOnce([quote('cn:999999', false)]);
    await uc.execute(['cn:999999']);
    expect(redis.store.has('quote:cn:999999')).toBe(true);
    port.getQuotes.mockClear();
    const out = await uc.execute(['cn:999999']);
    expect(port.getQuotes).not.toHaveBeenCalled();
    expect(out[0].hasData).toBe(false);
  });

  it('旧缓存快照无 name 键 → 兜 null (部署过渡兼容, 不重打端口)', async () => {
    const { name: _dropped, ...legacy } = quote('cn:600519');
    redis.store.set('quote:cn:600519', JSON.stringify(legacy));
    const out = await uc.execute(['cn:600519']);
    expect(out[0].name).toBeNull();
    expect(out[0].price).toBe('1700.0000');
    expect(port.getQuotes).not.toHaveBeenCalled();
  });

  it('空入参 → 空结果, 不触端口/Redis', async () => {
    const out = await uc.execute([]);
    expect(out).toEqual([]);
    expect(port.getQuotes).not.toHaveBeenCalled();
    expect(redis.mget).not.toHaveBeenCalled();
  });
});
