import { describe, it, expect } from 'vitest';
import type {
  EarningsDateSourceCapabilities,
  EarningsNoticeSignal,
} from './earnings-date-source.port.js';
import {
  NOTICE_MATCH_WINDOW_DAYS,
  mergeEarningsDateEvent,
  type EarningsDateMergeInput,
  type EarningsDateMergeObservation,
  type ExistingEarningsDateEvent,
} from './earnings-date-merge.rules.js';

const FUTU = 'futu_calendar';
const BOARD = 'hkex_board_meeting_list';
const ANN = 'hkex_announcement';

const announcedOnly: EarningsDateSourceCapabilities = {
  forward: 'announced_only',
  confirmationSignal: false,
  publicationFact: false,
};
const HK_CAPS: ReadonlyMap<string, EarningsDateSourceCapabilities | null> = new Map([
  [FUTU, announcedOnly],
  [BOARD, announcedOnly],
  [ANN, { forward: null, confirmationSignal: true, publicationFact: true }],
]);
const US_CAPS: ReadonlyMap<string, EarningsDateSourceCapabilities | null> = new Map([
  [FUTU, { forward: 'unconfirmed', confirmationSignal: false, publicationFact: false }],
]);

function obs(
  source: string,
  basis: EarningsDateMergeObservation['basis'],
  fields: Partial<Omit<EarningsDateMergeObservation, 'source' | 'basis'>>,
): EarningsDateMergeObservation {
  return {
    source,
    basis,
    announceDate: null,
    meetingDate: null,
    filedDate: null,
    publicationTime: null,
    firstSeenDate: '2026-01-01',
    ...fields,
  };
}

const structured = (date: string, firstSeenDate = date, source = FUTU) =>
  obs(source, 'structured', { announceDate: date, firstSeenDate });
const meeting = (date: string, firstSeenDate = date, source = BOARD) =>
  obs(source, 'meeting', { meetingDate: date, firstSeenDate });
const filed = (date: string) =>
  obs(ANN, 'filed', { filedDate: date, announceDate: date, firstSeenDate: date });
const notice = (noticeDate: string): EarningsNoticeSignal => ({
  instrumentId: 857n,
  noticeDate,
  title: '董事會會議召開日期',
  link: `notice:${noticeDate}`,
});

function input(overrides: Partial<EarningsDateMergeInput>): EarningsDateMergeInput {
  return {
    periodKey: 'P:2026-06-30',
    observations: [],
    capabilities: HK_CAPS,
    meetingLagDays: null,
    noticeSignals: [],
    previousFilingDate: null,
    existing: null,
    ...overrides,
  };
}

const confirmedAt = (
  confirmedDate: string,
  confirmedBasis: 'announced' | 'first_seen',
): ExistingEarningsDateEvent => ({
  status: 'confirmed',
  announceDate: '2026-08-28',
  announceBasis: 'structured',
  conflictCandidates: null,
  confirmedDate,
  confirmedBasis,
});

