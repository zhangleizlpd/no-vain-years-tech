import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { AnchorColdStartUseCase } from '../../src/marketdata/anchor-cold-start.usecase';
import { COLD_START_OUTCOME } from '../../src/marketdata/anchor-cold-start.rules';
import type { AnchorDrivenSyncGate } from '../../src/marketdata/anchor-driven-sync-gate';
import type { SyncOptionContractUseCase } from '../../src/marketdata/sync-option-contract.usecase';
import type { SyncOptionSnapshotUseCase } from '../../src/marketdata/sync-option-snapshot.usecase';
import type { TradingCalendarPort } from '../../src/marketdata/trading-calendar.port';
import { SyncEarningsFiscalProfileUseCase } from '../../src/marketdata/sync-earnings-fiscal-profile.usecase';
import { HkexAnnouncementSource } from '../../src/marketdata/hkex-announcement.source';
import {
  executeFiscalProfileSet,
  parseFiscalProfileArgs,
} from '../../src/marketdata/marketdata-fiscal-profile.cli';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GetLegsUseCase } from '../../src/optionsdesk/get-legs.usecase';
import { PrismaLegRetrievalAdapter } from '../../src/optionsdesk/leg-retrieval.adapter';
import { stubTradingCalendar } from '../_support/trading-calendar-stub';
import type {
  EarningsCalendarEvent,
  EarningsCalendarPort,
} from '../../src/marketdata/earnings-calendar.port';
import {
  assembleEarningsDateSources,
  EARNINGS_DATE_SOURCE_NAMES,
  type EarningsDateBasis,
  type EarningsDateCollectResult,
  type EarningsDateSource,
  type EarningsDateSourceCapabilities,
  type EarningsDateSourceObservation,
} from '../../src/marketdata/earnings-date-source.port';
import { FutuCalendarSource } from '../../src/marketdata/futu-calendar.source';
import { HkexBoardMeetingListSource } from '../../src/marketdata/hkex-board-meeting-list.source';
import { parseBoardMeetingList } from '../../src/marketdata/hkex-board-meeting-list.rules';
import { HKEXNEWS_PROFILE } from '../../src/marketdata/hkexnews.constraint-profile';
import { DbTradingCalendarAdapter } from '../../src/marketdata/db-trading-calendar.adapter';
import {
  VendorHttpClient,
  type VendorHttpClientDeps,
} from '../../src/marketdata/vendor-http-client';
import {
  deriveStatus,
  emptyStats,
  SyncRunRecorder,
  type SyncRunStats,
} from '../../src/marketdata/sync-run.recorder';
import { SyncEarningsDatesUseCase } from '../../src/marketdata/sync-earnings-dates.usecase';
import {
  DimensionExecutorRegistry,
  dimensionSyncType,
} from '../../src/marketdata/dimension-executor';

// 079 港股财报日期主 IT。
//
// T029 财年档案 (FR-026 / FR-028 / SC-014, plan §D13; state_branches 27 / 28): 反推用例一致写入 /
// 矛盾无行 / 已有档案矛盾不覆盖; 冷启动接入 (反推抛错不改结局与运行记录、非港股不调用); 人工补录 CLI。
//
// 为什么必须真 PG: 「矛盾 ⇒ 无行」「重复补录行数不变」是唯一键 instrument_id + createMany / upsert 的
// 落库语义, 替身只能复述实现; 冷启动臂比对的是真落库的 anchor_cold_start_run 行。
// 装配 = 直接 new 贫血 usecase + 真 PrismaService (体例同 optionsdesk-045.anchor.it.spec.ts);
// 冷启动的采集本体 / 开闸 / 日历端口用 no-op 替身 (体例同 marketdata.calendar-062.tri-state.it.spec.ts)。

const NOW = new Date('2026-09-13T12:00:00+08:00');
/** 香港周六 18:00 —— 已收盘, 冷启动走完第 7 步落 no_option_chain (同 anchor-cold-start.usecase.spec.ts)。 */
const HK_SATURDAY_1800_HKT = new Date('2026-08-15T18:00+08:00');
const day = (s: string): Date => new Date(`${s}T00:00:00Z`);

let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
let prisma: PrismaService;
let fiscal: SyncEarningsFiscalProfileUseCase;
let linkSeq = 0;

beforeAll(async () => {
  db = await setupIsolatedDb();
  process.env.DATABASE_URL = db.databaseUrl;
  prisma = new PrismaService(db.databaseUrl);
  await prisma.$connect();
  fiscal = new SyncEarningsFiscalProfileUseCase(prisma);
  await prisma.tradingDay.createMany({
    data: ['hk', 'us'].flatMap((market) =>
      ['2026-08-13', '2026-08-14'].map((d) => ({ market, date: day(d) })),
    ),
    skipDuplicates: true,
  });
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.drop();
});

beforeEach(async () => {
  await prisma.earningsFiscalProfile.deleteMany();
  await prisma.announcement.deleteMany();
  await prisma.anchorColdStartRun.deleteMany();
});

async function instrument(market: string, code: string) {
  return prisma.instrument.upsert({
    where: { market_code: { market, code } },
    create: {
      market,
      code,
      name: code,
      type: 'stock',
      currency: market === 'hk' ? 'HKD' : 'USD',
      status: 'active',
    },
    update: {},
    select: { id: true, market: true, code: true },
  });
}

async function announce(instrumentId: bigint, date: string, title: string, types: string[]) {
  await prisma.announcement.create({
    data: {
      instrumentId,
      date: day(date),
      linkUrl: `https://example.test/${instrumentId}/${++linkSeq}.pdf`,
      linkText: title,
      linkType: 'PDF',
      types,
    },
  });
}

describe('079 T029 财年档案反推用例 (Testcontainers PG)', () => {
  it('年度业绩标题与年度股息期末月一致 ⇒ 档案 = 12, source 与凭据落库; 重跑不重复写', async () => {
    const inst = await instrument('hk', '00700');
    await announce(inst.id, '2025-03-19', '截至2024年12月31日止年度的末期股息', ['dividend']);
    await announce(inst.id, '2025-08-13', '二零二五年中期業績公告', ['fs_main']);
    await announce(inst.id, '2026-03-18', '截至2025年12月31日止年度之業績公告', ['fs_main']);

    expect(await fiscal.syncInstrument(inst, NOW)).toEqual({
      kind: 'written',
      month: 12,
      source: 'annual_title',
    });
    const row = await prisma.earningsFiscalProfile.findUniqueOrThrow({
      where: { instrumentId: inst.id },
    });
    expect(row).toMatchObject({
      fiscalYearEndMonth: 12,
      source: 'annual_title',
      determinedAt: NOW,
    });
    expect(row.evidence).toContain('截至2025年12月31日止年度之業績公告');
    expect(row.evidence).toContain('dividend_title');

    expect(await fiscal.syncInstrument(inst, NOW)).toEqual({ kind: 'unchanged', month: 12 });
    expect(await prisma.earningsFiscalProfile.count({ where: { instrumentId: inst.id } })).toBe(1);
  });

  it('两路矛盾 (年度业绩 12 月 vs 年度股息 6 月) ⇒ 无行 + pending conflict', async () => {
    const inst = await instrument('hk', '01429');
    await announce(inst.id, '2026-03-18', '截至2025年12月31日止年度之業績公告', ['fs_main']);
    await announce(inst.id, '2025-09-20', '截至2025年6月30日止年度的末期股息', ['dividend']);

    const outcome = await fiscal.syncInstrument(inst, NOW);

    expect(outcome).toMatchObject({ kind: 'pending', pending: 'conflict' });
    expect(await prisma.earningsFiscalProfile.count({ where: { instrumentId: inst.id } })).toBe(0);
  });

  it('近 2 年无任何可反推来源 ⇒ 无行 + pending none (🚫 代入 12)', async () => {
    const inst = await instrument('hk', '00005');
    await announce(inst.id, '2023-03-01', '截至2022年12月31日止年度之業績公告', ['fs_main']);

    expect(await fiscal.syncInstrument(inst, NOW)).toMatchObject({
      kind: 'pending',
      pending: 'none',
    });
    expect(await prisma.earningsFiscalProfile.count({ where: { instrumentId: inst.id } })).toBe(0);
  });

  it('已有档案 12 月 + 新年度业绩标题期末 6 月 ⇒ conflict, 档案不变', async () => {
    const inst = await instrument('hk', '02628');
    const seeded = await prisma.earningsFiscalProfile.create({
      data: {
        instrumentId: inst.id,
        fiscalYearEndMonth: 12,
        source: 'manual',
        evidence: 'manual: seed',
        determinedAt: day('2026-01-01'),
      },
    });
    await announce(inst.id, '2026-09-10', '截至2026年6月30日止年度之業績公告', ['fs_main']);

    expect(await fiscal.syncInstrument(inst, NOW)).toMatchObject({
      kind: 'conflict',
      profileMonth: 12,
    });
    expect(
      await prisma.earningsFiscalProfile.findUniqueOrThrow({ where: { instrumentId: inst.id } }),
    ).toEqual(seeded);
  });
});

describe('079 T029 冷启动接入财年档案', () => {
  const buildColdStart = (fiscalProfile: SyncEarningsFiscalProfileUseCase) =>
    new AnchorColdStartUseCase(
      prisma,
      { recalcSafely: async () => null } as unknown as AnchorDrivenSyncGate,
      { collect: async () => false } as unknown as SyncOptionContractUseCase,
      { collect: async () => false } as unknown as SyncOptionSnapshotUseCase,
      { classify: async () => 'non-trading' } as unknown as TradingCalendarPort,
      fiscalProfile,
    );

  const runRow = (anchorId: bigint) =>
    prisma.anchorColdStartRun.findUniqueOrThrow({
      where: { anchorId },
      select: { ticker: true, outcome: true, reason: true, targetSession: true, lastRunAt: true },
    });

  it('港股锚反推抛错 ⇒ 冷启动结局与运行记录同基线, 只 warn', async () => {
    const baseline = await buildColdStart(fiscal).run({
      anchorId: 9001n,
      ticker: 'hk:00700',
      now: HK_SATURDAY_1800_HKT,
    });
    const baselineRow = await runRow(9001n);

    const syncInstrument = vi.fn(async () => {
      throw new Error('fiscal boom');
    });
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const result = await buildColdStart({
      syncInstrument,
    } as unknown as SyncEarningsFiscalProfileUseCase).run({
      anchorId: 9001n,
      ticker: 'hk:00700',
      now: HK_SATURDAY_1800_HKT,
    });

    expect(syncInstrument).toHaveBeenCalledTimes(1);
    expect(baseline).toEqual({ settled: true, outcome: COLD_START_OUTCOME.NO_OPTION_CHAIN });
    expect(result).toEqual(baseline);
    expect(await runRow(9001n)).toEqual(baselineRow);
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('fiscal boom'))).toBe(true);
    warn.mockRestore();
  });

  it('非港股锚冷启动 ⇒ 不调用反推 (Instrument 行已就位, 非早退)', async () => {
    const syncInstrument = vi.fn(async () => ({ kind: 'unchanged', month: 12 }));
    const result = await buildColdStart({
      syncInstrument,
    } as unknown as SyncEarningsFiscalProfileUseCase).run({
      anchorId: 9002n,
      ticker: 'us:AOS',
      now: HK_SATURDAY_1800_HKT,
    });

    expect(result.settled).toBe(true);
    expect(
      await prisma.instrument.findUnique({ where: { market_code: { market: 'us', code: 'AOS' } } }),
    ).not.toBeNull();
    expect(syncInstrument).not.toHaveBeenCalled();
  });
});

describe('079 T029 人工补录 CLI', () => {
  it('--set hk:00005=12 ⇒ manual 行; 重复执行行数与各列不变; 主表外代码 ⇒ 退出码 1 且零写入', async () => {
    const inst = await instrument('hk', '00005');
    const args = parseFiscalProfileArgs(['--set', 'hk:00005=12']);

    expect(await executeFiscalProfileSet(prisma, args, NOW)).toBe(0);
    const first = await prisma.earningsFiscalProfile.findMany({ where: { instrumentId: inst.id } });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ fiscalYearEndMonth: 12, source: 'manual' });

    expect(await executeFiscalProfileSet(prisma, args, new Date(NOW.getTime() + 60_000))).toBe(0);
    expect(
      await prisma.earningsFiscalProfile.findMany({ where: { instrumentId: inst.id } }),
    ).toEqual(first);

    expect(
      await executeFiscalProfileSet(
        prisma,
        parseFiscalProfileArgs(['--set', 'hk:00005=3', '--set', 'hk:99999=12']),
        NOW,
      ),
    ).toBe(1);
    expect(
      await prisma.earningsFiscalProfile.findMany({ where: { instrumentId: inst.id } }),
    ).toEqual(first);
  });
});

