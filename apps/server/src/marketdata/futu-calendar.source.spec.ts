import { describe, it, expect, vi } from 'vitest';
import type { PrismaService } from '../security/prisma.service.js';
import {
  EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS,
  type EarningsCalendarEvent,
  type EarningsCalendarPort,
  type EarningsCalendarWindowQuery,
} from './earnings-calendar.port.js';
import {
  FUTU_CALENDAR_BACKFILL_LOOKBACK_DAYS,
  FUTU_CALENDAR_DAILY_LOOKBACK_DAYS,
  FutuCalendarSource,
  toSourceObservations,
} from './futu-calendar.source.js';
import { EARNINGS_FORWARD_HORIZON_DAYS } from './sync-earnings-event.usecase.js';

// 079 T010 来源 A 富途财报日历 (FR-002 / FR-003 / FR-021 / FR-024, plan §D5; state_branches 1、19)。
// Small: 假日历端口 + 假 Prisma (只读标的主表与财年档案), 零容器 —— 观测落库在 T013 的 IT。

const BUSINESS_DATE = '2026-09-14';
const NOW = new Date('2026-09-14T15:30:00Z');

function addUtcDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function event(
  symbol: string,
  earningsDate: string,
  over: Partial<EarningsCalendarEvent> = {},
): EarningsCalendarEvent {
  return {
    underlyingSymbol: symbol,
    earningsDate,
    pubType: 'AFTER',
    periodText: '2027Q1',
    epsActual: null,
    epsPredict: null,
    publicationTime: null,
    ...over,
  };
}

function harness(opts: {
  eventsFor?: (q: EarningsCalendarWindowQuery) => EarningsCalendarEvent[];
  instruments?: { id: bigint; code: string }[];
  profiles?: { instrumentId: bigint; fiscalYearEndMonth: number }[];
}) {
  const calls: EarningsCalendarWindowQuery[] = [];
  const calendar: EarningsCalendarPort = {
    getWindow: vi.fn(async (q: EarningsCalendarWindowQuery) => {
      calls.push(q);
      return opts.eventsFor?.(q) ?? [];
    }),
  };
  const prisma = {
    instrument: { findMany: vi.fn(async () => opts.instruments ?? []) },
    earningsFiscalProfile: { findMany: vi.fn(async () => opts.profiles ?? []) },
  } as unknown as PrismaService;
  return { source: new FutuCalendarSource(calendar, prisma), calls };
}

describe('FutuCalendarSource 能力声明', () => {
  it('港股 = 前向仅已公告; 美股 = 前向 unconfirmed (🚫 升级确认); 均不给信号 / 刊发事实; 其余市场 null', () => {
    const { source } = harness({});
    expect(source.name).toBe('futu_calendar');
    expect(source.capabilities('hk')).toEqual({
      forward: 'announced_only',
      confirmationSignal: false,
      publicationFact: false,
    });
    expect(source.capabilities('us')).toEqual({
      forward: 'unconfirmed',
      confirmationSignal: false,
      publicationFact: false,
    });
    expect(source.capabilities('cn')).toBeNull();
  });
});

describe('toSourceObservations (取值单点, 美股钩子 T020 复用)', () => {
  const PUBLISHED_AT = new Date('2026-08-27T16:00:00+08:00');

  it('港股有财年档案 (3 月结) ⇒ `2027Q1` 对齐 P:2026-06-30, structured 口径逐字段', () => {
    const { observations, skippedUnknownInstruments } = toSourceObservations(
      [event('hk:09988', '2026-08-27', { publicationTime: PUBLISHED_AT })],
      'hk',
      { instrumentIds: new Map([['hk:09988', 1n]]), fiscalYearEndMonths: new Map([[1n, 3]]) },
    );

    expect(skippedUnknownInstruments).toBe(0);
    expect(observations).toEqual([
      {
        instrumentId: 1n,
        periodKey: 'P:2026-06-30',
        reportKind: 'quarterly',
        periodEnd: '2026-06-30',
        periodText: '2027Q1',
        basis: 'structured',
        announceDate: '2026-08-27',
        meetingDate: null,
        publicationTime: PUBLISHED_AT,
        filedDate: null,
        evidence: null,
      },
    ]);
  });

  it('🚨 港股无财年档案 ⇒ T: 键 (🚫 代入 12 月); 美股即便查得到月份也一律 T:', () => {
    const lookup = {
      instrumentIds: new Map([
        ['hk:00700', 1n],
        ['us:PEP', 2n],
      ]),
      fiscalYearEndMonths: new Map([[2n, 12]]),
    };
    const hk = toSourceObservations([event('hk:00700', '2026-11-12')], 'hk', lookup);
    const us = toSourceObservations(
      [event('us:PEP', '2026-10-06', { periodText: '2026Q3' })],
      'us',
      lookup,
    );

    expect(hk.observations.map((o) => [o.periodKey, o.periodEnd])).toEqual([
      ['T:futu_calendar:2027Q1', null],
    ]);
    expect(us.observations.map((o) => [o.periodKey, o.basis])).toEqual([
      ['T:futu_calendar:2026Q3', 'structured'],
    ]);
  });

  it('主表外代码 (人民币柜台等) ⇒ 跳过计数不落观测; 相邻窗共享端点日的重复行只计一次', () => {
    const { observations, skippedUnknownInstruments } = toSourceObservations(
      [
        event('hk:00700', '2026-09-20'),
        event('hk:80700', '2026-09-20'),
        event('hk:80700', '2026-09-20'),
        event('hk:09999', '2026-09-21'),
      ],
      'hk',
      { instrumentIds: new Map([['hk:00700', 1n]]), fiscalYearEndMonths: new Map() },
    );

    expect(observations.map((o) => o.instrumentId)).toEqual([1n]);
    expect(skippedUnknownInstruments).toBe(2);
  });
});

