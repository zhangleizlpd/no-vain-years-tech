import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  OTM_BAND_COUNT,
  OTM_BAND_ITM_INDEX,
  OTM_BAND_TOP_INDEX,
  OTM_BAND_WIDTH,
  chainReportColumns,
  chainReportRows,
  chainReportSkeleton,
  classifyOtmBand,
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
