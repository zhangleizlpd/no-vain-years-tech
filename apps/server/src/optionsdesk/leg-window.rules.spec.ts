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

  /**
   * 🚨 **反例样本已从 `hk` 换成 `cn`** (071 T004①): 本条此前拿 hk 当「未支持市场」的被试对象,
   * 而 071 把 hk 接进白名单 ⇒ 再拿它当反例就是**测了个寂寞**(恒不 throw, 而断言写的是 throw
   * ⇒ 当场红, 这是好事; 坏的是有人顺手把断言删掉而不是换样本)。
   * 📌 `IMPORTABLE_MARKETS = ['us','hk']` 没有第三个市场 ⇒ `cn` 建不了锚, 但本函数是**纯函数
   * 纵深防御**、不经建锚校验 ⇒ 拿 cn 当反例成立且更贴真实防御面 (调用方闸失效时兜住)。
   */
  it('🚨 非已支持市场 (cn) → throw 且消息列出已支持市场 (静默返空会让它悄悄拿到 us 的窗)', () => {
    expect(() => bootstrapWindowFor('cn', SPOT)).toThrow(/cn/);
    expect(() => bootstrapWindowFor('cn', SPOT)).toThrow(
      new RegExp(WINDOW_SUPPORTED_MARKETS.join('|')),
    );
    expect(() => bootstrapWindowFor('', SPOT)).toThrow();
  });

  it('🚨 hk 已进白名单 ⇒ 返窗而非 throw (071 FR-001)', () => {
    expect(WINDOW_SUPPORTED_MARKETS).toEqual(['us', 'hk']);
    const hk = bootstrapWindowFor('hk', SPOT);
    expect(hk.optionType).toBe('PUT');
    expect(hk.isStandard).toBe(true);
    expect(hk.dteMin).toBe(Math.min(BUILD_RECALL_DTE.min, RENT_RECALL_DTE.min));
    expect(hk.dteMax).toBe(Math.max(BUILD_RECALL_DTE.max, RENT_RECALL_DTE.max));
  });

  /**
   * 🚨 **美股逐值零变化** (071 SC-004)。071 只往白名单加数据、不动派生逻辑 ⇒ us 的窗必须
   * 逐值不动。期望值**硬编码**: 从常量反算等于拿被测对象当基线。
   */
  it('🚨 us 逐值不变, 且 hk 当前与 us 同比例 (下界尚未 per-market 化, 见 T004②)', () => {
    const us = bootstrapWindowFor('us', SPOT);
    const hk = bootstrapWindowFor('hk', SPOT);
    expect(us.strikeMin.toString()).toBe('70'); // 100 × 0.7
    expect(us.strikeMax.toString()).toBe('105'); // 100 × 1.05
    // ⚠️ **已知缺陷, 蓄意在本片保留**: 下界是 spot 的固定比例, 而收租成色上界是 W 派生
    //    (≈ 0.824 × V/spot) ⇒ 锚的 V 相对 spot 偏低时下界会**高过**上界 ⇒ bootstrap 首日
    //    收租候选恒空。实测踩中: hk:00700 (0.681×spot) 与 **us:APA (0.635×spot, 美股今天
    //    就在犯)** —— 不是港股特有。取证与处置挂 issue #308, 🚫 MUST NOT 在这里悄悄改一个数。
    expect(hk.strikeMin.toString()).toBe('70');
    expect(hk.strikeMax.toString()).toBe('105');
  });

  it('🚨 windowTripwire 已随 064 覆盖范式退役 —— 绊线导出不复存在 (068 D1 退役清单)', async () => {
    const mod = await import('./leg-window.rules.js');
    expect('windowTripwire' in mod).toBe(false);
  });
});
