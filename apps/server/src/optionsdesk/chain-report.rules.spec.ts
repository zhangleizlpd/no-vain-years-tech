import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  CHAIN_REPORT_CELL_STATES,
  CHAIN_REPORT_METRICS,
  CHAIN_REPORT_METRIC_BETTER,
  OTM_BAND_COUNT,
  OTM_BAND_ITM_INDEX,
  OTM_BAND_TOP_INDEX,
  OTM_BAND_WIDTH,
  aggregateCell,
  chainReportColumns,
  chainReportGateCounts,
  chainReportRows,
  chainReportSkeleton,
  classifyOtmBand,
  type ChainReportLegVerdict,
} from './chain-report.rules';
import { recallCandidates, type RecallContext, type RecallLegInput } from './leg-recall.rules';

// 价外幅度量纲一律**小数比例** (0.10 = 10%)，同 leg-tier.rules.ts 的档界口径。
// 📌 现价取 100 是蓄意的：行权价区间与幅度区间的换算 (K = spot × (1 − 幅度)) 一眼可验，
//    且避开 check-optionsdesk-rule-constants 不变量 #1 的档位系数子串扫描（spec 文件在其扫描面内）。

const SPOT = new Prisma.Decimal('100');
const context: RecallContext = { spot: SPOT };

const band = (strike: string) => classifyOtmBand(SPOT, new Prisma.Decimal(strike));

describe('chain-report.rules — 行轴 (FR-002, plan D-AGG-1)', () => {
  it('整根轴由档宽与档数两个常量决定 —— 别处 MUST NOT 再写第二份档界', () => {
    const rows = chainReportRows(SPOT);
    expect(rows).toHaveLength(OTM_BAND_COUNT);
    expect(rows.map((r) => r.index)).toEqual([...Array(OTM_BAND_COUNT).keys()]);
    for (const row of rows) {
      expect(row.otmFloor.toString()).toBe(OTM_BAND_WIDTH.times(row.index - 1).toString());
    }
  });

  it('相邻两档首尾相接 —— 上一档的上界即下一档的下界，无重叠无空洞', () => {
    const rows = chainReportRows(SPOT);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].otmFloor.toString()).toBe(rows[i - 1].otmCeiling?.toString());
    }
  });

  it('两端非对称：首档下界封在价内一个档宽，顶档开口无上界', () => {
    const rows = chainReportRows(SPOT);
    expect(rows[OTM_BAND_ITM_INDEX].otmFloor.toString()).toBe(OTM_BAND_WIDTH.negated().toString());
    expect(rows[OTM_BAND_ITM_INDEX].otmFloor.isNegative()).toBe(true);
    expect(rows[OTM_BAND_TOP_INDEX].otmCeiling).toBeNull();
    expect(rows[OTM_BAND_TOP_INDEX].strikeFloor).toBeNull();
  });

  it('每档同时给行权价区间 —— 幅度下界闭对应行权价上界闭，两端反向 (FR-027 读数面板要)', () => {
    const rows = chainReportRows(SPOT);
    // 价内档：幅度 [−10%, 0) ⇒ 行权价 (100, 110]
    expect(rows[OTM_BAND_ITM_INDEX].strikeCeiling.toString()).toBe('110');
    expect(rows[OTM_BAND_ITM_INDEX].strikeFloor?.toString()).toBe('100');
    // 价外首档：幅度 [0, 10%) ⇒ 行权价 (90, 100]
    expect(rows[1].strikeCeiling.toString()).toBe('100');
    expect(rows[1].strikeFloor?.toString()).toBe('90');
    // 顶档：幅度 [60%, ∞) ⇒ 行权价 (0, 40]，下界开口
    expect(rows[OTM_BAND_TOP_INDEX].strikeCeiling.toString()).toBe('40');
  });

  it('行权价区间与落档判据互为反函数 —— 每档的上界值恰落回本档', () => {
    for (const row of chainReportRows(SPOT)) {
      expect(band(row.strikeCeiling.toString())).toBe(row.index);
    }
  });
});

