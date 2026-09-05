/**
 * 075 T002 —— 「喂完的行不再被引用」这层断言为什么走**结构遍历**而不是 `WeakRef`（二选一的留档）：
 *
 * `WeakRef` + 可达性那条在本仓的默认执行路径上**恒绿**：拿不到 `global.gc`（本仓 `--expose-gc`
 * 零先例，vitest 默认不开）时 GC 不会在断言之前发生，`deref()` 必然还拿得到对象 ⇒ 累加器有没有
 * 持有那批行，断言都过。而 FR-021① 要的正是一条**确定性、每次回归都跑**的判据 —— 区分不了
 * 「过」与「根本没跑」的断言不满足它（testing.md §7「恒有输出 = 恒无输出」）。
 *
 * ⇒ 走结构遍历：把累加器的累计状态当对象图走一遍，断言里面找不到任何一条喂入的行。代价是
 * 累加器要把 `state` 作为只读引用暴露出来（`option-anomaly.rules.ts` 已就此写明用途）。
 */
import { describe, it, expect } from 'vitest';
import {
  IV_OUTLIER_PERCENT,
  MAX_SAMPLE_ITEMS,
  SHORT_DTE_EXEMPT_DAYS,
  createOptionAnomalyAccumulator,
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

// ─────────────────────────────────────────────────────────────────────────────
// 075 T001 —— 增量累加器：切批喂与一次喂完的差分臂
// ─────────────────────────────────────────────────────────────────────────────

const ACC_INIT = { now: NOW, exchange: 'us', knownNonStandardRoots: [] as readonly string[] };

/**
 * 把同一序列按给定切点**连续分割**后逐批喂进一个累加器，出整轮结论。
 * `cuts` 为空 ⇒ 一次喂完 (N = 1)。输入序不变 ⇒ 样本序在各臂之间可比。
 */
function reportBySplits(rows: readonly OptionAnomalyRow[], cuts: readonly number[]) {
  const acc = createOptionAnomalyAccumulator(ACC_INIT);
  let prev = 0;
  for (const cut of [...cuts, rows.length]) {
    acc.feed(rows.slice(prev, cut));
    prev = cut;
  }
  return acc.report();
}

/** 前段行数 = 2 条非标 + 3 条实值 —— 整轮**拿得到 greeks 的行全在这里**。 */
const USABLE_LEAD = 5;
/** 后段虚值缺 greeks 的行数, 蓄意 > `MAX_SAMPLE_ITEMS`, 让样本截断也进差分面。 */
const MISSING_TAIL = 25;

/**
 * 差分臂的混合序列：三条判据 + 样本截断 + 跨批 root 去重各有代表行, 且**前 5 行全部拿得到
 * greeks、其后一行都拿不到** —— 于是「切在第 5 行」这一刀正好横切 FR-005 的全域判据。
 *
 * 🚨 **前段蓄意一条虚值标准腿都不放**（只放非标与实值腿）: 全域判据的三个合取项之一是
 * 「虚值区**全部**缺失」, 前段若混进一条 greeks 齐全的虚值腿, 该项恒假 ⇒ 判据无论用整轮域
 * 还是逐批域都走不到那条分支, 差分臂就照样绿 —— 这份 fixture 的第一版正是这么空跑的。
 */
function mixedRows(): OptionAnomalyRow[] {
  const rows: OptionAnomalyRow[] = [];
  // 非标两条 (greeks 齐全 ⇒ 计 usableAnywhere, 但判不出实值/虚值 ⇒ 计 unclassified)。
  rows.push(
    otmPut({
      contractCode: 'US.VICI1260918P030000',
      root: 'VICI1',
      isStandard: false,
      strikePrice: '30',
    }),
  );
  rows.push(
    otmPut({
      contractCode: 'US.ZZZ1260918P010000',
      root: 'ZZZ1',
      isStandard: false,
      strikePrice: '10',
    }),
  );
  // 实值三条 (K 200/210/220 ≫ spot 140), greeks 齐全 ⇒ 计 usableAnywhere 但不进虚值判定面。
  // 其中两条挂宽 IV: 一条 DTE = 60 (离群), 一条 DTE = 1 (短 DTE 豁免) —— IV 两个计数器都非零
  // (② 的判定与实值/虚值无关)。
  rows.push(otmPut({ contractCode: 'US.PEP260918P200000', strikePrice: '200' }));
  rows.push(
    otmPut({
      contractCode: 'US.PEP261006P210000',
      strikePrice: '210',
      expiryDate: '2026-10-06',
      iv: '600',
    }),
  );
  rows.push(
    otmPut({
      contractCode: 'US.PEP260808P220000',
      strikePrice: '220',
      expiryDate: '2026-08-08',
      iv: '600',
    }),
  );

  for (let i = 0; i < MISSING_TAIL; i++) {
    const strike = 100 + i;
    rows.push(
      otmPut({
        contractCode: `US.PEP260918P${strike}000`,
        strikePrice: String(strike),
        ...ZERO_GREEKS,
      }),
    );
  }
  rows.push(deepItmPutWithoutGreeks());
  // 同一个 VICI1 在**后一批**再出现一次 —— 跨批去重的正面样本。
  rows.push(
    otmPut({
      contractCode: 'US.VICI1260918P035000',
      root: 'VICI1',
      isStandard: false,
      strikePrice: '35',
      iv: null,
      delta: null,
      gamma: null,
      vega: null,
      theta: null,
    }),
  );
  return rows;
}

/**
 * 🚨 **变异留档（075 T001，sabotage 臂 per testing.md §7.1）** —— 这一段断言能不能红是有实证的：
 *
 * · 改坏处：`option-anomaly.rules.ts` 的 `feed()` 首行插 `state.usableAnywhere = 0;`
 *   （= 把 FR-005 的全域判据从整轮域退化成逐批域）
 * · 读数：**1 failed | 26 passed** —— 红的正是下面第一条差分臂，实际结论变成误报的
 *   `greeks_batch_unavailable`；**20 条既有单测全绿**（它们只走一次性入口 ⇒ 单批 ⇒ 看不见这个退化，
 *   这正是差分臂非加不可的理由）
 * · 还原后：**27 passed**
 * · 复跑：`pnpm nx test server src/marketdata/option-anomaly.rules.spec.ts --skip-nx-cache`
 */
describe('createOptionAnomalyAccumulator —— 切批喂结论恒等 (075 FR-001 / FR-004 / FR-004a)', () => {
  it('🚨 差分臂: 一次喂完 vs 切批喂 (含横切全域判据的那一刀) 结论逐字段相同', () => {
    const rows = mixedRows();
    const oneShot = reportBySplits(rows, []);

    // 先钉住「量到的是满载」—— 三条判据 / 样本截断 / 跨批 root 去重都真的发生了。否则下面
    // 几臂可能在比较两份空结论 (恒等而零判别力, testing.md §7)。
    expect(oneShot.findings.map((f) => f.code)).toEqual([
      'otm_greeks_unavailable',
      'iv_outlier',
      'new_nonstandard_root',
    ]);
    expect(oneShot.metrics).toEqual({
      rows: rows.length,
      // 🚨 虚值判定面**全部缺失** (subjects === unavailable) —— 这是全域判据三个合取项里的
      // 一项, 少了它那条分支永远走不到, 差分臂就失去判别力 (见 mixedRows 的文件内注释)。
      greeksSubjects: MISSING_TAIL,
      greeksUnavailable: MISSING_TAIL,
      greeksUnclassified: 3,
      ivEvaluated: USABLE_LEAD,
      ivOutliers: 1,
      ivShortDteExempt: 1,
    });
    expect(oneShot.findings[0]?.samples).toHaveLength(MAX_SAMPLE_ITEMS);
    expect(oneShot.newNonStandardRoots).toEqual(['VICI1', 'ZZZ1']);

    // 🚨 这一刀横切 FR-005: 可用 greeks 全落第一批、缺失全落第二批。整轮口径 ⇒
    // otm_greeks_unavailable; 退化成逐批口径 ⇒ 末批零可用 ⇒ 误报 greeks_batch_unavailable。
    expect(reportBySplits(rows, [USABLE_LEAD])).toEqual(oneShot);
    // 逐行喂 (N = 行数) 与不等长三刀 —— 切法不改变结论。
    expect(reportBySplits(rows, [...rows.keys()].slice(1))).toEqual(oneShot);
    expect(reportBySplits(rows, [3, 11, 30])).toEqual(oneShot);
  });

  it('一次性入口是薄封装 —— detectOptionAnomalies 与累加器一次喂完逐字段相同 (FR-004a)', () => {
    const rows = mixedRows();
    expect(detectOptionAnomalies({ ...ACC_INIT, rows })).toEqual(reportBySplits(rows, []));
  });

  it('🚨 整轮零可用 greeks 切成 3 批 → 仍只出**一条**批级 WARN (FR-005, sb 2)', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      otmPut({ contractCode: `US.PEP260918P1${20 + i}000`, ...ZERO_GREEKS }),
    );
    const split = reportBySplits(rows, [2, 4]);
    expect(split.findings.map((f) => f.code)).toEqual(['greeks_batch_unavailable']);
    expect(split.findings[0]?.affected).toBe(rows.length);
    expect(split).toEqual(reportBySplits(rows, []));
  });

  it('新非标 root 跨批去重, 整轮只报一次 (FR-009, sb 7)', () => {
    const nonStd = (root: string, contractCode: string) =>
      otmPut({ root, contractCode, isStandard: false });
    const rows = [
      nonStd('VICI1', 'US.VICI1260918P030000'),
      otmPut(),
      nonStd('VICI1', 'US.VICI1260918P035000'),
      nonStd('AAA1', 'US.AAA1260918P010000'),
    ];
    const split = reportBySplits(rows, [2]);
    expect(split.newNonStandardRoots).toEqual(['AAA1', 'VICI1']);
    expect(split.findings.find((f) => f.code === 'new_nonstandard_root')?.affected).toBe(2);
  });

  it(`样本截到 ${MAX_SAMPLE_ITEMS} 而 affected 仍是全量, 切批不改样本序 (FR-011, sb 10)`, () => {
    const rows = mixedRows();
    const codes = rows.filter((r) => r.iv === '0').map((r) => r.contractCode);
    const finding = reportBySplits(rows, [USABLE_LEAD]).findings[0];
    expect(finding?.affected).toBe(MISSING_TAIL);
    expect(finding?.samples).toEqual(codes.slice(0, MAX_SAMPLE_ITEMS));
  });

  it('一批不喂 / 只喂空批 → 与空输入的一次性调用逐字段相同 (FR-010, sb 8)', () => {
    const acc = createOptionAnomalyAccumulator(ACC_INIT);
    const empty = detectOptionAnomalies({ ...ACC_INIT, rows: [] });
    expect(createOptionAnomalyAccumulator(ACC_INIT).report()).toEqual(empty);
    acc.feed([]);
    acc.feed([]);
    expect(acc.report()).toEqual(empty);
  });

  it('report() 幂等 —— 连调两次结论相同, 之后仍可继续 feed', () => {
    const acc = createOptionAnomalyAccumulator(ACC_INIT);
    acc.feed([otmPut({ iv: null })]);
    const first = acc.report();
    expect(acc.report()).toEqual(first);
    acc.feed([otmPut()]);
    expect(acc.report().metrics.rows).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 075 T002 —— 常驻结构断言（确定性, 每次回归都跑; 选型理由见文件头）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 `root` 出发走对象图, 收集**可达的对象引用**（函数与原始值不收）。数组 / `Set` / `Map`
 * 的元素也走进去 —— 行若被换个壳存回状态里, 也照样会被这一趟遍历撞见。
 *
 * 复杂度 **O(V + E)**（V = 可达对象数, E = 引用边数）: 每个对象靠 `seen` 只入栈一次, 环安全。
 */
function reachableObjects(root: unknown): Set<object> {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) stack.push(...node);
    else if (node instanceof Set) stack.push(...node);
    else if (node instanceof Map) stack.push(...node.keys(), ...node.values());
    else stack.push(...Object.values(node));
  }
  return seen;
}

/** n 条虚值缺 greeks 的行（合约 code 互不相同）—— 只用来把计数器 / 样本数组喂满。 */
function missingRows(n: number, salt = 0): OptionAnomalyRow[] {
  return Array.from({ length: n }, (_, i) =>
    otmPut({ contractCode: `US.PEP260918P${salt}-${i}`, ...ZERO_GREEKS }),
  );
}

/**
 * 🚨 **变异留档（075 T002，sabotage 臂 per testing.md §7.1）**：
 *
 * · 改坏处：`option-anomaly.rules.ts` 的 `OptionAnomalyAccumulatorState` 加一个
 *   `heldRows: OptionAnomalyRow[]`（初值 `[]`），`feed()` 里加一行 `state.heldRows.push(...rows)`
 * · 读数：**2 failed | 30 passed** —— 红的正是臂 ① 的两条（行对象可达 / 可达对象数随行数长）；
 *   臂 ②③ 与 20 条既有单测**全绿** ⇒ 只有臂 ① 够得到「持有」这件事，其余观察面看不见它
 * · 还原后：**32 passed**
 * · 复跑：`pnpm nx test server src/marketdata/option-anomaly.rules.spec.ts --skip-nx-cache`
 */
describe('createOptionAnomalyAccumulator —— 常驻结构不随行数增长 (075 FR-002 / FR-003 / FR-021①)', () => {
  it('🚨 ① 喂完的行不再被累加器可达 —— 状态对象图里一条行都找不到 (FR-003)', () => {
    const acc = createOptionAnomalyAccumulator(ACC_INIT);
    const first = mixedRows();
    acc.feed(first);
    // 再喂一批: 排除「只有最后一批被留着」这种只在末批可见的持有形态。
    acc.feed(missingRows(30, 1));

    const reachable = reachableObjects(acc.state);
    // ⓐ identity: 喂进去的那些行对象本身, 以及承载它们的那个数组。
    for (const row of first) expect(reachable.has(row)).toBe(false);
    expect(reachable.has(first)).toBe(false);
    // ⓑ 形状: 换个壳存回去也算持有 —— 可达集里 MUST NOT 有任何「长得像行」的对象。
    const rowShaped = [...reachable].filter((o) => 'contractCode' in o && 'strikePrice' in o);
    expect(rowShaped).toEqual([]);
  });

  it('🚨 ① 续: 可达对象数与已喂入行数无关 (10 倍行 ⇒ 同一组容器对象)', () => {
    const small = createOptionAnomalyAccumulator(ACC_INIT);
    small.feed(missingRows(50));
    const large = createOptionAnomalyAccumulator(ACC_INIT);
    for (let batch = 0; batch < 10; batch++) large.feed(missingRows(50, batch));

    expect(large.state.rows).toBe(10 * small.state.rows);
    expect(reachableObjects(large.state).size).toBe(reachableObjects(small.state).size);
  });

  it(`② 样本数组恒 ≤ ${MAX_SAMPLE_ITEMS}, 喂 10 倍行数不变; affected 仍是全量 (FR-011)`, () => {
    const acc = createOptionAnomalyAccumulator(ACC_INIT);
    acc.feed(missingRows(50));
    const capped = acc.state.otmMissingSamples.length;
    for (let batch = 1; batch < 10; batch++) acc.feed(missingRows(50, batch));

    expect(capped).toBe(MAX_SAMPLE_ITEMS);
    expect(acc.state.otmMissingSamples).toHaveLength(MAX_SAMPLE_ITEMS);
    // 上界只截样本, 没把计数一起截掉 —— 否则 `affected` 会静默从 500 变成 20。
    expect(acc.state.greeksUnavailable).toBe(500);
    expect(acc.report().findings[0]?.affected).toBe(500);
  });

  it(`② 续: IV 离群样本同样有上界 ${MAX_SAMPLE_ITEMS}`, () => {
    const acc = createOptionAnomalyAccumulator(ACC_INIT);
    for (let batch = 0; batch < 5; batch++) {
      acc.feed(
        Array.from({ length: 50 }, (_, i) =>
          otmPut({
            contractCode: `US.PEP261006P${batch}-${i}`,
            expiryDate: '2026-10-06',
            iv: '600',
          }),
        ),
      );
    }
    expect(acc.state.ivOutlierSamples).toHaveLength(MAX_SAMPLE_ITEMS);
    expect(acc.state.ivOutliers).toBe(250);
  });

  it('③ freshRoots 基数只随**不同 root 数**增长, 与行数无关 (FR-009)', () => {
    const roots = ['AAA1', 'VICI1', 'ZZZ1'];
    const acc = createOptionAnomalyAccumulator(ACC_INIT);
    for (let batch = 0; batch < 20; batch++) {
      acc.feed(
        Array.from({ length: 100 }, (_, i) =>
          otmPut({
            root: roots[i % roots.length],
            contractCode: `US.NS${batch}-${i}`,
            isStandard: false,
          }),
        ),
      );
    }
    expect(acc.state.rows).toBe(2000);
    expect(acc.state.freshRoots.size).toBe(roots.length);
  });
});
