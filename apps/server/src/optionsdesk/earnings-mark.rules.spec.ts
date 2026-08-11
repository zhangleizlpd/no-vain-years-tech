import { describe, expect, it } from 'vitest';
import { EARNINGS_FORWARD_HORIZON_DAYS } from '../marketdata/sync-earnings-event.usecase';
import {
  EARNINGS_BUFFER_MIN_DAYS,
  crossesEarnings,
  earningsCalendarContext,
  earningsMark,
  earningsMarksByExpiry,
  type EarningsLegFamily,
} from './earnings-mark.rules';

// 全部日期取自 mockup handoff §④「同一到期日的财报标必须一致」那张表, 便于逐行回归:
//   today = 2025-08-04 · E1 = 2025-08-12 · E2 = 2025-10-14
//   08-08 (4d, 早于 E1) 不跨 · 08-15 (11d, 短腿跨 E1) ⚠ · 09-19 (46d, 长腿缓冲 38d) 覆盖 ✓
//   10-17 (74d, 长腿最后利空 E2, 缓冲 3d) 缓冲不足 · 2027-01-15 (529d, 超视野) 无日期
const TODAY = '2025-08-04';
const E1 = '2025-08-12';
const E2 = '2025-10-14';
const PEP = 'us:PEP';

const calendar = () => earningsCalendarContext(PEP, TODAY, [E2, E1]);

describe('earnings-mark.rules — 覆盖窗与三个域 (FR-023/026/034, plan D-UI-4)', () => {
  it('覆盖窗右端 = 今天 + 采集侧前向视野 —— 视野常量从 marketdata 单点 import, 不自写半年', () => {
    expect(EARNINGS_FORWARD_HORIZON_DAYS).toBe(182);
    expect(calendar().coverageEnd).toBe('2026-02-02');
    expect(calendar().dates).toEqual([E1, E2]); // 升序去重, 入参顺序不影响
  });

  it('建仓腿恒 null —— 含跨财报与超视野两种情形 (FR-023 建仓腿无标)', () => {
    for (const expiry of ['2025-08-15', '2025-10-17', '2027-01-15']) {
      expect(earningsMark(calendar(), expiry, 'build_position')).toBeNull();
    }
  });

  it('null (建仓腿按设计无标) 与 no_date (该打但不知道) 是两个值', () => {
    expect(earningsMark(calendar(), '2027-01-15', 'build_position')).toBeNull();
    expect(earningsMark(calendar(), '2027-01-15', 'rent_long')?.mark).toBe('no_date');
  });
});

describe('earnings-mark.rules — 无日期 MUST NOT 渲成不跨 (Guardrail 12, FR-026/034)', () => {
  it('到期日 529 天 (超 vendor 前向视野) → no_date, 而不是 no_cross', () => {
    const verdict = earningsMark(calendar(), '2027-01-15', 'rent_long');
    expect(verdict?.mark).toBe('no_date');
    expect(verdict?.mark).not.toBe('no_cross');
    expect(verdict?.lastEarningsDate).toBeNull();
  });

  it('覆盖窗右端当天仍在窗内, 右端后一天才落 no_date (边界不含糊)', () => {
    // 该标的有财报行但全在今天之前 ⇒ 窗内确认不跨, 于是右端两侧的差别只剩「在不在视野里」。
    const settled = earningsCalendarContext(PEP, TODAY, ['2025-07-30']);
    expect(earningsMark(settled, '2026-02-02', 'rent_long')?.mark).toBe('no_cross');
    expect(earningsMark(settled, '2026-02-03', 'rent_long')?.mark).toBe('no_date');
  });

  it('该标的零财报行 → no_date, 且与「已确认不跨」可区分', () => {
    const empty = earningsCalendarContext('us:VICI', TODAY, []);
    expect(earningsMark(empty, '2025-09-19', 'rent_long')?.mark).toBe('no_date');
    // 同一个到期日, 日历里有该标的的财报行 (只是窗口内没撞上) → 确认不跨。两者必须不同值。
    expect(earningsMark(calendar(), '2025-08-08', 'rent_long')?.mark).toBe('no_cross');
  });
});

