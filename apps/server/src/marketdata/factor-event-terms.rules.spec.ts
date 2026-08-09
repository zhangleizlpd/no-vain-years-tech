import { describe, it, expect } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import {
  DISAGREE_TOLERANCE,
  decideFactor,
  factorFromEventTerms,
  factorFromOfficialChange,
  buildFactorEventTerms,
  type FactorEventTerms,
  type FactorNoneBar,
  type FactorSourceRows,
} from './factor-event-terms.rules.js';

const D = (v: string | number) => new Prisma.Decimal(v);

/** 只填必需项，其余按「无该条款」置 null（等价 R=1 / q=0 / P=0 / d=0）。 */
function terms(over: Partial<FactorEventTerms> & Pick<FactorEventTerms, 'prevClose' | 'exClose'>) {
  return {
    exDate: '2026-01-01',
    officialChangePct: null,
    cashDividend: null,
    shareRatio: null,
    allotmentRatio: null,
    allotmentPrice: null,
    ...over,
  } satisfies FactorEventTerms;
}

// ── 真实 prod 事件（2026-08-01 直连理杏仁 API 校真）──────────────────────────────
//
// 这些行是**现算法（vendor 序列反推）算错的**同一批事件 —— 拿真值做钉子，防换算法后
// 又滑回反推口径。存量错值一并记在用例里，直接对比可见修复幅度。
describe('事件条款法 vs 涨跌幅复权法 — prod 真实事件校真', () => {
  it('hk 00206 2025-05-26 纯现金分红: 两法吻合 → verified (存量反推值 2.0373 偏 95%)', () => {
    const t = terms({
      exDate: '2025-05-26',
      prevClose: D('0.235'),
      exClose: D('0.248'),
      officialChangePct: D('10.22'),
      cashDividend: D('0.01'), // 末期息 HKD 0.01
    });
    const d = decideFactor(t);
    expect(d.status).toBe('verified');
    expect(d.source).toBe('event_terms');
    // f = n0/(n0−d) = 0.235/0.225
    expect(d.factorJump.toFixed(6)).toBe('1.044444');
    expect(factorFromOfficialChange(t)!.toFixed(6)).toBe('1.044423');
  });

  it('hk 00430 2021-05-31 十合一并股 + 现金分红: R=0.1 参与, 两法吻合 → verified', () => {
    // capitalization 3,881,836,004 → 388,183,600 (changeReason「并股」) ⇒ R = 0.1
    const t = terms({
      exDate: '2021-05-31',
      prevClose: D('0.063'),
      exClose: D('0.62'),
      officialChangePct: D('1.64'),
      cashDividend: D('0.002'),
      shareRatio: D('0.1'),
    });
    const d = decideFactor(t);
    expect(d.status).toBe('verified');
    // f = 0.1 × 0.063/0.061 —— 合股让因子 < 1, 这是合法的 (不是数据错误)
    expect(d.factorJump.toFixed(6)).toBe('0.103279');
    expect(d.factorJump.lessThan(1)).toBe(true);
  });

  it('hk 01177 2018-06-04 十送五: R=1.5 参与, 两法差 0.11% → verified', () => {
    const t = terms({
      exDate: '2018-06-04',
      prevClose: D('19.44'),
      exClose: D('13.16'),
      officialChangePct: D('1.76'),
      cashDividend: D('0.02'),
      shareRatio: D('1.5'), // 8,425,194,325 → 12,637,791,488
    });
    const d = decideFactor(t);
    expect(d.status).toBe('verified');
    expect(d.factorJump.toFixed(6)).toBe('1.501545');
  });

  it('🚨 hk 00897 2024-03-11 实物分派类事件: 条款法算不出该跌幅 → 两法分歧 → 落 1 + needs_review', () => {
    // 官方涨跌幅 +193.51% 说明当日有重大权益调整, 但 dividend/equity-change/allotment
    // 三端点都给不出条款 (实物分派需被分拆实体市值, vendor 不覆盖) ⇒ 条款法退化成 1.0。
    // 现算法在这里反推出了**负因子 −1.507**; 本算法既不落负值也不落见证法的 5.84 猜测。
    const t = terms({
      exDate: '2024-03-11',
      prevClose: D('0.45'),
      exClose: D('0.226'),
      officialChangePct: D('193.51'),
    });
    const d = decideFactor(t);
    expect(d.status).toBe('needs_review');
    expect(d.source).toBe('unresolved');
    expect(d.factorJump.equals(1)).toBe(true); // 读时等价「无此事件」, 失真有界
    expect(d.reason).toContain('两法分歧');
  });
});

