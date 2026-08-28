import { describe, it, expect } from 'vitest';
import {
  IV_OUTLIER_PERCENT,
  SHORT_DTE_EXEMPT_DAYS,
  detectOptionAnomalies,
  type OptionAnomalyRow,
} from './option-anomaly.rules.js';

/**
 * 北京 2026-08-07 22:00 = **ET 2026-08-07 10:00** —— 同一 ET 日, 两侧日期一致。
 * 需要区分基准的用例另取 {@link NOW_ET_LAGS_SHANGHAI}。
 */
const NOW = new Date('2026-08-07T14:00:00Z');

/**
 * 北京 2026-08-08 09:00 = **ET 2026-08-07 21:00** —— 上海已翻页而 ET 没有。
 * 拿它可以把「DTE 基准取谁的今天」变成可证伪的：见 `IV 离群` 段最后一条。
 */
const NOW_ET_LAGS_SHANGHAI = new Date('2026-08-08T01:00:00Z');

/** 一条正常的**虚值**认沽腿 (spot 140 > K 130 ⇒ 内在价值 0), greeks 齐全。 */
function otmPut(overrides: Partial<OptionAnomalyRow> = {}): OptionAnomalyRow {
  return {
    contractCode: 'US.PEP260918P130000',
    optionSide: 'PUT',
    root: 'PEP',
    isStandard: true,
    expiryDate: '2026-09-18',
    strikePrice: '130',
    underlyingSpot: '140',
    iv: '21.4',
    delta: '-0.18',
    gamma: '0.012',
    vega: '0.21',
    theta: '-0.03',
    ...overrides,
  };
}

/** 一条**深实值**认沽腿 (K 200 ≫ spot 140), greeks 整块缺失 —— 实测 227/2150 行的形态。 */
function deepItmPutWithoutGreeks(overrides: Partial<OptionAnomalyRow> = {}): OptionAnomalyRow {
  return {
    ...otmPut(),
    contractCode: 'US.PEP260918P200000',
    strikePrice: '200',
    iv: null,
    delta: null,
    gamma: null,
    vega: null,
    theta: null,
    ...overrides,
  };
}

/** greeks 全为 0 的占位形态 (vendor 休市时段大面积如此)。 */
const ZERO_GREEKS = {
  iv: '0',
  delta: '0',
  gamma: '0',
  vega: '0',
  theta: '0',
} as const;

const run = (
  rows: OptionAnomalyRow[],
  now: Date = NOW,
  knownNonStandardRoots: string[] = [],
  // 本文件既有全部样本都是美股合约 (`US.` 前缀 code) ⇒ 默认 `'us'`; 港股基准另有专测,
  // 见 `trading-day-gate.spec.ts` 的「基准按交易所分叉」describe (#263)。
  exchange = 'us',
) => detectOptionAnomalies({ rows, now, exchange, knownNonStandardRoots });

const codes = (rows: OptionAnomalyRow[], now?: Date, known?: string[]) =>
  run(rows, now, known).findings.map((f) => f.code);

