import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { buildPositionGroups, type PositionDisplayRow } from './broker-position-display.rules';
import {
  convertRows,
  finalizeConvertedGroups,
  parseDisplayCurrency,
  resolveDisplayRate,
} from './display-currency.rules';
import type { FxRate } from './fx-rate.port';

/**
 * 085 T005 折算规则单测 (Small 档: 零外部依赖、与源码 colocate; 结构照 `radar-cursor.spec.ts`)。
 *
 * 🚨 **夹具汇率全部是合成值** —— 🚫 真实汇率 (per `testing.md` §7 合成数据条款), 且**三角蓄意
 * 不闭合** (`0.9500 × 7.5000 ≠ 7.0000`): 任何「用另两对相除凑第三对」的链式交叉实现都会在这组
 * 夹具上给出与直接币对不同的数字。数字字面量另需避开档位系数子串 (`check-optionsdesk-rule-constants`
 * 不变量 #1 扫本目录全部 `.ts`, 含 spec)。
 */

const d = (raw: string): Prisma.Decimal => new Prisma.Decimal(raw);

const CAPTURED_AT = new Date('2026-09-17T01:30:00.000Z');

const RATES: readonly FxRate[] = [
  { pair: 'USDCNY', rate: d('7.0000'), capturedAt: CAPTURED_AT },
  { pair: 'HKDCNY', rate: d('0.9500'), capturedAt: CAPTURED_AT },
  { pair: 'USDHKD', rate: d('7.5000'), capturedAt: CAPTURED_AT },
];

const NOW = new Date('2026-09-17T02:00:00.000Z');

type TestRow = PositionDisplayRow & {
  currency: string | null;
  averageCost: Prisma.Decimal | null;
};

interface RowSpec {
  ticker?: string;
  currency?: string | null;
  marketValue?: string;
  unrealizedPl?: string;
  currentPrice?: string;
  averageCost?: string;
  strike?: string;
}

let nextId = 1n;

function makeRow(spec: RowSpec = {}): TestRow {
  const id = nextId++;
  return {
    id,
    market: 'hk',
    code: `HK.T${id.toString().padStart(4, '0')}`,
    underlyingTicker: spec.ticker ?? 'ZZZ',
    connectionLabel: 'conn-a',
    option:
      spec.strike === undefined
        ? null
        : { expiry: '2026-12-31', right: 'C', strike: d(spec.strike) },
    marketValue: spec.marketValue === undefined ? null : d(spec.marketValue),
    unrealizedPl: spec.unrealizedPl === undefined ? null : d(spec.unrealizedPl),
    currentPrice: spec.currentPrice === undefined ? null : d(spec.currentPrice),
    averageCost: spec.averageCost === undefined ? null : d(spec.averageCost),
    currency: spec.currency === undefined ? 'HKD' : spec.currency,
    openedAt: new Date('2026-09-01T00:00:00.000Z'),
  };
}

function groupsOf<R extends TestRow>(rows: readonly R[]) {
  return buildPositionGroups<R>({
    rows,
    anchoredTickers: new Set(
      rows.map((r) => r.underlyingTicker).filter((t): t is string => t !== null),
    ),
    anchorSpots: new Map(),
    now: NOW,
  }).groups;
}

