import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import {
  ANNOUNCEMENT_LOAD_CHUNK_DAYS,
  HKEX_ANNOUNCEMENT_BACKFILL_LOOKBACK_DAYS,
  HkexAnnouncementSource,
  PUBLICATION_FACT_DAILY_LOOKBACK_DAYS,
} from '../../src/marketdata/hkex-announcement.source';
import { NOTICE_MATCH_WINDOW_DAYS } from '../../src/marketdata/earnings-date-merge.rules';
import type {
  EarningsDateCollectMode,
  EarningsDateCollectResult,
} from '../../src/marketdata/earnings-date-source.port';

// 079 来源 B 交易所公告：按日期分片载入 (回填 730 天窗整窗双载 OOM 风险修复)。
//
// ① 等价性：跨多个片边界种公告 (同一期「本体 + 補充」分落相邻两片、会前通知恰在片边界当天与前一天、
//    lookalike 标题在片边界、非港股行、窗口两端点内外各一天)，分片 (30 / 7 / 1 天) 的 collect 结果
//    与片宽 ≥ 窗口 (整窗一次读取) 的参考结果逐项相等，参考结果本身再对显式期望值断言。
// ② 结构性上界：包一层 announcement.findMany 记录每次读取区间 —— 回填每片跨度 ≤ 片宽、次数 =
//    ⌈731 / 片宽⌉、相邻区间首尾相接 (无重叠无缝)、并集 = 整窗；日常记录实际区间。
//
// 为什么必须真 PG：片边界是对 `@db.Date` 列的 gte / lte 区间查询 + instrument.market 关联过滤，
// 端点含不含、相邻片重叠 / 留缝会不会重复或丢行，只有真库说了算；替身只能复述 where 子句。
//
// 定向变异 (out-of-test sabotage，testing.md §7.1；改 hkex-announcement.source.ts、跑、还原)，2026-09-14：
// 复跑 `pnpm exec nx test server test/integration/marketdata-079.announcement-chunked-load.it.spec.ts --skip-nx-cache`
//   A. 下一片起点 `addDays(chunkTo, 1)` → 未到业务日时取 `chunkTo` (相邻片重叠一天)
//      ⇒ 2 failed：① 30 天臂在第 1 片边界前一天多出一条重复通知信号；② 读取 26 次 ≠ 25
//   B. 下一片起点 `addDays(chunkTo, 1)` → `addDays(chunkTo, 2)` (相邻片留一天缝)
//      ⇒ 2 failed：① 30 天臂缺第 1 片边界当天的通知信号；② 读取 24 次 ≠ 25
//   C. 循环前补一次信号窗整窗读取 + 片终点改为 `addDays(chunkFrom, 片宽 + 1000)` (回填两次整窗读取)
//      ⇒ 2 failed：② 读取 2 次 ≠ 25；① 红在参考臂读取区间断言 (4 次 ≠ 2 次)，其后的等价性断言未执行
//   还原后 2 passed。🚫 变异点挑编译得过、日期不越界的写法 (去掉片宽引用会先撞 TS6138，test 目标依赖
//   typecheck ⇒ 用例一条没跑)。

const BUSINESS_DATE = '2026-09-13';
const NOW = new Date('2026-09-13T23:30:00+08:00');
/** 片宽 ≥ 任一窗口 ⇒ 整窗一次读取，作等价性参考。 */
const WHOLE_WINDOW_CHUNK_DAYS = 100_000;