describe('earnings-mark.rules — 缓冲只约束「最后利空 → 到期」一侧 (FR-024)', () => {
  it('到期日之后的财报不参与判定 —— 右侧零约束', () => {
    const withLater = earningsCalendarContext(PEP, TODAY, [E1, E2, '2025-09-20']);
    // 09-19 到期, 09-20 才发的财报在到期之后 ⇒ 最后利空仍是 E1, 缓冲仍 38 天。
    const verdict = earningsMark(withLater, '2025-09-19', 'rent_long');
    expect(verdict?.mark).toBe('covered');
    expect(verdict?.lastEarningsDate).toBe(E1);
  });

  it('今天之前已发的财报不参与判定 —— 左侧零约束', () => {
    const withPast = earningsCalendarContext(PEP, TODAY, ['2025-08-01', E1, E2]);
    expect(earningsMark(withPast, '2025-08-08', 'rent_long')?.mark).toBe('no_cross');
  });

  it('缓冲达标即 covered, 差一天即 buffer_short 且 N = 还差几天 (不是实际缓冲)', () => {
    const exact = earningsCalendarContext(PEP, TODAY, [E1]);
    const onFloor = `2025-08-${String(12 + EARNINGS_BUFFER_MIN_DAYS).padStart(2, '0')}`;
    const belowFloor = `2025-08-${String(11 + EARNINGS_BUFFER_MIN_DAYS).padStart(2, '0')}`;
    expect(earningsMark(exact, onFloor, 'rent_long')?.mark).toBe('covered');
    expect(earningsMark(exact, onFloor, 'rent_long')?.bufferShortfallDays).toBeNull();
    expect(earningsMark(exact, belowFloor, 'rent_long')).toEqual({
      mark: 'buffer_short',
      bufferShortfallDays: 1,
      lastEarningsDate: E1,
    });
  });

  it('收租短腿只看跨不跨, 不进缓冲算式 —— 同一到期日长腿算缓冲、短腿不算', () => {
    const short = earningsMark(calendar(), '2025-10-17', 'rent_short');
    const long = earningsMark(calendar(), '2025-10-17', 'rent_long');
    expect(short?.mark).toBe('crosses_earnings');
    expect(short?.bufferShortfallDays).toBeNull();
    expect(long?.mark).toBe('buffer_short');
    expect(long?.bufferShortfallDays).toBe(EARNINGS_BUFFER_MIN_DAYS - 3);
  });

  it('财报日恰好落在到期日 / 今天当天一律算跨 (闭区间两端都取)', () => {
    const sameDay = earningsCalendarContext(PEP, TODAY, [TODAY, '2025-09-19']);
    expect(earningsMark(sameDay, '2025-09-19', 'rent_short')?.mark).toBe('crosses_earnings');
    expect(earningsMark(sameDay, TODAY, 'rent_short')?.mark).toBe('crosses_earnings');
  });
});

