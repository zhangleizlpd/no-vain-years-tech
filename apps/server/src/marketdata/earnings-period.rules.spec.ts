import { describe, it, expect } from 'vitest';
import {
  alignedPeriodKey,
  datePeriodKey,
  fiscalQuarterOf,
  fiscalYearEndMonthFromFutuPair,
  isAlignedPeriodKey,
  parseAnnouncementTitlePeriod,
  parseDayMonthYear,
  resolveAnnouncementPeriod,
  resolveBoardListPeriod,
  resolveFutuPeriod,
  textPeriodKey,
} from './earnings-period.rules.js';

const BOARD = 'hkex_board_meeting_list';
const FUTU = 'futu_calendar';

describe('period_key 三形态 (plan §D3)', () => {
  it('P: / T: / D: 形态与只有 P: 可跨来源对齐', () => {
    expect(alignedPeriodKey('2026-06-30')).toBe('P:2026-06-30');
    expect(textPeriodKey(FUTU, '2027Q1')).toBe('T:futu_calendar:2027Q1');
    expect(datePeriodKey(FUTU, '2026-08-20')).toBe('D:futu_calendar:2026-08-20');
    expect(isAlignedPeriodKey('P:2026-06-30')).toBe(true);
    expect(isAlignedPeriodKey('T:futu_calendar:2027Q1')).toBe(false);
    expect(isAlignedPeriodKey('D:futu_calendar:2026-08-20')).toBe(false);
  });
});

describe('parseDayMonthYear — 🚨 日/月/年 顺序 + 两位年份 = 20YY (FR-006)', () => {
  it('10/09/26 ⇒ 2026-09-10 (按「月/日」读会变成 10 月 9 日且不报错)', () => {
    expect(parseDayMonthYear('10/09/26')).toBe('2026-09-10');
  });

  it('四位年份的页首日期同样按 日/月/年', () => {
    expect(parseDayMonthYear('10/09/2026')).toBe('2026-09-10');
  });

  it('两位年份一律 20YY (99 ⇒ 2099 而非 1999)', () => {
    expect(parseDayMonthYear('31/12/99')).toBe('2099-12-31');
  });

  it('日 > 12 的日期只有 日/月 顺序解析得通', () => {
    expect(parseDayMonthYear('30/06/24')).toBe('2024-06-30');
  });

  it.each([
    ['2 月 30 日不存在', '30/02/26'],
    ['非闰年 2 月 29 日', '29/02/25'],
    ['月份 13', '01/13/26'],
    ['日为 00', '00/01/26'],
    ['单位数日月', '1/9/26'],
    ['ISO 写法', '2026-09-10'],
    ['空串', ''],
  ])('非法 (%s) ⇒ null', (_label, raw) => {
    expect(parseDayMonthYear(raw)).toBeNull();
  });

  it('闰年 2 月 29 日合法', () => {
    expect(parseDayMonthYear('29/02/24')).toBe('2024-02-29');
  });
});