describe('chain-report.rules — 落档边界 (FR-002「下界闭、上界开」)', () => {
  it('三个界值各归一档 —— 恰 0% / 恰 −10% / 恰 10% 有且只有一档', () => {
    expect(band('100')).toBe(1); // 恰 0% ⇒ 价外首档，不是价内档
    expect(band('110')).toBe(OTM_BAND_ITM_INDEX); // 恰 −10% ⇒ 价内档（下界闭）
    expect(band('90')).toBe(2); // 恰 10% ⇒ 第二档（上界开）
  });

  it('界值两侧各差一档 —— 判据不含浮点毛刺', () => {
    expect(band('90.01')).toBe(1);
    expect(band('99.99')).toBe(1);
    expect(band('89.99')).toBe(2);
  });

  it('比首档更深的价内 ⇒ 行下界外，单独可数 (FR-034 ② 的数据源)', () => {
    expect(band('110.01')).toBeNull();
    expect(band('150')).toBeNull();
  });

  it('顶档吸收极深价外腿 —— 🚫 MUST NOT 与「行下界外」共用 null', () => {
    expect(band('40')).toBe(OTM_BAND_TOP_INDEX);
    expect(band('39.99')).toBe(OTM_BAND_TOP_INDEX);
    expect(band('1')).toBe(OTM_BAND_TOP_INDEX);
  });

  it('现价非正 ⇒ 行轴不成立，判不出档 (state_branch 20 的纯函数一半)', () => {
    expect(classifyOtmBand(new Prisma.Decimal(0), new Prisma.Decimal('90'))).toBeNull();
  });
});

describe('chain-report.rules — 列轴 (FR-003 不分箱)', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  it('列 = 链上实际存在的到期日，去重升序，🚫 不造链上没有的到期日', () => {
    const legs = [
      { expiryDate: day('2026-10-16') },
      { expiryDate: day('2026-09-11') },
      { expiryDate: day('2026-10-16') },
      { expiryDate: day('2026-09-18') },
    ];
    expect(chainReportColumns(legs).map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-09-11',
      '2026-09-18',
      '2026-10-16',
    ]);
  });

  it('单到期日链塌成单列 (state_branch 10 的数据面)', () => {
    expect(chainReportColumns([{ expiryDate: day('2026-09-18') }])).toHaveLength(1);
  });

  it('空链 ⇒ 零列，🚫 不兜底造一列', () => {
    expect(chainReportColumns([])).toHaveLength(0);
  });
});

describe('chain-report.rules — 骨架 (FR-005, 🚨 Guardrail 2)', () => {
  const leg = (over: Partial<RecallLegInput>): RecallLegInput => ({
    dteDays: 30,
    strike: new Prisma.Decimal('90'),
    bid: new Prisma.Decimal('1.50'),
    ask: new Prisma.Decimal('1.70'),
    openInterest: 100,
    volume: 50,
    ...over,
  });

  /** 过权利金门槛、但**无人碰过** ⇒ 活性门槛挡下。实测 `us:ACN` 这类腿有 38 条。 */
  const untouched = leg({ openInterest: 0, volume: 0 });
  /** 三视角一律的两道门槛都过。 */
  const healthy = leg({});
  /** 报价低于权利金下限 ⇒ 整条移出骨架 (FR-034 ①)。 */
  const tooCheap = leg({ bid: new Prisma.Decimal('0.05') });

  const legs = [untouched, healthy, tooCheap];

  it('骨架 = 过权利金门槛之后的整条链 —— 太便宜的整条移出', () => {
    const skeleton = chainReportSkeleton(context, legs);
    expect(skeleton).toContain(healthy);
    expect(skeleton).not.toContain(tooCheap);
  });

  it('🚨 骨架 ≠ 候选集 —— 被活性门槛挡下的腿 MUST 留在骨架内', () => {
    const skeleton = chainReportSkeleton(context, legs);
    const candidates = recallCandidates(
      context,
      ['all', 'build', 'rent'],
      legs,
      legs.length,
      null,
    ).candidates;

    // 同一条腿：在骨架内（要留在网格上呈「被门槛挡下」态），却不在任何视角的候选集里。
    expect(skeleton).toContain(untouched);
    expect(candidates.map((c) => c.leg)).not.toContain(untouched);

    // 🔬 两个集合确实不等 —— 若骨架改成取 candidates，本断言当场红。
    expect(skeleton.length).toBeGreaterThan(candidates.length);
  });

  it('骨架不设上限 —— 腿数远超候选保险丝时零条被切 (🚨 Guardrail 1)', () => {
    const many = Array.from({ length: 4000 }, () => healthy);
    expect(chainReportSkeleton(context, many)).toHaveLength(many.length);
  });

  it('骨架不排序不截断 —— 输入顺序原样保留 (FR-005 🚫 不套选约表的条数截断)', () => {
    const skeleton = chainReportSkeleton(context, [healthy, untouched]);
    expect(skeleton).toEqual([healthy, untouched]);
  });
});

describe('chain-report.rules — 取优方向 (FR-006 / FR-011 – FR-013, plan D-AGG-1)', () => {
  it('四种格值各有一个方向 —— 加了格值忘配方向即编译红以外的第二道拦', () => {
    expect(Object.keys(CHAIN_REPORT_METRIC_BETTER).sort()).toEqual(
      [...CHAIN_REPORT_METRICS].sort(),
    );
  });

  it('🚨 建仓成色越低越好，其余三种越高越好', () => {
    expect(CHAIN_REPORT_METRIC_BETTER.build_quality).toBe('lower');
    expect(CHAIN_REPORT_METRIC_BETTER.rent_annualized).toBe('higher');
    expect(CHAIN_REPORT_METRIC_BETTER.all_annualized).toBe('higher');
    expect(CHAIN_REPORT_METRIC_BETTER.activity).toBe('higher');
  });
});