// T011 来源 B 交易所公告 (FR-004 / FR-005 / FR-020 / FR-027, plan §D6; state_branches 12 / 19)。
// 为什么必须真 PG: 两个窗口是对 announcement 表的 date 区间查询 + instrument.market 关联过滤,
// 端点含不含、美股行滤不滤只有真库说了算; 替身只能复述 where 子句。
describe('079 T011 来源 B 交易所公告 (Testcontainers PG)', () => {
  const ANCHORED_TICKER = 'hk:01810';
  const INTERIM_2026_TITLE = '截至2026年6月30日止六個月之中期業績公告';
  const source = () => new HkexAnnouncementSource(prisma);

  afterAll(async () => {
    await prisma.anchor.deleteMany({ where: { ticker: ANCHORED_TICKER } });
  });

  it('日常: 刊发事实 7 天窗覆盖锚与非锚港股、補充本体被收; 通知信号单独 120 天窗 (含端点); 决议公告只计数', async () => {
    const anchored = await instrument('hk', '01810');
    await prisma.anchor.upsert({
      where: { ticker: ANCHORED_TICKER },
      create: {
        ticker: ANCHORED_TICKER,
        market: 'hk',
        v: '50',
        asof: day('2026-06-01'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
      },
      update: {},
    });
    const plain = await instrument('hk', '02015');
    const supplemented = await instrument('hk', '09992');
    const us = await instrument('us', 'AAPL');

    await announce(plain.id, '2026-09-07', '截至2026年6月30日止六個月中期業績公告', ['fs_main']);
    await announce(anchored.id, '2026-09-10', INTERIM_2026_TITLE, ['fs_main']);
    await announce(supplemented.id, '2026-09-11', '有關二零二五年年報的補充公告', ['fs_main']);
    await announce(supplemented.id, '2026-09-12', `補充公告 ${INTERIM_2026_TITLE}`, ['fs_main']);
    await announce(anchored.id, '2026-09-05', '截至2026年3月31日止三個月之業績公告', ['fs_main']);
    await announce(us.id, '2026-09-10', INTERIM_2026_TITLE, ['fs_main']);
    await announce(anchored.id, '2026-08-14', '董事會會議召開日期', ['all']);
    await announce(plain.id, '2026-05-16', '董事會會議通知', ['all']);
    await announce(supplemented.id, '2026-05-15', '董事會會議日期', ['all']);
    await announce(anchored.id, '2026-09-01', '董事會會議決議公告', ['all']);

    const result = await source().collect({
      market: 'hk',
      businessDate: '2026-09-13',
      now: NOW,
      mode: 'daily',
    });

    expect(source().capabilities('hk')).toEqual({
      forward: null,
      confirmationSignal: true,
      publicationFact: true,
    });
    expect(source().capabilities('us')).toBeNull();
    // 09-05 (业务日前 8 天) 在刊发窗外; 美股行被 market 过滤; 不含业绩公告本体的補充不算刊发。
    expect(
      result.observations.map((o) => [
        o.instrumentId,
        o.periodKey,
        o.reportKind,
        o.basis,
        o.announceDate,
        o.filedDate,
      ]),
    ).toEqual([
      [plain.id, 'P:2026-06-30', 'interim', 'filed', '2026-09-07', '2026-09-07'],
      [anchored.id, 'P:2026-06-30', 'interim', 'filed', '2026-09-10', '2026-09-10'],
      [supplemented.id, 'P:2026-06-30', 'interim', 'filed', '2026-09-12', '2026-09-12'],
    ]);
    expect(result.observations.every((o) => o.evidence?.startsWith('https://example.test/'))).toBe(
      true,
    );
    // 业务日前 30 天 / 前 120 天 (窗口端点) 出信号, 前 121 天不出; 决议公告只进 lookalike 计数。
    expect(result.noticeSignals.map((s) => [s.instrumentId, s.noticeDate, s.title])).toEqual([
      [plain.id, '2026-05-16', '董事會會議通知'],
      [anchored.id, '2026-08-14', '董事會會議召開日期'],
    ]);
    expect(result.lookalikeNoticeTitles).toBe(1);
    expect(result.unalignedPublications).toBe(0);
    // 主表外代码: announcement.instrument_id 外键指向主表 ⇒ 结构上恒 0 (与正向计数同轮断言)。
    expect(result.skippedUnknownInstruments).toBe(0);
  });

  it('标题不带期末日: 有档案 (12 月) ⇒ P:2025-06-30; 无档案同标题 ⇒ D: 键并计数 (🚫 代入 12)', async () => {
    const withProfile = await instrument('hk', '00700');
    const withoutProfile = await instrument('hk', '00005');
    await prisma.earningsFiscalProfile.create({
      data: {
        instrumentId: withProfile.id,
        fiscalYearEndMonth: 12,
        source: 'manual',
        evidence: 'manual: seed',
        determinedAt: NOW,
      },
    });
    await announce(withProfile.id, '2025-08-20', '二零二五年中期業績公告', ['fs_main']);
    await announce(withoutProfile.id, '2025-08-20', '二零二五年中期業績公告', ['fs_main']);

    const result = await source().collect({
      market: 'hk',
      businessDate: '2025-08-22',
      now: NOW,
      mode: 'daily',
    });

    expect(result.observations.map((o) => [o.instrumentId, o.periodKey, o.reportKind])).toEqual([
      [withProfile.id, 'P:2025-06-30', 'interim'],
      [withoutProfile.id, 'D:hkex_announcement:2025-08-20', null],
    ]);
    expect(result.unalignedPublications).toBe(1);
  });

  it('回填 730 天: 日常窗外的刊发事实与通知信号只在 backfill 下被收', async () => {
    const inst = await instrument('hk', '02015');
    await announce(inst.id, '2025-08-26', '截至2025年6月30日止六個月之中期業績公告', ['fs_main']);
    await announce(inst.id, '2025-08-01', '董事會會議召開日期', ['all']);
    const request = { market: 'hk', businessDate: '2026-09-13', now: NOW } as const;

    const daily = await source().collect({ ...request, mode: 'daily' });
    const backfill = await source().collect({ ...request, mode: 'backfill' });

    expect([daily.observations, daily.noticeSignals]).toEqual([[], []]);
    expect(backfill.observations.map((o) => [o.periodKey, o.announceDate])).toEqual([
      ['P:2025-06-30', '2025-08-26'],
    ]);
    expect(backfill.noticeSignals.map((s) => s.noticeDate)).toEqual(['2025-08-01']);
  });
});

// T013 合并用例采集段 (FR-013 / FR-018 / FR-020a / FR-025, plan §D8 / §D10; state_branches 17 / 21 / 22)。
// 为什么必须真 PG + 真来源: 「失败来源零写入、其余来源照写」「两轮改期留痕」是观测表唯一键 upsert 的落库
// 语义; 陈旧 / 不可判走真 `trading_day` + 覆盖声明。富途用假日历端口、清单用真 VendorHttpClient + 假 fetch
// (fixture 同 T003), 公告来源读真 announcement 表。运行状态经真 SyncRunRecorder 落 sync_run。
describe('079 T013 合并用例采集段: 来源隔离 + 失败三件套 + 观测落库', () => {
  const BOARD_LIST_PAGE = readFileSync(
    join(
      __dirname,
      '../../src/marketdata/__fixtures__/hkex-board-meeting-list/ebmn_c-2026-09-13.htm',
    ),
    'utf8',
  );
  const FUTU = 'futu_calendar';
  const ANNOUNCEMENT = 'hkex_announcement';
  const BOARD_LIST = 'hkex_board_meeting_list';
  /** 页首 10/09/2026: 业务日 09-11 ⇒ 1 个交易日 (新鲜); 09-16 ⇒ 4 个 (陈旧); 10-02 ⇒ 覆盖外 (不可判)。 */
  const FRI_0911 = new Date('2026-09-11T20:00:00+08:00');
  const SAT_0912 = new Date('2026-09-12T20:00:00+08:00');
  const WED_0916 = new Date('2026-09-16T20:00:00+08:00');
  const FRI_1002 = new Date('2026-10-02T20:00:00+08:00');
  let tencentId: bigint;

  beforeAll(async () => {
    tencentId = (await instrument('hk', '00700')).id;
    for (const code of new Set(parseBoardMeetingList(BOARD_LIST_PAGE).rows.map((r) => r.code))) {
      await instrument('hk', code);
    }
    const septemberWeekdays = Array.from(
      { length: 30 },
      (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`,
    ).filter((d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()));
    await prisma.tradingDay.createMany({
      data: septemberWeekdays.map((d) => ({ market: 'hk', date: day(d) })),
      skipDuplicates: true,
    });
    await prisma.calendarCoverage.upsert({
      where: { market: 'hk' },
      create: {
        market: 'hk',
        coveredFrom: day('2026-01-01'),
        coveredTo: day('2026-09-30'),
        servedBy: 'seed',
      },
      update: { coveredFrom: day('2026-01-01'), coveredTo: day('2026-09-30') },
    });
  });

  beforeEach(async () => {
    // T014 起 runHk 会据观测建事件 ⇒ 事件与观测一起清, 否则上一用例的事件进下一用例的逾期扫描。
    await prisma.earningsDateEvent.deleteMany();
    await prisma.earningsDateObservation.deleteMany();
  });

  const futuEvent = (earningsDate: string): EarningsCalendarEvent => ({
    underlyingSymbol: 'hk:00700',
    earningsDate,
    pubType: 'AFTER',
    periodText: '2026 Q3',
    epsActual: null,
    epsPredict: null,
    publicationTime: null,
  });

  function buildUseCase(opts: { futu: () => EarningsCalendarEvent[]; boardListStatus?: number }) {
    const calendar = {
      getWindow: async ({ start, end }: { start: string; end: string }) =>
        opts.futu().filter((e) => e.earningsDate >= start && e.earningsDate <= end),
    } as unknown as EarningsCalendarPort;
    const status = opts.boardListStatus ?? 200;
    const fetch = async () => ({
      status,
      ok: status === 200,
      json: async () => ({}),
      text: async () => (status === 200 ? BOARD_LIST_PAGE : 'Not Found'),
      headers: { get: () => null },
    });
    const http = new VendorHttpClient(HKEXNEWS_PROFILE, {
      fetch: fetch as unknown as VendorHttpClientDeps['fetch'],
      sleep: async () => undefined,
    });
    return new SyncEarningsDatesUseCase(
      prisma,
      assembleEarningsDateSources([...EARNINGS_DATE_SOURCE_NAMES], {
        futu_calendar: new FutuCalendarSource(calendar, prisma),
        hkex_announcement: new HkexAnnouncementSource(prisma),
        hkex_board_meeting_list: new HkexBoardMeetingListSource(
          http,
          prisma,
          new DbTradingCalendarAdapter(prisma),
        ),
      }),
      fiscal,
      new DbTradingCalendarAdapter(prisma),
    );
  }

  async function runRecorded(useCase: SyncEarningsDatesUseCase, now: Date) {
    const recorder = new SyncRunRecorder(prisma);
    const stats: SyncRunStats = emptyStats();
    const id = await recorder.start(dimensionSyncType('hk_earnings_date'));
    await useCase.runHk(stats, { now, mode: 'daily' });
    await recorder.finish(id, deriveStatus(stats), stats);
    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id }, select: { status: true } });
    return { stats, status: run.status };
  }

  const observations = (source: string) =>
    prisma.earningsDateObservation.count({ where: { source } });
  const seedInterimFiling = (date: string) =>
    announce(tencentId, date, '截至2026年6月30日止六個月之中期業績公告', ['fs_main']);

  it('① 清单抛错 (404) ⇒ partial + 来源失败 finding + 清单观测 0 条; 富途与公告观测照写', async () => {
    await seedInterimFiling('2026-09-09');
    const { stats, status } = await runRecorded(
      buildUseCase({ futu: () => [futuEvent('2026-09-20')], boardListStatus: 404 }),
      FRI_0911,
    );

    expect(await observations(FUTU)).toBeGreaterThan(0);
    expect(await observations(ANNOUNCEMENT)).toBeGreaterThan(0);
    expect(stats.findings).toContainEqual(
      expect.objectContaining({
        kind: 'failure',
        symbol: `source:${BOARD_LIST}`,
        step: 'earnings_date_source',
        error: expect.stringContaining('404'),
      }),
    );
    expect(status).toBe('partial');
    expect(stats).toMatchObject({ scanned: 3, ok: 2, failed: 1 });
    expect(await observations(BOARD_LIST)).toBe(0);
  });

  it('② 富途抛错 ⇒ partial + 来源失败 finding + 富途观测 0 条; 清单与公告观测照写', async () => {
    await seedInterimFiling('2026-09-09');
    const { stats, status } = await runRecorded(
      buildUseCase({
        futu: () => {
          throw new Error('futu shim down');
        },
      }),
      FRI_0911,
    );

    expect(await observations(BOARD_LIST)).toBeGreaterThan(0);
    expect(await observations(ANNOUNCEMENT)).toBeGreaterThan(0);
    expect(stats.findings).toContainEqual(
      expect.objectContaining({
        kind: 'failure',
        symbol: `source:${FUTU}`,
        step: 'earnings_date_source',
        error: expect.stringContaining('futu shim down'),
      }),
    );
    expect(status).toBe('partial');
    expect(stats).toMatchObject({ ok: 2, failed: 1 });
    expect(await observations(FUTU)).toBe(0);
  });

  it('③ 清单页首落后 4 个交易日 (stale: true) ⇒ partial + stale finding, 清单观测照写', async () => {
    const { stats, status } = await runRecorded(
      buildUseCase({ futu: () => [futuEvent('2026-09-20')] }),
      WED_0916,
    );

    expect(await observations(BOARD_LIST)).toBeGreaterThan(0);
    expect(stats.findings).toContainEqual(
      expect.objectContaining({
        kind: 'failure',
        symbol: `source:${BOARD_LIST}`,
        step: 'earnings_board_list_stale',
      }),
    );
    expect(stats.findings.some((f) => 'step' in f && f.step === 'earnings_date_source')).toBe(
      false,
    );
    expect(stats).toMatchObject({ ok: 3, failed: 1 });
    expect(status).toBe('partial');
  });

  it('④ 陈旧判定区间落在日历覆盖外 (stale: unknown) ⇒ success + calendar unknown finding, 🚫 计失败', async () => {
    const { stats, status } = await runRecorded(
      buildUseCase({ futu: () => [futuEvent('2026-10-10')] }),
      FRI_1002,
    );

    expect(await observations(BOARD_LIST)).toBeGreaterThan(0);
    expect(await observations(FUTU)).toBeGreaterThan(0);
    expect(stats.findings).toContainEqual(
      expect.objectContaining({
        kind: 'unjudged',
        symbol: `source:${BOARD_LIST}`,
        step: 'earnings_date_calendar_unknown',
      }),
    );
    expect(status).toBe('success');
    expect(stats).toMatchObject({ ok: 3, failed: 0 });
  });

  it('⑤ 同一观测两轮日期不同 ⇒ 上一个日期与变更时刻落库, 首次观测不动; 清单最近观测时刻 = 本轮', async () => {
    let futuDate = '2026-09-20';
    const useCase = buildUseCase({ futu: () => [futuEvent(futuDate)] });
    await runRecorded(useCase, FRI_0911);
    futuDate = '2026-09-22';
    await runRecorded(useCase, SAT_0912);

    const rows = await prisma.earningsDateObservation.findMany({
      where: { source: FUTU, instrumentId: tencentId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      announceDate: day('2026-09-22'),
      prevDate: day('2026-09-20'),
      dateChangedAt: SAT_0912,
      firstSeenAt: FRI_0911,
      lastSeenAt: SAT_0912,
    });
    const listRows = await prisma.earningsDateObservation.findMany({
      where: { source: BOARD_LIST },
    });
    expect(listRows.length).toBeGreaterThan(0);
    expect(listRows.every((r) => r.lastSeenAt.getTime() === SAT_0912.getTime())).toBe(true);
    expect(listRows.every((r) => r.firstSeenAt.getTime() === FRI_0911.getTime())).toBe(true);
    expect(listRows.every((r) => r.prevDate === null)).toBe(true);
  });
});

// T014 合并用例 ②: 事件合并编排 + 乐观并发 + 占位事件 + 美股增量入口 (FR-007 / FR-012 / FR-016 / FR-017 /
// FR-021 / SC-005, plan §D8; state_branches 4 / 9 / 10 / 16)。
// 为什么必须真 PG: `revision` 条件更新的命中行数、唯一键 (instrument_id, period_key)、流水外键与「事件总数
// 不减」都是落库语义, 替身只能复述实现; 交易日数走真 trading_day + 覆盖声明。公告来源用真
// HkexAnnouncementSource (120 天信号窗口在代码路径上), 富途与清单用按轮改写的脚本化假来源 (合并用例只认
// port 契约, FR-001)。
const ANNOUNCED_ONLY: EarningsDateSourceCapabilities = {
  forward: 'announced_only',
  confirmationSignal: false,
  publicationFact: false,
};
const UNCONFIRMED: EarningsDateSourceCapabilities = { ...ANNOUNCED_ONLY, forward: 'unconfirmed' };
const ZERO_COUNTS = {
  dataRows: 0,
  resultRows: 0,
  dividendOnlyRows: 0,
  textPeriodKeyRows: 0,
  nonStandardMonthRows: 0,
};
const INTERIM = 'P:2026-06-30';
const NOTICE_TITLE = '董事會會議召開日期';

type Round = { current: Partial<EarningsDateCollectResult> };

/** 6–9 月港股工作日 = 交易日 (覆盖声明同 T013 段)。幂等。 */
async function seedHkTradingDays(): Promise<void> {
  const days: { market: string; date: Date }[] = [];
  for (let t = Date.UTC(2026, 5, 1); t <= Date.UTC(2026, 8, 30); t += 86_400_000) {
    if (![0, 6].includes(new Date(t).getUTCDay())) days.push({ market: 'hk', date: new Date(t) });
  }
  await prisma.tradingDay.createMany({ data: days, skipDuplicates: true });
  await prisma.calendarCoverage.upsert({
    where: { market: 'hk' },
    create: {
      market: 'hk',
      coveredFrom: day('2026-01-01'),
      coveredTo: day('2026-09-30'),
      servedBy: 'seed',
    },
    update: { coveredFrom: day('2026-01-01'), coveredTo: day('2026-09-30') },
  });
}

async function resetMergeTables(): Promise<void> {
  await prisma.earningsDateEvent.deleteMany();
  await prisma.earningsDateObservation.deleteMany();
  await prisma.earningsMeetingLag.deleteMany();
}

/** 按轮脚本化的假来源：`round.current` 由用例在两轮之间改写。 */
const scripted = (
  capabilities: (market: string) => EarningsDateSourceCapabilities | null,
  round: Round,
): EarningsDateSource => ({
  name: 'scripted',
  capabilities,
  collect: async () => ({
    observations: [],
    noticeSignals: [],
    skippedUnknownInstruments: 0,
    ...round.current,
  }),
});
const hkOnly = (market: string) => (market === 'hk' ? ANNOUNCED_ONLY : null);

const obs = (
  instrumentId: bigint,
  basis: EarningsDateBasis,
  date: string,
): EarningsDateSourceObservation => ({
  instrumentId,
  periodKey: INTERIM,
  reportKind: 'interim',
  periodEnd: '2026-06-30',
  periodText: null,
  basis,
  announceDate: basis === 'meeting' ? null : date,
  meetingDate: basis === 'meeting' ? date : null,
  publicationTime: null,
  filedDate: null,
  evidence: null,
});
/** 清单形态: 观测 + 本轮在清单的键 + 页首日期。 */
const listing = (pageDate: string, observations: EarningsDateSourceObservation[]) => ({
  observations,
  listedPeriodKeys: observations.map(({ instrumentId, periodKey }) => ({
    instrumentId,
    periodKey,
  })),
  boardListScan: { pageDate, counts: ZERO_COUNTS },
});

const buildMerge = (futu: Round, board: Round, futuCaps = hkOnly) =>
  new SyncEarningsDatesUseCase(
    prisma,
    assembleEarningsDateSources([...EARNINGS_DATE_SOURCE_NAMES], {
      futu_calendar: scripted(futuCaps, futu),
      hkex_announcement: new HkexAnnouncementSource(prisma),
      hkex_board_meeting_list: scripted(hkOnly, board),
    }),
    fiscal,
    new DbTradingCalendarAdapter(prisma),
  );
/** 香港当地 `date` 23:30 跑一轮 (业务日 = `date`)。 */
const at = (date: string) => new Date(`${date}T23:30:00+08:00`);
const runOn = (useCase: SyncEarningsDatesUseCase, date: string) =>
  useCase.runHk(emptyStats(), { now: at(date), mode: 'daily' });
const eventOf = (instrumentId: bigint, periodKey = INTERIM) =>
  prisma.earningsDateEvent.findUniqueOrThrow({
    where: { instrumentId_periodKey: { instrumentId, periodKey } },
    include: { logs: { orderBy: { id: 'asc' } } },
  });

describe('079 T014 合并用例 ①–④: 事件合并编排 + 乐观并发', () => {
  beforeAll(seedHkTradingDays);
  beforeEach(resetMergeTables);

  it('① 会前通知刊发后、清单首次列出该期那一轮 ⇒ confirmed, 确认日期 = 通知刊发日而非首次观测 (SC-005)', async () => {
    const inst = await instrument('hk', '06690');
    await announce(inst.id, '2026-09-01', NOTICE_TITLE, ['all']);
    const board = { current: listing('2026-09-03', [obs(inst.id, 'meeting', '2026-09-18')]) };

    await runOn(buildMerge({ current: {} }, board), '2026-09-03');

    const listed = await prisma.earningsDateObservation.findFirstOrThrow({
      where: { instrumentId: inst.id, source: 'hkex_board_meeting_list' },
    });
    expect(listed.firstSeenAt).toEqual(at('2026-09-03'));
    expect(await eventOf(inst.id)).toMatchObject({
      status: 'confirmed',
      announceDate: day('2026-09-18'),
      announceBasis: 'meeting',
      confirmedDate: day('2026-09-01'),
      confirmedBasis: 'announced',
    });
    // 该期已由带日期事件承接 ⇒ 不建占位事件 (事件数恰为 1)。
    expect(await prisma.earningsDateEvent.count({ where: { instrumentId: inst.id } })).toBe(1);
  });

  it('② 两精确口径冲突 ⇒ conflict + 全部日期可查; 次日一致 ⇒ confirmed + 解除留痕', async () => {
    const inst = await instrument('hk', '02331');
    const futu = { current: { observations: [obs(inst.id, 'explicit', '2026-09-20')] } };
    const board = { current: listing('2026-09-07', [obs(inst.id, 'explicit', '2026-09-22')]) };
    const useCase = buildMerge(futu, board);

    await runOn(useCase, '2026-09-07');
    const conflicted = await eventOf(inst.id);
    expect(conflicted).toMatchObject({ status: 'conflict', announceDate: null });
    expect(conflicted.conflictCandidates).toEqual([
      { source: 'futu_calendar', basis: 'explicit', date: '2026-09-20' },
      { source: 'hkex_board_meeting_list', basis: 'explicit', date: '2026-09-22' },
    ]);

    board.current = listing('2026-09-08', [obs(inst.id, 'explicit', '2026-09-20')]);
    await runOn(useCase, '2026-09-08');
    const resolved = await eventOf(inst.id);
    expect(resolved).toMatchObject({
      status: 'confirmed',
      announceDate: day('2026-09-20'),
      conflictCandidates: null,
    });
    expect(resolved.logs).toContainEqual(
      expect.objectContaining({
        kind: 'status_changed',
        fromStatus: 'conflict',
        toStatus: 'confirmed',
        detail: expect.objectContaining({ resolvedCandidates: conflicted.conflictCandidates }),
      }),
    );
  });

  it('③ 通知第 1 天、富途日期第 30 天才出现、第 40 天改期 ⇒ 每轮确认日期都 = 通知刊发日 (排序铁律 4)', async () => {
    const inst = await instrument('hk', '09618');
    await announce(inst.id, '2026-07-01', NOTICE_TITLE, ['all']);
    const futu: Round = { current: {} };
    const useCase = buildMerge(futu, { current: {} });

    await runOn(useCase, '2026-07-01');
    expect(await prisma.earningsDateEvent.count({ where: { instrumentId: inst.id } })).toBe(0);

    futu.current = { observations: [obs(inst.id, 'structured', '2026-08-25')] };
    await runOn(useCase, '2026-07-30');
    expect(await eventOf(inst.id)).toMatchObject({
      announceDate: day('2026-08-25'),
      confirmedDate: day('2026-07-01'),
      confirmedBasis: 'announced',
    });

    futu.current = { observations: [obs(inst.id, 'structured', '2026-08-27')] };
    await runOn(useCase, '2026-08-09');
    const rescheduled = await eventOf(inst.id);
    expect(rescheduled).toMatchObject({
      status: 'confirmed',
      announceDate: day('2026-08-27'),
      confirmedDate: day('2026-07-01'),
      confirmedBasis: 'announced',
    });
    expect(rescheduled.logs.map((l) => l.kind)).toContain('date_rescheduled');
  });

  it('④ 两次合并交错写同一事件 ⇒ revision 冲突重读重算, 确认日期不被旧读覆盖', async () => {
    const inst = await instrument('hk', '01024');
    const futu: Round = { current: { observations: [obs(inst.id, 'structured', '2026-09-25')] } };
    const useCase = buildMerge(futu, { current: {} });
    await runOn(useCase, '2026-09-07');
    const first = await eventOf(inst.id);
    expect(first).toMatchObject({
      confirmedDate: day('2026-09-07'),
      confirmedBasis: 'first_seen',
      revision: 0,
    });

    // 交错: 本轮读完事件、进事务之前, 另一轮 (带通知信号) 已把确认日期前移为 announced 并涨了 revision。
    const original = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    const transaction = vi.spyOn(prisma, '$transaction').mockImplementationOnce((async (
      ...args: unknown[]
    ) => {
      await prisma.earningsDateEvent.update({
        where: { id: first.id },
        data: {
          confirmedDate: day('2026-08-20'),
          confirmedBasis: 'announced',
          revision: { increment: 1 },
        },
      });
      return original(...args);
    }) as never);
    futu.current = { observations: [obs(inst.id, 'structured', '2026-09-26')] };
    let attempts = 0;
    try {
      await runOn(useCase, '2026-09-08');
    } finally {
      attempts = transaction.mock.calls.length;
      transaction.mockRestore();
    }

    expect(attempts).toBe(2);
    expect(await eventOf(inst.id)).toMatchObject({
      announceDate: day('2026-09-26'),
      confirmedDate: day('2026-08-20'),
      confirmedBasis: 'announced',
      revision: 2,
    });
  });
});

describe('079 T014 合并用例 ⑤⑥: 美股增量入口 + 已通知日期未知占位事件', () => {
  beforeAll(seedHkTradingDays);
  beforeEach(resetMergeTables);

  it('⑤ 增量入口传入 2 个美股键 ⇒ 生成 2 个 unconfirmed 事件 (公布日已过也不判逾期)', async () => {
    const keys = await Promise.all(['NVDA', 'MSFT'].map((code) => instrument('us', code)));
    const usCaps = (market: string) => (market === 'us' ? UNCONFIRMED : hkOnly(market));
    const useCase = buildMerge({ current: {} }, { current: {} }, usCaps);
    const now = new Date('2026-09-08T06:00:00-04:00');
    const usObservations = keys.map((i) => ({
      ...obs(i.id, 'structured', '2026-08-20'),
      periodKey: 'T:futu_calendar:2026 Q3',
      reportKind: null,
      periodEnd: null,
      periodText: '2026 Q3',
    }));
    await useCase.recordObservations('futu_calendar', 'us', usObservations, now, emptyStats());

    const summary = await useCase.mergeIncremental({
      market: 'us',
      now,
      keys: usObservations.map(({ instrumentId, periodKey }) => ({ instrumentId, periodKey })),
    });

    const events = await prisma.earningsDateEvent.findMany({ where: { market: 'us' } });
    expect(events).toHaveLength(2);
    expect(summary.eventsWritten).toBe(2);
    expect(events.every((e) => e.status === 'unconfirmed' && e.confirmedDate === null)).toBe(true);
  });

  it('⑥ 占位事件: 起手反推财年 → 迁入建 D:notice_undated: 占位 → 停留不进合并 → 被接手迁 superseded, 事件总数不减', async () => {
    const TICKER = 'hk:02020';
    const PLACEHOLDER = 'D:notice_undated:2026-09-01';
    const inst = await instrument('hk', '02020');
    await prisma.anchor.upsert({
      where: { ticker: TICKER },
      create: {
        ticker: TICKER,
        market: 'hk',
        v: '50',
        asof: day('2026-06-01'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
      },
      update: {},
    });
    try {
      await announce(inst.id, '2026-03-17', '截至2025年12月31日止年度之業績公告', ['fs_main']);
      await announce(inst.id, '2026-03-17', '截至2025年12月31日止年度的末期股息', ['dividend']);
      await announce(inst.id, '2026-09-01', NOTICE_TITLE, ['all']);
      // 曾在清单: 上一期 (年度) 的清单观测。
      await prisma.earningsDateObservation.create({
        data: {
          source: 'hkex_board_meeting_list',
          instrumentId: inst.id,
          periodKey: 'P:2025-12-31',
          market: 'hk',
          reportKind: 'annual',
          periodEnd: day('2025-12-31'),
          basis: 'meeting',
          meetingDate: day('2026-03-15'),
          firstSeenAt: day('2026-03-10'),
          lastSeenAt: day('2026-03-10'),
        },
      });
      const futu: Round = { current: {} };
      const useCase = buildMerge(futu, { current: {} });

      // 09-01 通知 → 09-03 满 2 个交易日、无任何日期。
      const entered = await runOn(useCase, '2026-09-03');
      expect(entered.fiscalProfiles.written).toBe(1);
      expect(
        await prisma.earningsFiscalProfile.findUniqueOrThrow({ where: { instrumentId: inst.id } }),
      ).toMatchObject({ fiscalYearEndMonth: 12 });
      const placeholder = await eventOf(inst.id, PLACEHOLDER);
      expect(placeholder).toMatchObject({
        status: 'notified_undated',
        confirmedDate: day('2026-09-01'),
        confirmedBasis: 'announced',
      });
      expect(placeholder.logs).toMatchObject([
        { kind: 'status_changed', fromStatus: null, toStatus: 'notified_undated' },
      ]);
      expect(entered.merge.findings).toContainEqual({
        instrumentId: inst.id,
        symbol: TICKER,
        finding: expect.objectContaining({
          step: 'earnings_notice_undated',
          countsAsFailure: true,
        }),
      });

      // 停留一轮: 🚨 占位事件进逐事件合并会被静默算成 confirmed。
      const stayed = await runOn(useCase, '2026-09-04');
      expect(await eventOf(inst.id, PLACEHOLDER)).toMatchObject({
        status: 'notified_undated',
        revision: 0,
      });
      expect(stayed.merge.findings.map((f) => f.finding.step)).not.toContain(
        'earnings_notice_undated',
      );

      // 富途给出该期日期 ⇒ 占位事件被接手。
      const before = await prisma.earningsDateEvent.count({ where: { instrumentId: inst.id } });
      futu.current = { observations: [obs(inst.id, 'structured', '2026-09-25')] };
      await runOn(useCase, '2026-09-07');
      const successor = await eventOf(inst.id);
      expect(successor).toMatchObject({
        status: 'confirmed',
        confirmedDate: day('2026-09-01'),
        confirmedBasis: 'announced',
      });
      const superseded = await eventOf(inst.id, PLACEHOLDER);
      expect(superseded.status).toBe('superseded');
      expect(superseded.logs.at(-1)).toMatchObject({
        kind: 'status_changed',
        fromStatus: 'notified_undated',
        toStatus: 'superseded',
        detail: { supersededBy: successor.id.toString(), supersededByPeriodKey: INTERIM },
      });
      expect(await prisma.earningsDateEvent.count({ where: { instrumentId: inst.id } })).toBe(
        before + 1,
      );
    } finally {
      await prisma.anchor.deleteMany({ where: { ticker: TICKER } });
    }
  });
});

// T015 findings 其余出口 + 迁入标红计数 (FR-017 / FR-019a / FR-023 / FR-026 / FR-028 / SC-011, plan §D10;
// state_branches 11 / 14)。经真 SyncRunRecorder 收尾, 断言落库的 sync_run.status —— 日报只读运行状态、
// 不按 step 判红, 计数错了飞书就不标红 (或连日标红)。
const seedProfile = (instrumentId: bigint) =>
  prisma.earningsFiscalProfile.create({
    data: {
      instrumentId,
      fiscalYearEndMonth: 12,
      source: 'manual',
      evidence: 'manual: seed',
      determinedAt: day('2026-01-01'),
    },
  });

/** 一轮 runHk 经真 SyncRunRecorder 收尾 ⇒ 返回 stats 与落库的运行状态。 */
async function recordedRun(useCase: SyncEarningsDatesUseCase, date: string) {
  const recorder = new SyncRunRecorder(prisma);
  const stats: SyncRunStats = emptyStats();
  const id = await recorder.start(dimensionSyncType('hk_earnings_date'));
  await useCase.runHk(stats, { now: at(date), mode: 'daily' });
  await recorder.finish(id, deriveStatus(stats), stats);
  const run = await prisma.syncRun.findUniqueOrThrow({ where: { id }, select: { status: true } });
  return { stats, status: run.status };
}

const steps = (stats: SyncRunStats, step: string) =>
  stats.findings.filter((f) => 'step' in f && f.step === step);

describe('079 T015 迁入标红计数 ①②: overdue / notified_undated 只在迁入那一轮计失败', () => {
  beforeAll(seedHkTradingDays);
  beforeEach(resetMergeTables);

  it('① 事件迁入 overdue ⇒ 该轮 failed = 迁入事件数 + partial; 次轮仍 overdue ⇒ failed 0 + success', async () => {
    const pair = await Promise.all(['00981', '00992'].map((code) => instrument('hk', code)));
    for (const i of pair) await seedProfile(i.id);
    // 公布日 09-07 (周一) → 09-09 满 2 个交易日。
    const futu: Round = {
      current: { observations: pair.map((i) => obs(i.id, 'structured', '2026-09-07')) },
    };
    const useCase = buildMerge(futu, { current: {} });

    const entered = await recordedRun(useCase, '2026-09-09');
    const overdue = steps(entered.stats, 'earnings_date_overdue');
    expect(overdue).toHaveLength(2);
    expect(overdue).toContainEqual({
      kind: 'notice',
      step: 'earnings_date_overdue',
      detail: expect.objectContaining({ symbol: 'hk:00981', periodKey: INTERIM }),
    });
    expect(entered.stats.failed).toBe(overdue.length);
    expect(entered.status).toBe('partial');

    const stayed = await recordedRun(useCase, '2026-09-10');
    for (const i of pair) expect((await eventOf(i.id)).status).toBe('overdue');
    expect(stayed.stats.failed).toBe(0);
    expect(stayed.status).toBe('success');
  });

  it('② 曾在清单的标的迁入 notified_undated ⇒ 同形; 从未在清单的同形通知只计数', async () => {
    const [listed, neverListed] = await Promise.all(
      ['02382', '08083'].map((code) => instrument('hk', code)),
    );
    for (const i of [listed, neverListed]) {
      await seedProfile(i.id);
      await announce(i.id, '2026-09-01', NOTICE_TITLE, ['all']);
    }
    await prisma.earningsDateObservation.create({
      data: {
        source: 'hkex_board_meeting_list',
        instrumentId: listed.id,
        periodKey: 'P:2025-12-31',
        market: 'hk',
        reportKind: 'annual',
        periodEnd: day('2025-12-31'),
        basis: 'meeting',
        meetingDate: day('2026-03-15'),
        firstSeenAt: day('2026-03-10'),
        lastSeenAt: day('2026-03-10'),
      },
    });
    const useCase = buildMerge({ current: {} }, { current: {} });

    const entered = await recordedRun(useCase, '2026-09-03');
    const undated = steps(entered.stats, 'earnings_notice_undated');
    expect(undated).toContainEqual({
      kind: 'notice',
      step: 'earnings_notice_undated',
      detail: expect.objectContaining({ symbol: 'hk:02382', noticeDate: '2026-09-01' }),
    });
    expect(undated).toContainEqual({
      kind: 'notice',
      step: 'earnings_notice_undated',
      detail: { neverListed: 1, symbols: ['hk:08083'] },
    });
    expect(entered.stats.failed).toBe(1);
    expect(entered.status).toBe('partial');

    const stayed = await recordedRun(useCase, '2026-09-04');
    expect((await eventOf(listed.id, 'D:notice_undated:2026-09-01')).status).toBe(
      'notified_undated',
    );
    expect(stayed.stats.failed).toBe(0);
    expect(stayed.status).toBe('success');
  });
});

describe('079 T015 findings 出口 ③④: 各 step / kind 与 plan §D10 表一致, 🚫 计失败', () => {
  beforeAll(seedHkTradingDays);
  beforeEach(resetMergeTables);

  it('③ 只有冲突 / 清单行消失 / 未对齐 finding 的一轮 ⇒ 这些 finding 条数 > 0, failed 0 + success', async () => {
    const [conflicted, dropped, unaligned] = await Promise.all(
      ['00020', '00268', '00772'].map((code) => instrument('hk', code)),
    );
    const futu: Round = {
      current: { observations: [obs(conflicted.id, 'explicit', '2026-09-20')] },
    };
    const board: Round = {
      current: listing('2026-09-07', [obs(dropped.id, 'meeting', '2026-09-25')]),
    };
    const useCase = buildMerge(futu, board);
    await recordedRun(useCase, '2026-09-07');

    futu.current = {
      observations: [
        obs(conflicted.id, 'explicit', '2026-09-20'),
        {
          ...obs(unaligned.id, 'structured', '2026-09-30'),
          periodKey: 'T:futu_calendar:2026 Q3',
          reportKind: null,
          periodEnd: null,
        },
      ],
    };
    board.current = listing('2026-09-08', [obs(conflicted.id, 'explicit', '2026-09-22')]);
    const { stats, status } = await recordedRun(useCase, '2026-09-08');

    for (const step of [
      'earnings_date_conflict',
      'earnings_board_list_dropped',
      'earnings_date_unaligned',
    ]) {
      expect(steps(stats, step).length, step).toBeGreaterThan(0);
    }
    expect(steps(stats, 'earnings_date_conflict')).toEqual([
      expect.objectContaining({
        kind: 'notice',
        detail: expect.objectContaining({ symbol: 'hk:00020' }),
      }),
    ]);
    expect(steps(stats, 'earnings_board_list_dropped')).toEqual([
      expect.objectContaining({
        kind: 'notice',
        detail: expect.objectContaining({ symbol: 'hk:00268' }),
      }),
    ]);
    expect(steps(stats, 'earnings_date_unaligned')).toEqual([
      expect.objectContaining({ kind: 'notice', detail: expect.objectContaining({ count: 1 }) }),
    ]);
    expect(steps(stats, 'earnings_board_list_scan')).toEqual([
      {
        kind: 'notice',
        step: 'earnings_board_list_scan',
        detail: {
          source: 'hkex_board_meeting_list',
          pageDate: '2026-09-08',
          ...ZERO_COUNTS,
          skippedUnknownInstruments: 0,
          noticeSignals: 0,
        },
      },
    ]);
    expect(stats.failed).toBe(0);
    expect(status).toBe('success');
  });

  it('④ 财年未知 (每轮一条) / 财年待补 / 财年矛盾 / 逾期日历不可判 ⇒ kind 与 §D10 表一致, 🚫 计失败', async () => {
    const [pending, conflict, noProfile, beforeCoverage] = await Promise.all(
      ['03690', '00388', '02318', '00883'].map((code) => instrument('hk', code)),
    );
    const anchored = [`hk:${pending.code}`, `hk:${conflict.code}`];
    for (const ticker of anchored) {
      await prisma.anchor.upsert({
        where: { ticker },
        create: {
          ticker,
          market: 'hk',
          v: '50',
          asof: day('2026-06-01'),
          method: 'dcf',
          confidence: '8',
          confidenceSource: 'manual',
          lLevelEffective: 'L2',
        },
        update: {},
      });
    }
    try {
      await seedProfile(conflict.id);
      await announce(conflict.id, '2026-09-04', '截至2026年6月30日止年度之業績公告', ['fs_main']);
      // 无档案标的公布日 09-01 已过 4 个交易日; 另一标的公布日落在日历覆盖 (2026-01-01 起) 之前。
      const futu: Round = {
        current: {
          observations: [
            obs(noProfile.id, 'structured', '2026-09-01'),
            obs(beforeCoverage.id, 'structured', '2025-12-20'),
          ],
        },
      };
      const { stats, status } = await recordedRun(buildMerge(futu, { current: {} }), '2026-09-07');

      expect(steps(stats, 'earnings_fiscal_profile_pending')).toEqual([
        {
          kind: 'notice',
          step: 'earnings_fiscal_profile_pending',
          detail: expect.objectContaining({ symbol: 'hk:03690', pending: 'none' }),
        },
      ]);
      expect(steps(stats, 'earnings_fiscal_profile_conflict')).toEqual([
        {
          kind: 'notice',
          step: 'earnings_fiscal_profile_conflict',
          detail: expect.objectContaining({ symbol: 'hk:00388' }),
        },
      ]);
      expect(steps(stats, 'earnings_date_fiscal_unknown')).toEqual([
        {
          kind: 'notice',
          step: 'earnings_date_fiscal_unknown',
          detail: { count: 1, samples: ['hk:02318'] },
        },
      ]);
      expect(steps(stats, 'earnings_date_calendar_unknown')).toEqual([
        expect.objectContaining({ kind: 'unjudged', symbol: 'hk:00883' }),
      ]);
      expect(stats.failed).toBe(0);
      expect(status).toBe('success');
    } finally {
      await prisma.anchor.deleteMany({ where: { ticker: { in: anchored } } });
    }
  });

  it('⑤ 富途港股前向行数 (plan §D5 运行时不变量) ⇒ 每轮一条 notice、计数 = 来源给出值, 🚫 计失败', async () => {
    const inst = await instrument('hk', '01211');
    const futu: Round = {
      current: { observations: [obs(inst.id, 'structured', '2026-09-25')], forwardRows: 7 },
    };
    const { stats, status } = await recordedRun(buildMerge(futu, { current: {} }), '2026-09-08');

    expect(await prisma.earningsDateEvent.count({ where: { instrumentId: inst.id } })).toBe(1);
    expect(steps(stats, 'earnings_date_futu_forward_rows')).toEqual([
      {
        kind: 'notice',
        step: 'earnings_date_futu_forward_rows',
        detail: { source: 'futu_calendar', forwardRows: 7 },
      },
    ]);
    expect(stats.failed).toBe(0);
    expect(status).toBe('success');
  });
});

// T016 维度执行入口 (plan §D9; T017–T019 / T022 经维度运行的臂复用): 走生产同一条
// `DimensionExecutorRegistry.execute` → 执行器 → `runHk`, 运行记录由注册表自己开 / 收 (`sync:<key>`)。
// 只装本维度用得到的位置 (prisma / recorder / 第 35 位 use case); 其余留 undefined —— 可选位的
// 默认值是真实例 + null-object 端口, 前 6 位与 tierRecalc 只被别的维度的执行器闭包引用。
const viaDimension = (useCase: SyncEarningsDatesUseCase) =>
  new DimensionExecutorRegistry(
    undefined as never, // 1 syncUniverse
    undefined as never, // 2 syncProfile
    undefined as never, // 3 eodBar
    undefined as never, // 4 fundamental
    undefined as never, // 5 financials
    undefined as never, // 6 corporateAction
    prisma, // 7
    new SyncRunRecorder(prisma), // 8
    undefined as never, // 9 tierRecalc (本维度不走 fact 前置)
    undefined, // 10 backfillPacer
    undefined, // 11 shortSelling
    undefined, // 12 connectHolding
    undefined, // 13 fundHolding
    undefined, // 14 fundCompanyHolding
    undefined, // 15 indexMembership
    undefined, // 16 volatility
    undefined, // 17 hotSnapshot
    undefined, // 18 buyback
    undefined, // 19 equityChange
    undefined, // 20 shareholderChange
    undefined, // 21 allotment
    undefined, // 22 revenueSegment
    undefined, // 23 shareholderSnapshot
    undefined, // 24 employee
    undefined, // 25 industryClassification
    undefined, // 26 announcement
    undefined, // 27 anchorGate
    undefined, // 28 underlyingIv
    undefined, // 29 usIndex
    undefined, // 30 syncOptionContract
    undefined, // 31 syncOptionSnapshot
    undefined, // 32 syncEarningsEvent
    undefined, // 33 tradingCalendar
    undefined, // 34 syncOptionOiSettle
    useCase, // 35 syncEarningsDates
  );

describe('079 T016 经维度执行: DimensionExecutorRegistry.execute(hk_earnings_date) 跑通三来源一轮', () => {
  beforeAll(seedHkTradingDays);
  beforeEach(resetMergeTables);

  it('三来源观测均落库、事件数 > 0、sync:hk_earnings_date 运行记录 success', async () => {
    const meituan = await instrument('hk', '03690');
    const xiaomi = await instrument('hk', '01810');
    await announce(xiaomi.id, '2026-09-09', '截至2026年6月30日止六個月之中期業績公告', ['fs_main']);
    const registry = viaDimension(
      buildMerge(
        { current: { observations: [obs(meituan.id, 'structured', '2026-09-25')] } },
        { current: listing('2026-09-11', [obs(meituan.id, 'meeting', '2026-09-25')]) },
      ),
    );

    const result = await registry.execute('hk_earnings_date', {
      mode: 'delta',
      asOf: '2026-09-11',
      now: at('2026-09-11'),
    });

    // 先断言有东西: 事件表为空时下面的运行状态断言照样成立, 证明不了执行器真调到了 runHk。
    expect(await prisma.earningsDateEvent.count()).toBeGreaterThan(0);
    for (const source of EARNINGS_DATE_SOURCE_NAMES) {
      expect(
        await prisma.earningsDateObservation.count({ where: { source } }),
        `来源 ${source} 本轮零观测`,
      ).toBeGreaterThan(0);
    }
    expect(result.budgetExhausted).toBe(false);
    const run = await prisma.syncRun.findFirstOrThrow({
      where: { syncType: 'sync:hk_earnings_date' },
      orderBy: { id: 'desc' },
      select: { status: true, failed: true },
    });
    expect(run).toEqual({ status: 'success', failed: 0 });
  });
});

/** 经维度执行跑一轮 (香港当地 `date` 23:30) ⇒ 该轮 `sync:hk_earnings_date` 运行记录 (T017 / T018)。 */
async function dimensionRun(useCase: SyncEarningsDatesUseCase, date: string) {
  await viaDimension(useCase).execute('hk_earnings_date', {
    mode: 'delta',
    asOf: date,
    now: at(date),
  });
  const run = await prisma.syncRun.findFirstOrThrow({
    where: { syncType: dimensionSyncType('hk_earnings_date') },
    orderBy: { id: 'desc' },
    select: { status: true, failed: true, findings: true },
  });
  const findings = (Array.isArray(run.findings) ? run.findings : []) as SyncRunStats['findings'];
  return { status: run.status, failed: run.failed, findings };
}

const runSteps = (run: { findings: SyncRunStats['findings'] }, step: string) =>
  run.findings.filter((f) => 'step' in f && f.step === step);

// T017 场景 IT ① (FR-009 / FR-010 / FR-014 / FR-015 / FR-019 / SC-006, plan §D12 #7 #13 #18): 取值、间隔学习与
// 刊发覆盖, 全部经维度执行。间隔学习跨两期同类报告 ⇒ ① 用 2025 / 2026 两个中期 (hk:00857 形态)。
describe('079 T017 场景 IT ①: 取值、间隔学习与刊发覆盖 (经维度运行)', () => {
  beforeAll(seedHkTradingDays);
  beforeEach(resetMergeTables);

  it('① hk:00857 形态: 周五会议 → 周日刊发学到间隔 2; 下一期富途记会议日 ⇒ 取推定 +2, 0 条冲突告警, 差异留痕', async () => {
    const inst = await instrument('hk', '00857');
    const meeting2025 = {
      ...obs(inst.id, 'meeting', '2025-08-22'),
      periodKey: 'P:2025-06-30',
      periodEnd: '2025-06-30',
    };
    const futu: Round = { current: {} };
    const board: Round = { current: listing('2025-08-21', [meeting2025]) };
    const useCase = buildMerge(futu, board);

    await dimensionRun(useCase, '2025-08-21');
    await announce(inst.id, '2025-08-24', '截至2025年6月30日止六個月之中期業績公告', ['fs_main']);
    await dimensionRun(useCase, '2025-08-25');

    expect(await eventOf(inst.id, 'P:2025-06-30')).toMatchObject({
      status: 'published',
      announceDate: day('2025-08-24'),
      announceBasis: 'filed',
    });

    futu.current = { observations: [obs(inst.id, 'structured', '2026-08-28')] };
    board.current = listing('2026-08-20', [obs(inst.id, 'meeting', '2026-08-28')]);
    const run = await dimensionRun(useCase, '2026-08-20');

    const next = await eventOf(inst.id);
    expect(next).toMatchObject({
      status: 'confirmed',
      announceDate: day('2026-08-30'),
      announceBasis: 'meeting',
      conflictCandidates: null,
    });
    expect(next.logs).toContainEqual(
      expect.objectContaining({
        kind: 'value_changed',
        detail: expect.objectContaining({
          reason: 'explainable_meeting_lag',
          candidates: expect.arrayContaining([
            { source: 'futu_calendar', basis: 'structured', date: '2026-08-28' },
            { source: 'hkex_board_meeting_list', basis: 'meeting', date: '2026-08-30' },
          ]),
        }),
      }),
    );
    expect(runSteps(run, 'earnings_date_conflict')).toEqual([]);
    expect(run.status).toBe('success');
    // 间隔行放最后断言: 定向变异「刊发后不更新间隔」须红在上面的 +2 取值上, 而非提前红在读间隔行。
    const lag = await prisma.earningsMeetingLag.findUniqueOrThrow({
      where: { instrumentId_reportKind: { instrumentId: inst.id, reportKind: 'interim' } },
    });
    expect(lag).toMatchObject({ lagDays: 2, periodEnd: day('2025-06-30') });
  });

  it('② 报告期无法对齐 (富途 T: 键 / 无档案标题不带期末日 D: 键) ⇒ 各自独立事件, 🚫 猜测性合并, unaligned 计数', async () => {
    const inst = await instrument('hk', '09988');
    await announce(inst.id, '2026-09-09', '2026年中期業績公告', ['fs_main']);
    const futu: Round = {
      current: {
        observations: [
          {
            ...obs(inst.id, 'structured', '2026-09-20'),
            periodKey: 'T:futu_calendar:2026 Q2',
            reportKind: null,
            periodEnd: null,
            periodText: '2026 Q2',
          },
        ],
      },
    };
    const board: Round = {
      current: listing('2026-09-10', [obs(inst.id, 'meeting', '2026-09-18')]),
    };

    const run = await dimensionRun(buildMerge(futu, board), '2026-09-10');

    const events = await prisma.earningsDateEvent.findMany({
      where: { instrumentId: inst.id },
      select: { periodKey: true, status: true, announceDate: true, announceBasis: true },
      orderBy: { periodKey: 'asc' },
    });
    expect(events).toEqual([
      {
        periodKey: 'D:hkex_announcement:2026-09-09',
        status: 'published',
        announceDate: day('2026-09-09'),
        announceBasis: 'filed',
      },
      {
        periodKey: INTERIM,
        status: 'confirmed',
        announceDate: day('2026-09-18'),
        announceBasis: 'meeting',
      },
      {
        periodKey: 'T:futu_calendar:2026 Q2',
        status: 'confirmed',
        announceDate: day('2026-09-20'),
        announceBasis: 'structured',
      },
    ]);
    expect(runSteps(run, 'earnings_date_unaligned')).toEqual([
      expect.objectContaining({ kind: 'notice', detail: expect.objectContaining({ count: 2 }) }),
    ]);
    expect(runSteps(run, 'earnings_date_conflict')).toEqual([]);
  });

  it('③ 刊发覆盖: 刊发日覆盖公布日 (口径 filed) + 各来源刊发前取值偏差 + 间隔更新 (US3 AS1)', async () => {
    const inst = await instrument('hk', '00175');
    const futu: Round = { current: { observations: [obs(inst.id, 'structured', '2026-09-09')] } };
    const board: Round = {
      current: listing('2026-09-07', [obs(inst.id, 'meeting', '2026-09-08')]),
    };
    const useCase = buildMerge(futu, board);

    await dimensionRun(useCase, '2026-09-07');
    expect(await eventOf(inst.id)).toMatchObject({
      status: 'confirmed',
      announceDate: day('2026-09-09'),
      announceBasis: 'structured',
    });

    await announce(inst.id, '2026-09-10', '截至2026年6月30日止六個月之中期業績公告', ['fs_main']);
    const run = await dimensionRun(useCase, '2026-09-10');

    const published = await eventOf(inst.id);
    expect(published).toMatchObject({
      status: 'published',
      announceDate: day('2026-09-10'),
      announceBasis: 'filed',
    });
    expect(published.logs).toContainEqual(
      expect.objectContaining({
        kind: 'status_changed',
        fromStatus: 'confirmed',
        toStatus: 'published',
      }),
    );
    expect(
      await prisma.earningsDateObservation.findMany({
        where: { instrumentId: inst.id },
        select: { source: true, deviationDays: true },
        orderBy: { source: 'asc' },
      }),
    ).toEqual([
      { source: 'futu_calendar', deviationDays: -1 },
      { source: 'hkex_announcement', deviationDays: null },
      { source: 'hkex_board_meeting_list', deviationDays: -2 },
    ]);
    const lag = await prisma.earningsMeetingLag.findUniqueOrThrow({
      where: { instrumentId_reportKind: { instrumentId: inst.id, reportKind: 'interim' } },
    });
    expect(lag.lagDays).toBe(2);
    expect(run.status).toBe('success');
  });
});

// T018 场景 IT ② (FR-016 / FR-017 / FR-019a / FR-028 / SC-011, plan §D12 #11 #14 #15 #16 #26): 状态迁移, 全部经维度
// 执行, 断言落库的 `sync:hk_earnings_date` 运行状态 (日报只读它判红)。
/**
 * T018 日历: 6–10 月工作日为交易日; 🚨 10-01 (周四) 在覆盖内且无行 = 非交易日 (假日); 覆盖声明延到 10-31
 * ⇒ 11 月起不可判 (unknown)。幂等。
 */
async function seedHolidayCalendar(): Promise<void> {
  await seedHkTradingDays();
  const october: { market: string; date: Date }[] = [];
  for (let t = Date.UTC(2026, 9, 2); t <= Date.UTC(2026, 9, 31); t += 86_400_000) {
    if (![0, 6].includes(new Date(t).getUTCDay()))
      october.push({ market: 'hk', date: new Date(t) });
  }
  await prisma.tradingDay.createMany({ data: october, skipDuplicates: true });
  await prisma.calendarCoverage.update({
    where: { market: 'hk' },
    data: { coveredTo: day('2026-10-31') },
  });
}

describe('079 T018 场景 IT ② ①②: 逾期迁入 / 停留 / 解除 + 日历不可判 + 改期 (经维度运行)', () => {
  beforeAll(seedHolidayCalendar);
  beforeEach(resetMergeTables);

  it('① 满 2 个交易日未刊发 ⇒ overdue + finding + partial (未转历史); 次轮仍逾期 success; 刊发 ⇒ published', async () => {
    const inst = await instrument('hk', '00386');
    await seedProfile(inst.id);
    const futu: Round = { current: { observations: [obs(inst.id, 'structured', '2026-09-30')] } };
    const useCase = buildMerge(futu, { current: {} });

    // 公布日 09-30 (周三) → 10-02 已是 2 个日历日, 但 10-01 假日 ⇒ 只 1 个交易日。
    const beforeDue = await dimensionRun(useCase, '2026-10-02');
    expect((await eventOf(inst.id)).status).toBe('confirmed');
    expect(beforeDue).toMatchObject({ status: 'success', failed: 0 });

    const entered = await dimensionRun(useCase, '2026-10-05');
    expect(await eventOf(inst.id)).toMatchObject({
      status: 'overdue',
      announceDate: day('2026-09-30'),
      overdueSince: at('2026-10-05'),
    });
    expect(runSteps(entered, 'earnings_date_overdue')).toEqual([
      expect.objectContaining({
        kind: 'notice',
        detail: expect.objectContaining({ symbol: 'hk:00386', periodKey: INTERIM }),
      }),
    ]);
    expect(entered).toMatchObject({ status: 'partial', failed: 1 });

    const stayed = await dimensionRun(useCase, '2026-10-06');
    expect((await eventOf(inst.id)).status).toBe('overdue');
    expect(runSteps(stayed, 'earnings_date_overdue')).toEqual([]);
    expect(stayed).toMatchObject({ status: 'success', failed: 0 });

    await announce(inst.id, '2026-10-06', '截至2026年6月30日止六個月之中期業績公告', ['fs_main']);
    await dimensionRun(useCase, '2026-10-07');
    const published = await eventOf(inst.id);
    expect(published).toMatchObject({
      status: 'published',
      announceDate: day('2026-10-06'),
      overdueSince: null,
    });
    expect(published.logs).toContainEqual(
      expect.objectContaining({
        kind: 'status_changed',
        fromStatus: 'overdue',
        toStatus: 'published',
      }),
    );
  });

  it('① 逾期判定区间落在日历覆盖外 (unknown) ⇒ 不判: 非 overdue + unjudged finding, success', async () => {
    const inst = await instrument('hk', '00390');
    await seedProfile(inst.id);
    const futu: Round = { current: { observations: [obs(inst.id, 'structured', '2026-11-02')] } };

    const run = await dimensionRun(buildMerge(futu, { current: {} }), '2026-11-04');

    expect(runSteps(run, 'earnings_date_calendar_unknown')).toEqual([
      expect.objectContaining({ kind: 'unjudged', symbol: 'hk:00390' }),
    ]);
    expect((await eventOf(inst.id)).status).toBe('confirmed');
    expect(run).toMatchObject({ status: 'success', failed: 0 });
  });

  it('② 两份清单页先后运行、同期会议日变化 ⇒ 改期流水 + 旧日期留痕 + 按新日期重判, 🚫 判消失', async () => {
    const inst = await instrument('hk', '01398');
    const board: Round = {
      current: listing('2026-09-07', [obs(inst.id, 'meeting', '2026-09-24')]),
    };
    const useCase = buildMerge({ current: {} }, board);
    await dimensionRun(useCase, '2026-09-07');

    board.current = listing('2026-09-08', [obs(inst.id, 'meeting', '2026-09-25')]);
    const run = await dimensionRun(useCase, '2026-09-08');

    const rescheduled = await eventOf(inst.id);
    expect(rescheduled).toMatchObject({ status: 'confirmed', announceDate: day('2026-09-25') });
    expect(rescheduled.logs).toContainEqual(
      expect.objectContaining({
        kind: 'date_rescheduled',
        detail: expect.objectContaining({
          source: 'hkex_board_meeting_list',
          previousDate: '2026-09-24',
          date: '2026-09-25',
        }),
      }),
    );
    expect(
      await prisma.earningsDateObservation.findFirstOrThrow({
        where: { instrumentId: inst.id, source: 'hkex_board_meeting_list' },
      }),
    ).toMatchObject({ prevDate: day('2026-09-24'), dateChangedAt: at('2026-09-08') });
    expect(runSteps(run, 'earnings_board_list_dropped')).toEqual([]);
  });
});

describe('079 T018 场景 IT ② ③④⑤: 清单行提前消失 / 已通知日期未知 / 无财年档案 (经维度运行)', () => {
  beforeAll(seedHolidayCalendar);
  beforeEach(resetMergeTables);

  it('③ 其间插一轮失败页 ⇒ 不判消失; 下一份页缺该行、会议日未到 ⇒ 提前消失 finding、确认保留', async () => {
    const [dropped, kept] = await Promise.all(['00005', '00011'].map((c) => instrument('hk', c)));
    const board: Round = {
      current: listing('2026-09-07', [
        obs(dropped.id, 'meeting', '2026-09-25'),
        obs(kept.id, 'meeting', '2026-09-28'),
      ]),
    };
    const useCase = buildMerge({ current: {} }, board);
    await dimensionRun(useCase, '2026-09-07');
    const firstSeen = { confirmedDate: day('2026-09-07'), confirmedBasis: 'first_seen' };
    expect(await eventOf(dropped.id)).toMatchObject({ status: 'confirmed', ...firstSeen });

    // 失败页 (结构异常 ⇒ 来源抛错): 取不到页面 ≠ 行消失。
    board.current = {
      get observations(): EarningsDateSourceObservation[] {
        throw new Error('清单结构异常: 缺页首日期');
      },
    };
    const failedRound = await dimensionRun(useCase, '2026-09-08');
    expect(runSteps(failedRound, 'earnings_date_source')).toEqual([
      expect.objectContaining({ kind: 'failure', symbol: 'source:hkex_board_meeting_list' }),
    ]);
    expect(failedRound.status).toBe('partial');
    expect(runSteps(failedRound, 'earnings_board_list_dropped')).toEqual([]);

    board.current = listing('2026-09-09', [obs(kept.id, 'meeting', '2026-09-28')]);
    const droppedRound = await dimensionRun(useCase, '2026-09-09');
    expect(runSteps(droppedRound, 'earnings_board_list_dropped')).toEqual([
      expect.objectContaining({
        kind: 'notice',
        detail: expect.objectContaining({ symbol: 'hk:00005', lastDate: '2026-09-25' }),
      }),
    ]);
    const afterDrop = await eventOf(dropped.id);
    expect(afterDrop).toMatchObject({
      status: 'confirmed',
      announceDate: day('2026-09-25'),
      ...firstSeen,
    });
    expect(afterDrop.logs.filter((l) => l.kind === 'listing_dropped')).toHaveLength(1);
    expect(droppedRound).toMatchObject({ status: 'success', failed: 0 });
  });

  it('④ 通知 2 个交易日后仍无日期: 从未在清单的创业板代码 ⇒ 只计数 success; 曾在清单 ⇒ notified_undated + partial', async () => {
    const [gem, listed] = await Promise.all(['08217', '02269'].map((c) => instrument('hk', c)));
    for (const i of [gem, listed]) await seedProfile(i.id);
    const useCase = buildMerge({ current: {} }, { current: {} });

    // 创业板代码、无任何清单观测: 09-01 通知 → 09-03 满 2 个交易日。
    await announce(gem.id, '2026-09-01', NOTICE_TITLE, ['all']);
    const gemRound = await dimensionRun(useCase, '2026-09-03');
    expect(runSteps(gemRound, 'earnings_notice_undated').length).toBeGreaterThan(0);
    expect(gemRound).toMatchObject({ status: 'success', failed: 0 });
    expect(runSteps(gemRound, 'earnings_notice_undated')).toEqual([
      {
        kind: 'notice',
        step: 'earnings_notice_undated',
        detail: { neverListed: 1, symbols: ['hk:08217'] },
      },
    ]);
    expect(await prisma.earningsDateEvent.count({ where: { instrumentId: gem.id } })).toBe(0);

    // 曾在清单: 上一期 (年度) 的清单观测。
    await prisma.earningsDateObservation.create({
      data: {
        source: 'hkex_board_meeting_list',
        instrumentId: listed.id,
        periodKey: 'P:2025-12-31',
        market: 'hk',
        reportKind: 'annual',
        periodEnd: day('2025-12-31'),
        basis: 'meeting',
        meetingDate: day('2026-03-15'),
        firstSeenAt: day('2026-03-10'),
        lastSeenAt: day('2026-03-10'),
      },
    });
    await announce(listed.id, '2026-09-01', NOTICE_TITLE, ['all']);
    const listedRound = await dimensionRun(useCase, '2026-09-03');
    expect(await eventOf(listed.id, 'D:notice_undated:2026-09-01')).toMatchObject({
      status: 'notified_undated',
    });
    expect(runSteps(listedRound, 'earnings_notice_undated')).toContainEqual(
      expect.objectContaining({ detail: expect.objectContaining({ symbol: 'hk:02269' }) }),
    );
    expect(listedRound).toMatchObject({ status: 'partial', failed: 1 });
  });

  it('⑤ 无财年档案的港股标的过公布日 2 个交易日 ⇒ 非 overdue + fiscal_unknown 计数; 同轮有档案的对照标的已迁入 overdue', async () => {
    const [control, noProfile] = await Promise.all(
      ['00267', '00288'].map((c) => instrument('hk', c)),
    );
    await seedProfile(control.id);
    const futu: Round = {
      current: {
        observations: [control, noProfile].map((i) => obs(i.id, 'structured', '2026-09-01')),
      },
    };

    const run = await dimensionRun(buildMerge(futu, { current: {} }), '2026-09-03');

    expect((await eventOf(control.id)).status).toBe('overdue');
    expect(runSteps(run, 'earnings_date_fiscal_unknown')).toEqual([
      {
        kind: 'notice',
        step: 'earnings_date_fiscal_unknown',
        detail: { count: 1, samples: ['hk:00288'] },
      },
    ]);
    expect((await eventOf(noProfile.id)).status).toBe('confirmed');
    expect(run).toMatchObject({ status: 'partial', failed: 1 });
  });

  // 2026-09-14 prod hk:00939 形态 (FR-015 / FR-028): 回填时无财年档案 ⇒ 刊发事实落 D: 键, 富途事件是 T: 键,
  // 两边永远对不上; 后补档案后 T: 事件过公布日曾被成批判逾期、标红。
  it('⑥ 后补财年档案的标的: 过公布日 2 个交易日的 T: 键未刊发事件 (同日刊发事实在 D: 键) ⇒ 非 overdue、🚫 计失败、overdueUnjudged 计数; 同轮 P: 键对照已迁入 overdue', async () => {
    const [control, ccb] = await Promise.all(['00688', '00939'].map((c) => instrument('hk', c)));
    await seedProfile(control.id);
    const unaligned = 'T:futu_calendar:2026 Q2';
    const futu: Round = {
      current: {
        observations: [
          obs(control.id, 'structured', '2026-09-01'),
          {
            ...obs(ccb.id, 'structured', '2026-09-01'),
            periodKey: unaligned,
            reportKind: null,
            periodEnd: null,
            periodText: '2026 Q2',
          },
        ],
      },
    };
    const useCase = buildMerge(futu, { current: {} });

    // 首轮 (公布日当天) 尚无档案: 标题不带期末日的刊发事实落 D: 键、已刊发。
    await announce(ccb.id, '2026-09-01', '2026年中期業績公告', ['fs_main']);
    await dimensionRun(useCase, '2026-09-01');
    expect(await eventOf(ccb.id, 'D:hkex_announcement:2026-09-01')).toMatchObject({
      status: 'published',
    });
    expect((await eventOf(ccb.id, unaligned)).status).toBe('confirmed');

    await seedProfile(ccb.id);
    const run = await dimensionRun(useCase, '2026-09-03');

    // 先断言正向: 同轮 P: 键对照迁入 overdue 且计 1 次失败 —— 证明本轮逾期判定确实在跑。
    expect((await eventOf(control.id)).status).toBe('overdue');
    expect(runSteps(run, 'earnings_date_overdue')).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ symbol: 'hk:00688' }) }),
    ]);
    expect(run).toMatchObject({ status: 'partial', failed: 1 });

    expect(await eventOf(ccb.id, unaligned)).toMatchObject({
      status: 'confirmed',
      overdueSince: null,
    });
    expect(runSteps(run, 'earnings_date_unaligned')).toEqual([
      expect.objectContaining({
        kind: 'notice',
        detail: expect.objectContaining({
          overdueUnjudged: 1,
          overdueUnjudgedSamples: [`hk:00939 ${unaligned}`],
        }),
      }),
    ]);
  });
});

// T019 清单失败、陈旧与日历不可判 (FR-025 / SC-012, plan §D12 #21 #22; Edge 13): 飞书标红面端到端。
// 清单用真 HkexBoardMeetingListSource + 真 VendorHttpClient + 假 fetch (fixture 同 T003, 结构变异同
// `hkex-board-meeting-list.rules.spec.ts`), 公告来源读真 announcement 表, 富途脚本化; 全部经维度执行,
// 断言落库的 `sync:hk_earnings_date` 运行记录 —— 日报只读运行状态判红。
describe('079 T019 清单失败、陈旧与日历不可判 (经维度运行)', () => {
  const PAGE = readFileSync(
    join(
      __dirname,
      '../../src/marketdata/__fixtures__/hkex-board-meeting-list/ebmn_c-2026-09-13.htm',
    ),
    'utf8',
  );
  const NEW_LOCATION = 'https://www3.hkexnews.hk/reports/bmn/moved.htm';
  const BOARD_LIST = 'hkex_board_meeting_list';
  let futuInstrumentId: bigint;

  beforeAll(async () => {
    await seedHolidayCalendar();
    futuInstrumentId = (await instrument('hk', '00700')).id;
    for (const code of new Set(parseBoardMeetingList(PAGE).rows.map((r) => r.code))) {
      await instrument('hk', code);
    }
  });
  beforeEach(resetMergeTables);

  type PageResponse = { status: number; body: string; location?: string };

  const mutatePage = (from: string | RegExp): string => {
    const html = PAGE.replace(from, '');
    expect(html).not.toBe(PAGE);
    return html;
  };

  function buildWithBoardList(page: PageResponse) {
    const fetch = async () => ({
      status: page.status,
      ok: page.status >= 200 && page.status < 300,
      json: async () => ({}),
      text: async () => page.body,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'location' ? (page.location ?? null) : null),
      },
    });
    const http = new VendorHttpClient(HKEXNEWS_PROFILE, {
      fetch: fetch as unknown as VendorHttpClientDeps['fetch'],
      sleep: async () => undefined,
    });
    const futu: Round = {
      current: { observations: [obs(futuInstrumentId, 'structured', '2026-11-20')] },
    };
    return new SyncEarningsDatesUseCase(
      prisma,
      assembleEarningsDateSources([...EARNINGS_DATE_SOURCE_NAMES], {
        futu_calendar: scripted(hkOnly, futu),
        hkex_announcement: new HkexAnnouncementSource(prisma),
        hkex_board_meeting_list: new HkexBoardMeetingListSource(
          http,
          prisma,
          new DbTradingCalendarAdapter(prisma),
        ),
      }),
      fiscal,
      new DbTradingCalendarAdapter(prisma),
    );
  }

  /** 富途观测来自脚本; 公告观测要一条业务日前 7 天内的刊发事实。 */
  const seedFiling = (date: string) =>
    announce(futuInstrumentId, date, '截至2026年6月30日止六個月之中期業績公告', ['fs_main']);
  const observationCount = (source: string) =>
    prisma.earningsDateObservation.count({ where: { source } });

  it.each([
    ['① 404', () => ({ status: 404, body: 'Not Found' }), ['404']],
    [
      '② 301 + location',
      () => ({ status: 301, body: '', location: NEW_LOCATION }),
      ['301', NEW_LOCATION],
    ],
    [
      '③ 缺页首日期',
      () => ({ status: 200, body: mutatePage('日期 : 10/09/2026') }),
      ['page_date_missing'],
    ],
    [
      '④ 缺表头',
      () => ({ status: 200, body: mutatePage(/<tr>(?:(?!<\/tr>)[\s\S])*會議日期[\s\S]*?<\/tr>/) }),
      ['header_missing'],
    ],
    [
      '⑤ 一行列数被破坏 (攜程那行删掉「期間」格)',
      () => ({
        status: 200,
        body: mutatePage(
          "<td valign=top><font face='monospace' style='font-size: 12'>截至30/06/26止6個月</font></td>",
        ),
      }),
      ['row_malformed', '首个不合法行'],
    ],
  ] as const)(
    '%s ⇒ partial + failed ≥ 1 + 来源失败 finding 带原因, 清单观测 0 条; 富途与公告观测照写',
    async (_label, page, reasons) => {
      // 页首 10/09/2026 → 业务日 09-11 = 1 个交易日 (新鲜): 红只能来自取数 / 解析失败。
      await seedFiling('2026-09-09');

      const run = await dimensionRun(buildWithBoardList(page()), '2026-09-11');

      expect(await observationCount('futu_calendar')).toBeGreaterThan(0);
      expect(await observationCount('hkex_announcement')).toBeGreaterThan(0);
      // 定向变异「清单失败返回空数组」须红在这里 (运行状态), 而非先红在 finding 上。
      expect(run.status).toBe('partial');
      expect(run.failed).toBeGreaterThanOrEqual(1);
      const failures = runSteps(run, 'earnings_date_source');
      expect(failures).toEqual([
        expect.objectContaining({ kind: 'failure', symbol: `source:${BOARD_LIST}` }),
      ]);
      for (const reason of reasons) {
        expect(failures[0]).toMatchObject({ error: expect.stringContaining(reason) });
      }
      expect(await observationCount(BOARD_LIST)).toBe(0);
    },
  );

  it('⑥ 页首日期落后 3 个交易日 ⇒ partial + earnings_board_list_stale, 该页行照常入库', async () => {
    // (09-10, 09-15] = 09-11 / 09-14 / 09-15 三个交易日 > 阈值 2。
    await seedFiling('2026-09-09');

    const run = await dimensionRun(buildWithBoardList({ status: 200, body: PAGE }), '2026-09-15');

    expect(await observationCount('futu_calendar')).toBeGreaterThan(0);
    expect(await observationCount('hkex_announcement')).toBeGreaterThan(0);
    // 业绩行 29、无人民币柜台 (同 hkex-board-meeting-list.source.spec.ts 当日页用例), 标的已全部入主表。
    expect(await observationCount(BOARD_LIST)).toBe(29);
    expect(run).toMatchObject({ status: 'partial', failed: 1 });
    expect(runSteps(run, 'earnings_board_list_stale')).toEqual([
      expect.objectContaining({ kind: 'failure', symbol: `source:${BOARD_LIST}` }),
    ]);
    expect(runSteps(run, 'earnings_date_source')).toEqual([]);
  });

  it('⑦ 陈旧判定区间含 unknown ⇒ success + earnings_date_calendar_unknown, 🚫 计失败, 清单观测照写', async () => {
    // 日历覆盖止于 10-31 ⇒ (09-10, 11-02] 含覆盖外日期 ⇒ 不可判。
    await seedFiling('2026-10-30');

    const run = await dimensionRun(buildWithBoardList({ status: 200, body: PAGE }), '2026-11-02');

    expect(await observationCount('futu_calendar')).toBeGreaterThan(0);
    expect(await observationCount('hkex_announcement')).toBeGreaterThan(0);
    expect(await observationCount(BOARD_LIST)).toBe(29);
    expect(runSteps(run, 'earnings_date_calendar_unknown')).toContainEqual(
      expect.objectContaining({ kind: 'unjudged', symbol: `source:${BOARD_LIST}` }),
    );
    expect(runSteps(run, 'earnings_board_list_stale')).toEqual([]);
    expect(run).toMatchObject({ status: 'success', failed: 0 });
  });
});

// T021 港股打标隔离 (FR-022 / SC-009, plan §D1; state_branches 24): 期权台取腿只读 `earnings_event`
// (`get-legs.usecase.ts` `readEarningsDates`, 按标的过滤、不分市场) ⇒ 本片新表里的 confirmed 港股事件
// 不得让港股收租腿的财报标离开「无日期」。取腿用例装配 = 直接 new + 真 PrismaLegRetrievalAdapter + 日历替身
// (体例同 `optionsdesk-050.mark.it.spec.ts`), 港股链形态同 `optionsdesk-070.offline-ladder.it.spec.ts`。
describe('079 T021 港股打标隔离: 期权台取腿读不到本片产出', () => {
  const HK_CODE = '06060';
  const SYMBOL = `hk:${HK_CODE}`;
  /** 香港周一 10:00 ⇒ 交易所今天 09-14; 收盘快照取上一场 09-11。 */
  const LEGS_NOW = new Date('2026-09-14T02:00:00Z');
  const PREV_SESSION = '2026-09-11';
  /** DTE 45 > 28 ⇒ 收租长腿, 落收租召回段; 事件日 09-25 落打标窗口 [09-14, 10-29] 内。 */
  const EXPIRY = '2026-10-29';
  const EVENT_DATE = '2026-09-25';

  beforeAll(seedHkTradingDays);
  beforeEach(resetMergeTables);

  it('新表有 confirmed 港股事件 ⇒ 港股收租腿财报标仍为 no_date', async () => {
    const inst = await instrument('hk', HK_CODE);
    await dimensionRun(
      buildMerge(
        { current: { observations: [obs(inst.id, 'structured', EVENT_DATE)] } },
        { current: listing(PREV_SESSION, [obs(inst.id, 'meeting', EVENT_DATE)]) },
      ),
      PREV_SESSION,
    );
    // 先断言有东西: 新表没有 confirmed 港股事件时, 下面的「无日期」照样成立、测不出隔离。
    expect(
      await prisma.earningsDateEvent.count({
        where: {
          instrumentId: inst.id,
          market: 'hk',
          status: 'confirmed',
          announceDate: day(EVENT_DATE),
        },
      }),
    ).toBeGreaterThan(0);
    expect(await prisma.earningsEvent.count({ where: { instrumentId: inst.id } })).toBe(0);

    const contractIds: bigint[] = [];
    try {
      for (const [strike, bid, ask, delta] of [
        ['120', '1.40', '1.50', '-0.20'],
        ['115', '0.70', '0.80', '-0.10'],
      ] as const) {
        const contract = await prisma.optionContract.create({
          data: {
            market: 'hk',
            code: `${HK_CODE}-T021-${strike}`,
            root: HK_CODE,
            underlyingInstrumentId: inst.id,
            expiryDate: day(EXPIRY),
            strikePrice: strike,
            optionType: 'PUT',
            isStandard: true,
            expirationCycle: 'MONTH',
            contractSize: 500,
          },
          select: { id: true },
        });
        contractIds.push(contract.id);
        await prisma.optionDailySnapshot.create({
          data: {
            contractId: contract.id,
            sessionDate: day(PREV_SESSION),
            source: 'eod',
            quoteAsOf: new Date(`${PREV_SESSION}T08:10:00Z`),
            oiAsOf: day(PREV_SESSION),
            bid,
            ask,
            delta,
            openInterest: '900',
            volume: '40',
            underlyingSpot: '132.4000',
            greeksComplete: true,
          },
        });
      }
      // V = 150 ⇒ W = 120, spot 132.40 落卖put区; 水位 ≥ 2/3 ⇒ 收租意图 (同 050 mark IT)。
      await prisma.anchor.create({
        data: {
          ticker: SYMBOL,
          market: 'hk',
          v: '150',
          asof: day('2026-06-30'),
          method: 'dcf',
          confidence: '8',
          confidenceSource: 'manual',
          lLevelEffective: 'L2',
          positionBucketManual: 'gte_two_thirds',
          positionBucketSetAt: new Date('2026-09-01T02:00:00Z'),
        },
      });

      const view = await new GetLegsUseCase(
        prisma,
        new PrismaLegRetrievalAdapter(prisma),
        stubTradingCalendar(),
        { marchPhiTier: 'good', marchMode: 'phi', brokerSyncScope: 'anchored' },
      ).execute(SYMBOL, 'rent', LEGS_NOW);

      expect(view.intent).toBe('rent');
      expect(view.legs.length).toBeGreaterThan(0);
      expect(view.legs.map((l) => [l.code, l.earningsMark?.mark])).toEqual(
        view.legs.map((l) => [l.code, 'no_date']),
      );
    } finally {
      await prisma.anchor.deleteMany({ where: { ticker: SYMBOL } });
      await prisma.optionDailySnapshot.deleteMany({ where: { contractId: { in: contractIds } } });
      await prisma.optionContract.deleteMany({ where: { id: { in: contractIds } } });
    }
  });

  it('结构: apps/server/src/optionsdesk/ 零引用本片 5 个新 model (prisma 访问器 / 类型名 / 表名)', () => {
    const NEW_MODEL_REFERENCE =
      /\b(?:earningsDate(?:Observation|Event)|earningsMeetingLag|earningsFiscalProfile|EarningsDate(?:Observation|Event)|EarningsMeetingLag|EarningsFiscalProfile|earnings_date_(?:observation|event)|earnings_meeting_lag|earnings_fiscal_profile)/g;
    const srcRoot = join(__dirname, '../../src');
    const scan = (dir: string, files: readonly string[]) =>
      files
        .filter((f) => f.endsWith('.ts'))
        .flatMap((f) =>
          (readFileSync(join(dir, f), 'utf8').match(NEW_MODEL_REFERENCE) ?? []).map(
            (m) => `${f}: ${m}`,
          ),
        );
    const optionsdeskFiles = readdirSync(join(srcRoot, 'optionsdesk'), {
      recursive: true,
      encoding: 'utf8',
    });

    // 管道自检: 同一扫描对 marketdata 合并用例必有命中 —— 否则「零命中」可能只是没扫到。
    expect(scan(join(srcRoot, 'marketdata'), ['sync-earnings-dates.usecase.ts'])).toEqual(
      expect.arrayContaining([
        expect.stringContaining('earningsDateObservation'),
        expect.stringContaining('earningsDateEvent'),
        expect.stringContaining('earningsMeetingLag'),
        expect.stringContaining('earningsFiscalProfile'),
      ]),
    );
    expect(optionsdeskFiles.filter((f) => f.endsWith('.ts')).length).toBeGreaterThan(0);
    expect(scan(join(srcRoot, 'optionsdesk'), optionsdeskFiles)).toEqual([]);
  });
});

// T022 来源增删演练 + 单源失败隔离 (FR-001 / FR-018 / SC-007 / SC-010, plan §D2; state_branches 17; Edge 13)。
// 启用集合 = 配置 `EARNINGS_DATE_SOURCES` 的取值, 经生产同一个 `assembleEarningsDateSources` 组装; 全部经维度
// 执行, 断言落库的 `sync:hk_earnings_date` 运行记录。
type EarningsSourceName = (typeof EARNINGS_DATE_SOURCE_NAMES)[number];
const BOARD_LIST_SOURCE: EarningsSourceName = 'hkex_board_meeting_list';

/** 按启用名组装 (实例表同 buildMerge)。 */
const buildEnabled = (enabled: readonly string[], futu: Round, board: Round) =>
  new SyncEarningsDatesUseCase(
    prisma,
    assembleEarningsDateSources(enabled, {
      futu_calendar: scripted(hkOnly, futu),
      hkex_announcement: new HkexAnnouncementSource(prisma),
      hkex_board_meeting_list: scripted(hkOnly, board),
    }),
    fiscal,
    new DbTradingCalendarAdapter(prisma),
  );

/** 事件的确认面 —— 「不删不撤」对比用。 */
const confirmationOf = async (instrumentId: bigint) => {
  const e = await eventOf(instrumentId);
  return {
    id: e.id,
    status: e.status,
    announceDate: e.announceDate,
    confirmedDate: e.confirmedDate,
    confirmedBasis: e.confirmedBasis,
  };
};

describe('079 T022 ①②: 来源增删演练 (经维度运行)', () => {
  beforeAll(seedHkTradingDays);
  beforeEach(resetMergeTables);

  it('① 配置去掉清单来源跑一轮 ⇒ success, 此前由清单确认的事件不删不撤; 恢复 ⇒ 清单重新参与 (SC-007)', async () => {
    const [listed, futuOnly] = await Promise.all(
      ['06862', '02899'].map((code) => instrument('hk', code)),
    );
    const futu: Round = { current: {} };
    const board: Round = {
      current: listing('2026-09-07', [obs(listed.id, 'meeting', '2026-09-24')]),
    };

    await dimensionRun(buildEnabled(EARNINGS_DATE_SOURCE_NAMES, futu, board), '2026-09-07');
    const confirmed = await confirmationOf(listed.id);
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      announceDate: day('2026-09-24'),
      confirmedDate: day('2026-09-07'),
      confirmedBasis: 'first_seen',
    });

    // 停用清单: 富途照常给另一标的日期 ⇒ 本轮不是空跑; 已确认事件照样进逾期扫描被重算。
    futu.current = { observations: [obs(futuOnly.id, 'structured', '2026-09-28')] };
    const withoutBoardList = EARNINGS_DATE_SOURCE_NAMES.filter(
      (name) => name !== BOARD_LIST_SOURCE,
    );
    const disabled = await dimensionRun(buildEnabled(withoutBoardList, futu, board), '2026-09-08');

    expect(await prisma.earningsDateEvent.count({ where: { instrumentId: futuOnly.id } })).toBe(1);
    expect(disabled).toMatchObject({ status: 'success', failed: 0 });
    expect(await confirmationOf(listed.id)).toEqual(confirmed);
    expect(
      await prisma.earningsDateObservation.count({
        where: { instrumentId: listed.id, source: BOARD_LIST_SOURCE },
      }),
    ).toBe(1);
    expect(runSteps(disabled, 'earnings_board_list_dropped')).toEqual([]);

    // 恢复: 清单改期 ⇒ 清单观测最近出现时刻 = 本轮、事件按新日期重判。
    board.current = listing('2026-09-09', [obs(listed.id, 'meeting', '2026-09-25')]);
    const restored = await dimensionRun(
      buildEnabled(EARNINGS_DATE_SOURCE_NAMES, futu, board),
      '2026-09-09',
    );

    expect(
      await prisma.earningsDateObservation.findFirstOrThrow({
        where: { instrumentId: listed.id, source: BOARD_LIST_SOURCE },
      }),
    ).toMatchObject({ lastSeenAt: at('2026-09-09'), prevDate: day('2026-09-24') });
    expect(await eventOf(listed.id)).toMatchObject({
      status: 'confirmed',
      announceDate: day('2026-09-25'),
      confirmedDate: day('2026-09-07'),
    });
    expect(restored).toMatchObject({ status: 'success', failed: 0 });
  });

  it('② 注入只给刊发事实的新来源、移除全部真来源 ⇒ 合并照常完成; 合并规则源码不含来源名 (SC-010)', async () => {
    const inst = await instrument('hk', '01177');
    // 生产加源 = 往 port 的 EARNINGS_DATE_SOURCE_NAMES 登记新名 + 模块注册实例 (都不是合并规则);
    // 本臂直接给装配结果, 名字不在三者之列 ⇒ 合并用例若按来源名分支, 这里就走不通。
    const HISTORY_ONLY = 'history_only' as string as EarningsSourceName;
    const historyOnly: EarningsDateSource = {
      name: HISTORY_ONLY,
      capabilities: (market) =>
        market === 'hk'
          ? { forward: null, confirmationSignal: false, publicationFact: true }
          : null,
      collect: async () => ({
        observations: [{ ...obs(inst.id, 'filed', '2026-09-04'), filedDate: '2026-09-04' }],
        noticeSignals: [],
        skippedUnknownInstruments: 0,
      }),
    };

    const run = await dimensionRun(
      new SyncEarningsDatesUseCase(
        prisma,
        [{ name: HISTORY_ONLY, source: historyOnly }],
        fiscal,
        new DbTradingCalendarAdapter(prisma),
      ),
      '2026-09-07',
    );

    expect(await prisma.earningsDateObservation.count({ where: { source: HISTORY_ONLY } })).toBe(1);
    expect(await eventOf(inst.id)).toMatchObject({
      status: 'published',
      announceDate: day('2026-09-04'),
      announceBasis: 'filed',
    });
    expect(run).toMatchObject({ status: 'success', failed: 0 });
    expect(
      await prisma.earningsDateObservation.count({
        where: { source: { in: [...EARNINGS_DATE_SOURCE_NAMES] } },
      }),
    ).toBe(0);

    /** 去掉注释后仍出现的来源名 —— 注释里提及某个键形态不算分支。 */
    const namesInCode = (text: string) => {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      return EARNINGS_DATE_SOURCE_NAMES.filter((name) => code.includes(name));
    };
    const source = (file: string) =>
      readFileSync(join(__dirname, '../../src/marketdata', file), 'utf8');
    // 管道自检: 代码里的字面量扫得到 (port 常量表三者齐)、注释里的提及被剔除。
    expect(namesInCode(`const s = 'futu_calendar'; // hkex_announcement`)).toEqual([
      'futu_calendar',
    ]);
    expect(namesInCode(source('earnings-date-source.port.ts'))).toEqual([
      ...EARNINGS_DATE_SOURCE_NAMES,
    ]);
    expect(namesInCode(source('earnings-date-merge.rules.ts'))).toEqual([]);
  });
});

describe('079 T022 ③: 单源失败隔离 (经维度运行)', () => {
  beforeAll(seedHkTradingDays);
  beforeEach(resetMergeTables);

  it('③ 富途来源抛普通 Error ⇒ partial + 来源失败 finding; 其余来源照常合并, 既有确认不撤销', async () => {
    const [futuConfirmed, listedLater, filer] = await Promise.all(
      ['00291', '01928', '02007'].map((code) => instrument('hk', code)),
    );
    const futu: Round = {
      current: { observations: [obs(futuConfirmed.id, 'structured', '2026-09-25')] },
    };
    const board: Round = { current: {} };
    const useCase = buildEnabled(EARNINGS_DATE_SOURCE_NAMES, futu, board);
    await dimensionRun(useCase, '2026-09-07');
    const before = await confirmationOf(futuConfirmed.id);
    expect(before).toMatchObject({ status: 'confirmed', announceDate: day('2026-09-25') });

    // 普通 Error (非 429 顺延) ⇒ 来源失败; 清单与公告本轮各给新东西。
    futu.current = {
      get observations(): EarningsDateSourceObservation[] {
        throw new Error('futu shim down');
      },
    };
    board.current = listing('2026-09-08', [obs(listedLater.id, 'meeting', '2026-09-29')]);
    await announce(filer.id, '2026-09-08', '截至2026年6月30日止六個月之中期業績公告', ['fs_main']);
    const run = await dimensionRun(useCase, '2026-09-08');

    // 先断言其余来源照常合并 (正向), 再断言失败形态。
    expect(await eventOf(listedLater.id)).toMatchObject({
      status: 'confirmed',
      announceDate: day('2026-09-29'),
    });
    expect(await eventOf(filer.id)).toMatchObject({ status: 'published', announceBasis: 'filed' });
    expect(await confirmationOf(futuConfirmed.id)).toEqual(before);
    expect(run).toMatchObject({ status: 'partial', failed: 1 });
    expect(runSteps(run, 'earnings_date_source')).toEqual([
      expect.objectContaining({
        kind: 'failure',
        symbol: 'source:futu_calendar',
        error: expect.stringContaining('futu shim down'),
      }),
    ]);
    expect(
      await prisma.earningsDateObservation.count({
        where: { instrumentId: futuConfirmed.id, source: 'futu_calendar' },
      }),
    ).toBe(1);
  });
});

// state_branches 3 / 5 / 6 / 8 直接覆盖 (FR-009 / FR-010 / FR-014 / FR-019, plan §D8): 取值口径优先级、精确 vs 近似、
// 近似差 1 天、近似差 ≥ 2 天不可解释。T017 各臂只顺带经过这些取值, 这里逐条断言「取谁 + 留痕 + 告不告警」。
// 装配同 T017 (公告来源读真 announcement 表, 富途与清单脚本化), 全部经维度执行、断言落库的运行记录。
const INTERIM_FILING_TITLE = '截至2026年6月30日止六個月之中期業績公告';

describe('079 state_branches 直接覆盖补齐 #3 #5 #6 #8: 取值口径与冲突 (经维度运行)', () => {
  beforeAll(seedHkTradingDays);
  beforeEach(resetMergeTables);

  const deviations = (instrumentId: bigint) =>
    prisma.earningsDateObservation.findMany({
      where: { instrumentId },
      select: { source: true, deviationDays: true },
      orderBy: { source: 'asc' },
    });

  it('#3 刊发事实 / 结构化 / 会议日推定三口径并存 ⇒ 公布日取刊发事实, 其余取值留痕 (流水候选 + 观测偏差)', async () => {
    const inst = await instrument('hk', '01833');
    await announce(inst.id, '2026-09-10', INTERIM_FILING_TITLE, ['fs_main']);
    const futu: Round = { current: { observations: [obs(inst.id, 'structured', '2026-09-11')] } };
    const board: Round = {
      current: listing('2026-09-10', [obs(inst.id, 'meeting', '2026-09-09')]),
    };

    const run = await dimensionRun(buildMerge(futu, board), '2026-09-10');

    const event = await eventOf(inst.id);
    expect(event).toMatchObject({
      status: 'published',
      announceDate: day('2026-09-10'),
      announceBasis: 'filed',
      conflictCandidates: null,
    });
    expect(event.logs).toContainEqual(
      expect.objectContaining({
        kind: 'value_changed',
        detail: expect.objectContaining({
          reason: 'exact_priority',
          candidates: [
            { source: 'hkex_announcement', basis: 'filed', date: '2026-09-10' },
            { source: 'futu_calendar', basis: 'structured', date: '2026-09-11' },
            { source: 'hkex_board_meeting_list', basis: 'meeting', date: '2026-09-09' },
          ],
        }),
      }),
    );
    expect(await deviations(inst.id)).toEqual([
      { source: 'futu_calendar', deviationDays: 1 },
      { source: 'hkex_announcement', deviationDays: null },
      { source: 'hkex_board_meeting_list', deviationDays: -1 },
    ]);
    expect(run).toMatchObject({ status: 'success', failed: 0 });
  });

  it('#5 精确口径 (刊发事实 09-10) 与结构化 (09-15) 相差 5 天 ⇒ 取精确口径, 差异留痕, 无冲突告警', async () => {
    const inst = await instrument('hk', '02688');
    await announce(inst.id, '2026-09-10', INTERIM_FILING_TITLE, ['fs_main']);
    const futu: Round = { current: { observations: [obs(inst.id, 'structured', '2026-09-15')] } };

    const run = await dimensionRun(buildMerge(futu, { current: {} }), '2026-09-10');

    // 先断言事件存在且 published: 无事件时下面的「无冲突 finding」照样成立。
    const event = await eventOf(inst.id);
    expect(event).toMatchObject({
      status: 'published',
      announceDate: day('2026-09-10'),
      announceBasis: 'filed',
      conflictCandidates: null,
    });
    expect(event.logs).toContainEqual(
      expect.objectContaining({
        kind: 'value_changed',
        detail: expect.objectContaining({
          candidates: [
            { source: 'hkex_announcement', basis: 'filed', date: '2026-09-10' },
            { source: 'futu_calendar', basis: 'structured', date: '2026-09-15' },
          ],
        }),
      }),
    );
    expect(await deviations(inst.id)).toEqual([
      { source: 'futu_calendar', deviationDays: 5 },
      { source: 'hkex_announcement', deviationDays: null },
    ]);
    expect(runSteps(run, 'earnings_date_conflict')).toEqual([]);
    expect(run).toMatchObject({ status: 'success', failed: 0 });
  });

  it('#6 仅近似口径: 结构化 09-25 vs 会议日推定 09-24 (差 1 天) ⇒ 按口径优先级取结构化, 差异留痕, 无冲突告警', async () => {
    const inst = await instrument('hk', '00316');
    const futu: Round = { current: { observations: [obs(inst.id, 'structured', '2026-09-25')] } };
    const board: Round = {
      current: listing('2026-09-07', [obs(inst.id, 'meeting', '2026-09-24')]),
    };

    const run = await dimensionRun(buildMerge(futu, board), '2026-09-07');

    // 取的是口径更高的结构化 (较晚那天), 不是较早的会议日推定。
    const event = await eventOf(inst.id);
    expect(event).toMatchObject({
      status: 'confirmed',
      announceDate: day('2026-09-25'),
      announceBasis: 'structured',
      conflictCandidates: null,
    });
    expect(event.logs).toContainEqual(
      expect.objectContaining({
        kind: 'value_changed',
        detail: expect.objectContaining({
          reason: 'approx_within_1_day',
          candidates: [
            { source: 'futu_calendar', basis: 'structured', date: '2026-09-25' },
            { source: 'hkex_board_meeting_list', basis: 'meeting', date: '2026-09-24' },
          ],
        }),
      }),
    );
    expect(runSteps(run, 'earnings_date_conflict')).toEqual([]);
    expect(run).toMatchObject({ status: 'success', failed: 0 });
  });

  it('#8 hk:00960 形态: 清单 03-28 vs 富途 03-31、无历史间隔可解释 ⇒ conflict + 全部候选 + 告警 finding, 🚫 计失败', async () => {
    const ANNUAL_2025 = 'P:2025-12-31';
    const inst = await instrument('hk', '00960');
    const annual = (basis: EarningsDateBasis, date: string) => ({
      ...obs(inst.id, basis, date),
      periodKey: ANNUAL_2025,
      reportKind: 'annual' as const,
      periodEnd: '2025-12-31',
    });
    const futu: Round = { current: { observations: [annual('structured', '2026-03-31')] } };
    const board: Round = { current: listing('2026-03-20', [annual('meeting', '2026-03-28')]) };

    const run = await dimensionRun(buildMerge(futu, board), '2026-03-20');

    const event = await eventOf(inst.id, ANNUAL_2025);
    expect(event).toMatchObject({ status: 'conflict', announceDate: null, announceBasis: null });
    const candidates = [
      { source: 'futu_calendar', basis: 'structured', date: '2026-03-31' },
      { source: 'hkex_board_meeting_list', basis: 'meeting', date: '2026-03-28' },
    ];
    expect(event.conflictCandidates).toEqual(candidates);
    expect(event.logs).toContainEqual(
      expect.objectContaining({
        kind: 'status_changed',
        toStatus: 'conflict',
        detail: expect.objectContaining({ candidates }),
      }),
    );
    expect(runSteps(run, 'earnings_date_conflict')).toEqual([
      {
        kind: 'notice',
        step: 'earnings_date_conflict',
        detail: { symbol: 'hk:00960', periodKey: ANNUAL_2025, candidates },
      },
    ]);
    expect(run).toMatchObject({ status: 'success', failed: 0 });
  });
});

// state_branches 19 / 20 直接覆盖 (FR-020 / FR-023, plan §D7): 清单来源的「主表外代码跳过计数」与「纯股息行不作财报
// 事件」。清单用真 HkexBoardMeetingListSource + 真 VendorHttpClient + 假 fetch 喂 fixture (同 T019), 计数经
// `earnings_board_list_scan` finding 落 sync_run —— 主表外 = 真 instrument 表查不到, 替身只能复述 Map 过滤。
describe('079 state_branches 直接覆盖补齐 #19 #20: 清单主表外代码与纯股息行 (真清单来源, 经维度运行)', () => {
  const fixture = (name: string) =>
    readFileSync(
      join(__dirname, '../../src/marketdata/__fixtures__/hkex-board-meeting-list', name),
      'utf8',
    );
  const SNAPSHOT_2024 = fixture('ebmn_c-wayback-20240424125921.htm');
  const PAGE_2026 = fixture('ebmn_c-2026-09-13.htm');
  const BOARD_LIST = 'hkex_board_meeting_list';

  beforeAll(seedHkTradingDays);
  beforeEach(resetMergeTables);

  function buildWithPage(html: string) {
    const fetch = async () => ({
      status: 200,
      ok: true,
      json: async () => ({}),
      text: async () => html,
      headers: { get: () => null },
    });
    const http = new VendorHttpClient(HKEXNEWS_PROFILE, {
      fetch: fetch as unknown as VendorHttpClientDeps['fetch'],
      sleep: async () => undefined,
    });
    return new SyncEarningsDatesUseCase(
      prisma,
      assembleEarningsDateSources([...EARNINGS_DATE_SOURCE_NAMES], {
        futu_calendar: scripted(hkOnly, { current: {} }),
        hkex_announcement: new HkexAnnouncementSource(prisma),
        hkex_board_meeting_list: new HkexBoardMeetingListSource(
          http,
          prisma,
          new DbTradingCalendarAdapter(prisma),
        ),
      }),
      fiscal,
      new DbTradingCalendarAdapter(prisma),
    );
  }

  const boardListObservations = () =>
    prisma.earningsDateObservation.count({ where: { source: BOARD_LIST } });

  it('#19 2024-04-24 快照: 人民币柜台 8xxxx 代码不在主表 ⇒ 跳过计数 = 9、零落库; 同轮主表内代码观测照写', async () => {
    const rows = parseBoardMeetingList(SNAPSHOT_2024).rows;
    const rmbCodes = [...new Set(rows.filter((r) => r.code.startsWith('8')).map((r) => r.code))];
    // 手工核对值同 hkex-board-meeting-list.source.spec.ts: 业绩行 218, 其中人民币柜台 9 行, 同标的同期重复 0。
    expect(rows).toHaveLength(218);
    expect(rows.filter((r) => rmbCodes.includes(r.code))).toHaveLength(9);
    for (const code of new Set(rows.map((r) => r.code))) {
      if (!rmbCodes.includes(code)) await instrument('hk', code);
    }
    // 前提: 这些代码确实不在主表 —— 否则「跳过」无从谈起。
    const rmbInstruments = () =>
      prisma.instrument.count({ where: { market: 'hk', code: { in: rmbCodes } } });
    expect(await rmbInstruments()).toBe(0);

    const run = await dimensionRun(buildWithPage(SNAPSHOT_2024), '2024-04-24');

    expect(await boardListObservations()).toBe(218 - 9);
    expect(runSteps(run, 'earnings_board_list_scan')).toEqual([
      expect.objectContaining({
        kind: 'notice',
        detail: expect.objectContaining({
          source: BOARD_LIST,
          pageDate: '2024-04-23',
          resultRows: 218,
          skippedUnknownInstruments: 9,
        }),
      }),
    ]);
    // 不落库: 既不写观测 (上面 209 = 218 − 9), 也不顺手建主表行。
    expect(await rmbInstruments()).toBe(0);
  }, 90_000);

  it('#20 当日页纯股息行 (02877 特別中期股息, 标的在主表) ⇒ 该标的零观测零事件, 纯股息计数 1; 同轮业绩行观测照写', async () => {
    // 前提: 02877 在页面上只此一行 (无同页业绩行) —— 按原文数, 不经解析规则。
    expect(PAGE_2026.match(/&nbsp;2877</g)).toHaveLength(1);
    for (const code of new Set(parseBoardMeetingList(PAGE_2026).rows.map((r) => r.code))) {
      await instrument('hk', code);
    }
    const dividendOnly = await instrument('hk', '02877');

    const run = await dimensionRun(buildWithPage(PAGE_2026), '2026-09-11');

    expect(await boardListObservations()).toBe(29);
    expect(runSteps(run, 'earnings_board_list_scan')).toEqual([
      expect.objectContaining({
        kind: 'notice',
        detail: expect.objectContaining({
          pageDate: '2026-09-10',
          dataRows: 30,
          resultRows: 29,
          dividendOnlyRows: 1,
          skippedUnknownInstruments: 0,
        }),
      }),
    ]);
    expect(
      await prisma.earningsDateObservation.count({ where: { instrumentId: dividendOnly.id } }),
    ).toBe(0);
    expect(await prisma.earningsDateEvent.count({ where: { instrumentId: dividendOnly.id } })).toBe(
      0,
    );
    expect(run).toMatchObject({ status: 'success', failed: 0 });
  });
});

// T030–T033 上线后误报修正 (spec Session（八）, FR-004 / FR-028 / FR-029 / FR-030): 各复刻一个 2026-09-14 prod
// 形态 + 对照臂, 全部经维度执行, 断言落库的 `sync:hk_earnings_date` 运行记录。
describe('079 T030 刊发判定放宽: fs 族标签 + 业绩标题 v3 (hk:09961 形态, 经维度运行)', () => {
  beforeAll(seedHolidayCalendar);
  beforeEach(resetMergeTables);

  it('fs,fs_full「第二季度及上半年業績公告」⇒ P: 刊发事实 + 事件 published; 同轮「中期業績報告」对照标的无刊发事实、迁入 overdue + partial', async () => {
    const [xpeng, control] = await Promise.all(['09961', '00005'].map((c) => instrument('hk', c)));
    for (const i of [xpeng, control]) await seedProfile(i.id);
    await announce(xpeng.id, '2026-08-28', '2026 年第二季度及上半年業績公告', ['fs', 'fs_full']);
    await announce(control.id, '2026-08-28', '2026年中期業績報告', ['fs', 'fs_full']);
    const futu: Round = {
      current: { observations: [xpeng, control].map((i) => obs(i.id, 'structured', '2026-08-28')) },
    };

    // 公布日 08-28 (周五) → 09-01 (周二) = 2 个交易日。
    const run = await dimensionRun(buildMerge(futu, { current: {} }), '2026-09-01');

    // 先断言正向: 对照标的迁入 overdue 且计 1 次失败 —— 证明本轮逾期判定在跑, 下面的 published 不是空转。
    expect((await eventOf(control.id)).status).toBe('overdue');
    expect(
      await prisma.earningsDateObservation.count({
        where: { instrumentId: control.id, basis: 'filed' },
      }),
    ).toBe(0);
    expect(run).toMatchObject({ status: 'partial', failed: 1 });

    expect(
      await prisma.earningsDateObservation.findFirstOrThrow({
        where: { instrumentId: xpeng.id, source: 'hkex_announcement' },
      }),
    ).toMatchObject({ periodKey: INTERIM, basis: 'filed', filedDate: day('2026-08-28') });
    expect(await eventOf(xpeng.id)).toMatchObject({
      status: 'published',
      announceDate: day('2026-08-28'),
      announceBasis: 'filed',
      overdueSince: null,
    });
    expect(runSteps(run, 'earnings_date_overdue')).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ symbol: 'hk:00005' }) }),
    ]);
  });
});

