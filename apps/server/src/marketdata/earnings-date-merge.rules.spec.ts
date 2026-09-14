import { describe, it, expect } from 'vitest';
import type {
  EarningsDateSourceCapabilities,
  EarningsNoticeSignal,
} from './earnings-date-source.port.js';
import {
  NOTICE_MATCH_WINDOW_DAYS,
  STATUS_DUE_TRADING_DAYS,
  isNoticeUndatedPlaceholder,
  judgeNoticeUndated,
  mergeEarningsDateEvent,
  noticeUndatedPeriodKey,
  selectAlignedSuccessor,
  selectAnnounceDate,
  selectPendingNotice,
  type EarningsDateCandidate,
  type EarningsDateMergeInput,
  type EarningsDateMergeObservation,
  type EarningsFilingFact,
  type ExistingEarningsDateEvent,
  type ListingPresence,
  type NoticeUndatedInput,
} from './earnings-date-merge.rules.js';

const FUTU = 'futu_calendar';
const BOARD = 'hkex_board_meeting_list';
const ANN = 'hkex_announcement';
const RUN_AT = new Date('2026-09-14T15:30:00Z');

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
    dateChange: null,
    presence: null,
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
const elapsed = (from: string, count: number | null, to = '2026-09-14') => ({ from, to, count });

/**
 * 照用例协议补交易日数：先按同一输入选出公布日，再从它起数 (默认 0 个交易日 = 公布日未过)。
 * 显式传 `elapsedTradingDays` (含 null) 时原样使用。
 */
function input(overrides: Partial<EarningsDateMergeInput>): EarningsDateMergeInput {
  const base: EarningsDateMergeInput = {
    periodKey: 'P:2026-06-30',
    observations: [],
    capabilities: HK_CAPS,
    meetingLagDays: null,
    noticeSignals: [],
    previousFilingDate: null,
    existing: null,
    runAt: RUN_AT,
    fiscalYearEndMonth: 12,
    filings: [],
    elapsedTradingDays: null,
    ...overrides,
  };
  if (overrides.elapsedTradingDays !== undefined) return base;
  const { date } = selectAnnounceDate(base.observations, base.meetingLagDays);
  return { ...base, elapsedTradingDays: date === null ? null : elapsed(date, 0, date) };
}

const existingEvent = (fields: Partial<ExistingEarningsDateEvent>): ExistingEarningsDateEvent => ({
  status: 'confirmed',
  announceDate: '2026-08-28',
  announceBasis: 'structured',
  conflictCandidates: null,
  confirmedDate: null,
  confirmedBasis: null,
  overdueSince: null,
  ...fields,
});

const CONFLICT_0960: EarningsDateCandidate[] = [
  { source: FUTU, basis: 'structured', date: '2026-03-31' },
  { source: BOARD, basis: 'meeting', date: '2026-03-28' },
];

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

describe('来源冲突 (FR-014)', () => {
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
    expect(r.event.conflictCandidates).toEqual(CONFLICT_0960);
  });

  it('冲突 finding 只在迁入 conflict 时产出: 既有已是 conflict 再算一轮 ⇒ 状态不变、0 条 finding', () => {
    const r = mergeEarningsDateEvent(
      input({
        observations: [meeting('2026-03-28'), structured('2026-03-31')],
        existing: existingEvent({
          status: 'conflict',
          announceDate: null,
          announceBasis: null,
          conflictCandidates: CONFLICT_0960,
          confirmedDate: '2026-03-20',
          confirmedBasis: 'first_seen',
        }),
      }),
    );
    expect(r.event.status).toBe('conflict');
    expect(r.findings).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  it('冲突后来源重新一致 ⇒ 解除, 流水带解除前的全部候选日期', () => {
    const r = mergeEarningsDateEvent(
      input({
        observations: [meeting('2026-03-28'), structured('2026-03-28')],
        existing: existingEvent({
          status: 'conflict',
          announceDate: null,
          announceBasis: null,
          conflictCandidates: CONFLICT_0960,
          confirmedDate: '2026-03-20',
          confirmedBasis: 'first_seen',
        }),
      }),
    );
    expect(r.event).toMatchObject({ status: 'confirmed', conflictCandidates: null });
    expect(r.logs.find((l) => l.kind === 'status_changed')).toMatchObject({
      fromStatus: 'conflict',
      toStatus: 'confirmed',
      detail: { resolvedCandidates: CONFLICT_0960 },
    });
  });
});