describe('公布日取值: 口径优先级 filed > explicit > structured > meeting (FR-008 / FR-009 / FR-010)', () => {
  it('US1 AS1: 清单会议日 M + 富途 D + 会前通知 ⇒ 公布日 D、口径结构化、确认日 = 通知刊发日, M 留痕', () => {
    const r = mergeEarningsDateEvent(
      input({
        observations: [meeting('2026-08-27', '2026-08-15'), structured('2026-08-28', '2026-08-16')],
        noticeSignals: [notice('2026-08-14')],
      }),
    );

    expect(r.event).toMatchObject({
      status: 'confirmed',
      announceDate: '2026-08-28',
      announceBasis: 'structured',
      conflictCandidates: null,
      confirmedDate: '2026-08-14',
      confirmedBasis: 'announced',
      sources: [FUTU, BOARD].sort(),
    });
    const valueLog = r.logs.find((l) => l.kind === 'value_changed');
    expect(valueLog?.detail).toMatchObject({
      reason: 'approx_within_1_day',
      candidates: expect.arrayContaining([{ source: BOARD, basis: 'meeting', date: '2026-08-27' }]),
    });
    expect(r.findings).toEqual([]);
  });

  it.each([
    ['无历史间隔 (null) 按 0 天', null],
    ['历史间隔 0 天', 0],
  ])('US1 AS2: 只有清单会议日 M, %s ⇒ 公布日 = M、口径会议日推定', (_label, lag) => {
    const r = mergeEarningsDateEvent(
      input({ observations: [meeting('2026-08-20')], meetingLagDays: lag }),
    );
    expect(r.event).toMatchObject({ announceDate: '2026-08-20', announceBasis: 'meeting' });
  });

  it('US1 AS3 (hk:00857 形态): 会议日 2026-08-28 周五 + 间隔 2 ⇒ 2026-08-30 (周日照记); 富途 08-28 = 会议日 ⇒ 可解释差异, 留痕不告警', () => {
    const r = mergeEarningsDateEvent(
      input({
        observations: [meeting('2026-08-28'), structured('2026-08-28')],
        meetingLagDays: 2,
      }),
    );

    expect(r.event).toMatchObject({
      status: 'confirmed',
      announceDate: '2026-08-30',
      announceBasis: 'meeting',
      conflictCandidates: null,
    });
    expect(r.logs.find((l) => l.kind === 'value_changed')?.detail).toMatchObject({
      reason: 'explainable_meeting_lag',
      candidates: expect.arrayContaining([
        { source: FUTU, basis: 'structured', date: '2026-08-28' },
      ]),
    });
    expect(r.findings).toEqual([]);
  });

  it('US1 AS4: 只有富途 D、无会前通知 ⇒ 口径结构化, 确认日 = 来源首次观测的当地日期 (first_seen)', () => {
    const r = mergeEarningsDateEvent(
      input({ observations: [structured('2026-09-16', '2026-09-02')] }),
    );
    expect(r.event).toMatchObject({
      status: 'confirmed',
      announceDate: '2026-09-16',
      announceBasis: 'structured',
      confirmedDate: '2026-09-02',
      confirmedBasis: 'first_seen',
    });
  });

  it('US2 AS1: 刊发事实 08-20 vs 结构化 08-19 ⇒ 取刊发事实 08-20, 差异留痕, 不告警', () => {
    const r = mergeEarningsDateEvent(
      input({ observations: [structured('2026-08-19'), filed('2026-08-20')] }),
    );
    expect(r.event).toMatchObject({ announceDate: '2026-08-20', announceBasis: 'filed' });
    expect(r.event.status).not.toBe('conflict');
    expect(r.logs.find((l) => l.kind === 'value_changed')?.detail).toMatchObject({
      reason: 'exact_priority',
      candidates: expect.arrayContaining([
        { source: FUTU, basis: 'structured', date: '2026-08-19' },
      ]),
    });
    expect(r.findings).toEqual([]);
  });

  it('US2 AS2: 两个精确口径 11-12 / 11-13 ⇒ 冲突, 全部日期保留, 产出冲突 finding', () => {
    const r = mergeEarningsDateEvent(
      input({
        observations: [
          obs('source_x', 'explicit', { announceDate: '2026-11-12' }),
          obs('source_y', 'explicit', { announceDate: '2026-11-13' }),
        ],
      }),
    );

    const candidates = [
      { source: 'source_x', basis: 'explicit', date: '2026-11-12' },
      { source: 'source_y', basis: 'explicit', date: '2026-11-13' },
    ];
    expect(r.event).toMatchObject({
      status: 'conflict',
      announceDate: null,
      announceBasis: null,
      conflictCandidates: candidates,
    });
    expect(r.findings).toEqual([
      {
        kind: 'notice',
        step: 'earnings_date_conflict',
        countsAsFailure: false,
        detail: { periodKey: 'P:2026-06-30', candidates },
      },
    ]);
  });

  it('US2 AS3: 会议日推定 11-14 (间隔 0) vs 结构化 11-11 ⇒ 差 3 天且结构化 ≠ 会议日 ⇒ 冲突', () => {
    const r = mergeEarningsDateEvent(
      input({ observations: [meeting('2026-11-14'), structured('2026-11-11')], meetingLagDays: 0 }),
    );
    expect(r.event.status).toBe('conflict');
    expect(r.findings.map((f) => f.step)).toEqual(['earnings_date_conflict']);
  });

  it('US2 AS3: 会议日推定 11-14 vs 结构化 11-15 (差 1 天) ⇒ 按优先级取结构化, 不告警', () => {
    const r = mergeEarningsDateEvent(
      input({ observations: [meeting('2026-11-14'), structured('2026-11-15')], meetingLagDays: 0 }),
    );
    expect(r.event).toMatchObject({
      status: 'confirmed',
      announceDate: '2026-11-15',
      announceBasis: 'structured',
    });
    expect(r.findings).toEqual([]);
  });

  it('hk:00960 形态: 清单 03-28 vs 富途 03-31、无历史间隔可解释 ⇒ 冲突', () => {
    const r = mergeEarningsDateEvent(
      input({ observations: [meeting('2026-03-28'), structured('2026-03-31')] }),
    );
    expect(r.event.status).toBe('conflict');
    expect(r.event.conflictCandidates).toEqual([
      { source: FUTU, basis: 'structured', date: '2026-03-31' },
      { source: BOARD, basis: 'meeting', date: '2026-03-28' },
    ]);
  });

  it('冲突 finding 只在迁入 conflict 时产出: 既有已是 conflict 再算一轮 ⇒ 状态不变、0 条 finding', () => {
    const r = mergeEarningsDateEvent(
      input({
        observations: [meeting('2026-03-28'), structured('2026-03-31')],
        existing: {
          status: 'conflict',
          announceDate: null,
          announceBasis: null,
          conflictCandidates: [
            { source: FUTU, basis: 'structured', date: '2026-03-31' },
            { source: BOARD, basis: 'meeting', date: '2026-03-28' },
          ],
          confirmedDate: '2026-03-20',
          confirmedBasis: 'first_seen',
        },
      }),
    );
    expect(r.event.status).toBe('conflict');
    expect(r.findings).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  it('冲突后来源重新一致 ⇒ 解除, 流水带解除前的全部候选日期', () => {
    const previous = [
      { source: FUTU, basis: 'structured' as const, date: '2026-03-31' },
      { source: BOARD, basis: 'meeting' as const, date: '2026-03-28' },
    ];
    const r = mergeEarningsDateEvent(
      input({
        observations: [meeting('2026-03-28'), structured('2026-03-28')],
        existing: {
          status: 'conflict',
          announceDate: null,
          announceBasis: null,
          conflictCandidates: previous,
          confirmedDate: '2026-03-20',
          confirmedBasis: 'first_seen',
        },
      }),
    );
    expect(r.event).toMatchObject({ status: 'confirmed', conflictCandidates: null });
    expect(r.logs.find((l) => l.kind === 'status_changed')).toMatchObject({
      fromStatus: 'conflict',
      toStatus: 'confirmed',
      detail: { resolvedCandidates: previous },
    });
  });

  it('FR-001: 规则不看来源名 —— 换任意来源名, 事件取值与状态不变', () => {
    const caps = new Map([
      ['source_a', announcedOnly],
      ['source_b', announcedOnly],
    ]);
    const r = mergeEarningsDateEvent(
      input({
        observations: [
          meeting('2026-08-28', '2026-08-18', 'source_a'),
          structured('2026-08-28', '2026-08-18', 'source_b'),
        ],
        capabilities: caps,
        meetingLagDays: 2,
      }),
    );
    expect(r.event).toMatchObject({
      status: 'confirmed',
      announceDate: '2026-08-30',
      announceBasis: 'meeting',
      sources: ['source_a', 'source_b'],
    });
  });

  it('非法日期 ⇒ 抛错 (🚫 当成空值静默跳过)', () => {
    expect(() =>
      mergeEarningsDateEvent(input({ observations: [structured('2026-02-30')] })),
    ).toThrow(/非法日期/);
  });
});

describe('确认日期: 会前通知刊发日 (announced) / 首次观测 (first_seen) (FR-011 / FR-012)', () => {
  it('信号窗口常量 = 120 天 (T011 取数窗口共用)', () => {
    expect(NOTICE_MATCH_WINDOW_DAYS).toBe(120);
  });

  // 事件日期 2026-08-28 ⇒ 窗口 [2026-04-30, 2026-08-28]; 富途首次观测 2026-08-20。
  it.each([
    ['恰 120 天前算', ['2026-04-30'], null, '2026-04-30', 'announced'],
    ['121 天前不算', ['2026-04-29'], null, '2026-08-20', 'first_seen'],
    ['事件日期当天算', ['2026-08-28'], null, '2026-08-28', 'announced'],
    ['晚于事件日期不算', ['2026-08-29'], null, '2026-08-20', 'first_seen'],
    ['早于该标的上一次刊发事实不算', ['2026-05-05'], '2026-05-10', '2026-08-20', 'first_seen'],
    ['与上一次刊发事实同日不算 (须晚于)', ['2026-05-10'], '2026-05-10', '2026-08-20', 'first_seen'],
    [
      '多通知取最早',
      ['2026-08-14', '2026-06-01', '2026-07-20'],
      '2026-05-10',
      '2026-06-01',
      'announced',
    ],
  ])('%s', (_label, notices, previousFilingDate, confirmedDate, confirmedBasis) => {
    const r = mergeEarningsDateEvent(
      input({
        observations: [structured('2026-08-28', '2026-08-20')],
        noticeSignals: notices.map(notice),
        previousFilingDate,
      }),
    );
    expect(r.event).toMatchObject({ confirmedDate, confirmedBasis });
  });

  it('🚨 不回退: 既有 announced 08-14, 本轮算不出对应信号 ⇒ 保留既有值, 不写确认流水', () => {
    const r = mergeEarningsDateEvent(
      input({
        observations: [structured('2026-08-28', '2026-08-16')],
        existing: confirmedAt('2026-08-14', 'announced'),
      }),
    );
    expect(r.event).toMatchObject({ confirmedDate: '2026-08-14', confirmedBasis: 'announced' });
    expect(r.logs.filter((l) => l.kind === 'confirmation_changed')).toEqual([]);
  });

  it('前移: 既有 first_seen 08-20, 本轮找到更早的通知 08-14 ⇒ 前移并改口径 announced, 写流水', () => {
    const r = mergeEarningsDateEvent(
      input({
        observations: [structured('2026-08-28', '2026-08-20')],
        noticeSignals: [notice('2026-08-14')],
        existing: confirmedAt('2026-08-20', 'first_seen'),
      }),
    );
    expect(r.event).toMatchObject({ confirmedDate: '2026-08-14', confirmedBasis: 'announced' });
    expect(r.logs.find((l) => l.kind === 'confirmation_changed')?.detail).toEqual({
      from: { date: '2026-08-20', basis: 'first_seen' },
      to: { date: '2026-08-14', basis: 'announced' },
    });
  });

  it('只前移: 既有 first_seen 08-10, 本轮通知 08-14 更晚 ⇒ 保留既有 08-10', () => {
    const r = mergeEarningsDateEvent(
      input({
        observations: [structured('2026-08-28', '2026-08-10')],
        noticeSignals: [notice('2026-08-14')],
        existing: confirmedAt('2026-08-10', 'first_seen'),
      }),
    );
    expect(r.event).toMatchObject({ confirmedDate: '2026-08-10', confirmedBasis: 'first_seen' });
  });

  it('🚫 永不升级: 只有「确认状态未知」来源 (美股富途), 即使有信号 ⇒ unconfirmed、无确认日期', () => {
    const r = mergeEarningsDateEvent(
      input({
        periodKey: 'T:futu_calendar:2026Q3',
        observations: [structured('2026-10-20', '2026-08-11')],
        capabilities: US_CAPS,
        noticeSignals: [notice('2026-10-01')],
      }),
    );
    expect(r.event).toMatchObject({
      status: 'unconfirmed',
      announceDate: '2026-10-20',
      announceBasis: 'structured',
      confirmedDate: null,
      confirmedBasis: null,
    });
  });

  it('FR-018: 既有确认、本轮给日期的来源已无能力声明 (停用) ⇒ 不撤销确认', () => {
    const r = mergeEarningsDateEvent(
      input({
        observations: [structured('2026-08-28', '2026-08-16')],
        capabilities: new Map(),
        existing: confirmedAt('2026-08-14', 'announced'),
      }),
    );
    expect(r.event).toMatchObject({
      status: 'confirmed',
      confirmedDate: '2026-08-14',
      confirmedBasis: 'announced',
    });
  });
});