describe('resolveBoardListPeriod — 清单「期間」× 「目的」→ 报告期 (plan §D4)', () => {
  it.each([
    ['截至30/06/26止6個月', '中期業績/股息', 'P:2026-06-30', '2026-06-30', 'interim'],
    ['截至31/03/24止3個月', '業績', 'P:2024-03-31', '2024-03-31', 'quarterly'],
    ['截至30/09/25止9個月', '業績', 'P:2025-09-30', '2025-09-30', 'quarterly'],
    ['截至31/12/25止12個月', '業績', 'P:2025-12-31', '2025-12-31', 'annual'],
    ['年度31/03/25', '末期業績/股息', 'P:2025-03-31', '2025-03-31', 'annual'],
    ['年度30/06/26', '業績', 'P:2026-06-30', '2026-06-30', 'annual'],
    ['截至31/03/24止季度', '業績', 'P:2024-03-31', '2024-03-31', 'quarterly'],
    ['截至30/06/24期間', '中期業績/股息', 'P:2024-06-30', '2024-06-30', 'interim'],
    ['由01/01/24至30/06/24', '中期業績', 'P:2024-06-30', '2024-06-30', 'interim'],
    ['由01/01/25至31/12/25', '末期業績', 'P:2025-12-31', '2025-12-31', 'annual'],
  ])('%s + %s ⇒ %s', (period, purpose, key, end, kind) => {
    expect(resolveBoardListPeriod(BOARD, period, purpose)).toEqual({
      periodKey: key,
      periodEnd: end,
      reportKind: kind,
      nonStandardMonths: false,
    });
  });

  it('其他 N 個月 (15, 停牌补批) ⇒ 年度 + nonStandardMonths 计数', () => {
    expect(resolveBoardListPeriod(BOARD, '截至31/12/25止15個月', '業績')).toEqual({
      periodKey: 'P:2025-12-31',
      periodEnd: '2025-12-31',
      reportKind: 'annual',
      nonStandardMonths: true,
    });
  });

  it('「截至…期間」且目的无季度 / 中期 / 末期字样 ⇒ 期末日有、类型不可判 (null)', () => {
    expect(resolveBoardListPeriod(BOARD, '截至30/06/24期間', '業績')).toMatchObject({
      periodKey: 'P:2024-06-30',
      reportKind: null,
    });
  });

  it('「由…至…」且目的无字样 ⇒ 类型按跨越月数换算 (3 個月 ⇒ 季度)', () => {
    expect(resolveBoardListPeriod(BOARD, '由01/01/24至31/03/24', '業績')).toMatchObject({
      periodKey: 'P:2024-03-31',
      reportKind: 'quarterly',
    });
  });

  it('「YYYY年第N季」⇒ 公司财年未知, 无期末日 ⇒ T: 键', () => {
    expect(resolveBoardListPeriod(BOARD, '2024年第一季', '業績')).toEqual({
      periodKey: 'T:hkex_board_meeting_list:2024年第一季',
      periodEnd: null,
      reportKind: 'quarterly',
      nonStandardMonths: false,
    });
  });

  it('期间空白 ⇒ T: 键, 类型取目的', () => {
    expect(resolveBoardListPeriod(BOARD, '', '第一季業績')).toEqual({
      periodKey: 'T:hkex_board_meeting_list:',
      periodEnd: null,
      reportKind: 'quarterly',
      nonStandardMonths: false,
    });
  });

  it('目的只看业绩段: 「末期業績/中期息」⇒ 年度 (股息段的「中期」不参与)', () => {
    expect(resolveBoardListPeriod(BOARD, '年度31/12/25', '末期業績/中期息')).toMatchObject({
      reportKind: 'annual',
    });
  });

  it('目的只看业绩段: 「業績/季度股息」+ 6 個月 ⇒ 中期 (股息段的「季」不参与)', () => {
    expect(resolveBoardListPeriod(BOARD, '截至30/06/26止6個月', '業績/季度股息')).toMatchObject({
      reportKind: 'interim',
    });
  });

  it('「季度收益資料」算季度', () => {
    expect(resolveBoardListPeriod(BOARD, '截至31/03/24止3個月', '季度收益資料')).toMatchObject({
      periodKey: 'P:2024-03-31',
      reportKind: 'quarterly',
    });
  });

  it('期间里的两位年份 = 20YY、日/月 顺序 (10/09/26 ⇒ 2026-09-10)', () => {
    expect(resolveBoardListPeriod(BOARD, '年度10/09/26', '末期業績')).toMatchObject({
      periodKey: 'P:2026-09-10',
    });
  });
});