describe('确认日期: 会前通知刊发日 (announced) / 首次观测 (first_seen) (FR-011 / FR-012)', () => {
  it('具名常量: 信号窗口 120 天 (T011 取数窗口共用)、状态判定门槛 2 个交易日', () => {
    expect(NOTICE_MATCH_WINDOW_DAYS).toBe(120);
    expect(STATUS_DUE_TRADING_DAYS).toBe(2);
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
        existing: existingEvent({ confirmedDate: '2026-08-14', confirmedBasis: 'announced' }),
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
        existing: existingEvent({ confirmedDate: '2026-08-20', confirmedBasis: 'first_seen' }),
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
        existing: existingEvent({ confirmedDate: '2026-08-10', confirmedBasis: 'first_seen' }),
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
        existing: existingEvent({ confirmedDate: '2026-08-14', confirmedBasis: 'announced' }),
      }),
    );
    expect(r.event).toMatchObject({
      status: 'confirmed',
      confirmedDate: '2026-08-14',
      confirmedBasis: 'announced',
    });
  });
});

describe('刊发覆盖 (FR-019)', () => {
  it('US3 AS1: 推定 11-13 的事件见到 11-13 刊发 ⇒ published、口径 filed, 各来源各口径偏差 (推定 0 天)', () => {
    const r = mergeEarningsDateEvent(
      input({
        observations: [meeting('2026-11-13'), structured('2026-11-12'), filed('2026-11-13')],
        meetingLagDays: 0,
        existing: existingEvent({
          announceDate: '2026-11-13',
          announceBasis: 'meeting',
          confirmedDate: '2026-10-30',
          confirmedBasis: 'announced',
        }),
      }),
    );

    expect(r.event).toMatchObject({
      status: 'published',
      announceDate: '2026-11-13',
      announceBasis: 'filed',
      confirmedDate: '2026-10-30',
      confirmedBasis: 'announced',
    });
    expect(r.deviations).toEqual([
      { source: BOARD, basis: 'meeting', date: '2026-11-13', deviationDays: 0 },
      { source: FUTU, basis: 'structured', date: '2026-11-12', deviationDays: -1 },
    ]);
    expect(r.logs.find((l) => l.kind === 'status_changed')).toMatchObject({
      fromStatus: 'confirmed',
      toStatus: 'published',
    });
  });

  it('US3 AS2 规则部分 (hk:00857): 年度会议 2026-03-27 周五、刊发 2026-03-29 周日 ⇒ 学到间隔 2 天', () => {
    const r = mergeEarningsDateEvent(
      input({
        periodKey: 'P:2025-12-31',
        observations: [meeting('2026-03-27'), filed('2026-03-29')],
      }),
    );
    expect(r.event).toMatchObject({ status: 'published', announceDate: '2026-03-29' });
    expect(r.meetingLagUpdate).toEqual({
      meetingDate: '2026-03-27',
      filedDate: '2026-03-29',
      lagDays: 2,
    });
    expect(r.deviations).toEqual([
      { source: BOARD, basis: 'meeting', date: '2026-03-27', deviationDays: -2 },
    ]);
  });

  it('停留在 published 再算一轮 ⇒ 不重复回填偏差、不重复学间隔、无流水', () => {
    const r = mergeEarningsDateEvent(
      input({
        observations: [meeting('2026-03-27'), filed('2026-03-29')],
        existing: existingEvent({
          status: 'published',
          announceDate: '2026-03-29',
          announceBasis: 'filed',
          confirmedDate: '2026-03-27',
          confirmedBasis: 'first_seen',
        }),
      }),
    );
    expect(r.event.status).toBe('published');
    expect(r.deviations).toEqual([]);
    expect(r.meetingLagUpdate).toBeNull();
    expect(r.logs).toEqual([]);
  });
});

// 逾期用例共用: 公布日 2026-09-11 (周五)、业务日 2026-09-14 (周一)、会前通知 2026-08-25。
const pastEvent = (overrides: Partial<EarningsDateMergeInput>) =>
  input({
    observations: [structured('2026-09-11', '2026-08-30')],
    noticeSignals: [notice('2026-08-25')],
    ...overrides,
  });
const overdueSince = new Date('2026-09-12T15:30:00Z');
const existingConfirmedPast = existingEvent({
  announceDate: '2026-09-11',
  announceBasis: 'structured',
  confirmedDate: '2026-08-25',
  confirmedBasis: 'announced',
});
const existingOverdue = existingEvent({
  ...existingConfirmedPast,
  status: 'overdue',
  overdueSince,
});