describe('earnings-mark.rules — 同一到期日必同标是结构保证 (Guardrail 11, plan D-UI-4)', () => {
  // 一批**同到期日、不同合约**的行 —— 含 handoff §④ 里那两条死档行 (110P / 105P, FR-006 要求
  // 死档照常打标) 与一条 greeks 缺失行 (FR-007 要求留在表内)。
  const rows = [
    { strike: '117.5', expiryDate: '2025-08-15', tier: 'good' },
    { strike: '115', expiryDate: '2025-08-15', tier: 'thin' },
    { strike: '110', expiryDate: '2025-08-15', tier: 'dead' },
    { strike: '105', expiryDate: '2025-08-15', tier: 'dead' },
    { strike: '120', expiryDate: '2025-08-15', tier: null }, // greeks 缺失, 不判档
    { strike: '118', expiryDate: '2025-08-08', tier: 'dead' },
    { strike: '112', expiryDate: '2025-09-19', tier: 'good' },
  ];
  // 腿族只随到期日变 (短腿 / 长腿由 DTE 定), 拿不到 strike / tier —— 这是签名层面的保证。
  const familyByExpiry = (expiryDate: string): EarningsLegFamily =>
    expiryDate >= '2025-09-01' ? 'rent_long' : 'rent_short';

  it('同一到期日的多条腿拿到同一个标 —— 含死档行与 greeks 缺失行', () => {
    const marks = earningsMarksByExpiry(
      calendar(),
      rows.map((r) => r.expiryDate),
      familyByExpiry,
    );
    const stamped = rows.map((r) => ({ ...r, earningsMark: marks.get(r.expiryDate) }));

    const aug15 = stamped.filter((r) => r.expiryDate === '2025-08-15');
    expect(aug15).toHaveLength(5);
    for (const row of aug15) {
      // 同一个**对象引用** —— 不是「值恰好相等」, 是结构上只算了一次。
      expect(row.earningsMark).toBe(aug15[0].earningsMark);
      expect(row.earningsMark?.mark).toBe('crosses_earnings');
    }
    // 死档行与 greeks 缺失行都在结果里, 且与同到期日的好档行同标 (FR-006 / FR-007)。
    expect(stamped.filter((r) => r.tier === 'dead' && r.expiryDate === '2025-08-15')).toHaveLength(
      2,
    );
    expect(stamped.find((r) => r.tier === null)?.earningsMark?.mark).toBe('crosses_earnings');
  });

  it('mockup handoff §④ 那张表逐行回归 (含超视野那一行)', () => {
    const cal = calendar();
    expect(earningsMark(cal, '2025-08-08', 'rent_short')?.mark).toBe('no_cross');
    expect(earningsMark(cal, '2025-08-15', 'rent_short')?.mark).toBe('crosses_earnings');
    expect(earningsMark(cal, '2025-09-19', 'rent_long')).toEqual({
      mark: 'covered',
      bufferShortfallDays: null,
      lastEarningsDate: E1,
    });
    expect(earningsMark(cal, '2025-10-17', 'rent_long')?.mark).toBe('buffer_short');
    expect(earningsMark(cal, '2027-01-15', 'rent_long')?.mark).toBe('no_date');
  });

  it('重复到期日只算一次, Map 键即到期日', () => {
    const marks = earningsMarksByExpiry(
      calendar(),
      ['2025-08-15', '2025-08-15', '2025-09-19'],
      familyByExpiry,
    );
    expect([...marks.keys()]).toEqual(['2025-08-15', '2025-09-19']);
  });
});

/** 050 T012 —— 精排层特征集要的那个布尔项 (FR-019), 判据只读已算好的标。 */
describe('earnings-mark.rules — 跨不跨财报 (050 特征集的布尔项)', () => {
  it('三个「跨了」的标一律 true —— `covered` 也是跨了, 只是缓冲够', () => {
    const cal = calendar();
    expect(crossesEarnings(earningsMark(cal, '2025-09-19', 'rent_long'))).toBe(true); // covered
    expect(crossesEarnings(earningsMark(cal, '2025-10-17', 'rent_long'))).toBe(true); // buffer_short
    expect(crossesEarnings(earningsMark(cal, '2025-08-15', 'rent_short'))).toBe(true);
  });

  it('确认不跨 / 不知道 / 按设计不打标 三者在特征层合流为 false', () => {
    const cal = calendar();
    expect(crossesEarnings(earningsMark(cal, '2025-08-08', 'rent_short'))).toBe(false); // no_cross
    expect(crossesEarnings(earningsMark(cal, '2027-01-15', 'rent_long'))).toBe(false); // no_date
    // 建仓域按设计不打标 —— 呈现层三态要分开 (FR-026), 但归一化到 0/1 的特征没有第三格。
    expect(earningsMark(cal, '2025-08-15', 'build_position')).toBeNull();
    expect(crossesEarnings(null)).toBe(false);
  });
});

describe('earnings-mark.rules — 脏日期抛而非静默算错', () => {
  it('溢出日 / 非法格式一律抛 (Date.UTC 会把 02-30 静默滚到 03-02)', () => {
    expect(() => earningsCalendarContext(PEP, '2026-02-30', [])).toThrow(/2026-02-30/);
    expect(() => earningsCalendarContext(PEP, TODAY, ['2025/08/12'])).toThrow(/2025\/08\/12/);
    expect(() => earningsMark(calendar(), '20250815', 'rent_long')).toThrow(/20250815/);
  });
});