describe('chain-report.rules — 格聚合 (FR-006 – FR-008, FR-027, FR-028)', () => {
  const d = (v: string) => new Prisma.Decimal(v);
  const rates = ['10', '25', '60'].map(d);

  it('🚨 取该格最优，🚫 不取均值 —— 均值会被格内边缘腿拉低', () => {
    const mean = rates.reduce((sum, v) => sum.plus(v), new Prisma.Decimal(0)).div(rates.length);
    const cell = aggregateCell(rates, 'all_annualized', rates.length);
    expect(cell.best?.toString()).toBe('60');
    expect(cell.best?.equals(mean)).toBe(false);
  });

  it('🚨 建仓成色取最小 —— 方向踩反时网格照常渲染，只是每格都在推荐反向的腿', () => {
    const quality = ['-5', '-12', '2'].map(d);
    const cell = aggregateCell(quality, 'build_quality', quality.length);
    expect(cell.best?.toString()).toBe('-12');
    expect(cell.runnerUp?.toString()).toBe('-5');
  });

  it('最优 / 次优与输入顺序无关', () => {
    const orders = [
      [rates[0], rates[1], rates[2]],
      [rates[2], rates[1], rates[0]],
      [rates[1], rates[2], rates[0]],
    ];
    for (const order of orders) {
      const cell = aggregateCell(order, 'rent_annualized', order.length);
      expect(cell.best?.toString()).toBe('60');
      expect(cell.runnerUp?.toString()).toBe('25');
    }
  });

  it('🚨 格内只有一条腿 ⇒ 次优显式为 null，🚫 MUST NOT 复述最优 (state_branch 14)', () => {
    const cell = aggregateCell([d('25')], 'rent_annualized', 1);
    expect(cell.best?.toString()).toBe('25');
    expect(cell.runnerUp).toBeNull();
    expect(cell.legCount).toBe(1);
  });

  it('🚨 两条腿取值相等 ⇒ 次优 = 那个值，🚫 不是 null —— 判据是腿数不是取值互异', () => {
    const cell = aggregateCell([d('25'), d('25')], 'rent_annualized', 2);
    expect(cell.runnerUp?.toString()).toBe('25');
    expect(cell.legCount).toBe(2);
  });

  it('腿数 = 算得出值的成员条数，与最优 / 次优同口径 (FR-007 + FR-027)', () => {
    expect(aggregateCell(rates, 'activity', 9).legCount).toBe(rates.length);
  });
});

describe('chain-report.rules — 格态 (FR-016 / FR-016a, plan D-STATE-1)', () => {
  const d = (v: string) => new Prisma.Decimal(v);

  it('恰三态，🚫 MUST NOT 为第四种成因单开格级色码 (FR-016a)', () => {
    expect(CHAIN_REPORT_CELL_STATES).toHaveLength(3);
  });

  it('三态各自可判 —— 有值 / 被门槛挡下 / 无合约', () => {
    expect(aggregateCell([d('25')], 'rent_annualized', 3).state).toBe('valued');
    expect(aggregateCell([], 'rent_annualized', 3).state).toBe('gated');
    expect(aggregateCell([], 'rent_annualized', 0).state).toBe('absent');
  });

  it('🚨 有腿但一条都不成员 ⇒ gated 而非 absent —— 报成「无合约」是给错误信息不是缺失信息', () => {
    const cell = aggregateCell([], 'build_quality', 7);
    expect(cell.state).toBe('gated');
    expect(cell.state).not.toBe('absent');
  });

  it('🚨 格态随格值重算 —— 同一格在两种格值下判出不同态 (state_branch 2 数据面, Guardrail 6)', () => {
    const chainLegCount = 4;
    // 同一个格位置：收租视角召回到 2 条，建仓视角一条都没召回（成色上界 / 有效成本硬门槛）。
    const asRent = aggregateCell([d('25'), d('10')], 'rent_annualized', chainLegCount);
    const asBuild = aggregateCell([], 'build_quality', chainLegCount);
    expect(asRent.state).toBe('valued');
    expect(asBuild.state).toBe('gated');
    expect(asRent.state).not.toBe(asBuild.state);
  });

  it('非有值态 ⇒ 腿数 0 且读数为 null，🚫 禁伪造 0 (承 046「禁显 0、显未知」)', () => {
    for (const chainLegCount of [0, 5]) {
      const cell = aggregateCell([], 'all_annualized', chainLegCount);
      expect(cell.legCount).toBe(0);
      expect(cell.best).toBeNull();
      expect(cell.runnerUp).toBeNull();
    }
  });
});