describe('parseAnnouncementTitlePeriod — 交易所业绩公告标题 → 期末日 (plan §D4)', () => {
  it.each([
    ['截至2026年6月30日止六個月的中期業績公告及授出獎勵之補充公告', '2026-06-30', 'interim'],
    ['截至二零二六年六月三十日止六個月', '2026-06-30', 'interim'],
    ['截至二零二四年十二月三十一日止年度全年業績公佈', '2024-12-31', 'annual'],
    ['截至2024年12月31日止年度之業績', '2024-12-31', 'annual'],
    ['截至2025年3月31日止三個月的未經審計業績公告', '2025-03-31', 'quarterly'],
    ['截至2025年 9 月 30日止三個月及九個月之業績公告', '2025-09-30', 'quarterly'],
    ['截至2025年6月30日止三個月及六個月的業績公告及宣派特別股息', '2025-06-30', 'interim'],
    ['截至2025年6月30日止6個月的未經審計業績公告', '2025-06-30', 'interim'],
    ['截至2025年6月30日止之中期業績公佈', '2025-06-30', 'interim'],
    ['二零二五年六月三十日止六個月之中期業績', '2025-06-30', 'interim'],
    [
      '2024年12月31日止第四季度及財政年度未經審計的財務業績公告及第四季度股息公告',
      '2024-12-31',
      'annual',
    ],
    ['2025年3月31日止第一季度業績公告及第一季度股息公告', '2025-03-31', 'quarterly'],
    ['2025年六月底止季度業績公告', '2025-06-30', 'quarterly'],
    ['2024年十二月底止季度業績公告', '2024-12-31', 'quarterly'],
    // 🚨 先认「半年度」再认「年度」(FR-027)
    ['截至2025年6月30日止半年度業績', '2025-06-30', 'interim'],
  ])('%s ⇒ %s / %s', (title, end, kind) => {
    expect(parseAnnouncementTitlePeriod(title)).toEqual({ periodEnd: end, reportKind: kind });
  });

  it.each([
    ['无显式期末日的季报', '2025年第一季度報告'],
    ['无显式期末日的年度业绩', '2024年度業績公告'],
    ['通知类标题', '董事會會議召開日期'],
    ['日期不存在', '截至2026年2月30日止六個月的中期業績公告'],
  ])('%s ⇒ null (不猜)', (_label, title) => {
    expect(parseAnnouncementTitlePeriod(title)).toBeNull();
  });
});

const pair = (
  futuPeriodText: string,
  futuDate: string,
  filingDate: string,
  filingPeriodEnd: string,
) => ({
  futuPeriodText,
  futuDate,
  filingDate,
  filingPeriodEnd,
});

describe('fiscalYearEndMonthFromFutuPair — 单条富途配对反推财年结束月 (档案 futu_pairing 路)', () => {
  it('阿里 2026Q1 @2025-08-29 ↔ 刊发 2025-08-29 截至 2025-06-30 ⇒ 3 月', () => {
    expect(
      fiscalYearEndMonthFromFutuPair(pair('2026Q1', '2025-08-29', '2025-08-29', '2025-06-30')),
    ).toBe(3);
  });

  it('公布日相差 1 天仍可配对', () => {
    expect(
      fiscalYearEndMonthFromFutuPair(pair('2024Q4', '2024-09-03', '2024-09-04', '2024-06-30')),
    ).toBe(6);
  });

  it('公布日相差 2 天 ⇒ 不配对 ⇒ null', () => {
    expect(
      fiscalYearEndMonthFromFutuPair(pair('2024Q4', '2024-09-03', '2024-09-05', '2024-06-30')),
    ).toBeNull();
  });

  it('标签年份与期末日推不出 1–12 月 ⇒ null', () => {
    expect(
      fiscalYearEndMonthFromFutuPair(pair('2026Q1', '2026-08-20', '2026-08-20', '2026-06-30')),
    ).toBeNull();
  });
});

