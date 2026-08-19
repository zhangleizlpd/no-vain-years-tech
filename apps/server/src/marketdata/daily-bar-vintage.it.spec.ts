import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { toDailyBarRow, writeDailyBarRows } from './dimension-executor';
import { EnsureLatestEodBarUseCase } from './ensure-latest-eod-bar.usecase';
import type { EodBarPort } from './eod-bar.port';
import type { EodBarPoint } from './marketdata.types';

/**
 * `daily_bar` **尾窗可订正**落库的写库路径 IT（Testcontainers PG），063 Phase 3.1 / plan §2.3。
 *
 * ## 为什么必须是 IT 而不是 mock 单测
 *
 * 本次改的东西**只在真唯一键上才存在**：`createMany(skipDuplicates)` 与 `upsert` 在 mock 上
 * 都只是「被调用过」，谁把已存在的那行改掉了、谁把它静默跳过了，**只有真表答得出**。而
 * 「订正静默失效」正是本片要消灭的那类偏差 —— 它不报错，只是数字一直是旧的。
 *
 * ## 断言的是**落库行的值**，不是调用次数
 *
 * 每条用例都读回 `daily_bar` 的真实列值。行数对得上、调用次数对得上而值是旧的，恰恰是
 * #103（盘中建锚落半根 K）的形状。
 */

/** us 标的一只，两个写入口共用。 */
const INSTRUMENT = {
  market: 'us',
  code: 'PEP',
  name: 'PepsiCo',
  type: 'stock',
  currency: 'USD',
  status: 'listed',
};

const bar = (tradeDate: string, close: string): EodBarPoint => ({
  tradeDate,
  adjust: 'none',
  open: close,
  high: close,
  low: close,
  close,
  changePct: null,
  prevClose: null,
  volume: null,
  amount: null,
  turnoverRate: null,
});

/** `YYYY-MM-DD` 序列（自然日，交易日历与本片无关 —— 尾窗切的是**行**不是日历）。 */
const days = (from: string, count: number): string[] => {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
};

describe('daily_bar 尾窗可订正落库 (063 Phase 3.1)', () => {
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let prisma: PrismaService;
  let instrumentId: bigint;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.dailyBar.deleteMany();
    await prisma.instrument.deleteMany();
    const inst = await prisma.instrument.create({ data: INSTRUMENT, select: { id: true } });
    instrumentId = inst.id;
  });

  const closesByDate = async (): Promise<Record<string, number>> => {
    const rows = await prisma.dailyBar.findMany({
      orderBy: { tradeDate: 'asc' },
      select: { tradeDate: true, close: true },
    });
    return Object.fromEntries(
      rows.map((r) => [r.tradeDate.toISOString().slice(0, 10), Number(r.close)]),
    );
  };

  const write = (points: EodBarPoint[]): Promise<void> =>
    writeDailyBarRows(
      prisma,
      points.map((p) => toDailyBarRow(instrumentId, p)),
    );

  it('尾窗内已存在的行**被订正** —— 盘中落的「进行中 K」收盘后能改回来 (#103 的形状)', async () => {
    await write([bar('2026-08-18', '100')]); // 盘中：半根 K
    await write([bar('2026-08-18', '123')]); // 收盘后：vendor 给的定值

    expect(await closesByDate()).toEqual({ '2026-08-18': 123 });
    expect(await prisma.dailyBar.count()).toBe(1); // 订正 ≠ 追加
  });

  it('尾窗**外**的行纹丝不动 —— 更老的历史仍是 insert-only', async () => {
    const dates = days('2026-08-01', 15); // 尾窗 10 ⇒ 前 5 根在窗外
    await write(dates.map((d) => bar(d, '100')));
    await write(dates.map((d) => bar(d, '200')));

    const closes = await closesByDate();
    expect(dates.slice(0, 5).map((d) => closes[d])).toEqual([100, 100, 100, 100, 100]);
    expect(dates.slice(5).map((d) => closes[d])).toEqual(Array.from({ length: 10 }, () => 200));
    expect(await prisma.dailyBar.count()).toBe(15);
  });

  it('入参**乱序**时尾窗仍按 tradeDate 切 (端口契约说升序, 但函数不赖它)', async () => {
    const dates = days('2026-08-01', 15);
    await write(dates.map((d) => bar(d, '100')));
    await write([...dates].reverse().map((d) => bar(d, '200')));

    const closes = await closesByDate();
    expect(dates.slice(0, 5).map((d) => closes[d])).toEqual([100, 100, 100, 100, 100]);
    expect(closes[dates[14]]).toBe(200);
  });

  it('空批零往返 (停牌 / 新股无行情 ⇒ 不该开事务)', async () => {
    await expect(write([])).resolves.toBeUndefined();
    expect(await prisma.dailyBar.count()).toBe(0);
  });

  it('EnsureLatestEodBarUseCase 走的是**同一个**写路径 —— 建锚那一次也能订正', async () => {
    await write([bar('2026-08-18', '100')]);

    const getBars = async (): Promise<EodBarPoint[]> => [bar('2026-08-18', '456')];
    const useCase = new EnsureLatestEodBarUseCase(prisma, { getBars } as unknown as EodBarPort);
    const latest = await useCase.execute('us:PEP', '2026-08-18');

    expect(latest?.close).toBe('456');
    expect(await closesByDate()).toEqual({ '2026-08-18': 456 });
    expect(await prisma.dailyBar.count()).toBe(1);
  });
});