describe('逾期未刊发: 迁入 / 停留 (FR-019a)', () => {
  it('周五公布、周一业务日 = 1 个交易日 (日历日 3 天) ⇒ 不判逾期', () => {
    const r = mergeEarningsDateEvent(pastEvent({ elapsedTradingDays: elapsed('2026-09-11', 1) }));
    expect(r.event).toMatchObject({ status: 'confirmed', overdueSince: null });
    expect(r.findings).toEqual([]);
  });

  it('满 2 个交易日未刊发 ⇒ 迁入 overdue + 计入失败的 finding, 未转 published', () => {
    const r = mergeEarningsDateEvent(
      pastEvent({ elapsedTradingDays: elapsed('2026-09-11', 2), existing: existingConfirmedPast }),
    );
    expect(r.event).toMatchObject({ status: 'overdue', overdueSince: RUN_AT });
    expect(r.fiscalProfileMissing).toBe(false);
    expect(r.findings).toEqual([
      {
        kind: 'notice',
        step: 'earnings_date_overdue',
        countsAsFailure: true,
        detail: {
          periodKey: 'P:2026-06-30',
          announceDate: '2026-09-11',
          announceBasis: 'structured',
          elapsedTradingDays: 2,
        },
      },
    ]);
    expect(r.logs.find((l) => l.kind === 'status_changed')).toMatchObject({
      fromStatus: 'confirmed',
      toStatus: 'overdue',
    });
  });

  it('区间日历不可判 (count = null) ⇒ 不判, 产出 unjudged', () => {
    const r = mergeEarningsDateEvent(
      pastEvent({ elapsedTradingDays: elapsed('2026-09-11', null) }),
    );
    expect(r.event.status).toBe('confirmed');
    expect(r.findings).toEqual([
      {
        kind: 'unjudged',
        step: 'earnings_date_calendar_unknown',
        countsAsFailure: false,
        detail: {
          periodKey: 'P:2026-06-30',
          judgement: 'overdue',
          from: '2026-09-11',
          to: '2026-09-14',
        },
      },
    ]);
  });

  it('既有 overdue + 本轮日历不可判 ⇒ 不凭空解除', () => {
    const r = mergeEarningsDateEvent(
      pastEvent({ elapsedTradingDays: elapsed('2026-09-11', null), existing: existingOverdue }),
    );
    expect(r.event).toMatchObject({ status: 'overdue', overdueSince });
    expect(r.findings.map((f) => f.kind)).toEqual(['unjudged']);
  });

  it('🚨 停留: 既有已是 overdue 再算一轮 ⇒ 状态不变、0 条 finding、逾期起算时刻不变', () => {
    const r = mergeEarningsDateEvent(
      pastEvent({ elapsedTradingDays: elapsed('2026-09-11', 5), existing: existingOverdue }),
    );
    expect(r.event).toMatchObject({ status: 'overdue', overdueSince });
    expect(r.findings).toEqual([]);
    expect(r.logs).toEqual([]);
  });
});