describe('配股 (allotment) 条款进公式', () => {
  it('1 股配 3 股 @0.20, 前收 1.00 → 除权价 0.40, f = 2.5; 见证法一致 → verified', () => {
    const t = terms({
      prevClose: D('1.00'),
      exClose: D('0.40'),
      officialChangePct: D('0'),
      allotmentRatio: D('3'),
      allotmentPrice: D('0.20'),
      shareRatio: D('4'), // 1 + q
    });
    const d = decideFactor(t);
    // f = 4 × 1.00 / (1.00 + 0.20×3) = 4/1.6
    expect(d.factorJump.toFixed(4)).toBe('2.5000');
    expect(d.status).toBe('verified');
  });

  it('配股价/比率缺失 → 按 0 处理, 不污染纯分红事件', () => {
    const f = factorFromEventTerms(
      terms({ prevClose: D('10'), exClose: D('9.5'), cashDividend: D('0.5') }),
    );
    expect(f!.toFixed(6)).toBe('1.052632'); // 10/9.5
  });
});

describe('降级与拒绝落坏值', () => {
  it('派息超过前收 (分母 ≤ 0) → 条款法返 null, 不算出负因子/无穷大', () => {
    expect(
      factorFromEventTerms(
        terms({ prevClose: D('1.0'), exClose: D('0.5'), cashDividend: D('1.5') }),
      ),
    ).toBeNull();
  });

  it('条款不全但有官方涨跌幅 → 落见证法值 + unverified (好过整段不复权)', () => {
    const d = decideFactor(
      terms({
        prevClose: D('1.0'),
        exClose: D('0.5'),
        cashDividend: D('1.5'), // 条款自相矛盾 → terms=null
        officialChangePct: D('0'),
      }),
    );
    expect(d.source).toBe('official_change');
    expect(d.status).toBe('unverified');
    expect(d.factorJump.toFixed(4)).toBe('2.0000');
  });

  it('有条款但无官方涨跌幅 (全库约 45% 因子) → 落条款值 + unverified, 不因缺见证而丢事件', () => {
    const d = decideFactor(
      terms({ prevClose: D('10'), exClose: D('9.5'), cashDividend: D('0.5') }),
    );
    expect(d.source).toBe('event_terms');
    expect(d.status).toBe('unverified');
    expect(d.factorJump.toFixed(6)).toBe('1.052632');
  });

  it('两法均不可解 → 落 1 + needs_review (不静默丢事件, 留待补数据)', () => {
    const d = decideFactor(terms({ prevClose: D('0'), exClose: D('1') }));
    expect(d.status).toBe('needs_review');
    expect(d.factorJump.equals(1)).toBe(true);
  });

  it('🚨 任何路径都不产出 ≤0 因子 (负复权因子物理上不可能)', () => {
    const cases: FactorEventTerms[] = [
      terms({ prevClose: D('-1'), exClose: D('1'), officialChangePct: D('0') }),
      terms({ prevClose: D('1'), exClose: D('-1'), officialChangePct: D('0') }),
      terms({ prevClose: D('1'), exClose: D('1'), officialChangePct: D('-200') }), // 1+(-2) < 0
      terms({ prevClose: D('1'), exClose: D('1'), shareRatio: D('-2'), cashDividend: D('0.1') }),
    ];
    for (const c of cases) expect(decideFactor(c).factorJump.greaterThan(0)).toBe(true);
  });
});