describe('detectOptionAnomalies —— ① greeks 缺失只在虚值区抬 (FR-047)', () => {
  it('深实值腿整批缺 greeks → 不告警 (数学固有现象)', () => {
    const report = run([
      deepItmPutWithoutGreeks(),
      deepItmPutWithoutGreeks({ contractCode: 'US.PEP260918P210000', strikePrice: '210' }),
    ]);
    expect(report.findings).toEqual([]);
  });

  it('🚨 深实值缺 greeks MUST NOT 计入指标 —— 判定对象数与缺失数都是 0', () => {
    const metrics = run([deepItmPutWithoutGreeks()]).metrics;
    expect(metrics.greeksSubjects).toBe(0);
    expect(metrics.greeksUnavailable).toBe(0);
  });

  it('虚值腿缺 greeks → 告警 (同批另有可用 greeks ⇒ 不是全域降级)', () => {
    const report = run([otmPut(), otmPut({ contractCode: 'US.PEP260918P125000', iv: null })]);
    const finding = report.findings.find((f) => f.code === 'otm_greeks_unavailable');
    expect(finding).toBeDefined();
    expect(finding?.affected).toBe(1);
    expect(finding?.samples).toEqual(['US.PEP260918P125000']);
    expect(report.metrics).toMatchObject({ greeksSubjects: 2, greeksUnavailable: 1 });
  });

  it('🚨 greeks 全为 0 的虚值腿判「不可用」—— 值判据, 不看 vendor 的完整性标记', () => {
    // 实测 US.PEP260807C75000: `greeks_complete === true` 而五个数全是 0。
    // 本函数**蓄意不收** `greeksComplete` 字段 ⇒ 拿标记当「值可用」的证明在类型层就不可能。
    const report = run([otmPut(), otmPut({ contractCode: 'US.PEP260807C75000', ...ZERO_GREEKS })]);
    expect(report.findings.find((f) => f.code === 'otm_greeks_unavailable')?.samples).toEqual([
      'US.PEP260807C75000',
    ]);
  });

  it('🚨 整批零可用 greeks (休市时段快照) → 只出一条批级 WARN, 不逐腿刷屏', () => {
    const rows = [
      otmPut({ contractCode: 'US.PEP260918P130000', ...ZERO_GREEKS }),
      otmPut({ contractCode: 'US.PEP260918P125000', ...ZERO_GREEKS }),
      otmPut({ contractCode: 'US.PEP260918P120000', ...ZERO_GREEKS }),
      deepItmPutWithoutGreeks(),
    ];
    const report = run(rows);
    expect(report.findings.map((f) => f.code)).toEqual(['greeks_batch_unavailable']);
    expect(report.findings[0]?.affected).toBe(3);
  });

  it('缺 spot ⇒ 判不出实值/虚值 → 计入「不可分类」而非任一侧 (不可算是显式态)', () => {
    const metrics = run([otmPut({ underlyingSpot: null, iv: null })]).metrics;
    expect(metrics).toMatchObject({
      greeksSubjects: 0,
      greeksUnavailable: 0,
      greeksUnclassified: 1,
    });
    expect(run([otmPut({ underlyingSpot: null, iv: null })]).findings).toEqual([]);
  });

  it('空批 → 无告警 (无对象 ≠ 0%)', () => {
    expect(run([])).toMatchObject({ findings: [], newNonStandardRoots: [] });
  });
});

describe('detectOptionAnomalies —— 非标合约判不出实值/虚值 (#186, 与落库硬门同源)', () => {
  /** 调整后合约 (`CHTR1`): 交割物不是 100 股标的 ⇒ K 与 S 的大小关系不决定实值/虚值。 */
  const adjustedPut = (overrides: Partial<OptionAnomalyRow> = {}) =>
    otmPut({
      contractCode: 'US.CHTR1260918P17500',
      root: 'CHTR1',
      isStandard: false,
      strikePrice: '17.5',
      ...overrides,
    });

  /** greeks 整块缺失 (深实值腿的形态, 也正是非标腿被误判成虚值时会被冤枉的那一组)。 */
  const NO_GREEKS = { iv: null, delta: null, gamma: null, vega: null, theta: null } as const;

  it('🚨 非标腿缺 greeks → 计「不可分类」而非虚值缺失, 不抬 WARN', () => {
    // 非标 root 本身会另抬 ③ new_nonstandard_root, 预置进已知名单以隔离本条判定。
    const report = run([adjustedPut(NO_GREEKS)], NOW, ['CHTR1']);
    expect(report.findings).toEqual([]);
    expect(report.metrics).toMatchObject({
      greeksSubjects: 0,
      greeksUnavailable: 0,
      greeksUnclassified: 1,
    });
  });

  it('🚨 对照：同一行标成标准合约即进虚值判定面并告警 —— 退出判定面来自 is_standard', () => {
    const standard = run([otmPut(), adjustedPut({ ...NO_GREEKS, isStandard: true })], NOW, [
      'CHTR1',
    ]);
    expect(standard.findings.map((f) => f.code)).toEqual(['otm_greeks_unavailable']);
    expect(standard.metrics).toMatchObject({ greeksSubjects: 2, greeksUnavailable: 1 });

    const nonStandard = run([otmPut(), adjustedPut(NO_GREEKS)], NOW, ['CHTR1']);
    expect(nonStandard.findings).toEqual([]);
    expect(nonStandard.metrics).toMatchObject({ greeksSubjects: 1, greeksUnclassified: 1 });
  });
});

