import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { BUILD_RECALL_DTE, RENT_RECALL_DTE } from './leg-recall.rules';
import { WINDOW_SUPPORTED_MARKETS, bootstrapWindowFor } from './leg-window.rules';

const SPOT = new Prisma.Decimal('100');

describe('bootstrapWindowFor —— bootstrap 宽窗由召回常量派生 (068 FR-004; 064 教义存续场景)', () => {
  it('DTE 段 = 两个召回段的并 (禁手写第二份边界数)', () => {
    const window = bootstrapWindowFor('us', SPOT);
    expect(window.dteMin).toBe(Math.min(BUILD_RECALL_DTE.min, RENT_RECALL_DTE.min));
    expect(window.dteMax).toBe(Math.max(BUILD_RECALL_DTE.max, RENT_RECALL_DTE.max));
    // 并集 ⇒ 两段各自整段都被覆盖 (取交 / 取其一都会在这里红)。
    expect(window.dteMin).toBeLessThanOrEqual(BUILD_RECALL_DTE.min);
    expect(window.dteMin).toBeLessThanOrEqual(RENT_RECALL_DTE.min);
    expect(window.dteMax).toBeGreaterThanOrEqual(BUILD_RECALL_DTE.max);
    expect(window.dteMax).toBeGreaterThanOrEqual(RENT_RECALL_DTE.max);
  });

  it('🚨 改动 RENT_RECALL_DTE.max 后窗随之变 —— 硬编码上界会在这里红', async () => {
    vi.resetModules();
    vi.doMock('./leg-recall.rules', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./leg-recall.rules')>();
      return { ...actual, RENT_RECALL_DTE: { min: actual.RENT_RECALL_DTE.min, max: 999 } };
    });
    try {
      const remocked = await import('./leg-window.rules.js');
      expect(remocked.bootstrapWindowFor('us', SPOT).dteMax).toBe(999);
    } finally {
      vi.doUnmock('./leg-recall.rules');
      vi.resetModules();
    }
  });

  it('类型 PUT + 只要标准合约 (047 FR-008)', () => {
    const window = bootstrapWindowFor('us', SPOT);
    expect(window.optionType).toBe('PUT');
    expect(window.isStandard).toBe(true);
  });

  it('strike 上下界随 spot 缩放 (盘中基准喂进来就跟着动)', () => {
    const low = bootstrapWindowFor('us', new Prisma.Decimal('100'));
    const high = bootstrapWindowFor('us', new Prisma.Decimal('200'));
    expect(high.strikeMin.equals(low.strikeMin.times(2))).toBe(true);
    expect(high.strikeMax.equals(low.strikeMax.times(2))).toBe(true);
    expect(low.strikeMin.lessThan(SPOT)).toBe(true);
    expect(low.strikeMax.greaterThan(SPOT)).toBe(true);
  });

  it('🚨 非已支持市场 → throw 且消息列出已支持市场 (静默返空会让 hk 悄悄拿到 us 的窗)', () => {
    expect(() => bootstrapWindowFor('hk', SPOT)).toThrow(/hk/);
    expect(() => bootstrapWindowFor('hk', SPOT)).toThrow(
      new RegExp(WINDOW_SUPPORTED_MARKETS.join('|')),
    );
    expect(() => bootstrapWindowFor('', SPOT)).toThrow();
  });

  it('🚨 windowTripwire 已随 064 覆盖范式退役 —— 绊线导出不复存在 (068 D1 退役清单)', async () => {
    const mod = await import('./leg-window.rules.js');
    expect('windowTripwire' in mod).toBe(false);
  });
});