describe('分歧阈值', () => {
  it('恰好落在容忍度内 → verified; 超出 → needs_review 且落 1', () => {
    // 构造: 条款法固定 1.0 (无任何条款), 见证法由 officialChangePct 调出想要的偏离。
    const at = (chgPct: string) =>
      decideFactor(terms({ prevClose: D('1'), exClose: D('1'), officialChangePct: D(chgPct) }));
    expect(at('4').status).toBe('verified'); // witness=1.04, relErr≈0.0385 < 5%
    expect(at('4').factorJump.toFixed(4)).toBe('1.0000');
    expect(at('10').status).toBe('needs_review'); // witness=1.10, relErr≈0.0909 > 5%
    expect(at('10').factorJump.equals(1)).toBe(true);
  });

  it('容忍度取 5% —— 低价股官方涨跌幅只有 2 位有效小数, 卡更严会把量化噪声刷成告警', () => {
    expect(DISAGREE_TOLERANCE.toFixed(2)).toBe('0.05');
  });
});

// ── 四表原始行 → 条款（组装层）────────────────────────────────────────────────
describe('buildFactorEventTerms 组装', () => {
  const bars = (rows: [string, string, string | null][]): FactorNoneBar[] =>
    rows.map(([tradeDate, close, chg]) => ({
      tradeDate,
      close: D(close),
      changePct: chg === null ? null : D(chg),
    }));

  const base = (over: Partial<FactorSourceRows> = {}): FactorSourceRows => ({
    currency: 'HKD',
    noneBars: bars([
      ['2024-06-03', '10.00', '0'],
      ['2024-06-04', '9.50', '-0.53'],
      ['2024-06-05', '9.60', '1.05'],
    ]),
    corporateActions: [],
    equityChanges: [],
    allotments: [],
    ...over,
  });

  it('事件集取三源并集: corp action / 配股除权日 / 影响价格的股本变动日各自都能触发', () => {
    const out = buildFactorEventTerms(
      base({
        corporateActions: [
          { exDate: '2024-06-04', dividend: D('0.5'), bonusShares: null, currency: 'HKD' },
        ],
        allotments: [
          { exDate: '2024-06-05', allotmentRatio: D('1'), allotmentPrice: D('5'), currency: 'HKD' },
        ],
      }),
    );
    expect(out.map((t) => t.exDate)).toEqual(['2024-06-04', '2024-06-05']);
  });

  it('🚨 币种不符 → 条款置 null (不做汇率换算, 宁可判不可解也不按错币种算)', () => {
    const out = buildFactorEventTerms(
      base({
        corporateActions: [
          { exDate: '2024-06-04', dividend: D('0.5'), bonusShares: null, currency: 'CNY' },
        ],
      }),
    );
    expect(out[0].cashDividend).toBeNull();
  });

  it('股本比值 R = 影响价格事件的 capitalization / 事件前最近一条', () => {
    const out = buildFactorEventTerms(
      base({
        equityChanges: [
          { date: '2024-01-01', capitalization: D('1000'), changeReason: '定期報告' },
          { date: '2024-06-04', capitalization: D('1500'), changeReason: '分红送股' },
        ],
      }),
    );
    expect(out[0].shareRatio?.toFixed(4)).toBe('1.5000');
  });

  it('🚨 复合 changeReason 不给 R (精确匹配) —— 子串匹配会把「以股代息發行紅股」当送股双算', () => {
    const out = buildFactorEventTerms(
      base({
        corporateActions: [
          { exDate: '2024-06-04', dividend: D('0.5'), bonusShares: null, currency: 'HKD' },
        ],
        equityChanges: [
          { date: '2024-01-01', capitalization: D('1000'), changeReason: '定期報告' },
          { date: '2024-06-04', capitalization: D('1500'), changeReason: '以股代息發行紅股' },
        ],
      }),
    );
    expect(out[0].shareRatio).toBeNull(); // 派息已由 d 承载, 不再叠 R
  });

  it('🚨 有配股条款时份额项走 1+q, 不再取 R (供股会同时体现在 capitalization 上 → 双算)', () => {
    const out = buildFactorEventTerms(
      base({
        allotments: [
          { exDate: '2024-06-04', allotmentRatio: D('3'), allotmentPrice: D('5'), currency: 'HKD' },
        ],
        equityChanges: [
          { date: '2024-01-01', capitalization: D('1000'), changeReason: '定期報告' },
          { date: '2024-06-04', capitalization: D('9999'), changeReason: '分红送股' },
        ],
      }),
    );
    expect(out[0].shareRatio?.toFixed(4)).toBe('4.0000'); // 1+q, 而非 9999/1000
  });

  it('非影响价格原因 (回购/增发/行权) 不产生 R', () => {
    const out = buildFactorEventTerms(
      base({
        corporateActions: [
          { exDate: '2024-06-04', dividend: D('0.5'), bonusShares: null, currency: 'HKD' },
        ],
        equityChanges: [
          { date: '2024-01-01', capitalization: D('1000'), changeReason: '定期報告' },
          { date: '2024-06-04', capitalization: D('900'), changeReason: '注銷購回股份' },
        ],
      }),
    );
    expect(out[0].shareRatio).toBeNull();
  });

  it('除权日无 bar (未来日/停牌) 或恰为首根 → 跳过, 不产生条款', () => {
    const out = buildFactorEventTerms(
      base({
        corporateActions: [
          { exDate: '2030-01-01', dividend: D('1'), bonusShares: null, currency: 'HKD' }, // 未来, 无 bar
          { exDate: '2024-06-03', dividend: D('1'), bonusShares: null, currency: 'HKD' }, // 首根, 无前一日
        ],
      }),
    );
    expect(out).toEqual([]);
  });

  it('n0/n1/官方涨跌幅取自除权日与其前一交易日', () => {
    const out = buildFactorEventTerms(
      base({
        corporateActions: [
          { exDate: '2024-06-05', dividend: null, bonusShares: null, currency: null },
        ],
      }),
    );
    expect(out[0].prevClose.toFixed(2)).toBe('9.50');
    expect(out[0].exClose.toFixed(2)).toBe('9.60');
    expect(out[0].officialChangePct?.toFixed(2)).toBe('1.05');
  });
});

