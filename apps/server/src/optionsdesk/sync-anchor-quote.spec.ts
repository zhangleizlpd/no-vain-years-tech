import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { ANCHOR_QUOTE_PRICE_KIND, SyncAnchorQuoteUseCase, toQuoteAsOf } from './sync-anchor-quote';
import { parseAnchorTicker } from './anchor.rules';
import type { PrismaService } from '../security/prisma.service';

type Fn = ReturnType<typeof vi.fn>;

interface PrismaMock {
  prisma: PrismaService;
  anchorFindMany: Fn;
  anchorUpdateMany: Fn;
  instrumentFindUnique: Fn;
  dailyBarFindFirst: Fn;
}

const anchorRef = (ticker: string, overrides: Record<string, unknown> = {}) => ({
  id: 7n,
  ticker,
  lastClose: null as Prisma.Decimal | null,
  lastCloseDate: null as Date | null,
  ...overrides,
});

function buildPrismaMock(): PrismaMock {
  const anchorFindMany = vi.fn().mockResolvedValue([anchorRef('us:AOS')]);
  const anchorUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const instrumentFindUnique = vi.fn().mockResolvedValue({ id: 91n });
  const dailyBarFindFirst = vi.fn().mockResolvedValue({
    tradeDate: new Date('2026-07-31T00:00:00Z'),
    close: new Prisma.Decimal('36.5000'),
  });
  const prisma = {
    anchor: { findMany: anchorFindMany, updateMany: anchorUpdateMany },
    instrument: { findUnique: instrumentFindUnique },
    dailyBar: { findFirst: dailyBarFindFirst },
  } as unknown as PrismaService;
  return { prisma, anchorFindMany, anchorUpdateMany, instrumentFindUnique, dailyBarFindFirst };
}

describe('parseAnchorTicker — canonical `market:code` (本 ctx 自解析)', () => {
  it('正常 ticker → market + code', () => {
    expect(parseAnchorTicker('us:AOS')).toEqual({ market: 'us', code: 'AOS' });
  });

  it.each(['AOS', ':AOS', 'us:', ''])('非法 ticker %s → null (不猜, 走 no-data)', (raw) => {
    expect(parseAnchorTicker(raw)).toBeNull();
  });
});

describe('toQuoteAsOf — EC-14 asOf 取数据自身的 session 日期', () => {
  it('bar 的 tradeDate 原样投影为 YYYY-MM-DD', () => {
    expect(toQuoteAsOf(new Date('2026-07-31T00:00:00Z'))).toBe('2026-07-31');
  });
});