describe('detectOptionAnomalies —— ② IV 离群结合 DTE (FR-048)', () => {
  /** 600% 的 IV, 到期日由用例给。 */
  const wideIvPut = (expiryDate: string, contractCode = 'US.PEP260808P130000') =>
    otmPut({ contractCode, expiryDate, iv: '600' });

  it('DTE = 1 的 600% IV → 不告警 (极短 DTE 宽价差属预期, 实测 3/2150 全是这形态)', () => {
    const report = run([wideIvPut('2026-08-08')]);
    expect(report.findings).toEqual([]);
    // 豁免必须留数 —— 静默豁免与「没发生过」在事后无法区分。
    expect(report.metrics).toMatchObject({ ivOutliers: 0, ivShortDteExempt: 1 });
  });

  it('DTE = 60 的同一个 600% IV → 告警', () => {
    const report = run([wideIvPut('2026-10-06')]);
    const finding = report.findings.find((f) => f.code === 'iv_outlier');
    expect(finding).toBeDefined();
    expect(finding?.affected).toBe(1);
    expect(report.metrics).toMatchObject({ ivOutliers: 1, ivShortDteExempt: 0 });
  });

  it(`豁免线闭区间: DTE = ${SHORT_DTE_EXEMPT_DAYS} 豁免, DTE = ${SHORT_DTE_EXEMPT_DAYS + 1} 不豁免`, () => {
    expect(codes([wideIvPut('2026-08-09')])).toEqual([]);
    expect(codes([wideIvPut('2026-08-10')])).toEqual(['iv_outlier']);
  });

  it(`阈值边界闭: IV 恰好 ${IV_OUTLIER_PERCENT.toString()} 不算离群`, () => {
    expect(
      codes([otmPut({ expiryDate: '2026-10-06', iv: IV_OUTLIER_PERCENT.toString() })]),
    ).toEqual([]);
  });

  it('🚨 DTE 基准走 **ET 的今天**, 不是宿主 (上海) 的今天', () => {
    // now = 北京 08-08 09:00 = ET 08-07 21:00。到期 08-10 ⇒ ET 基准 DTE = 3 (不豁免, 告警);
    // 若误取上海日期则 DTE = 2 (落进豁免线) ⇒ 告警凭空消失且永远不会红。
    expect(codes([wideIvPut('2026-08-10')], NOW_ET_LAGS_SHANGHAI)).toEqual(['iv_outlier']);
  });

  it('IV 缺失的行不参与离群判定 (缺失不是离群)', () => {
    expect(run([otmPut({ iv: null })]).metrics.ivEvaluated).toBe(0);
  });
});

describe('detectOptionAnomalies —— ③ 新的非标 root 进复核名单 (FR-049)', () => {
  const nonStandard = (root: string, contractCode: string) =>
    otmPut({ root, contractCode, isStandard: false });

  it('首见 VICI1 → 告警 + 进新名单', () => {
    const report = run([otmPut(), nonStandard('VICI1', 'US.VICI1260918P030000')]);
    const finding = report.findings.find((f) => f.code === 'new_nonstandard_root');
    expect(finding).toBeDefined();
    expect(finding?.samples).toEqual(['VICI1']);
    expect(report.newNonStandardRoots).toEqual(['VICI1']);
  });

  it('次日同 root 已在名单 → 不重复报', () => {
    const report = run([nonStandard('VICI1', 'US.VICI1260918P030000')], NOW, ['VICI1']);
    expect(report.findings).toEqual([]);
    expect(report.newNonStandardRoots).toEqual([]);
  });

  it('同一 root 的多条非标合约只报一次', () => {
    const report = run([
      nonStandard('VICI1', 'US.VICI1260918P030000'),
      nonStandard('VICI1', 'US.VICI1260918P035000'),
      otmPut(),
    ]);
    expect(report.newNonStandardRoots).toEqual(['VICI1']);
    expect(report.findings.find((f) => f.code === 'new_nonstandard_root')?.affected).toBe(1);
  });

  it('标准合约的 root 不进名单 (本条只盯非标)', () => {
    expect(run([otmPut({ root: 'BRAND-NEW' })]).newNonStandardRoots).toEqual([]);
  });

  it('多个新 root 按字典序稳定输出 (逐日 log 可比)', () => {
    const report = run([
      nonStandard('ZZZ1', 'US.ZZZ1260918P010000'),
      nonStandard('AAA1', 'US.AAA1260918P010000'),
    ]);
    expect(report.newNonStandardRoots).toEqual(['AAA1', 'ZZZ1']);
  });
});