describe('resolveAnnouncementPeriod — 标题不带期末日: 年份 + 类型 + 财年档案 + 刊发时限 (FR-027)', () => {
  it.each([
    ['12 月结年 中期', '二零二五年中期業績公告', '2025-08-26', 12, '2025-06-30', 'interim'],
    [
      '3 月结年 中期 (hk:01429 形态)',
      '二零二四年中期業績公告',
      '2024-11-29',
      3,
      '2024-09-30',
      'interim',
    ],
    ['12 月结年 年度', '2024年度業績公告', '2025-03-20', 12, '2024-12-31', 'annual'],
    [
      '季报期末后 50 天 (hk:09961 形态)',
      '2025年第一季度業績公告',
      '2025-05-20',
      12,
      '2025-03-31',
      'quarterly',
    ],
    ['3 月结年 第三季', '2025年第三季度業績公告', '2026-02-10', 3, '2025-12-31', 'quarterly'],
    ['跨年写法只取财年结束年', '2024/25年度中期業績公告', '2024-11-20', 3, '2024-09-30', 'interim'],
  ])('%s: %s @%s 财年 %i 月结 ⇒ %s', (_label, title, date, fy, end, kind) => {
    expect(
      resolveAnnouncementPeriod(title, { announceDate: date, fiscalYearEndMonth: fy }),
    ).toEqual({
      periodEnd: end,
      reportKind: kind,
    });
  });

  it('期末后 6 个月的延期年度业绩 ⇒ null (超时限, 调用方落 D:)', () => {
    expect(
      resolveAnnouncementPeriod('2024年度業績公告', {
        announceDate: '2025-06-30',
        fiscalYearEndMonth: 12,
      }),
    ).toBeNull();
  });

  it('刊发日早于或等于候选期末日 ⇒ null (区间左开)', () => {
    expect(
      resolveAnnouncementPeriod('二零二五年中期業績公告', {
        announceDate: '2025-06-30',
        fiscalYearEndMonth: 12,
      }),
    ).toBeNull();
  });

  it('🚫 财年未知 ⇒ null, 不代入 12', () => {
    expect(
      resolveAnnouncementPeriod('二零二五年中期業績公告', {
        announceDate: '2025-08-26',
        fiscalYearEndMonth: null,
      }),
    ).toBeNull();
  });

  it('标题带显式期末日 ⇒ 直接取, 与财年档案无关', () => {
    expect(
      resolveAnnouncementPeriod('截至2025年6月30日止半年度業績公告', {
        announceDate: '2025-08-26',
        fiscalYearEndMonth: null,
      }),
    ).toEqual({ periodEnd: '2025-06-30', reportKind: 'interim' });
  });

  it.each([
    ['认不出类型', '2025年業務更新'],
    ['无年份', '中期業績公告'],
  ])('%s ⇒ null', (_label, title) => {
    expect(
      resolveAnnouncementPeriod(title, { announceDate: '2025-08-26', fiscalYearEndMonth: 12 }),
    ).toBeNull();
  });
});