describe('SyncAnchorQuoteUseCase — last_close 单向投影 (FR-016/017/027/036)', () => {
  let m: PrismaMock;
  let useCase: SyncAnchorQuoteUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new SyncAnchorQuoteUseCase(m.prisma);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('有 bar → 回填 last_close + last_close_date, hasData=true', async () => {
    const report = await useCase.execute();

    expect(report.scanned).toBe(1);
    expect(report.updated).toBe(1);
    expect(report.projections[0]).toMatchObject({
      ticker: 'us:AOS',
      asOf: '2026-07-31',
      priceKind: ANCHOR_QUOTE_PRICE_KIND,
      hasData: true,
    });
    expect(report.projections[0]!.lastClose!.toFixed(4)).toBe('36.5000');

    expect(m.anchorUpdateMany).toHaveBeenCalledTimes(1);
    const call = m.anchorUpdateMany.mock.calls[0]![0] as {
      where: { id: bigint };
      data: { lastClose: Prisma.Decimal; lastCloseDate: Date };
    };
    expect(call.where.id).toBe(7n);
    expect(call.data.lastClose.toFixed(4)).toBe('36.5000');
    expect(call.data.lastCloseDate.toISOString().slice(0, 10)).toBe('2026-07-31');
  });

  it('未注册 adjust=none 口径以外的序列不参与 (D7 原始价口径), 取最新 tradeDate', async () => {
    await useCase.execute();
    const query = m.dailyBarFindFirst.mock.calls[0]![0] as {
      where: { instrumentId: bigint; adjust: string };
      orderBy: { tradeDate: string };
    };
    expect(query.where).toMatchObject({ instrumentId: 91n, adjust: 'none' });
    expect(query.orderBy).toEqual({ tradeDate: 'desc' });
  });

  it('🚨 无 bar → hasData=false 且**一列不写** (禁 0 值伪造, FR-017)', async () => {
    m.dailyBarFindFirst.mockResolvedValue(null);

    const report = await useCase.execute();

    expect(report.projections[0]).toMatchObject({
      ticker: 'us:AOS',
      lastClose: null,
      asOf: null,
      hasData: false,
    });
    expect(report.updated).toBe(0);
    expect(m.anchorUpdateMany).not.toHaveBeenCalled();
  });

  it('未注册 instrument → 显式 no-data, 且不再查 daily_bar', async () => {
    m.instrumentFindUnique.mockResolvedValue(null);

    const report = await useCase.execute();

    expect(report.projections[0]!.hasData).toBe(false);
    expect(m.dailyBarFindFirst).not.toHaveBeenCalled();
    expect(m.anchorUpdateMany).not.toHaveBeenCalled();
  });

  it('非法 ticker → 显式 no-data, 一次跨 ctx 读都不发', async () => {
    m.anchorFindMany.mockResolvedValue([anchorRef('AOS')]);

    const report = await useCase.execute();

    expect(report.projections[0]!.hasData).toBe(false);
    expect(m.instrumentFindUnique).not.toHaveBeenCalled();
    expect(m.dailyBarFindFirst).not.toHaveBeenCalled();
  });

  it('🚨 EC-14 asOf 恒等于 bar 的 tradeDate, 与运行时本地日期无关 (美股 session 跨本地日)', async () => {
    // 本地已是 08-02 凌晨 (盘后), 而最新 bar 仍是 07-31 session —— 取本地日期即谎报新鲜度。
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T03:00:00Z'));

    const report = await useCase.execute();

    expect(report.projections[0]!.asOf).toBe('2026-07-31');
    const call = m.anchorUpdateMany.mock.calls[0]![0] as { data: { lastCloseDate: Date } };
    expect(call.data.lastCloseDate.toISOString().slice(0, 10)).toBe('2026-07-31');
  });

  it('🚨 单向: 全程只读 marketdata (instrument / daily_bar 上零写方法)', async () => {
    await useCase.execute();
    const marketdata = m.prisma as unknown as {
      instrument: Record<string, unknown>;
      dailyBar: Record<string, unknown>;
    };
    // mock 上只挂了读方法 —— 若实现试图反写 daily_bar 会 TypeError 直接红。
    expect(Object.keys(marketdata.instrument)).toEqual(['findUnique']);
    expect(Object.keys(marketdata.dailyBar)).toEqual(['findFirst']);
  });

  it('值未变 → 幂等不重复写 (投影是缓存, 无变化不产生 UPDATE)', async () => {
    m.anchorFindMany.mockResolvedValue([
      anchorRef('us:AOS', {
        lastClose: new Prisma.Decimal('36.5000'),
        lastCloseDate: new Date('2026-07-31T00:00:00Z'),
      }),
    ]);

    const report = await useCase.execute();

    expect(report.projections[0]!.hasData).toBe(true);
    expect(report.updated).toBe(0);
    expect(m.anchorUpdateMany).not.toHaveBeenCalled();
  });

  it('一只 no-data 不污染同批其余 (逐锚独立投影)', async () => {
    m.anchorFindMany.mockResolvedValue([
      anchorRef('us:AOS', { id: 7n }),
      anchorRef('us:NOPE', { id: 8n }),
    ]);
    m.instrumentFindUnique.mockImplementation(
      async (args: { where: { market_code: { code: string } } }) =>
        args.where.market_code.code === 'NOPE' ? null : { id: 91n },
    );

    const report = await useCase.execute();

    expect(report.scanned).toBe(2);
    expect(report.updated).toBe(1);
    expect(report.projections.map((p: { hasData: boolean }) => p.hasData)).toEqual([true, false]);
  });
});