describe('逾期未刊发: 解除 / 财年档案 / 判定范围 (FR-019a / FR-028)', () => {
  it('刊发后解除: 既有 overdue + 刊发事实 ⇒ published, 逾期起算时刻清空, 留痕', () => {
    const r = mergeEarningsDateEvent(
      pastEvent({
        observations: [structured('2026-09-11', '2026-08-30'), filed('2026-09-15')],
        existing: existingOverdue,
      }),
    );
    expect(r.event).toMatchObject({ status: 'published', overdueSince: null });
    expect(r.logs.find((l) => l.kind === 'status_changed')).toMatchObject({
      fromStatus: 'overdue',
      toStatus: 'published',
    });
    expect(r.findings).toEqual([]);
  });

  it('改期解除: 富途日期 09-11 → 09-25 ⇒ 流水记旧日期与变更时刻, 按新日期重判解除逾期', () => {
    const changedAt = new Date('2026-09-14T15:30:00Z');
    const r = mergeEarningsDateEvent(
      pastEvent({
        observations: [
          obs(FUTU, 'structured', {
            announceDate: '2026-09-25',
            firstSeenDate: '2026-08-30',
            dateChange: { previousDate: '2026-09-11', changedAt },
          }),
        ],
        elapsedTradingDays: elapsed('2026-09-25', 0),
        existing: existingOverdue,
      }),
    );

    expect(r.event).toMatchObject({
      status: 'confirmed',
      announceDate: '2026-09-25',
      overdueSince: null,
    });
    expect(r.logs.map((l) => l.kind)).toEqual([
      'date_rescheduled',
      'status_changed',
      'value_changed',
    ]);
    expect(r.logs[0]).toEqual({
      kind: 'date_rescheduled',
      fromStatus: 'overdue',
      toStatus: 'confirmed',
      detail: {
        source: FUTU,
        basis: 'structured',
        previousDate: '2026-09-11',
        date: '2026-09-25',
        changedAt: '2026-09-14T15:30:00.000Z',
      },
    });
  });

  it('🚨 无财年档案: 满 2 个交易日仍不迁入 overdue, 只报无法判定', () => {
    const r = mergeEarningsDateEvent(
      pastEvent({ elapsedTradingDays: elapsed('2026-09-11', 2), fiscalYearEndMonth: null }),
    );
    expect(r.event.status).toBe('confirmed');
    expect(r.fiscalProfileMissing).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('无刊发事实来源的市场 (美股) ⇒ 不判逾期、不报无法判定、不要求交易日数', () => {
    const r = mergeEarningsDateEvent(
      input({
        periodKey: 'T:futu_calendar:2026Q2',
        observations: [structured('2026-08-01', '2026-06-01')],
        capabilities: US_CAPS,
        fiscalYearEndMonth: null,
        elapsedTradingDays: null,
      }),
    );
    expect(r.event.status).toBe('unconfirmed');
    expect(r.fiscalProfileMissing).toBe(false);
    expect(r.findings).toEqual([]);
  });

  it('交易日数不是从本轮公布日起算 ⇒ 抛错', () => {
    expect(() =>
      mergeEarningsDateEvent(pastEvent({ elapsedTradingDays: elapsed('2026-09-10', 5) })),
    ).toThrow(/起算/);
  });
});

describe('逾期未刊发: 只判期末日对齐键 (FR-015 / FR-028; 2026-09-14 prod hk:00939 后补财年档案)', () => {
  it.each(['T:futu_calendar:2025Q3', 'D:hkex_announcement:2025-10-30'])(
    '🚨 %s: 有财年档案 + 满 2 个交易日 + 未刊发 ⇒ 不迁入 overdue、0 条计失败 finding、记非对齐',
    (periodKey) => {
      const r = mergeEarningsDateEvent(
        pastEvent({
          periodKey,
          elapsedTradingDays: elapsed('2026-09-11', 2),
          existing: existingConfirmedPast,
        }),
      );
      expect(r.event).toMatchObject({ status: 'confirmed', overdueSince: null });
      expect(r.findings.filter((f) => f.countsAsFailure)).toEqual([]);
      expect(r.findings).toEqual([]);
      expect(r).toMatchObject({ overdueUnaligned: true, fiscalProfileMissing: false });
    },
  );

  it('对照 P:2025-09-30 同输入 ⇒ 仍迁入 overdue + 计失败 finding (逾期未被整体关掉)', () => {
    const r = mergeEarningsDateEvent(
      pastEvent({
        periodKey: 'P:2025-09-30',
        elapsedTradingDays: elapsed('2026-09-11', 2),
        existing: existingConfirmedPast,
        // 第三财季: 无季度刊发会命中 FR-029 (非季报公司不判); 给一份季报, 保持本臂「对齐键照常判逾期」的原意。
        filings: [
          {
            filedDate: '2025-08-10',
            periodEnd: '2025-06-30',
            reportKind: 'quarterly',
            periodText: null,
          },
        ],
      }),
    );
    expect(r.event).toMatchObject({ status: 'overdue', overdueSince: RUN_AT });
    expect(r.findings.filter((f) => f.countsAsFailure)).toHaveLength(1);
    expect(r.overdueUnaligned).toBe(false);
  });

  it('判定顺序: 日历不可判 / 未到期先于键形态; 键形态先于财年档案 (无档案的非对齐键 🚫 报财年未知)', () => {
    const key = 'T:futu_calendar:2025Q3';
    const noProfile = mergeEarningsDateEvent(
      pastEvent({
        periodKey: key,
        elapsedTradingDays: elapsed('2026-09-11', 2),
        fiscalYearEndMonth: null,
      }),
    );
    expect(noProfile.event.status).toBe('confirmed');
    expect(noProfile).toMatchObject({ overdueUnaligned: true, fiscalProfileMissing: false });

    const notDue = mergeEarningsDateEvent(
      pastEvent({ periodKey: key, elapsedTradingDays: elapsed('2026-09-11', 1) }),
    );
    expect(notDue).toMatchObject({ overdueUnaligned: false, findings: [] });

    const unknown = mergeEarningsDateEvent(
      pastEvent({ periodKey: key, elapsedTradingDays: elapsed('2026-09-11', null) }),
    );
    expect(unknown.overdueUnaligned).toBe(false);
    expect(unknown.findings.map((f) => f.step)).toEqual(['earnings_date_calendar_unknown']);
  });

  it('既有 overdue 的非对齐事件 ⇒ 保持原状 (不凭空解除)、0 条 finding', () => {
    const r = mergeEarningsDateEvent(
      pastEvent({
        periodKey: 'D:hkex_announcement:2025-10-30',
        elapsedTradingDays: elapsed('2026-09-11', 5),
        existing: existingOverdue,
      }),
    );
    expect(r.event).toMatchObject({ status: 'overdue', overdueSince });
    expect(r.findings).toEqual([]);
    expect(r.overdueUnaligned).toBe(true);
  });
});

// 1b 用例共用 (FR-029): hk:01299 形态 —— 12 月结年, 第三季 P:2025-09-30 由富途记为 2025-10-31, 业务日 2025-11-04
// 满 2 个交易日; 730 天内只有年度与中期刊发 (无任何季度业绩)。
const Q3_2025 = 'P:2025-09-30';
const filing = (
  filedDate: string,
  fields: Partial<EarningsFilingFact> = {},
): EarningsFilingFact => ({
  filedDate,
  periodEnd: null,
  reportKind: null,
  periodText: null,
  ...fields,
});
const ANNUAL_AND_INTERIM_ONLY: readonly EarningsFilingFact[] = [
  filing('2025-03-14', {
    periodEnd: '2024-12-31',
    reportKind: 'annual',
    periodText: '截至2024年12月31日止年度之業績公告',
  }),
  filing('2025-08-22', {
    periodEnd: '2025-06-30',
    reportKind: 'interim',
    periodText: '截至2025年6月30日止六個月之中期業績公告',
  }),
];
const q3Event = (overrides: Partial<EarningsDateMergeInput>) =>
  input({
    periodKey: Q3_2025,
    observations: [structured('2025-10-31', '2025-10-01')],
    filings: ANNUAL_AND_INTERIM_ONLY,
    elapsedTradingDays: elapsed('2025-10-31', 2, '2025-11-04'),
    ...overrides,
  });
const existingQ3 = existingEvent({
  announceDate: '2025-10-31',
  announceBasis: 'structured',
  confirmedDate: '2025-10-01',
  confirmedBasis: 'first_seen',
});
const existingQ3Overdue = existingEvent({ ...existingQ3, status: 'overdue', overdueSince });

describe('逾期未刊发: 非季报公司的第一 / 第三季不判 (FR-029; spec Session（八）1b, 2026-09-14 prod hk:01299)', () => {
  it('🚨 12 月结年第三季、730 天内只有年度与中期刊发 ⇒ 不迁入 overdue、0 条 finding、只计数', () => {
    const r = mergeEarningsDateEvent(q3Event({ existing: existingQ3 }));
    expect(r.event).toMatchObject({ status: 'confirmed', overdueSince: null });
    expect(r.findings).toEqual([]);
    expect(r.logs).toEqual([]);
    expect(r).toMatchObject({
      nonQuarterlyReporter: { released: false },
      overdueUnaligned: false,
      fiscalProfileMissing: false,
    });
  });

  it('🚨 既有 overdue ⇒ 解除回 confirmed、清逾期起算时刻、status_changed 流水带 releasedBy, 🚫 计失败', () => {
    const r = mergeEarningsDateEvent(q3Event({ existing: existingQ3Overdue }));
    expect(r.event).toMatchObject({ status: 'confirmed', overdueSince: null });
    expect(r.findings).toEqual([]);
    expect(r.nonQuarterlyReporter).toEqual({ released: true });
    expect(r.logs).toEqual([
      {
        kind: 'status_changed',
        fromStatus: 'overdue',
        toStatus: 'confirmed',
        detail: {
          announceDate: '2025-10-31',
          announceBasis: 'structured',
          releasedBy: 'non_quarterly_reporter',
        },
      },
    ]);
  });

  it.each([
    ['报告类型为季度', filing('2025-05-15', { periodEnd: '2025-03-31', reportKind: 'quarterly' })],
    ['报告类型空、期末日为第一财季 (P: 键)', filing('2025-05-15', { periodEnd: '2025-03-31' })],
    [
      '报告类型空、无期末日 (D: 键) 标题「第一季度業績公告」',
      filing('2025-05-15', { periodText: '2025年第一季度業績公告' }),
    ],
  ])('对照: 730 天内有季度刊发 (%s) ⇒ 照常迁入 overdue + 计失败 finding', (_label, quarterly) => {
    const r = mergeEarningsDateEvent(
      q3Event({ existing: existingQ3, filings: [...ANNUAL_AND_INTERIM_ONLY, quarterly] }),
    );
    expect(r.event.status).toBe('overdue');
    expect(r.findings.filter((f) => f.countsAsFailure)).toHaveLength(1);
    expect(r.nonQuarterlyReporter).toBeNull();
  });

  it.each([
    ['中期', 'P:2025-06-30'],
    ['年度', 'P:2025-12-31'],
  ])('只限第一 / 第三季: 非季报公司的%s期末 (%s) ⇒ 照常迁入 overdue', (_label, periodKey) => {
    const r = mergeEarningsDateEvent(q3Event({ periodKey, existing: existingQ3 }));
    expect(r.event.status).toBe('overdue');
    expect(r.nonQuarterlyReporter).toBeNull();
  });

  it('财季按财年档案换算: 3 月结年公司 P:2025-12-31 = 第三财季 ⇒ 不判; P:2025-09-30 = 中期 ⇒ 迁入', () => {
    const march: Partial<EarningsDateMergeInput> = {
      fiscalYearEndMonth: 3,
      existing: existingQ3,
      filings: [
        filing('2025-06-20', { periodEnd: '2025-03-31', reportKind: 'annual' }),
        filing('2024-11-28', { periodEnd: '2024-09-30', reportKind: 'interim' }),
      ],
    };
    const q3 = mergeEarningsDateEvent(q3Event({ ...march, periodKey: 'P:2025-12-31' }));
    expect(q3.event.status).toBe('confirmed');
    expect(q3.nonQuarterlyReporter).toEqual({ released: false });
    const interim = mergeEarningsDateEvent(q3Event({ ...march, periodKey: 'P:2025-09-30' }));
    expect(interim.event.status).toBe('overdue');
  });

  it.each([
    ['第 730 天 (2023-11-01) 的季度刊发 ⇒ 算', '2023-11-01', 'overdue'],
    ['第 731 天 (2023-10-31) ⇒ 不算', '2023-10-31', 'confirmed'],
    ['公布日当天 (2025-10-31) ⇒ 不算 (「之前」)', '2025-10-31', 'confirmed'],
  ])('730 天窗口边界: %s', (_label, filedDate, status) => {
    const quarterly = filing(filedDate, { periodEnd: '2023-09-30', reportKind: 'quarterly' });
    const r = mergeEarningsDateEvent(
      q3Event({ existing: existingQ3, filings: [...ANNUAL_AND_INTERIM_ONLY, quarterly] }),
    );
    expect(r.event.status).toBe(status);
  });

  it('判定顺序: 无财年档案先报财年未知; 日历不可判时既有逾期不解除; 非对齐键先报无法对齐; 未到期不计数', () => {
    const noProfile = mergeEarningsDateEvent(q3Event({ fiscalYearEndMonth: null }));
    expect(noProfile).toMatchObject({ fiscalProfileMissing: true, nonQuarterlyReporter: null });

    const unknown = mergeEarningsDateEvent(
      q3Event({
        existing: existingQ3Overdue,
        elapsedTradingDays: elapsed('2025-10-31', null, '2025-11-04'),
      }),
    );
    expect(unknown.event).toMatchObject({ status: 'overdue', overdueSince });
    expect(unknown.nonQuarterlyReporter).toBeNull();

    const unaligned = mergeEarningsDateEvent(q3Event({ periodKey: 'T:futu_calendar:2025Q3' }));
    expect(unaligned).toMatchObject({ overdueUnaligned: true, nonQuarterlyReporter: null });

    const notDue = mergeEarningsDateEvent(
      q3Event({ elapsedTradingDays: elapsed('2025-10-31', 1, '2025-11-04') }),
    );
    expect(notDue).toMatchObject({ nonQuarterlyReporter: null, findings: [] });
  });
});

describe('selectAlignedSuccessor — 无法对齐旧事件的接手键 (FR-030; spec Session（八）3a, 2026-09-14 prod hk:00939)', () => {
  const T_KEY = 'T:futu_calendar:2024Q3';
  const keyObs = (source: string, periodKey: string, periodText: string | null) => ({
    source,
    periodKey,
    periodText,
  });
  const confirmedT = { periodKey: T_KEY, status: 'confirmed' as const };

  it('🚨 同来源同原文已有 P: 键观测 ⇒ 该 P: 键 (带配对来源与原文留痕)', () => {
    expect(
      selectAlignedSuccessor(confirmedT, [
        keyObs(FUTU, T_KEY, '2024Q3'),
        keyObs(FUTU, 'P:2024-09-30', '2024Q3'),
        keyObs(ANN, 'P:2024-06-30', '截至2024年6月30日止六個月之中期業績公告'),
      ]),
    ).toEqual({ periodKey: 'P:2024-09-30', source: FUTU, periodText: '2024Q3' });
  });

  it('既有 overdue 的旧事件同样收尾; D: 键同样适用', () => {
    const d = 'D:futu_calendar:2024-10-30';
    expect(
      selectAlignedSuccessor({ periodKey: d, status: 'overdue' }, [
        keyObs(FUTU, d, '2024Q3'),
        keyObs(FUTU, 'P:2024-09-30', '2024Q3'),
      ]),
    ).toMatchObject({ periodKey: 'P:2024-09-30' });
  });

  it.each([
    ['来源不同', [keyObs(FUTU, T_KEY, '2024Q3'), keyObs(BOARD, 'P:2024-09-30', '2024Q3')]],
    ['原文不同', [keyObs(FUTU, T_KEY, '2024Q3'), keyObs(FUTU, 'P:2024-09-30', '2024 Q3')]],
    ['原文为空', [keyObs(FUTU, T_KEY, null), keyObs(FUTU, 'P:2024-09-30', null)]],
    [
      '🚫 同原文对应两个 P: 键 (财年档案改过, 不猜)',
      [
        keyObs(FUTU, T_KEY, '2024Q3'),
        keyObs(FUTU, 'P:2024-09-30', '2024Q3'),
        keyObs(FUTU, 'P:2024-06-30', '2024Q3'),
      ],
    ],
    ['无任何 P: 键观测', [keyObs(FUTU, T_KEY, '2024Q3')]],
  ])('%s ⇒ null', (_label, observations) => {
    expect(selectAlignedSuccessor(confirmedT, observations)).toBeNull();
  });

  it.each([
    ['已刊发', { periodKey: T_KEY, status: 'published' as const }],
    ['已并入', { periodKey: T_KEY, status: 'superseded' as const }],
    ['占位事件', { periodKey: 'D:notice_undated:2024-10-02', status: 'notified_undated' as const }],
    ['本身是 P: 键', { periodKey: 'P:2024-09-30', status: 'confirmed' as const }],
  ])('%s ⇒ null', (_label, event) => {
    expect(
      selectAlignedSuccessor(event, [
        keyObs(FUTU, event.periodKey, '2024Q3'),
        keyObs(FUTU, 'P:2024-09-30', '2024Q3'),
      ]),
    ).toBeNull();
  });
});

describe('清单行提前消失 (FR-016)', () => {
  const listedEvent = (
    presence: ListingPresence,
    extra: readonly EarningsDateMergeObservation[] = [],
  ) =>
    input({
      observations: [
        obs(BOARD, 'meeting', { meetingDate: '2026-09-20', firstSeenDate: '2026-09-02', presence }),
        ...extra,
      ],
      noticeSignals: [notice('2026-09-01')],
      existing: existingEvent({
        announceDate: '2026-09-20',
        announceBasis: 'meeting',
        confirmedDate: '2026-09-01',
        confirmedBasis: 'announced',
      }),
    });

  it('上一轮在、本轮解析成功而不在、会议日晚于页首日期、同期无新日期 ⇒ 留痕 + finding, 日期与确认保留', () => {
    const r = mergeEarningsDateEvent(
      listedEvent({ listedLastRound: true, thisRound: 'absent', pageDate: '2026-09-14' }),
    );
    const drop = { source: BOARD, lastDate: '2026-09-20', pageDate: '2026-09-14' };

    expect(r.event).toMatchObject({
      status: 'confirmed',
      announceDate: '2026-09-20',
      announceBasis: 'meeting',
      confirmedDate: '2026-09-01',
      confirmedBasis: 'announced',
    });
    expect(r.logs).toEqual([
      { kind: 'listing_dropped', fromStatus: 'confirmed', toStatus: 'confirmed', detail: drop },
    ]);
    expect(r.findings).toEqual([
      {
        kind: 'notice',
        step: 'earnings_board_list_dropped',
        countsAsFailure: false,
        detail: { periodKey: 'P:2026-06-30', ...drop },
      },
    ]);
  });

  it.each([
    ['🚨 本轮清单解析失败 / 来源失败', { listedLastRound: true, thisRound: 'unavailable' }, []],
    [
      '会议日不晚于页首日期',
      { listedLastRound: true, thisRound: 'absent', pageDate: '2026-09-20' },
      [],
    ],
    ['上一轮也不在', { listedLastRound: false, thisRound: 'absent', pageDate: '2026-09-14' }, []],
    [
      '同期另一来源给出新日期 (改期)',
      { listedLastRound: true, thisRound: 'absent', pageDate: '2026-09-14' },
      [
        obs(FUTU, 'structured', {
          announceDate: '2026-09-21',
          firstSeenDate: '2026-09-02',
          dateChange: { previousDate: '2026-09-20', changedAt: RUN_AT },
        }),
      ],
    ],
  ] as const)('%s ⇒ 不判消失', (_label, presence, extra) => {
    const r = mergeEarningsDateEvent(listedEvent(presence, extra));
    expect(r.logs.filter((l) => l.kind === 'listing_dropped')).toEqual([]);
    expect(r.findings.filter((f) => f.step === 'earnings_board_list_dropped')).toEqual([]);
  });
});

describe('已通知日期未知 (FR-017 / FR-028)', () => {
  // 通知 2026-09-01、最近一次刊发 2026-08-20。
  const undatedInput = (overrides: Partial<NoticeUndatedInput>): NoticeUndatedInput => ({
    noticeSignals: [notice('2026-09-01')],
    latestFilingDate: '2026-08-20',
    unpublishedEventDates: [],
    everListed: true,
    hasFiscalProfile: true,
    capabilities: HK_CAPS,
    elapsedTradingDays: elapsed('2026-09-01', 2),
    existingStatus: null,
    ...overrides,
  });

  it('满 2 个交易日仍无任何日期、曾在清单 ⇒ 迁入 notified_undated + 计入失败的 finding', () => {
    const r = judgeNoticeUndated(undatedInput({}));
    expect(r.status).toBe('notified_undated');
    expect(r.neverListedUndated).toBe(false);
    expect(r.findings).toEqual([
      {
        kind: 'notice',
        step: 'earnings_notice_undated',
        countsAsFailure: true,
        detail: {
          noticeDate: '2026-09-01',
          title: '董事會會議召開日期',
          link: 'notice:2026-09-01',
          elapsedTradingDays: 2,
        },
      },
    ]);
    expect(r.logs).toEqual([
      {
        kind: 'status_changed',
        fromStatus: null,
        toStatus: 'notified_undated',
        detail: { noticeDate: '2026-09-01', link: 'notice:2026-09-01' },
      },
    ]);
  });

  it('🚨 从未在清单 (创业板形态) ⇒ 只计数: 不迁入、0 条 finding', () => {
    const r = judgeNoticeUndated(undatedInput({ everListed: false }));
    expect(r.status).toBeNull();
    expect(r.neverListedUndated).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('🚨 该标的有公布日早于通知日的长期 overdue 事件 (期间空白 D: 键) + 新通知满 2 个交易日无日期 ⇒ 迁入 notified_undated', () => {
    const r = judgeNoticeUndated(undatedInput({ unpublishedEventDates: ['2026-03-20'] }));
    expect(r.status).toBe('notified_undated');
    expect(r.findings).toMatchObject([
      {
        step: 'earnings_notice_undated',
        countsAsFailure: true,
        detail: { noticeDate: '2026-09-01' },
      },
    ]);
  });

  it.each([
    ['公布日晚于通知日', '2026-09-18'],
    ['公布日 = 通知日', '2026-09-01'],
  ])('%s的未刊发事件 ⇒ 日期已由它给出, 不判', (_label, date) => {
    const r = judgeNoticeUndated(
      undatedInput({ unpublishedEventDates: ['2026-03-20', date], elapsedTradingDays: null }),
    );
    expect(r.status).toBeNull();
    expect(r.findings).toEqual([]);
    expect(r.neverListedUndated).toBe(false);
  });

  it('只过 1 个交易日 ⇒ 不判', () => {
    const r = judgeNoticeUndated(undatedInput({ elapsedTradingDays: elapsed('2026-09-01', 1) }));
    expect(r.status).toBeNull();
    expect(r.findings).toEqual([]);
  });

  it('区间日历不可判 ⇒ 不判, 产出 unjudged', () => {
    const r = judgeNoticeUndated(undatedInput({ elapsedTradingDays: elapsed('2026-09-01', null) }));
    expect(r.status).toBeNull();
    expect(r.findings).toEqual([
      {
        kind: 'unjudged',
        step: 'earnings_date_calendar_unknown',
        countsAsFailure: false,
        detail: { judgement: 'notified_undated', from: '2026-09-01', to: '2026-09-14' },
      },
    ]);
  });

  it('🚨 停留: 既有已是 notified_undated 再算一轮 ⇒ 状态不变、0 条 finding、无流水', () => {
    const r = judgeNoticeUndated(
      undatedInput({
        existingStatus: 'notified_undated',
        elapsedTradingDays: elapsed('2026-09-01', 5),
      }),
    );
    expect(r.status).toBe('notified_undated');
    expect(r.findings).toEqual([]);
    expect(r.logs).toEqual([]);
  });

  it('之后任一来源给出日期 ⇒ 占位事件迁为 superseded (🚫 删除); 该事件的确认日期取通知刊发日', () => {
    const r = judgeNoticeUndated(
      undatedInput({ existingStatus: 'notified_undated', unpublishedEventDates: ['2026-10-15'] }),
    );
    expect(r.status).toBe('superseded');
    expect(r.findings).toEqual([]);
    expect(r.logs).toMatchObject([
      { kind: 'status_changed', fromStatus: 'notified_undated', toStatus: 'superseded' },
    ]);

    const dated = mergeEarningsDateEvent(
      input({
        observations: [structured('2026-10-15', '2026-09-30')],
        noticeSignals: [notice('2026-09-01')],
        previousFilingDate: '2026-08-20',
      }),
    );
    expect(dated.event).toMatchObject({ confirmedDate: '2026-09-01', confirmedBasis: 'announced' });
  });

  it.each([
    ['hk:00941 季度: 该期无会前通知', []],
    ['通知不晚于最近一次刊发 (已被那次刊发用掉)', [notice('2026-08-10'), notice('2026-08-20')]],
  ])('%s ⇒ 无未知日期态、无计数', (_label, signals) => {
    const r = judgeNoticeUndated(
      undatedInput({ noticeSignals: signals, elapsedTradingDays: null }),
    );
    expect(r).toEqual({
      pendingNotice: null,
      status: null,
      logs: [],
      findings: [],
      neverListedUndated: false,
      fiscalProfileMissing: false,
    });
  });

  it('🚨 无财年档案 ⇒ 不迁入, 只报无法判定', () => {
    const r = judgeNoticeUndated(undatedInput({ hasFiscalProfile: false }));
    expect(r.status).toBeNull();
    expect(r.fiscalProfileMissing).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('占位事件键 = D:notice_undated:<通知刊发日>, 与公告来源兜底键不同形', () => {
    expect(noticeUndatedPeriodKey('2026-09-01')).toBe('D:notice_undated:2026-09-01');
    expect(isNoticeUndatedPlaceholder(noticeUndatedPeriodKey('2026-09-01'))).toBe(true);
    expect(isNoticeUndatedPlaceholder('D:hkex_announcement:2026-09-01')).toBe(false);
  });

  it('待判通知 = 晚于最近一次刊发的通知中最早者', () => {
    const signals = ['2026-09-05', '2026-09-01', '2026-08-10'].map(notice);
    expect(selectPendingNotice(signals, '2026-08-20')?.noticeDate).toBe('2026-09-01');
    expect(selectPendingNotice(signals, null)?.noticeDate).toBe('2026-08-10');
  });
});