describe('resolveFutuPeriod — 富途 period_text 按公司财年换算 (plan §D4)', () => {
  it('阿里 2027Q1 (财年 3 月结) ⇒ 截至 2026-06-30', () => {
    expect(
      resolveFutuPeriod(FUTU, {
        market: 'hk',
        periodText: '2027Q1',
        earningsDate: '2026-08-28',
        fiscalYearEndMonth: 3,
      }),
    ).toEqual({ periodKey: 'P:2026-06-30', periodEnd: '2026-06-30', reportKind: 'quarterly' });
  });

  it.each([
    ['2026Q2', 3, 'P:2025-09-30', 'interim'],
    ['2026Q3', 3, 'P:2025-12-31', 'quarterly'],
    ['2026Q4', 3, 'P:2026-03-31', 'annual'],
    ['2024Q4', 6, 'P:2024-06-30', 'annual'],
    ['2026Q2', 12, 'P:2026-06-30', 'interim'],
  ])('%s 财年 %i 月结 ⇒ %s', (text, fy, key, kind) => {
    expect(
      resolveFutuPeriod(FUTU, {
        market: 'hk',
        periodText: text,
        earningsDate: '2026-01-01',
        fiscalYearEndMonth: fy,
      }),
    ).toMatchObject({ periodKey: key, reportKind: kind });
  });

  it('🚫 财年未知 ⇒ T: 键, 不默认 12 月结年', () => {
    expect(
      resolveFutuPeriod(FUTU, {
        market: 'hk',
        periodText: '2027Q1',
        earningsDate: '2026-08-28',
        fiscalYearEndMonth: null,
      }),
    ).toEqual({ periodKey: 'T:futu_calendar:2027Q1', periodEnd: null, reportKind: 'quarterly' });
  });

  it('美股一律 T: 键 (即使给了财年)', () => {
    expect(
      resolveFutuPeriod(FUTU, {
        market: 'us',
        periodText: '2026Q3',
        earningsDate: '2026-10-20',
        fiscalYearEndMonth: 12,
      }),
    ).toMatchObject({ periodKey: 'T:futu_calendar:2026Q3', periodEnd: null });
  });

  it('非 YYYYQn 原文 ⇒ T: 键保留原文', () => {
    expect(
      resolveFutuPeriod(FUTU, {
        market: 'hk',
        periodText: 'FY2026 H1',
        earningsDate: '2026-08-20',
        fiscalYearEndMonth: 12,
      }),
    ).toEqual({ periodKey: 'T:futu_calendar:FY2026 H1', periodEnd: null, reportKind: null });
  });

  it.each([
    ['null', null],
    ['空白', '  '],
    ['N/A 哨兵', 'N/A'],
  ])('原文缺失 (%s) ⇒ 兜底 D:<来源>:<日期>', (_label, text) => {
    expect(
      resolveFutuPeriod(FUTU, {
        market: 'hk',
        periodText: text,
        earningsDate: '2026-08-20',
        fiscalYearEndMonth: 12,
      }),
    ).toEqual({ periodKey: 'D:futu_calendar:2026-08-20', periodEnd: null, reportKind: null });
  });
});

describe('跨来源同一次财报落同一 P: 键 (FR-015)', () => {
  it('自然年公司: 富途 2026Q2 / 清单「截至30/06/26止6個月」/ 公告「截至二零二六年六月三十日止六個月」', () => {
    const futu = resolveFutuPeriod(FUTU, {
      market: 'hk',
      periodText: '2026Q2',
      earningsDate: '2026-08-20',
      // 财年档案值 (earnings_fiscal_profile)。
      fiscalYearEndMonth: 12,
    });
    const board = resolveBoardListPeriod(BOARD, '截至30/06/26止6個月', '中期業績');
    const title = parseAnnouncementTitlePeriod('截至二零二六年六月三十日止六個月的中期業績公告');

    expect(title).not.toBeNull();
    const announcementKey = alignedPeriodKey(title!.periodEnd);
    expect(futu.periodKey).toBe('P:2026-06-30');
    expect(board.periodKey).toBe(futu.periodKey);
    expect(announcementKey).toBe(futu.periodKey);
    expect(isAlignedPeriodKey(futu.periodKey)).toBe(true);
  });
});

describe('fiscalQuarterOf — 期末日按财年档案换算财季 (FR-029, spec Session（八）1b)', () => {
  it.each([
    [12, '2025-03-31', 1],
    [12, '2025-06-30', 2],
    [12, '2025-09-30', 3],
    [12, '2025-12-31', 4],
    [3, '2025-06-30', 1],
    [3, '2025-09-30', 2],
    [3, '2025-12-31', 3],
    [3, '2026-03-31', 4],
    [6, '2025-09-30', 1],
    [6, '2026-03-31', 3],
  ])('财年结束月 %i、期末 %s ⇒ 第 %i 财季', (fiscalYearEndMonth, periodEnd, quarter) => {
    expect(fiscalQuarterOf(periodEnd, fiscalYearEndMonth)).toBe(quarter);
  });

  it.each([
    ['期末月不在财季边界', '2025-08-31', 12],
    ['日历上不存在的日期', '2025-02-30', 12],
    ['非 YYYY-MM-DD', '30/09/25', 12],
    ['财年结束月越界', '2025-09-30', 13],
  ])('%s (%s, 财年结束月 %i) ⇒ null', (_label, periodEnd, fiscalYearEndMonth) => {
    expect(fiscalQuarterOf(periodEnd, fiscalYearEndMonth)).toBeNull();
  });
});