/** 整个输出的可读快照 —— 用来断言「屏上不存在某个数字」(`id` 是 bigint, 需显式转串)。 */
function dumpOf(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveDisplayRate —— 汇率表按币对索引', () => {
  it('直接币对命中 ⇒ 原值 + 原样带出 capturedAt', () => {
    const applied = resolveDisplayRate(RATES, 'HKD', 'CNY');
    expect(applied?.pair).toBe('HKDCNY');
    expect(applied?.rate.toFixed()).toBe('0.95');
    expect(applied?.capturedAt).toBe(CAPTURED_AT);
  });

  it('只有反向命中 ⇒ 取倒数 (反向币对 vendor 全 MISS), 往返误差 < 1e-9', () => {
    const back = resolveDisplayRate(RATES, 'CNY', 'HKD');
    expect(back?.pair).toBe('HKDCNY');
    const roundTrip = d('1000').mul(d('0.9500')).mul(back!.rate);
    expect(roundTrip.minus(d('1000')).abs().lt(d('1e-9'))).toBe(true);
  });

  it('🚨 按 `pair` 索引而非按位置 —— 打乱汇率表顺序结果不变 (port 只保证三对齐全)', () => {
    const shuffled = [RATES[2], RATES[0], RATES[1]];
    expect(resolveDisplayRate(shuffled, 'HKD', 'CNY')?.rate.toFixed()).toBe(
      resolveDisplayRate(RATES, 'HKD', 'CNY')?.rate.toFixed(),
    );
  });

  it('from = to ⇒ null (不需要汇率, 不是汇率缺失) —— 汇率行据此不出现 (FR-007 / FR-011)', () => {
    expect(resolveDisplayRate(RATES, 'CNY', 'CNY')).toBeNull();
  });

  it('表里没有该币对 (全源失败 ⇒ 空表) ⇒ null', () => {
    expect(resolveDisplayRate([], 'HKD', 'CNY')).toBeNull();
  });

  it('parseDisplayCurrency: 三档内归一化, 档外 / null ⇒ null (不猜不回落)', () => {
    expect(parseDisplayCurrency('hkd')).toBe('HKD');
    expect(parseDisplayCurrency(' USD ')).toBe('USD');
    expect(parseDisplayCurrency('JPY')).toBeNull();
    expect(parseDisplayCurrency('')).toBeNull();
    expect(parseDisplayCurrency(null)).toBeNull();
  });
});

describe('convertRows —— 逐行折算与降级 (FR-002 / FR-003 / FR-006 / FR-008)', () => {
  it('① 选定币种 = 该行原币种 ⇒ 原值直出: Decimal 字符串**逐字**相同, 且乘法调用次数为 0', () => {
    // 🚨 `.equals()` 数值相等在此**不会**红 —— 「乘以 1 再按有效位定标」的实现同样通过。
    // 逐字 (toFixed) + 乘法 spy 两条一起, 才逼得出 FR-008 说的那个差别。
    const mul = vi.spyOn(Prisma.Decimal.prototype, 'mul');
    const row = makeRow({
      currency: 'HKD',
      marketValue: '98765.4321',
      unrealizedPl: '-54321.9876',
    });

    const [out] = convertRows([row], { target: 'HKD', rates: RATES });

    expect(out.marketValue?.toFixed()).toBe('98765.4321');
    expect(out.unrealizedPl?.toFixed()).toBe('-54321.9876');
    expect(mul).toHaveBeenCalledTimes(0);
    expect(out.converted).toBe(false);
    expect(out.degraded).toBe(false);
    expect(out.displayCurrency).toBe('HKD');
  });

  it('② 选定 ≠ 原 ∧ 汇率可用 ⇒ 金额类折算, **价格类三项逐字不变** (FR-003)', () => {
    const row = makeRow({
      currency: 'HKD',
      marketValue: '2000.0000',
      unrealizedPl: '-400.0000',
      currentPrice: '9.8765',
      averageCost: '7.6543',
      strike: '450.0000',
    });

    const [out] = convertRows([row], { target: 'CNY', rates: RATES });

    expect(out.marketValue?.toFixed()).toBe('1900');
    expect(out.unrealizedPl?.toFixed()).toBe('-380');
    expect(out.currentPrice?.toFixed()).toBe('9.8765');
    expect(out.averageCost?.toFixed()).toBe('7.6543');
    expect(out.option?.strike.toFixed()).toBe('450');
    expect(out.converted).toBe(true);
    expect(out.degraded).toBe(false);
    expect(out.displayCurrency).toBe('CNY');
  });

  it('③ 汇率不可用 ⇒ 金额类为 null + 标原币种, 输出**不含任何折算数字**', () => {
    const row = makeRow({ currency: 'HKD', marketValue: '2000.0000', unrealizedPl: '-400.0000' });

    const [out] = convertRows([row], { target: 'CNY', rates: [] });

    expect(out.marketValue).toBeNull();
    expect(out.unrealizedPl).toBeNull();
    expect(out.degraded).toBe(true);
    expect(out.converted).toBe(false);
    expect(out.displayCurrency).toBe('HKD');
    // FR-006「以该行原币种显示其金额」—— 置 null 的那份是聚合入参, 呈现值在这里。
    expect(out.originalMarketValue?.toFixed()).toBe('2000');
    expect(out.originalUnrealizedPl?.toFixed()).toBe('-400');
    // 屏上一个 CNY 单位的数字都不该有 (SC-003)。
    const dump = dumpOf(out);
    expect(dump).not.toContain('1900');
    expect(dump).not.toContain('-380');
  });

  it('④ 该行 currency 为 null ⇒ 同 ③; 选定币种 = 该市场原币种时**同样降级** (不被默认成任何币种)', () => {
    const row = makeRow({ currency: null, marketValue: '2000.0000', unrealizedPl: '-400.0000' });

    const [out] = convertRows([row], { target: 'CNY', rates: RATES });

    expect(out.marketValue).toBeNull();
    expect(out.unrealizedPl).toBeNull();
    expect(out.degraded).toBe(true);
    expect(out.displayCurrency).toBeNull();
    expect(out.originalMarketValue?.toFixed()).toBe('2000');
    expect(dumpOf(out)).not.toContain('1900');

    // US3-AS2: 币种未知的行无从证明「它已经是 HKD」⇒ 直出路径也不许走。
    const [native] = convertRows([row], { target: 'HKD', rates: RATES });
    expect(native.degraded).toBe(true);
    expect(native.marketValue).toBeNull();
  });

  it('⑩ 汇率陈旧**不触发降级** —— 照常折算并保留取数时刻 (plan D6: 本片不设陈旧阈值)', () => {
    const stale = new Date('2020-01-02T03:04:05.000Z');
    const staleRates: readonly FxRate[] = RATES.map((r) => ({ ...r, capturedAt: stale }));
    const row = makeRow({ currency: 'HKD', marketValue: '2000.0000', unrealizedPl: '-400.0000' });

    const [out] = convertRows([row], { target: 'CNY', rates: staleRates });

    expect(out.degraded).toBe(false);
    expect(out.converted).toBe(true);
    expect(out.marketValue?.toFixed()).toBe('1900');
    expect(out.unrealizedPl?.toFixed()).toBe('-380');
    // 时刻原样上屏 (FR-007), 由用户自己判陈旧。
    expect(resolveDisplayRate(staleRates, 'HKD', 'CNY')?.capturedAt).toBe(stale);
  });
});

