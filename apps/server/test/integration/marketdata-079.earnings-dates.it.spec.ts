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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EarningsCalendarEvent,
  EarningsCalendarPort,
} from '../../src/marketdata/earnings-calendar.port';
import {
  assembleEarningsDateSources,
  EARNINGS_DATE_SOURCE_NAMES,
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
    );
  }

  async function runRecorded(useCase: SyncEarningsDatesUseCase, now: Date) {
    const recorder = new SyncRunRecorder(prisma);
    const stats: SyncRunStats = emptyStats();
    const id = await recorder.start('hk_earnings_date');
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