/** 上一轮落下的刊发事实观测 (T031 季度刊发判定只读 `filed` 口径观测, 与本轮公告窗口无关)。 */
const seedFiling = (
  instrumentId: bigint,
  periodKey: string,
  filedDate: string,
  fields: { reportKind: string | null; periodEnd: string | null; periodText: string },
) =>
  prisma.earningsDateObservation.create({
    data: {
      source: 'hkex_announcement',
      instrumentId,
      periodKey,
      market: 'hk',
      reportKind: fields.reportKind,
      periodEnd: fields.periodEnd === null ? null : day(fields.periodEnd),
      periodText: fields.periodText,
      basis: 'filed',
      announceDate: day(filedDate),
      filedDate: day(filedDate),
      firstSeenAt: day(filedDate),
      lastSeenAt: day(filedDate),
    },
  });

describe('079 T031 非季报公司的第一 / 第三季不判逾期 (hk:01299 形态, 经维度运行)', () => {
  beforeAll(seedHolidayCalendar);
  beforeEach(resetMergeTables);

  it('既有 overdue 的 Q3 事件 (730 天内只有中期刊发) ⇒ 解除回 confirmed + releasedBy 流水 + non_quarterly 计数; 同轮对照 (D: 键、报告类型空的第一季度刊发) 迁入 overdue + partial', async () => {
    const [aia, control] = await Promise.all(['01299', '00700'].map((c) => instrument('hk', c)));
    for (const i of [aia, control]) await seedProfile(i.id);
    const Q3 = 'P:2026-09-30';
    const q3Observation = (instrumentId: bigint): EarningsDateSourceObservation => ({
      ...obs(instrumentId, 'structured', '2026-10-15'),
      periodKey: Q3,
      reportKind: 'quarterly',
      periodEnd: '2026-09-30',
      periodText: '2026Q3',
    });
    await seedFiling(aia.id, INTERIM, '2026-08-20', {
      reportKind: 'interim',
      periodEnd: '2026-06-30',
      periodText: '截至2026年6月30日止六個月之中期業績公告',
    });
    await seedFiling(control.id, 'D:hkex_announcement:2026-05-15', '2026-05-15', {
      reportKind: null,
      periodEnd: null,
      periodText: '2026年第一季度業績公告',
    });
    // prod 形态: 上一轮已迁入 overdue 的 Q3 事件 (富途把非业绩事件列成财报日)。
    await prisma.earningsDateEvent.create({
      data: {
        instrumentId: aia.id,
        periodKey: Q3,
        market: 'hk',
        reportKind: 'quarterly',
        periodEnd: day('2026-09-30'),
        status: 'overdue',
        announceDate: day('2026-10-15'),
        announceBasis: 'structured',
        confirmedDate: day('2026-09-01'),
        confirmedBasis: 'first_seen',
        sources: ['futu_calendar'],
        overdueSince: at('2026-10-19'),
      },
    });
    const futu: Round = {
      current: { observations: [aia, control].map((i) => q3Observation(i.id)) },
    };

    // 公布日 10-15 (周四) → 10-20 (周二) = 3 个交易日。
    const run = await dimensionRun(buildMerge(futu, { current: {} }), '2026-10-20');

    // 先断言正向: 对照标的 (有季度刊发) 迁入 overdue 且计 1 次失败 —— 证明本轮逾期判定在跑。
    expect((await eventOf(control.id, Q3)).status).toBe('overdue');
    expect(runSteps(run, 'earnings_date_overdue')).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ symbol: 'hk:00700' }) }),
    ]);
    expect(run).toMatchObject({ status: 'partial', failed: 1 });

    const released = await eventOf(aia.id, Q3);
    expect(released).toMatchObject({ status: 'confirmed', overdueSince: null });
    expect(released.logs).toEqual([
      expect.objectContaining({
        kind: 'status_changed',
        fromStatus: 'overdue',
        toStatus: 'confirmed',
        detail: expect.objectContaining({ releasedBy: 'non_quarterly_reporter' }),
      }),
    ]);
    expect(runSteps(run, 'earnings_date_non_quarterly')).toEqual([
      {
        kind: 'notice',
        step: 'earnings_date_non_quarterly',
        detail: { count: 1, released: 1, samples: [`hk:01299 ${Q3}`] },
      },
    ]);
  });
});
