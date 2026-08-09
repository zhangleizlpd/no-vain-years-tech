import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  BUILD_LEG_MAX_DTE_DAYS,
  RENT_DEPTH_UNION_BAND,
  RENT_LEG_MAX_DTE_DAYS,
  RENT_LEG_MIN_DTE_DAYS,
  RENT_SHORT_MAX_DTE_DAYS,
  earningsLegFamilyFor,
  legTabs,
  type LegTabContext,
} from './leg-tab.rules';

const W = new Prisma.Decimal('120');
const leg = (absDelta: number | null, dteDays: number, strike: string) => ({
  absDelta,
  dteDays,
  strike: new Prisma.Decimal(strike),
});
const sellPutZone: LegTabContext = { zone: 'thin', w: W, rentDepth: 'deep' };
const buyZone: LegTabContext = { zone: 'buy', w: W, rentDepth: 'moderate' };

describe('leg-tab.rules — 成员判据只住一处 (plan D-SOT-4)', () => {
  it('全腿 Tab 恒含每一条腿 —— 不存在「落库了但哪个 Tab 都看不见」的腿 (FR-005)', () => {
    expect(legTabs(sellPutZone, leg(null, 3, '999'))).toEqual(['all']);
  });

  it('建仓带两端闭合, 带外与 DTE 超界都出局', () => {
    expect(legTabs(sellPutZone, leg(0.4, BUILD_LEG_MAX_DTE_DAYS, '130'))).toContain('build');
    expect(legTabs(sellPutZone, leg(0.55, 1, '130'))).toContain('build');
    expect(legTabs(sellPutZone, leg(0.39, 10, '130'))).not.toContain('build');
    expect(legTabs(sellPutZone, leg(0.45, BUILD_LEG_MAX_DTE_DAYS + 1, '130'))).not.toContain(
      'build',
    );
  });

  it('卖put区走锚轴 K ≤ W (与 Δ 无关), 买区走市场轴 Δ 档 (与 K 无关)', () => {
    expect(legTabs(sellPutZone, leg(0.9, 200, '120'))).toContain('rent');
    expect(legTabs(sellPutZone, leg(0.1, 200, '121'))).not.toContain('rent');
    // 深度档 = 0.05–0.15; moderate = 0.15–0.30。买区按矩阵给的档筛, K 多高都不看。
    expect(legTabs(buyZone, leg(0.2, 200, '999'))).toContain('rent');
    expect(legTabs(buyZone, leg(0.35, 200, '10'))).not.toContain('rent');
  });

  it('收租 DTE 带两端闭合', () => {
    expect(legTabs(sellPutZone, leg(0.3, RENT_LEG_MIN_DTE_DAYS, '110'))).toContain('rent');
    expect(legTabs(sellPutZone, leg(0.3, RENT_LEG_MAX_DTE_DAYS, '110'))).toContain('rent');
    expect(legTabs(sellPutZone, leg(0.3, RENT_LEG_MIN_DTE_DAYS - 1, '110'))).not.toContain('rent');
    expect(legTabs(sellPutZone, leg(0.3, RENT_LEG_MAX_DTE_DAYS + 1, '110'))).not.toContain('rent');
  });

  it('水位未选 → 市场轴取三档并集, MUST NOT 静默取某一档 (FR-017)', () => {
    const pending: LegTabContext = { zone: 'buy', w: W, rentDepth: null };
    expect(RENT_DEPTH_UNION_BAND).toEqual({ min: 0.05, max: 0.4 });
    expect(legTabs(pending, leg(0.38, 200, '999'))).toContain('rent');
    expect(legTabs(pending, leg(0.06, 200, '999'))).toContain('rent');
    expect(legTabs(pending, leg(0.41, 200, '999'))).not.toContain('rent');
  });
});

describe('leg-tab.rules — 财报打标的域 (FR-023)', () => {
  it('建仓意图恒建仓域 (与 DTE 无关); 其余按 DTE 分长短', () => {
    expect(earningsLegFamilyFor('build_position', 300)).toBe('build_position');
    expect(earningsLegFamilyFor('rent', RENT_SHORT_MAX_DTE_DAYS)).toBe('rent_short');
    expect(earningsLegFamilyFor('rent', RENT_SHORT_MAX_DTE_DAYS + 1)).toBe('rent_long');
  });

  it('待定与不开新仓都不是建仓授权 ⇒ 按收租域打标 (腿数据照常全量展示, FR-021)', () => {
    expect(earningsLegFamilyFor('pending', 200)).toBe('rent_long');
    expect(earningsLegFamilyFor('no_new_position', 10)).toBe('rent_short');
  });
});
