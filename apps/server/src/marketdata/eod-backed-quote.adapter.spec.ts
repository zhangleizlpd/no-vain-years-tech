import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { EodBackedQuoteAdapter } from './eod-backed-quote.adapter.js';
import type { PrismaService } from '../security/prisma.service.js';

/** 最小 PrismaService stub: 仅 instrument.findUnique + dailyBar.findFirst。 */
function makePrisma(opts: {
  instrument?: { id: bigint; name: string } | null;
  bar?: {
    tradeDate: Date;
    close: Prisma.Decimal;
    changePct: Prisma.Decimal | null;
    prevClose: Prisma.Decimal | null;
  } | null;
}): PrismaService {
  return {
    instrument: { findUnique: vi.fn(async () => opts.instrument ?? null) },
    dailyBar: { findFirst: vi.fn(async () => opts.bar ?? null) },
  } as unknown as PrismaService;
}

const D = (v: string) => new Prisma.Decimal(v);

describe('EodBackedQuoteAdapter — EOD-backed 报价投影', () => {
  it('有官方 changePct → 据其反推涨跌额 (除权日正确, 非相邻收盘差)', async () => {
    // 茅台 2025-06-26 分红除息: 官方 +0.83%; 若用相邻原始前收 1435.86 算会得负值 (错)。
    // 适配器优先官方 changePct → 涨跌额 +11.69, 与同花顺一致。
    const adapter = new EodBackedQuoteAdapter(
      makePrisma({
        instrument: { id: 1n, name: '贵州茅台' },
        bar: {
          tradeDate: new Date('2025-06-26T00:00:00Z'),
          close: D('1420'),
          changePct: D('0.8300'),
          prevClose: D('1435.86'), // 误导项: 相邻原始收盘, 适配器不该用它
        },
      }),
    );
    const [q] = await adapter.getQuotes(['cn:600519']);
    expect(q).toMatchObject({ price: '1420.0000', change: '11.6890', changePct: '0.8300' });
  });

  it('changePct 缺 (旧行未回填) → 回退相邻前收算涨跌', async () => {
    const adapter = new EodBackedQuoteAdapter(
      makePrisma({
        instrument: { id: 1n, name: '贵州茅台' },
        bar: {
          tradeDate: new Date('2026-06-01T00:00:00Z'),
          close: D('1700'),
          changePct: null,
          prevClose: D('1690'),
        },
      }),
    );
    const [q] = await adapter.getQuotes(['cn:600519']);
    expect(q).toEqual({
      symbol: 'cn:600519',
      name: '贵州茅台',
      price: '1700.0000',
      change: '10.0000',
      changePct: '0.5917',
      asOf: '2026-06-01',
      priceKind: 'eod_close',
      hasData: true,
    });
  });

  it('changePct 与前收都缺 → price 有值但 change/changePct null (不伪造)', async () => {
    const adapter = new EodBackedQuoteAdapter(
      makePrisma({
        instrument: { id: 1n, name: '贵州茅台' },
        bar: {
          tradeDate: new Date('2026-06-01T00:00:00Z'),
          close: D('1700'),
          changePct: null,
          prevClose: null,
        },
      }),
    );
    const [q] = await adapter.getQuotes(['cn:600519']);
    expect(q).toMatchObject({ price: '1700.0000', change: null, changePct: null, hasData: true });
  });

  // name 与 hasData 正交: instrument 已注册即返 name (列表主名不留空)。
  it.each([
    ['非法 canonical (无市场段)', '600519', makePrisma({}), null],
    ['未注册 instrument', 'cn:999999', makePrisma({ instrument: null }), null],
    [
      '有 instrument 但无 DailyBar',
      'cn:600519',
      makePrisma({ instrument: { id: 1n, name: '贵州茅台' }, bar: null }),
      '贵州茅台',
    ],
  ])('%s → 显式 no-data (hasData:false 报价字段全 null)', async (_label, symbol, prisma, name) => {
    const [q] = await new EodBackedQuoteAdapter(prisma).getQuotes([symbol]);
    expect(q).toEqual({
      symbol,
      name,
      price: null,
      change: null,
      changePct: null,
      asOf: null,
      priceKind: 'eod_close',
      hasData: false,
    });
  });

  it('批量中单项 no-data 不污染同批其余项', async () => {
    // 第一只有数据, 第二只 instrument 缺失 → 各自独立投影。
    const prisma = {
      instrument: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ id: 1n, name: '贵州茅台' })
          .mockResolvedValueOnce(null),
      },
      dailyBar: {
        findFirst: vi.fn().mockResolvedValueOnce({
          tradeDate: new Date('2026-06-01T00:00:00Z'),
          close: D('1700'),
          changePct: null,
          prevClose: D('1690'),
        }),
      },
    } as unknown as PrismaService;
    const out = await new EodBackedQuoteAdapter(prisma).getQuotes(['cn:600519', 'cn:000001']);
    expect(out[0].hasData).toBe(true);
    expect(out[1].hasData).toBe(false);
    expect(out.map((q) => q.symbol)).toEqual(['cn:600519', 'cn:000001']);
  });
});