describe('FutuCalendarSource.collect', () => {
  it(`日常 hk: 窗口 [业务日 − ${FUTU_CALENDAR_DAILY_LOOKBACK_DAYS}, 业务日 + ${EARNINGS_FORWARD_HORIZON_DAYS}] 切成首尾相接的合规窗, 跳过计数 + 前向行数`, async () => {
    const { source, calls } = harness({
      instruments: [{ id: 1n, code: '00700' }],
      profiles: [{ instrumentId: 1n, fiscalYearEndMonth: 12 }],
      eventsFor: (q) =>
        q.start === addUtcDays(BUSINESS_DATE, -FUTU_CALENDAR_DAILY_LOOKBACK_DAYS)
          ? [
              event('hk:00700', addUtcDays(BUSINESS_DATE, -3), { periodText: '2026Q2' }),
              event('hk:80700', BUSINESS_DATE),
            ]
          : [],
    });

    const result = await source.collect({
      market: 'hk',
      businessDate: BUSINESS_DATE,
      now: NOW,
      mode: 'daily',
    });

    expect(calls[0].start).toBe(addUtcDays(BUSINESS_DATE, -FUTU_CALENDAR_DAILY_LOOKBACK_DAYS));
    expect(calls.at(-1)?.end).toBe(addUtcDays(BUSINESS_DATE, EARNINGS_FORWARD_HORIZON_DAYS));
    expect(calls.every((c) => c.market === 'hk')).toBe(true);
    for (let i = 0; i < calls.length; i++) {
      const spanDays =
        (Date.parse(`${calls[i].end}T00:00:00Z`) - Date.parse(`${calls[i].start}T00:00:00Z`)) /
        86_400_000;
      expect(spanDays).toBeGreaterThan(0);
      expect(spanDays).toBeLessThanOrEqual(EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS);
      if (i > 0) expect(calls[i].start).toBe(calls[i - 1].end);
    }
    expect(result.observations.map((o) => [o.instrumentId, o.periodKey])).toEqual([
      [1n, 'P:2026-06-30'],
    ]);
    expect(result.noticeSignals).toEqual([]);
    expect(result.skippedUnknownInstruments).toBe(1);
    // 前向行数含主表外代码 (它是 vendor 侧的量), 业务日当天算前向。
    expect(result.forwardRows).toBe(1);
  });

  it(`backfill ⇒ 起点前移到业务日 − ${FUTU_CALENDAR_BACKFILL_LOOKBACK_DAYS}, 终点不变`, async () => {
    const { source, calls } = harness({});
    await source.collect({ market: 'hk', businessDate: BUSINESS_DATE, now: NOW, mode: 'backfill' });

    expect(calls[0].start).toBe(addUtcDays(BUSINESS_DATE, -FUTU_CALENDAR_BACKFILL_LOOKBACK_DAYS));
    expect(calls.at(-1)?.end).toBe(addUtcDays(BUSINESS_DATE, EARNINGS_FORWARD_HORIZON_DAYS));
  });

  it('不支持的 market ⇒ 抛且零外呼; 日历端口抛错原样上抛 (🚫 捕获后返回空)', async () => {
    const unsupported = harness({});
    await expect(
      unsupported.source.collect({
        market: 'cn',
        businessDate: BUSINESS_DATE,
        now: NOW,
        mode: 'daily',
      }),
    ).rejects.toThrow(/仅 hk \/ us/);
    expect(unsupported.calls).toHaveLength(0);

    const boom = new Error('shim 503');
    const failing = harness({
      eventsFor: () => {
        throw boom;
      },
    });
    await expect(
      failing.source.collect({
        market: 'hk',
        businessDate: BUSINESS_DATE,
        now: NOW,
        mode: 'daily',
      }),
    ).rejects.toBe(boom);
  });
});
