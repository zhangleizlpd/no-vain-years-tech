import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  buildPositionGroups,
  type PositionDisplayRow,
  type PositionGroup,
} from './broker-position-display.rules';

/**
 * 083 持仓展示纯函数单测 (plan D3–D6; FR-001 / FR-003 / FR-004 / FR-005 / FR-006 / FR-011 / FR-021)。
 * 代码 / 连接标签 / 数值全部合成 (`ZQX` / `ZQY` / `ZQR` / 港股 `088xx`)。
 */

interface TestRow extends PositionDisplayRow {
  /** 行原样透传的字段 (T005 的行还带名称、数量等) —— 用它验证「不合并、原样带出」。 */
  qty: string;
}

const D = (v: string) => new Prisma.Decimal(v);
const str = (d: Prisma.Decimal | null) => (d === null ? null : d.toString());

type OptionShape = NonNullable<PositionDisplayRow['option']>;

/** 期权字段构造; 排序键 `right` / `strike` 带默认值, 用例只覆写自己关心的那个。 */
const optionOf = (over: Partial<OptionShape> = {}): OptionShape => ({
  expiry: '2026-10-16',
  right: 'C',
  strike: D('100'),
  ...over,
});

let nextId = 1n;
function row(over: Partial<TestRow>): TestRow {
  const id = nextId;
  nextId += 1n;
  return {
    id,
    market: 'us',
    code: 'US.ZQX',
    underlyingTicker: 'us:ZQX',
    connectionLabel: 'acct-a',
    option: null,
    marketValue: null,
    unrealizedPl: null,
    currentPrice: null,
    openedAt: null,
    qty: '1',
    ...over,
  };
}

const ANCHORED = new Set(['us:ZQX', 'us:ZQY', 'us:ZQR', 'hk:08801', 'hk:08802']);
const NO_SPOTS: ReadonlyMap<string, Prisma.Decimal | null> = new Map();
const NOW = new Date('2026-09-15T02:00:00Z');

function build(
  rows: readonly TestRow[],
  opts: { anchorSpots?: ReadonlyMap<string, Prisma.Decimal | null>; now?: Date } = {},
) {
  return buildPositionGroups({
    rows,
    anchoredTickers: ANCHORED,
    anchorSpots: opts.anchorSpots ?? NO_SPOTS,
    now: opts.now ?? NOW,
  });
}

const tickers = (groups: readonly PositionGroup<TestRow>[]) =>
  groups.map((g) => g.underlyingTicker);

describe('buildPositionGroups — 展示过滤 (plan D3)', () => {
  it('① 未解析行 (underlyingTicker = null) 不进组、计入 unresolvedCount (branch 9)', () => {
    const result = build([
      row({ underlyingTicker: null, code: 'US.UNKNOWN1' }),
      row({ underlyingTicker: 'us:ZQX' }),
    ]);
    expect(result.unresolvedCount).toBe(1);
    expect(tickers(result.groups)).toEqual(['us:ZQX']);
    expect(result.groups.flatMap((g) => g.rows).map((r) => r.code)).toEqual(['US.ZQX']);
  });

  it('② 非锚标的行丢弃, 且不计入 unresolvedCount (branch 8)', () => {
    const result = build([row({ underlyingTicker: 'us:ZQZ', code: 'US.ZQZ' }), row({})]);
    expect(result.unresolvedCount).toBe(0);
    expect(tickers(result.groups)).toEqual(['us:ZQX']);
  });

  it('③ unresolvedCount 为 0 / 2 两例; 全部未解析时 groups 为空 (branch 10 服务端半)', () => {
    expect(build([row({})]).unresolvedCount).toBe(0);
    const allUnresolved = build([row({ underlyingTicker: null }), row({ underlyingTicker: null })]);
    expect(allUnresolved.unresolvedCount).toBe(2);
    expect(allUnresolved.groups).toEqual([]);
  });
});

