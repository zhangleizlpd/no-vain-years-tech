import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { MarketRoutedRealtimeQuoteAdapter } from './market-routed-realtime-quote.adapter.js';
import { MARKET_STATE_PORT, type MarketStatePort } from './market-state.port.js';
import { OPTION_SNAPSHOT_PORT } from './option-snapshot.port.js';
import {
  REALTIME_QUOTE_PORT,
  RealtimeQuoteMarketUnsupportedError,
  type RealtimeQuote,
  type RealtimeQuotePort,
} from './realtime-quote.port.js';
import { MockCollectionRefusedError } from './refusing-collection.adapter.js';
import { MarketdataModule } from './marketdata.module.js';
import type { VendorHttpClient, VendorRequest } from './vendor-http-client.js';

/**
 * 按市场路由的实时报价 adapter 单测 + **module 接线的机器化回归钉** (061 T005)。
 *
 * 后半段刻意不 boot Nest: 要验的两件事 (① 实时报价与期权快照注入**同一个** client 实例
 * ② live 档下哪几个市场槽真接上了 —— 066 T10 起是 `us` + `hk`, `cn` 仍空) 都写在
 * `@Module` 的 metadata 与 `useFactory` 里,
 * 直接读 metadata + 调工厂比起一个真容器更直接, 也验得到 mock 档那一支。
 */
const BASE = 'http://10.89.0.1:8811';
const TOKEN = 'test-shim-token';

/** 只记录调用、不真发请求的假 port（路由层验的是「转给谁」，不是 vendor 解析）。 */
function fakeRoute(quotes: Record<string, RealtimeQuote> = {}) {
  const seen: string[][] = [];
  const port: RealtimeQuotePort = {
    fetchQuotes: vi.fn(async (symbols: readonly string[]) => {
      seen.push([...symbols]);
      return new Map(Object.entries(quotes));
    }),
  };
  return { port, seen };
}

const QUOTE: RealtimeQuote = {
  price: '148.21',
  capturedAt: new Date('2026-08-17T20:19:48Z'),
  vendorUpdateTime: new Date('2026-08-17T19:59:12Z'),
};

describe('MarketRoutedRealtimeQuoteAdapter', () => {
  it('已登记市场 → 转给该路由, 结果原样合并', async () => {
    const us = fakeRoute({ 'us:PEP': QUOTE });
    const quotes = await new MarketRoutedRealtimeQuoteAdapter({ us: us.port }).fetchQuotes([
      'us:PEP',
    ]);

    expect(us.seen).toEqual([['us:PEP']]);
    expect(quotes.get('us:PEP')).toEqual(QUOTE);
  });

  describe('🚨 无默认路由 = 刻意 fail-closed (state_branch 14 / Guardrail 16)', () => {
    it('hk → 抛**专属错误类型**, 不是裸 Error 也不是静默 null', async () => {
      const us = fakeRoute();
      const routed = new MarketRoutedRealtimeQuoteAdapter({ us: us.port });

      const err = await routed.fetchQuotes(['hk:00700']).then(
        () => null,
        (e: unknown) => e,
      );

      // 上游 (tick / 熔断) 靠这个类型区分「配置事实」与「源故障」—— 裸 Error 会让一只合法的
      // hk 锚每 30 秒 +1 failstreak, 90 秒后把正常的 us 那半边一起降级。
      expect(err).toBeInstanceOf(RealtimeQuoteMarketUnsupportedError);
      expect((err as RealtimeQuoteMarketUnsupportedError).market).toBe('hk');
      // 消息体例照 `MarketRoutedEodBarAdapter`: 把已登记市场列出来, 一眼看出是配置漏了。
      expect((err as Error).message).toMatch(/us/);
    });

    it('cn → 同上 (066 T10 后 live 档接的是 us + hk, cn 槽仍留空)', async () => {
      const routed = new MarketRoutedRealtimeQuoteAdapter({ us: fakeRoute().port });
      await expect(routed.fetchQuotes(['cn:600519'])).rejects.toBeInstanceOf(
        RealtimeQuoteMarketUnsupportedError,
      );
    });

    it('无路由的市场混在批里 → **零外呼**就抛 (已登记那一半也不发)', async () => {
      const us = fakeRoute({ 'us:PEP': QUOTE });
      const routed = new MarketRoutedRealtimeQuoteAdapter({ us: us.port });

      await expect(routed.fetchQuotes(['us:PEP', 'hk:00700'])).rejects.toBeInstanceOf(
        RealtimeQuoteMarketUnsupportedError,
      );
      expect(us.port.fetchQuotes).not.toHaveBeenCalled();
    });

    it('不成形的 symbol → 同一条 fail-closed 路径 (不猜市场)', async () => {
      const routed = new MarketRoutedRealtimeQuoteAdapter({ us: fakeRoute().port });
      await expect(routed.fetchQuotes(['PEP'])).rejects.toBeInstanceOf(
        RealtimeQuoteMarketUnsupportedError,
      );
    });
  });

  it('空批 → 前置拒绝且零外呼 (同 port 契约, 工作集为空时不该调用)', async () => {
    const us = fakeRoute();
    await expect(
      new MarketRoutedRealtimeQuoteAdapter({ us: us.port }).fetchQuotes([]),
    ).rejects.toThrow(/为空/);
    expect(us.port.fetchQuotes).not.toHaveBeenCalled();
  });
});