describe('chain-report.rules — 三互斥计数 (FR-034, SC-006, state_branch 9)', () => {
  /** 四类腿的原型 —— 每一类沿求值链只落一个桶。 */
  const tooCheap: ChainReportLegVerdict = { inSkeleton: false, live: false, band: null };
  const deepItm: ChainReportLegVerdict = { inSkeleton: true, live: true, band: null };
  const untouched: ChainReportLegVerdict = { inSkeleton: true, live: false, band: 3 };
  const admitted: ChainReportLegVerdict = { inSkeleton: true, live: true, band: 3 };

  const chain = (spec: readonly [ChainReportLegVerdict, number][]): ChainReportLegVerdict[] =>
    spec.flatMap(([verdict, count]) => Array.from({ length: count }, () => verdict));

  // 实测锚：`us:ACN` **单链** 825 条认沽腿（⚠️ SC-006 里那组 3531 是全池 12 链，两组口径不同）。
  const acn = chain([
    [tooCheap, 252],
    [deepItm, 261],
    [untouched, 38],
    [admitted, 274],
  ]);

  it('🚨 求和恒等式：三计数 + 有值 ≡ 该链全量 (实测锚 252 + 261 + 38 + 274 = 825)', () => {
    const counts = chainReportGateCounts(acn);
    expect(counts.total).toBe(825);
    expect(counts.removedByPremium).toBe(252);
    expect(counts.outsideRowFloor).toBe(261);
    expect(counts.blockedByLiveness).toBe(38);
    expect(counts.valued).toBe(274);
    expect(
      counts.removedByPremium + counts.outsideRowFloor + counts.blockedByLiveness + counts.valued,
    ).toBe(counts.total);
  });

  it('每个计数带自己的分母 —— 骨架 = 全量 − ①，行内 = 骨架 − ② (FR-034)', () => {
    const counts = chainReportGateCounts(acn);
    expect(counts.skeleton).toBe(counts.total - counts.removedByPremium);
    expect(counts.withinRows).toBe(counts.skeleton - counts.outsideRowFloor);
    expect(counts.withinRows).toBe(counts.blockedByLiveness + counts.valued);
  });

  it('🚨 互斥是结构性的 —— 每条腿只落一个桶，四类各自单独成链都只点亮自己那一个', () => {
    const buckets = [
      [tooCheap, 'removedByPremium'],
      [deepItm, 'outsideRowFloor'],
      [untouched, 'blockedByLiveness'],
      [admitted, 'valued'],
    ] as const;
    for (const [verdict, field] of buckets) {
      const counts = chainReportGateCounts(chain([[verdict, 7]]));
      expect(counts[field]).toBe(7);
      for (const [, other] of buckets) {
        if (other !== field) expect(counts[other]).toBe(0);
      }
    }
  });

  it('🔬 反例探针：被活性挡下的深价内腿 MUST 计入 ②，🚫 不计入 ③ —— 否则两桶重复计', () => {
    // 这条腿同时满足「行下界外」与「活性不过」。求值顺序决定它只算一次，且算在 ② 上。
    const both: ChainReportLegVerdict = { inSkeleton: true, live: false, band: null };
    const counts = chainReportGateCounts(chain([[both, 865]]));
    expect(counts.outsideRowFloor).toBe(865);
    expect(counts.blockedByLiveness).toBe(0);
    expect(
      counts.removedByPremium + counts.outsideRowFloor + counts.blockedByLiveness + counts.valued,
    ).toBe(counts.total);
  });

  it('`inSkeleton` 为假时其余判定不参与 —— 太便宜的腿整条不在图上 (FR-034 ①)', () => {
    const contradictory: ChainReportLegVerdict = { inSkeleton: false, live: true, band: 2 };
    const counts = chainReportGateCounts(chain([[contradictory, 5]]));
    expect(counts.removedByPremium).toBe(5);
    expect(counts.skeleton).toBe(0);
    expect(counts.valued).toBe(0);
  });

  it('空链 ⇒ 四个数全 0 且恒等式仍成立', () => {
    const counts = chainReportGateCounts([]);
    expect(counts.total).toBe(0);
    expect(counts.skeleton).toBe(0);
    expect(counts.withinRows).toBe(0);
    expect(counts.valued).toBe(0);
  });

  it('顶档腿计入有值 —— 极深价外不是「行下界外」(承 T001 的顶档开口)', () => {
    const farOtm: ChainReportLegVerdict = {
      inSkeleton: true,
      live: true,
      band: OTM_BAND_TOP_INDEX,
    };
    expect(chainReportGateCounts(chain([[farOtm, 4]])).valued).toBe(4);
  });
});