describe('buildPositionGroups — 分组与组值 (plan D4)', () => {
  it('④ 只有 1 行的组 rows.length === 1 (branch 11)', () => {
    const result = build([row({ underlyingTicker: 'us:ZQR', code: 'US.ZQR' })]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.rows).toHaveLength(1);
  });

  it('⑤ 组值 = 非空者带符号求和; 部分 null 只和非空; 全 null ⇒ null (branch 12)', () => {
    const full = build([
      row({ marketValue: D('1000'), unrealizedPl: D('99.5') }),
      row({ option: optionOf(), marketValue: D('-350.5'), unrealizedPl: D('-20') }),
      row({
        option: optionOf({ expiry: '2026-11-20' }),
        marketValue: D('250'),
        unrealizedPl: D('7.25'),
      }),
    ]);
    expect(str(full.groups[0]!.groupMarketValue)).toBe('899.5');
    expect(str(full.groups[0]!.groupUnrealizedPl)).toBe('86.75');

    const partial = build([
      row({ marketValue: D('1000'), unrealizedPl: null }),
      row({ option: optionOf(), marketValue: null, unrealizedPl: D('-20') }),
      row({
        option: optionOf({ expiry: '2026-11-20' }),
        marketValue: D('-400'),
        unrealizedPl: null,
      }),
    ]);
    expect(str(partial.groups[0]!.groupMarketValue)).toBe('600');
    expect(str(partial.groups[0]!.groupUnrealizedPl)).toBe('-20');

    const allNull = build([row({}), row({ option: optionOf() })]);
    expect(allNull.groups[0]!.groupMarketValue).toBeNull();
    expect(allNull.groups[0]!.groupUnrealizedPl).toBeNull();
  });

  it('⑫ 两个连接持有同一合约 ⇒ 两行、数量不合并、各带自己的 connectionLabel (branch 21)', () => {
    const code = 'US.ZQY261016P090000';
    const result = build([
      row({
        underlyingTicker: 'us:ZQY',
        code,
        option: optionOf(),
        connectionLabel: 'acct-a',
        qty: '-2',
      }),
      row({
        underlyingTicker: 'us:ZQY',
        code,
        option: optionOf(),
        connectionLabel: 'acct-b',
        qty: '-3',
      }),
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.rows.map((r) => [r.connectionLabel, r.qty])).toEqual([
      ['acct-a', '-2'],
      ['acct-b', '-3'],
    ]);
  });
});

describe('buildPositionGroups — 组头正股现价 (plan D5)', () => {
  it('⑥ 组内有正股 ⇒ 取组内排序第一的正股行现价, 不取锚现价 (branch 15)', () => {
    const spots = new Map([['us:ZQY', D('150')]]);
    const result = build(
      [
        row({
          underlyingTicker: 'us:ZQY',
          code: 'US.ZQY',
          option: optionOf(),
          currentPrice: D('3'),
        }),
        row({
          underlyingTicker: 'us:ZQY',
          code: 'US.ZQY',
          connectionLabel: 'acct-b',
          currentPrice: D('149'),
        }),
        row({
          underlyingTicker: 'us:ZQY',
          code: 'US.ZQY',
          connectionLabel: 'acct-a',
          currentPrice: D('148'),
        }),
      ],
      { anchorSpots: spots },
    );
    expect(str(result.groups[0]!.underlyingPrice)).toBe('148');
  });

  it('⑦ 无正股、锚现价非空 ⇒ 取锚现价 (branch 16)', () => {
    const spots = new Map([['us:ZQY', D('150')]]);
    const result = build(
      [row({ underlyingTicker: 'us:ZQY', option: optionOf(), currentPrice: D('3') })],
      { anchorSpots: spots },
    );
    expect(str(result.groups[0]!.underlyingPrice)).toBe('150');
  });

  it('⑧ 无正股、锚现价 null 或缺键 ⇒ null (branch 17)', () => {
    const optionOnly = [
      row({ underlyingTicker: 'us:ZQY', option: optionOf(), currentPrice: D('3') }),
    ];
    expect(
      build(optionOnly, { anchorSpots: new Map([['us:ZQY', null]]) }).groups[0]!.underlyingPrice,
    ).toBeNull();
    expect(build(optionOnly).groups[0]!.underlyingPrice).toBeNull();
  });
});

describe('buildPositionGroups — 全序排序 (plan D4)', () => {
  it('⑨ 组内: 正股段在前; 期权段 已到期沉底 → 沽(P) 先于购(C) → 到期日近的在前 → 行权价升序 → code → connectionLabel → id; 开仓时间不再参与期权段排序; 输入打乱三次结果逐项相同 (branch 18)', () => {
    const t = (iso: string) => new Date(iso);
    const base = { underlyingTicker: 'us:ZQY' };
    // 🚨 openedAt 刻意与期望序**完全相反** (越靠后的期望位置开仓越早) —— 旧实现按开仓时间升序,
    // 会把 callNov70 排到期权段最前。它是本用例对「开仓时间已不参与期权段排序」的反例臂。
    const rows = {
      stockA: row({ ...base, code: 'US.ZQY', connectionLabel: 'acct-a' }),
      stockB: row({ ...base, code: 'US.ZQY', connectionLabel: 'acct-b' }),
      putOct90: row({
        ...base,
        code: 'US.ZQY261016P090000',
        option: optionOf({ expiry: '2026-10-16', right: 'P', strike: D('90') }),
        openedAt: t('2026-06-01T14:00:00Z'),
      }),
      putOct100: row({
        ...base,
        code: 'US.ZQY261016P100000',
        option: optionOf({ expiry: '2026-10-16', right: 'P', strike: D('100') }),
        openedAt: t('2026-05-01T14:00:00Z'),
      }),
      // 🚨 200 / 1000 这一对是 `strike` 键的**专用反例臂**: 代码里的行权价定宽零填充在跨数位时
      // 宽度会变 ('200000' 6 位 vs '1000000' 7 位), 字典序给出 1000 → 200, 数值序给出 200 → 1000。
      // 去掉 strike 比较、退回 `code` 兜底时这两行会互换 ⇒ 本用例才真能钉住 strike 键。
      putOct200: row({
        ...base,
        code: 'US.ZQY261016P200000',
        option: optionOf({ expiry: '2026-10-16', right: 'P', strike: D('200') }),
        openedAt: t('2026-05-15T14:00:00Z'),
      }),
      putOct1000: row({
        ...base,
        code: 'US.ZQY261016P1000000',
        option: optionOf({ expiry: '2026-10-16', right: 'P', strike: D('1000') }),
        openedAt: t('2026-05-10T14:00:00Z'),
      }),
      putNov80: row({
        ...base,
        code: 'US.ZQY261120P080000',
        option: optionOf({ expiry: '2026-11-20', right: 'P', strike: D('80') }),
        openedAt: t('2026-04-01T14:00:00Z'),
      }),
      callOct85: row({
        ...base,
        code: 'US.ZQY261016C085000',
        option: optionOf({ expiry: '2026-10-16', right: 'C', strike: D('85') }),
        openedAt: t('2026-03-01T14:00:00Z'),
      }),
      callNov70: row({
        ...base,
        code: 'US.ZQY261120C070000',
        option: optionOf({ expiry: '2026-11-20', right: 'C', strike: D('70') }),
        openedAt: t('2026-02-01T14:00:00Z'),
      }),
      // 到期日 < 交易所今天 (NOW = 2026-09-15T02:00Z = EDT 09-14) ⇒ expired: 沽购一律沉底,
      // 段内仍按 沽→购 排 —— 否则「临到期在前」会把死合约顶到最显眼的首位。
      expiredPut: row({
        ...base,
        code: 'US.ZQY260911P095000',
        option: optionOf({ expiry: '2026-09-11', right: 'P', strike: D('95') }),
        openedAt: t('2026-01-05T14:00:00Z'),
      }),
      expiredCall: row({
        ...base,
        code: 'US.ZQY260911C060000',
        option: optionOf({ expiry: '2026-09-11', right: 'C', strike: D('60') }),
        openedAt: t('2026-01-01T14:00:00Z'),
      }),
    };
    const expected = [
      rows.stockA,
      rows.stockB,
      rows.putOct90,
      rows.putOct100,
      rows.putOct200,
      rows.putOct1000,
      rows.putNov80,
      rows.callOct85,
      rows.callNov70,
      rows.expiredPut,
      rows.expiredCall,
    ].map((r) => r.id);

    const list = Object.values(rows);
    const reversed = [...list].reverse();
    const rotated = [...list.slice(3), ...list.slice(0, 3)];
    for (const input of [list, reversed, rotated]) {
      expect(build(input).groups[0]!.rows.map((r) => r.id)).toEqual(expected);
    }
  });

  it('⑩ 跨组: |组值| 降序、并列按 ticker 升序、null 组排末 (null 组之间也按 ticker) (branch 19)', () => {
    const result = build([
      row({ underlyingTicker: 'us:ZQY', marketValue: D('300') }),
      row({ underlyingTicker: 'hk:08802', market: 'hk', code: 'HK.08802' }),
      row({ underlyingTicker: 'us:ZQX', marketValue: D('-500') }),
      row({ underlyingTicker: 'hk:08801', market: 'hk', code: 'HK.08801' }),
      row({ underlyingTicker: 'us:ZQR', marketValue: D('500') }),
    ]);
    expect(tickers(result.groups)).toEqual(['us:ZQR', 'us:ZQX', 'us:ZQY', 'hk:08801', 'hk:08802']);
  });

  it('⑪ 组值恰为 0 按 0 排: 在正值组之后、null 组之前 (Edge「组市值为 0」)', () => {
    const result = build([
      row({ underlyingTicker: 'hk:08801', market: 'hk', code: 'HK.08801' }),
      row({ underlyingTicker: 'us:ZQX', marketValue: D('250') }),
      row({ underlyingTicker: 'us:ZQX', option: optionOf(), marketValue: D('-250') }),
      row({ underlyingTicker: 'us:ZQY', marketValue: D('5') }),
    ]);
    expect(str(result.groups.find((g) => g.underlyingTicker === 'us:ZQX')!.groupMarketValue)).toBe(
      '0',
    );
    expect(tickers(result.groups)).toEqual(['us:ZQY', 'us:ZQX', 'hk:08801']);
  });
});

describe('buildPositionGroups — 到期判定 (plan D6; FR-021)', () => {
  it('⑬ 美股期权到期日 = 美东今天、now = 北京次日 03:00 ⇒ expired=false (branch 24); 到期日 = 美东昨天 ⇒ true (branch 23); 正股恒 false', () => {
    // 2026-09-11T19:00:00Z = 北京 09-12 03:00 = EDT 09-11 15:00。
    const now = new Date('2026-09-11T19:00:00Z');
    const result = build(
      [
        row({ code: 'US.ZQX260911C050000', option: optionOf({ expiry: '2026-09-11' }) }),
        row({ code: 'US.ZQX260910C050000', option: optionOf({ expiry: '2026-09-10' }) }),
        row({ code: 'US.ZQX' }),
      ],
      { now },
    );
    const expiredByCode = Object.fromEntries(
      result.groups[0]!.rows.map((r) => [r.code, r.expired]),
    );
    expect(expiredByCode).toEqual({
      'US.ZQX260911C050000': false,
      'US.ZQX260910C050000': true,
      'US.ZQX': false,
    });
  });
});