describe('组聚合与跨组排序 (FR-004 / FR-006 / FR-012)', () => {
  it('⑤ 组内各行可折算 ⇒ 先逐行折算再聚合, 两个组值均为选定币种', () => {
    const rows = [
      makeRow({ ticker: 'ZZZ', marketValue: '2000.0000', unrealizedPl: '-100.0000' }),
      makeRow({ ticker: 'ZZZ', marketValue: '3000.0000', unrealizedPl: '200.0000' }),
    ];

    const [group] = finalizeConvertedGroups(
      groupsOf(convertRows(rows, { target: 'CNY', rates: RATES })),
    );

    expect(group.groupMarketValue?.toFixed()).toBe('4750');
    expect(group.groupUnrealizedPl?.toFixed()).toBe('95');
    expect(group.aggregateComplete).toBe(true);
  });

  it('⑥ 组聚合**不许混入降级行**: 组市值恰等于前两行折算值之和, 且组标不完整', () => {
    const rows = [
      makeRow({ ticker: 'ZZZ', marketValue: '2000.0000', unrealizedPl: '-100.0000' }),
      makeRow({ ticker: 'ZZZ', marketValue: '3000.0000', unrealizedPl: '200.0000' }),
      makeRow({
        ticker: 'ZZZ',
        currency: null,
        marketValue: '5000.0000',
        unrealizedPl: '-700.0000',
      }),
    ];

    const [raw] = groupsOf(convertRows(rows, { target: 'CNY', rates: RATES }));

    // 恰等于前两行折算值之和 —— 🚨 把第三行原币种值也加进去会得到 9750, 再整体折算会得到 9500,
    // 两个数都「看起来合理」, 只有逐字断言分得开。
    expect(raw.groupMarketValue?.toFixed()).toBe('4750');
    expect(raw.groupMarketValue?.toFixed()).not.toBe('9750');
    expect(raw.groupMarketValue?.toFixed()).not.toBe('9500');
    expect(raw.groupUnrealizedPl?.toFixed()).toBe('95');

    const [group] = finalizeConvertedGroups([raw]);
    // FR-006: **两个**聚合值都标不完整、都不出数字 (只置一个会让人以为另一个完整)。
    expect(group.aggregateComplete).toBe(false);
    expect(group.groupMarketValue).toBeNull();
    expect(group.groupUnrealizedPl).toBeNull();
  });

  it('⑦ 全部组可完整折算 ⇒ 折算前后组顺序逐项相同 (同屏同币种 = 等比例缩放; SC-002)', () => {
    const rows = [
      makeRow({ ticker: 'ZZZ', marketValue: '1000.0000' }),
      makeRow({ ticker: 'YYY', marketValue: '3000.0000' }),
      makeRow({ ticker: 'XXX', marketValue: '2000.0000' }),
    ];

    const baseline = groupsOf(rows).map((g) => g.underlyingTicker);
    const converted = finalizeConvertedGroups(
      groupsOf(convertRows(rows, { target: 'CNY', rates: RATES })),
    ).map((g) => g.underlyingTicker);

    expect(baseline).toEqual(['YYY', 'XXX', 'ZZZ']);
    expect(converted).toEqual(baseline);
  });

  it('⑧ 降级组沉底: 可完整折算但**值小**的组排在含降级行但**值大**的组之前', () => {
    // 🚨 这组构造是为了区分「根本没实现沉底」: ticker 升序也会把 AAA 排前, 部分和降序同样把
    // AAA 排前 —— 期望 ZZZ 在前, 才同时否掉这两种实现。
    const rows = [
      makeRow({ ticker: 'ZZZ', marketValue: '1000.0000' }),
      makeRow({ ticker: 'AAA', marketValue: '2000.0000' }),
      makeRow({ ticker: 'AAA', currency: null, marketValue: '5000.0000' }),
    ];

    const converted = convertRows(rows, { target: 'CNY', rates: RATES });
    const raw = groupsOf(converted);
    // 前提自证: 沉底之前, 含降级行的那组确实排在前 (部分和 1900 > 950)。
    expect(raw.map((g) => g.underlyingTicker)).toEqual(['AAA', 'ZZZ']);

    const finalized = finalizeConvertedGroups(raw);
    expect(finalized.map((g) => g.underlyingTicker)).toEqual(['ZZZ', 'AAA']);
    expect(finalized[0].groupMarketValue?.toFixed()).toBe('950');
    expect(finalized[1].groupMarketValue).toBeNull();
  });

  it('⑨ 降级组之间保持原有相对顺序, 组内各行顺序不受折算影响 (FR-012)', () => {
    const rows = [
      makeRow({ ticker: 'MMM', marketValue: '1000.0000' }),
      makeRow({ ticker: 'AAA', marketValue: '2000.0000' }),
      makeRow({ ticker: 'AAA', currency: null, marketValue: '5000.0000' }),
      makeRow({ ticker: 'BBB', marketValue: '3000.0000' }),
      makeRow({ ticker: 'BBB', currency: null, marketValue: '5000.0000' }),
      makeRow({ ticker: 'CCC', currency: null, marketValue: '5000.0000' }),
    ];

    const raw = groupsOf(convertRows(rows, { target: 'CNY', rates: RATES }));
    expect(raw.map((g) => g.underlyingTicker)).toEqual(['BBB', 'AAA', 'MMM', 'CCC']);

    const finalized = finalizeConvertedGroups(raw);
    // 完整组提前, 降级组三者之间的相对顺序原样保留 (🚫 按 ticker 重排 ⇒ 会得到 AAA/BBB/CCC)。
    expect(finalized.map((g) => g.underlyingTicker)).toEqual(['MMM', 'BBB', 'AAA', 'CCC']);
    expect(finalized.map((g) => g.aggregateComplete)).toEqual([true, false, false, false]);

    // 组内各行相对顺序与「不折算」时逐条相同 (按 ticker 对齐比较 —— 组**之间**的顺序本来就变了)。
    const rowIdsByTicker = (groups: { underlyingTicker: string; rows: { id: bigint }[] }[]) =>
      new Map(groups.map((g) => [g.underlyingTicker, g.rows.map((r) => r.id.toString())]));
    expect(rowIdsByTicker(finalized)).toEqual(rowIdsByTicker(groupsOf(rows)));
  });
});