// ── A 股送转股份额项（cn 的唯一来源，equity_change 无 cn 数据）──────────────────
describe('cn 送转股: 份额项取 payload 的 bonusSharesFrom*', () => {
  const bars: FactorNoneBar[] = [
    { tradeDate: '2024-06-03', close: D('30'), changePct: null },
    { tradeDate: '2024-06-04', close: D('19.8'), changePct: D('0') },
  ];

  it('🚨 十送五 (s=0.5) + 每股派息 0.2 → M=1.5, f = 1.5×30/(30−0.2)', () => {
    const out = buildFactorEventTerms({
      currency: 'CNY',
      noneBars: bars,
      corporateActions: [
        { exDate: '2024-06-04', dividend: D('0.2'), bonusShares: D('0.5'), currency: 'CNY' },
      ],
      equityChanges: [],
      allotments: [],
    });
    expect(out[0].shareRatio?.toFixed(4)).toBe('1.5000');
    expect(decideFactor(out[0]).factorJump.toFixed(6)).toBe('1.510067');
  });

  it('🚨 送转股与配股同日 → M = 1 + s + q (标准除权价公式的份额项, 不是二选一)', () => {
    const out = buildFactorEventTerms({
      currency: 'CNY',
      noneBars: bars,
      corporateActions: [
        { exDate: '2024-06-04', dividend: null, bonusShares: D('0.5'), currency: 'CNY' },
      ],
      equityChanges: [],
      allotments: [
        { exDate: '2024-06-04', allotmentRatio: D('0.3'), allotmentPrice: D('5'), currency: 'CNY' },
      ],
    });
    expect(out[0].shareRatio?.toFixed(4)).toBe('1.8000'); // 1 + 0.5 + 0.3
  });

  it('有条款给出的 s → 不再回退 equity_change 的 R (两者描述同一份额扩张, 叠加即双算)', () => {
    const out = buildFactorEventTerms({
      currency: 'CNY',
      noneBars: bars,
      corporateActions: [
        { exDate: '2024-06-04', dividend: null, bonusShares: D('0.5'), currency: 'CNY' },
      ],
      equityChanges: [
        { date: '2024-01-01', capitalization: D('1000'), changeReason: '定期報告' },
        { date: '2024-06-04', capitalization: D('9999'), changeReason: '分红送股' },
      ],
      allotments: [],
    });
    expect(out[0].shareRatio?.toFixed(4)).toBe('1.5000');
  });
});