const day = (s: string): Date => new Date(`${s}T00:00:00Z`);
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
function addDays(dateStr: string, days: number): string {
  const d = day(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
}

const BACKFILL_FROM = addDays(BUSINESS_DATE, -HKEX_ANNOUNCEMENT_BACKFILL_LOOKBACK_DAYS);
/** 回填第 k 片的起始日 (片从 BACKFILL_FROM 起按默认片宽切)。 */
const boundary = (k: number): string => addDays(BACKFILL_FROM, k * ANNOUNCEMENT_LOAD_CHUNK_DAYS);

let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
let prisma: PrismaService;
let linkSeq = 0;

beforeAll(async () => {
  db = await setupIsolatedDb();
  process.env.DATABASE_URL = db.databaseUrl;
  prisma = new PrismaService(db.databaseUrl);
  await prisma.$connect();
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.drop();
});

beforeEach(async () => {
  await prisma.earningsFiscalProfile.deleteMany();
  await prisma.announcement.deleteMany();
});

async function instrument(market: string, code: string): Promise<bigint> {
  const row = await prisma.instrument.upsert({
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
    select: { id: true },
  });
  return row.id;
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

/** 包一层 announcement.findMany，记录每次读取的 `[gte, lte]` (其余透传真 PrismaService)。 */
function recordingSource(chunkDays: number) {
  const ranges: Array<[string, string]> = [];
  const recorder = {
    announcement: {
      findMany: (args: { where: { date: { gte: Date; lte: Date } } }) => {
        ranges.push([isoDay(args.where.date.gte), isoDay(args.where.date.lte)]);
        return prisma.announcement.findMany(
          args as Parameters<typeof prisma.announcement.findMany>[0],
        );
      },
    },
    earningsFiscalProfile: prisma.earningsFiscalProfile,
  };
  return {
    source: new HkexAnnouncementSource(recorder as unknown as PrismaService, chunkDays),
    ranges,
  };
}

function collect(
  source: HkexAnnouncementSource,
  mode: EarningsDateCollectMode,
): Promise<EarningsDateCollectResult> {
  return source.collect({ market: 'hk', businessDate: BUSINESS_DATE, now: NOW, mode });
}

const INTERIM_2024 = '截至2024年6月30日止六個月之中期業績公告';
const INTERIM_2026 = '截至2026年6月30日止六個月中期業績公告';

describe('079 来源 B 公告按日期分片载入 (Testcontainers PG)', () => {
  let ids: { a: bigint; b: bigint; c: bigint; d: bigint; us: bigint };

  beforeEach(async () => {
    ids = {
      a: await instrument('hk', '00001'),
      b: await instrument('hk', '00002'),
      c: await instrument('hk', '00003'),
      d: await instrument('hk', '00004'),
      us: await instrument('us', 'AAPL'),
    };
    const { a, b, c, d, us } = ids;
    // 同一期本体在第 0 片最后一天、補充在第 1 片第一天 ⇒ 只留本体 (最早刊发)。
    await announce(a, addDays(boundary(1), -1), INTERIM_2024, ['fs_main']);
    await announce(a, boundary(1), `補充公告 ${INTERIM_2024}`, ['fs_main']);
    // 会前通知恰在片边界前一天与当天 (第 1 片边界 + 第 5 片边界)；lookalike 标题在片边界当天。
    // 第 1 片边界必须有「看得见」的行：重叠 / 留缝会让之后各片起点整体漂移，只有第一道缝位置固定。
    await announce(b, addDays(boundary(1), -1), '董事會會議通知', ['all']);
    await announce(b, boundary(1), '董事會會議召開日期', ['all']);
    await announce(b, addDays(boundary(5), -1), '董事會會議召開日期', ['all']);
    await announce(b, boundary(5), '董事會會議通知', ['all']);
    await announce(c, boundary(5), '董事會會議決議公告', ['all']);
    // 标题无期末日且无财年档案 ⇒ D: 键 + 未对齐计数；不含本体的補充 ⇒ 非刊发。
    await announce(c, '2025-08-20', '二零二五年中期業績公告', ['fs_main']);
    await announce(c, '2025-09-01', '有關二零二四年年報的補充公告', ['fs_main']);
    // 非港股行落在片边界。
    await announce(us, boundary(1), '董事會會議召開日期', ['all']);
    await announce(us, boundary(1), INTERIM_2024, ['fs_main']);
    // 回填窗两端点：起点当天收、前一天不收；业务日当天收、后一天不收。
    await announce(a, BACKFILL_FROM, '董事會會議通知', ['all']);
    await announce(a, addDays(BACKFILL_FROM, -1), '董事會會議通知', ['all']);
    await announce(b, BUSINESS_DATE, INTERIM_2026, ['fs_main']);
    await announce(b, addDays(BUSINESS_DATE, 1), '董事會會議召開日期', ['all']);
    // 日常窗端点：刊发 7 天窗 / 信号 120 天窗内外各一天。
    await announce(a, addDays(BUSINESS_DATE, -PUBLICATION_FACT_DAILY_LOOKBACK_DAYS), INTERIM_2026, [
      'fs_main',
    ]);
    await announce(
      d,
      addDays(BUSINESS_DATE, -PUBLICATION_FACT_DAILY_LOOKBACK_DAYS - 1),
      INTERIM_2026,
      ['fs_main'],
    );
    await announce(d, addDays(BUSINESS_DATE, -NOTICE_MATCH_WINDOW_DAYS), '董事會會議日期', ['all']);
    await announce(d, addDays(BUSINESS_DATE, -NOTICE_MATCH_WINDOW_DAYS - 1), '董事會會議日期', [
      'all',
    ]);
  });

  it('① 等价性: 分片 (30 / 7 / 1 天) 回填与日常结果 = 整窗一次读取, 参考结果命中显式期望', async () => {
    const { a, b, c, d } = ids;
    const summary = (r: EarningsDateCollectResult) => ({
      observations: r.observations.map((o) => [o.instrumentId, o.periodKey, o.announceDate]),
      noticeSignals: r.noticeSignals.map((s) => [s.instrumentId, s.noticeDate]),
      unalignedPublications: r.unalignedPublications,
      lookalikeNoticeTitles: r.lookalikeNoticeTitles,
    });

    const reference = recordingSource(WHOLE_WINDOW_CHUNK_DAYS);
    const backfillRef = await collect(reference.source, 'backfill');
    const dailyRef = await collect(reference.source, 'daily');
    // 参考臂确为整窗一次读取 (回填 1 次 + 日常 1 次)。
    expect(reference.ranges).toEqual([
      [BACKFILL_FROM, BUSINESS_DATE],
      [addDays(BUSINESS_DATE, -NOTICE_MATCH_WINDOW_DAYS), BUSINESS_DATE],
    ]);

    expect(summary(backfillRef)).toEqual({
      observations: [
        [a, 'P:2024-06-30', addDays(boundary(1), -1)],
        [c, 'D:hkex_announcement:2025-08-20', '2025-08-20'],
        [d, 'P:2026-06-30', addDays(BUSINESS_DATE, -PUBLICATION_FACT_DAILY_LOOKBACK_DAYS - 1)],
        [a, 'P:2026-06-30', addDays(BUSINESS_DATE, -PUBLICATION_FACT_DAILY_LOOKBACK_DAYS)],
        [b, 'P:2026-06-30', BUSINESS_DATE],
      ],
      noticeSignals: [
        [a, BACKFILL_FROM],
        [b, addDays(boundary(1), -1)],
        [b, boundary(1)],
        [b, addDays(boundary(5), -1)],
        [b, boundary(5)],
        [d, addDays(BUSINESS_DATE, -NOTICE_MATCH_WINDOW_DAYS - 1)],
        [d, addDays(BUSINESS_DATE, -NOTICE_MATCH_WINDOW_DAYS)],
      ],
      unalignedPublications: 1,
      lookalikeNoticeTitles: 1,
    });
    expect(summary(dailyRef)).toEqual({
      observations: [
        [a, 'P:2026-06-30', addDays(BUSINESS_DATE, -PUBLICATION_FACT_DAILY_LOOKBACK_DAYS)],
        [b, 'P:2026-06-30', BUSINESS_DATE],
      ],
      noticeSignals: [[d, addDays(BUSINESS_DATE, -NOTICE_MATCH_WINDOW_DAYS)]],
      unalignedPublications: 0,
      lookalikeNoticeTitles: 0,
    });

    // 默认片宽排第一：重叠变异下片宽 1 会死循环，先在 30 天臂就红出来。
    for (const chunkDays of [ANNOUNCEMENT_LOAD_CHUNK_DAYS, 7, 1]) {
      const chunked = new HkexAnnouncementSource(prisma, chunkDays);
      expect({ chunkDays, result: await collect(chunked, 'backfill') }).toEqual({
        chunkDays,
        result: backfillRef,
      });
      expect({ chunkDays, result: await collect(chunked, 'daily') }).toEqual({
        chunkDays,
        result: dailyRef,
      });
    }
  });

  it('② 结构性上界: 回填每片 ≤ 片宽、次数 = ⌈731 / 片宽⌉、相邻区间首尾相接; 日常区间记录实际值', async () => {
    const backfill = recordingSource(ANNOUNCEMENT_LOAD_CHUNK_DAYS);
    await collect(backfill.source, 'backfill');

    const windowDays = HKEX_ANNOUNCEMENT_BACKFILL_LOOKBACK_DAYS + 1;
    expect(backfill.ranges).toHaveLength(Math.ceil(windowDays / ANNOUNCEMENT_LOAD_CHUNK_DAYS));
    expect(backfill.ranges[0][0]).toBe(BACKFILL_FROM);
    expect(backfill.ranges.at(-1)?.[1]).toBe(BUSINESS_DATE);
    backfill.ranges.forEach(([from, to], i) => {
      const spanDays = (day(to).getTime() - day(from).getTime()) / 86_400_000 + 1;
      expect({
        i,
        spanDays,
        withinChunk: spanDays >= 1 && spanDays <= ANNOUNCEMENT_LOAD_CHUNK_DAYS,
      }).toEqual({
        i,
        spanDays,
        withinChunk: true,
      });
      if (i > 0) expect({ i, from }).toEqual({ i, from: addDays(backfill.ranges[i - 1][1], 1) });
    });

    const daily = recordingSource(ANNOUNCEMENT_LOAD_CHUNK_DAYS);
    await collect(daily.source, 'daily');
    // 日常：刊发 7 天窗 ⊂ 信号 120 天窗 ⇒ 只扫 121 天并集，按 30 天切 5 片。
    expect(daily.ranges).toEqual([
      ['2026-05-16', '2026-06-14'],
      ['2026-06-15', '2026-07-14'],
      ['2026-07-15', '2026-08-13'],
      ['2026-08-14', '2026-09-12'],
      ['2026-09-13', '2026-09-13'],
    ]);

    expect(() => new HkexAnnouncementSource(prisma, 0)).toThrow(/loadChunkDays/);
    expect(() => new HkexAnnouncementSource(prisma, 1.5)).toThrow(/loadChunkDays/);
  });
});