// ── module 接线 ────────────────────────────────────────────────────────────────

interface FactoryProviderShape {
  provide: unknown;
  inject?: unknown[];
  useFactory: (...args: unknown[]) => unknown;
}

function providerFor(token: symbol): FactoryProviderShape {
  const providers = (Reflect.getMetadata('providers', MarketdataModule) ?? []) as unknown[];
  const found = providers.find(
    (p): p is FactoryProviderShape =>
      typeof p === 'object' && p !== null && (p as { provide?: unknown }).provide === token,
  );
  if (found === undefined) {
    throw new Error(`marketdata.module.ts 里没有 ${String(token.description)} 的 provider`);
  }
  return found;
}

/** `{ kind: 'live', … }` 的最小形态 —— `collectionPort` 的 live 回调只读这几个字段。 */
const LIVE_CFG = { kind: 'live', futuShimUrl: BASE, futuShimToken: TOKEN };

function fakeHttp() {
  const request = vi.fn(async (req: VendorRequest) => ({
    as_of: '2026-08-17T20:19:48+00:00',
    count: 1,
    rows: [{ code: new URL(req.url).searchParams.get('codes'), last_price: 148.21 }],
  }));
  return { http: { request } as unknown as VendorHttpClient, request };
}

describe('marketdata.module 接线', () => {
  it('🚨🚨 实时报价与期权快照注入**同一个 VendorHttpClient 实例** (Guardrail 1 的回归钉)', () => {
    const realtime = providerFor(REALTIME_QUOTE_PORT);
    const snapshot = providerFor(OPTION_SNAPSHOT_PORT);

    // 两者打的是同一个 shim capability (`LIMITS["snapshot"] = (60, 30)` 是服务端单一桶),
    // 而每个 VendorHttpClient 实例各持一个独立令牌桶 ⇒ 起两个 = 120 次/30 s = 上游允许值的
    // 2 倍。这条断言在有人「顺手」新起一个 client 时立刻红。
    expect(realtime.inject?.[1]).toBe(snapshot.inject?.[1]);
    expect(String((realtime.inject?.[1] as symbol).description)).toBe(
      'FUTU_OPTION_SNAPSHOT_HTTP_CLIENT',
    );
  });

  it('市场时段口**自起**一个 client (异 capability 各自一个桶)', () => {
    const marketState = providerFor(MARKET_STATE_PORT);
    const snapshot = providerFor(OPTION_SNAPSHOT_PORT);
    expect(marketState.inject?.[1]).not.toBe(snapshot.inject?.[1]);
  });

  it('两个新 token 都在 exports 里 (T007 / T008 要跨 ctx 注入)', () => {
    const exported = (Reflect.getMetadata('exports', MarketdataModule) ?? []) as unknown[];
    expect(exported).toContain(REALTIME_QUOTE_PORT);
    expect(exported).toContain(MARKET_STATE_PORT);
  });

  describe('live 档', () => {
    it('🚨 us + hk 都接上 (066 T10); cn 槽仍留空 ⇒ 抛专属错误类型', async () => {
      const { http, request } = fakeHttp();
      const port = providerFor(REALTIME_QUOTE_PORT).useFactory(LIVE_CFG, http) as RealtimeQuotePort;

      expect((await port.fetchQuotes(['us:PEP'])).get('us:PEP')?.price).toBe('148.21');
      expect(request).toHaveBeenCalledTimes(1);

      // 🚨 hk 槽是 066 T10 的另一半 (适配器前缀是第一半): 缺它的时候港股锚每 30 秒落一次
      // `unsupported-market`、恒为收盘档 —— 且那是**配置事实**, 不计熔断 ⇒ 一条告警都不会有。
      expect((await port.fetchQuotes(['hk:00700'])).get('hk:00700')?.price).toBe('148.21');
      expect(request).toHaveBeenCalledTimes(2);

      await expect(port.fetchQuotes(['cn:600519'])).rejects.toBeInstanceOf(
        RealtimeQuoteMarketUnsupportedError,
      );
      expect(request).toHaveBeenCalledTimes(2); // 无路由 ⇒ 零外呼
    });

    it('市场时段口打的是 /market-state (不套 MarketRouted*, 一次返全部市场)', async () => {
      const { http, request } = fakeHttp();
      const port = providerFor(MARKET_STATE_PORT).useFactory(LIVE_CFG, http) as MarketStatePort;

      await port.getMarketSessions().catch(() => undefined); // 假响应形状不对, 只验打到哪
      expect(new URL(request.mock.calls[0][0].url).pathname).toBe('/market-state');
    });
  });

  describe('mock 档 (054 拒绝壳)', () => {
    it('两个新口一调即抛 MockCollectionRefusedError, 零伪造数据', () => {
      const realtime = providerFor(REALTIME_QUOTE_PORT).useFactory({
        kind: 'mock',
      }) as RealtimeQuotePort;
      const marketState = providerFor(MARKET_STATE_PORT).useFactory({
        kind: 'mock',
      }) as MarketStatePort;

      expect(() => realtime.fetchQuotes(['us:PEP'])).toThrow(MockCollectionRefusedError);
      expect(() => marketState.getMarketSessions()).toThrow(MockCollectionRefusedError);
    });
  });
});
