import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { EodBackedQuoteAdapter } from './eod-backed-quote.adapter';

// 真 PG 落库读路径 IT (testcontainers)：补 mock 单测 (eod-backed-quote.adapter.spec.ts) 覆盖不到的
// 缝 —— instrument.findUnique / dailyBar.findFirst 真打表 + Decimal 真序列化 + tradeDate 真排序。
// 此前由 mobile contract-smoke EP2 担纲, 但该套件 server boot 恒 MARKETDATA_PROVIDER=mock →
// QUOTE_PORT 绑 MockMarketDataAdapter (fixture), 不读 PG, 断言 name 永远对不上 → 下沉至此。
describe('EodBackedQuoteAdapter (Testcontainers PG) — 真落库读路径', () => {
  let prisma: PrismaService;
  let adapter: EodBackedQuoteAdapter;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;

    const url = db.databaseUrl;

    prisma = new PrismaService(url);
    adapter = new EodBackedQuoteAdapter(prisma);

    // 种 symbol (有 EOD 行): 06-05 close 1700 / prevClose 1690, change_pct 留 null → 读侧
    // 回退 computeChange(close, prevClose): change 10.0000, changePct 10/1690*100 = 0.5917。
    const seeded = await prisma.instrument.create({
      data: {
        market: 'cn',
        code: '600599',
        name: '契约冒烟标的',
        type: 'stock',
        currency: 'CNY',
        pinyinAbbr: 'qyhgmd',
        pinyinFull: 'qiyuehuagongmaodou',
        status: 'listed',
        listDate: new Date('2001-08-27'),
      },
    });
    await prisma.dailyBar.create({
      data: {
        instrumentId: seeded.id,
        tradeDate: new Date('2026-06-05'),
        adjust: 'none',
        open: '1680',
        high: '1710',
        low: '1670',
        close: '1700',
        prevClose: '1690',
      },
    });

    // 注册但无任何 DailyBar: 验 name 与 hasData 正交 (已注册即返 name, 无行 hasData false)。
    await prisma.instrument.create({
      data: {
        market: 'cn',
        code: '600588',
        name: '缺维度标的',
        type: 'stock',
        currency: 'CNY',
        status: 'listed',
      },
    });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  it('种 symbol → EOD-backed 读 PG: name 取自 Instrument, 报价取自最近 none 行', async () => {
    const [q] = await adapter.getQuotes(['cn:600599']);
    expect(q).toEqual({
      symbol: 'cn:600599',
      name: '契约冒烟标的',
      price: '1700.0000',
      change: '10.0000',
      changePct: '0.5917',
      asOf: '2026-06-05',
      priceKind: 'eod_close',
      hasData: true,
    });
  });

  it('注册无 DailyBar → name 仍返 (与 hasData 正交), 价格维度全 null', async () => {
    const [q] = await adapter.getQuotes(['cn:600588']);
    expect(q).toEqual({
      symbol: 'cn:600588',
      name: '缺维度标的',
      price: null,
      change: null,
      changePct: null,
      asOf: null,
      priceKind: 'eod_close',
      hasData: false,
    });
  });

  it('未注册 symbol → no-data 形状 (name null, 价格全 null, priceKind 仍 eod_close)', async () => {
    const [q] = await adapter.getQuotes(['cn:999999']);
    expect(q).toEqual({
      symbol: 'cn:999999',
      name: null,
      price: null,
      change: null,
      changePct: null,
      asOf: null,
      priceKind: 'eod_close',
      hasData: false,
    });
  });

  it('批量混合 → 按入参顺序返回, 有/无数据同批隔离', async () => {
    const quotes = await adapter.getQuotes(['cn:600599', 'cn:999999']);
    expect(quotes.map((q) => q.symbol)).toEqual(['cn:600599', 'cn:999999']);
    expect(quotes[0]!.hasData).toBe(true);
    expect(quotes[1]!.hasData).toBe(false);
  });
});
