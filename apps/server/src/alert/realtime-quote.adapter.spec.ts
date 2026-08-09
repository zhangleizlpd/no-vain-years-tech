import { describe, expect, it, vi } from 'vitest';

import type { RealtimeQuotePort } from './realtime-quote.port.js';
import type { RealtimeQuote } from './realtime-quote.rules.js';
import { RealtimeQuoteFallbackChainAdapter } from './realtime-quote-fallback-chain.adapter.js';
import { SINA_REFERER, SinaRealtimeAdapter } from './sina-realtime.adapter.js';
import { TencentRealtimeAdapter } from './tencent-realtime.adapter.js';
import type { RealtimeFetch } from './realtime-fetch.js';

/**
 * 024 T007 双源 adapter + FallbackChain 红绿 (US1)。fetchBytes 注入式 stub → 验请求编排
 * (URL / header) + 解析接线 + schema-fail 抛 + 链路降级。GBK 正确性已 T006 证 (此处 ASCII 合成字节)。
 * 真实请求 (字段/批量/延迟/双源切换) 由 T012 env-gated IT 校真。
 */

const bytesOf = (s: string): Uint8Array => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

// 腾讯最小合成报文 (ASCII 名占位; price idx3 / prevClose idx4 / changePct idx32 直给)
const tencentBody = (sym: string, price: string, prevClose: string, pct: string): string =>
  `v_${sym}="51~NAME~000001~${price}~${prevClose}~${Array(27).fill('0').join('~')}~${pct}~";\n`;
// 新浪最小合成报文 (name idx0 / open idx1 / prevClose idx2 / price idx3; pct 自算)
const sinaBody = (sym: string, prevClose: string, price: string): string =>
  `var hq_str_${sym}="NAME,0,${prevClose},${price},0,0,0,0,0,0";\n`;

describe('TencentRealtimeAdapter', () => {
  it('构造 q= 批量 URL + 解析现价/昨收/直给涨跌幅', async () => {
    const fetchBytes = vi
      .fn<RealtimeFetch>()
      .mockResolvedValue(bytesOf(tencentBody('sz000001', '11.03', '10.98', '0.46')));
    const quotes = await new TencentRealtimeAdapter(fetchBytes).fetchQuotes([
      'sz000001',
      'sh600519',
    ]);
    expect(fetchBytes).toHaveBeenCalledWith('https://qt.gtimg.cn/q=sz000001,sh600519');
    expect(quotes.get('sz000001')).toMatchObject({
      price: 11.03,
      prevClose: 10.98,
      changePct: 0.46,
    });
  });

  it('空符号集 → 不请求, 返空 map', async () => {
    const fetchBytes = vi.fn<RealtimeFetch>();
    expect((await new TencentRealtimeAdapter(fetchBytes).fetchQuotes([])).size).toBe(0);
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('200 但 0 解析 (schema drift) → 抛 (供 FallbackChain 切备)', async () => {
    const fetchBytes = vi.fn<RealtimeFetch>().mockResolvedValue(bytesOf('garbage not a quote'));
    await expect(new TencentRealtimeAdapter(fetchBytes).fetchQuotes(['sz000001'])).rejects.toThrow(
      /schema drift/,
    );
  });

  it('传输故障 (fetchBytes 抛) → 透传抛', async () => {
    const fetchBytes = vi.fn<RealtimeFetch>().mockRejectedValue(new Error('HTTP 500'));
    await expect(new TencentRealtimeAdapter(fetchBytes).fetchQuotes(['sz000001'])).rejects.toThrow(
      /HTTP 500/,
    );
  });
});

describe('SinaRealtimeAdapter', () => {
  it('注入 Referer + 构造 list= URL + 自算涨跌幅', async () => {
    const fetchBytes = vi
      .fn<RealtimeFetch>()
      .mockResolvedValue(bytesOf(sinaBody('sz000001', '10.98', '11.03')));
    const quotes = await new SinaRealtimeAdapter(fetchBytes).fetchQuotes(['sz000001']);
    expect(fetchBytes).toHaveBeenCalledWith('https://hq.sinajs.cn/list=sz000001', {
      Referer: SINA_REFERER,
    });
    expect(quotes.get('sz000001')).toMatchObject({
      price: 11.03,
      prevClose: 10.98,
      changePct: 0.46,
    });
  });

  it('200 但 0 解析 → 抛', async () => {
    const fetchBytes = vi.fn<RealtimeFetch>().mockResolvedValue(bytesOf('var hq_str_sz000001="";'));
    await expect(new SinaRealtimeAdapter(fetchBytes).fetchQuotes(['sz000001'])).rejects.toThrow(
      /schema drift/,
    );
  });
});

describe('RealtimeQuoteFallbackChainAdapter', () => {
  const quote = (symbol: string): RealtimeQuote => ({
    symbol,
    name: 'N',
    price: 1,
    prevClose: 1,
    changePct: 0,
  });
  const stub = (impl: RealtimeQuotePort['fetchQuotes']): RealtimeQuotePort => ({
    fetchQuotes: impl,
  });

  it('主源成功 → 短路返回, 不打备源', async () => {
    const primary = vi.fn().mockResolvedValue(new Map([['sz000001', quote('sz000001')]]));
    const backup = vi.fn();
    const chain = new RealtimeQuoteFallbackChainAdapter([stub(primary), stub(backup)]);
    const quotes = await chain.fetchQuotes(['sz000001']);
    expect(quotes.size).toBe(1);
    expect(backup).not.toHaveBeenCalled();
  });

  it('主源故障 → 平移备源返回', async () => {
    const primary = vi.fn().mockRejectedValue(new Error('tencent down'));
    const backup = vi.fn().mockResolvedValue(new Map([['sz000001', quote('sz000001')]]));
    const chain = new RealtimeQuoteFallbackChainAdapter([stub(primary), stub(backup)]);
    const quotes = await chain.fetchQuotes(['sz000001']);
    expect(quotes.get('sz000001')?.symbol).toBe('sz000001');
    expect(backup).toHaveBeenCalledTimes(1);
  });

  it('双源均败 → 抛 (供 T008 熔断计数)', async () => {
    const primary = vi.fn().mockRejectedValue(new Error('tencent down'));
    const backup = vi.fn().mockRejectedValue(new Error('sina 403'));
    const chain = new RealtimeQuoteFallbackChainAdapter([stub(primary), stub(backup)]);
    await expect(chain.fetchQuotes(['sz000001'])).rejects.toThrow(
      /all realtime quote sources failed/,
    );
  });

  it('空符号集 → 不打任何源, 返空 map', async () => {
    const primary = vi.fn();
    const chain = new RealtimeQuoteFallbackChainAdapter([stub(primary)]);
    expect((await chain.fetchQuotes([])).size).toBe(0);
    expect(primary).not.toHaveBeenCalled();
  });
});
