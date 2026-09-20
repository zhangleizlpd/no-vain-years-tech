import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { FX_PAIRS, type FxRate, type FxRatePort } from './fx-rate.port';
import { FxRateFallbackChainAdapter } from './fx-rate-fallback-chain.adapter';

/**
 * 085 T002 FX FallbackChain 单测 (Small: 节点全是 port 级 test double)。
 *
 * 🚨 夹具汇率一律**合成值**, 逐个避开 `0.8` / `0.6` / `1.2` ——
 * `scripts/checks/check-optionsdesk-rule-constants.ts` 不变量 #1 的扫描面含 `*.spec.ts`。
 *
 * 承重的是臂③: **全败必须抛, 不能返空数组**。空数组会被上层当成「查到了, 只是一条都没有」
 * 而静默走完折算路径; 两种实现都跑得通、都不报错, 差别只在屏幕上 —— 故必须有一条断言钉死。
 */

/** 一份合成结果 (值本身不重要, 只用来分辨「结果来自哪个节点」)。 */
function ratesFrom(marker: string, capturedAt = new Date('2026-09-17T02:00:00.000Z')): FxRate[] {
  return FX_PAIRS.map((pair) => ({
    pair,
    rate: new Prisma.Decimal(marker),
    capturedAt,
  }));
}

const PRIMARY_RATES = ratesFrom('7.1500');
const SECONDARY_RATES = ratesFrom('7.3300');

/** 固定成功的节点。 */
function okNode(rates: FxRate[]): { node: FxRatePort; calls: () => number } {
  const fetchRates = vi.fn(async () => rates);
  return { node: { fetchRates }, calls: () => fetchRates.mock.calls.length };
}

/** 固定失败的节点。 */
function failNode(message: string): { node: FxRatePort; calls: () => number } {
  const fetchRates = vi.fn(async () => {
    throw new Error(message);
  });
  return { node: { fetchRates }, calls: () => fetchRates.mock.calls.length };
}

describe('FxRateFallbackChainAdapter —— 主源命中即停 / 平移 / 全败抛', () => {
  it('主源成功 ⇒ 短路返回, 备源一次都不打', async () => {
    const primary = okNode(PRIMARY_RATES);
    const secondary = okNode(SECONDARY_RATES);
    const chain = new FxRateFallbackChainAdapter([primary.node, secondary.node]);

    const rates = await chain.fetchRates();

    expect(rates).toEqual(PRIMARY_RATES);
    expect(primary.calls()).toBe(1);
    expect(secondary.calls()).toBe(0);
  });

  it('② 主源抛 ⇒ 记 warn 并平移备源, 结果来自备源', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const primary = failNode('tencent 502');
    const secondary = okNode(SECONDARY_RATES);
    const chain = new FxRateFallbackChainAdapter([primary.node, secondary.node]);

    const rates = await chain.fetchRates();

    expect(rates).toEqual(SECONDARY_RATES);
    expect(secondary.calls()).toBe(1);
    // 平移是静默降级, 日志是它唯一的可观测面 —— 没有这条断言, 「悄悄用了备源」无从发现。
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('tencent 502');
    warn.mockRestore();
  });

  it('③ 两源全败 ⇒ **抛**, 且 MUST NOT 解析成空数组 (branch 8 的前置)', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const chain = new FxRateFallbackChainAdapter([
      failNode('primary 502').node,
      failNode('secondary 403').node,
    ]);

    const settled = await chain.fetchRates().then(
      (rates) => ({ rates, err: undefined }),
      (err: unknown) => ({ rates: undefined, err }),
    );

    // 两条一起断: 只断 rejects 的话, 「返回 []」的实现也会因为 rejects 不成立而红 ——
    // 但读者无从知道红在哪一侧; 显式钉住「没有解析成空数组」这一面。
    expect(settled.rates).toBeUndefined();
    expect(String(settled.err)).toContain('all fx rate sources failed');
    // 末一个节点的原话要能被带出去, 否则全败只剩一句说不出话的通用错。
    expect(String(settled.err)).toContain('secondary 403');
    vi.restoreAllMocks();
  });
});
