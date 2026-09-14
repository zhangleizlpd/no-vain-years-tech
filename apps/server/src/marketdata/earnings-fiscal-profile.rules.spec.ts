import { describe, it, expect } from 'vitest';
import {
  findFiscalProfileTitleConflict,
  resolveFiscalProfile,
  type FiscalProfileAnnouncement,
  type FiscalProfileInput,
} from './earnings-fiscal-profile.rules.js';

const results = (date: string, title: string): FiscalProfileAnnouncement => ({
  date,
  title,
  types: ['fs_main'],
  link: `https://example.test/${date}`,
});

const dividend = (date: string, title: string): FiscalProfileAnnouncement => ({
  date,
  title,
  types: ['dividend'],
  link: null,
});

const input = (partial: Partial<FiscalProfileInput>): FiscalProfileInput => ({
  announcements: [],
  boardListRows: [],
  futuObservations: [],
  ...partial,
});

describe('resolveFiscalProfile — 四路反推, 各路一致才出值 (FR-026, plan §D13)', () => {
  it('年度业绩标题 + 年度股息 + 清单年度行 一致 12 月 ⇒ 出值, source 取最优先的 annual_title', () => {
    const r = resolveFiscalProfile(
      input({
        announcements: [
          results('2025-03-20', '截至2024年12月31日止年度之業績公告'),
          dividend('2025-03-20', '截至2024年12月31日止年度的末期股息'),
        ],
        boardListRows: [
          { periodText: '年度31/12/25', periodEnd: '2025-12-31', evidence: '10/09/2026' },
        ],
      }),
    );
    expect(r).toMatchObject({ month: 12, source: 'annual_title' });
    expect('evidence' in r && r.evidence).toContain('截至2024年12月31日止年度之業績公告');
    expect('evidence' in r && r.evidence).toContain('board_list');
  });

  it.each([
    [
      'dividend_title',
      input({ announcements: [dividend('2025-06-20', '截至2025年3月31日止年度的末期股息')] }),
      3,
    ],
    [
      'board_list',
      input({
        boardListRows: [{ periodText: '年度30/06/25', periodEnd: '2025-06-30', evidence: null }],
      }),
      6,
    ],
    [
      'futu_pairing',
      input({
        announcements: [results('2025-08-29', '截至2025年6月30日止三個月之業績公告')],
        futuObservations: [{ periodText: '2026Q1', earningsDate: '2025-08-29' }],
      }),
      3,
    ],
  ])('只有 %s 一路 ⇒ 出值且 source = 该路', (source, given, month) => {
    expect(resolveFiscalProfile(given)).toMatchObject({ month, source });
  });

  it('年度业绩标题 12 月 vs 年度股息 6 月 ⇒ conflict, 🚫 择一', () => {
    const r = resolveFiscalProfile(
      input({
        announcements: [
          results('2025-03-20', '截至2024年12月31日止年度之業績公告'),
          dividend('2025-09-20', '截至2025年6月30日止年度的末期股息'),
        ],
      }),
    );
    expect(r).toMatchObject({ pending: 'conflict' });
    expect('detail' in r && r.detail).toContain('12 月');
    expect('detail' in r && r.detail).toContain('6 月');
  });

  it('富途配对内部矛盾 ⇒ conflict', () => {
    expect(
      resolveFiscalProfile(
        input({
          announcements: [
            results('2025-08-29', '截至2025年6月30日止三個月之業績公告'),
            results('2026-08-20', '截至2026年6月30日止六個月之中期業績公告'),
          ],
          futuObservations: [
            { periodText: '2026Q1', earningsDate: '2025-08-29' },
            { periodText: '2026Q2', earningsDate: '2026-08-20' },
          ],
        }),
      ),
    ).toMatchObject({ pending: 'conflict' });
  });

  it('全无 ⇒ none (🚫 代入 12)', () => {
    expect(resolveFiscalProfile(input({}))).toMatchObject({ pending: 'none' });
  });

  it('「截至2025年6月30日止半年度業績」是中期, 不作年度业绩标题来源 ⇒ none (反之会推成 6 月)', () => {
    expect(
      resolveFiscalProfile(
        input({ announcements: [results('2025-08-26', '截至2025年6月30日止半年度業績公告')] }),
      ),
    ).toMatchObject({ pending: 'none' });
  });

  it('「截至2024年6月30日止六個月的中期股息（更新）」不作来源 (hk:02628 形态)', () => {
    expect(
      resolveFiscalProfile(
        input({
          announcements: [dividend('2025-03-20', '截至2024年6月30日止六個月的中期股息（更新）')],
        }),
      ),
    ).toMatchObject({ pending: 'none' });
  });

  it('年度股息标题含「更新」即使类型对得上也不作来源', () => {
    expect(
      resolveFiscalProfile(
        input({
          announcements: [dividend('2025-09-20', '截至2025年6月30日止年度的末期股息（更新）')],
        }),
      ),
    ).toMatchObject({ pending: 'none' });
  });

  it('清单非「年度」行 (6 個月) 不作来源', () => {
    expect(
      resolveFiscalProfile(
        input({
          boardListRows: [
            { periodText: '截至30/06/26止6個月', periodEnd: '2026-06-30', evidence: null },
          ],
        }),
      ),
    ).toMatchObject({ pending: 'none' });
  });

  it('富途与刊发公布日相差 2 天 ⇒ 不配对 ⇒ none', () => {
    expect(
      resolveFiscalProfile(
        input({
          announcements: [results('2025-08-31', '截至2025年6月30日止三個月之業績公告')],
          futuObservations: [{ periodText: '2026Q1', earningsDate: '2025-08-29' }],
        }),
      ),
    ).toMatchObject({ pending: 'none' });
  });

  it('同一路多期取最近一期 (公司改财年: 2023-12 → 2025-06)', () => {
    expect(
      resolveFiscalProfile(
        input({
          announcements: [
            results('2024-03-20', '截至2023年12月31日止年度之業績公告'),
            results('2025-09-20', '截至2025年6月30日止年度之業績公告'),
          ],
        }),
      ),
    ).toMatchObject({ month: 6, source: 'annual_title' });
  });
});

describe('findFiscalProfileTitleConflict — 年度业绩标题与既有档案矛盾 ⇒ 告警不覆盖 (FR-026)', () => {
  it('档案 12 月, 最近年度业绩标题期末 2025-06-30 ⇒ 矛盾', () => {
    expect(
      findFiscalProfileTitleConflict(12, [
        results('2024-03-20', '截至2023年12月31日止年度之業績公告'),
        results('2025-09-20', '截至2025年6月30日止年度之業績公告'),
      ]),
    ).toMatchObject({ titleMonth: 6 });
  });

  it('一致 / 无年度业绩标题 ⇒ null', () => {
    expect(
      findFiscalProfileTitleConflict(12, [
        results('2025-03-20', '截至2024年12月31日止年度之業績公告'),
      ]),
    ).toBeNull();
    expect(
      findFiscalProfileTitleConflict(12, [results('2025-08-26', '二零二五年中期業績公告')]),
    ).toBeNull();
  });
});
