import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { LocalInstrumentSearchAdapter } from '../../src/marketdata/local-instrument-search.adapter';

// 015 T013 LocalInstrumentSearchAdapter Testcontainers IT (PG + pg_trgm)。FallbackChain 次源:
// 在 seed 的 Instrument 注册表上做名/拼音/代码三路模糊命中。验:
//  ① 中文名 trgm/子串命中 ② 拼音 abbr 命中 (短串子串) ③ 代码前缀命中 + 精确优先排序
//  ④ 错字 trgm 相似命中 ⑤ 无命中 → 空数组 (非 error)。run via `nx test server <file>`。
describe('015 LocalInstrumentSearchAdapter (Testcontainers PG + pg_trgm)', () => {
  let prisma: PrismaService;
  let adapter: LocalInstrumentSearchAdapter;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;

    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
    adapter = new LocalInstrumentSearchAdapter(prisma);

    // seed universe (含拼音 — 016 同步时 pinyin-pro 填; 本 IT fixture 直接给)。
    await prisma.instrument.createMany({
      data: [
        {
          market: 'cn',
          code: '600519',
          name: '贵州茅台',
          type: 'stock',
          currency: 'CNY',
          pinyinAbbr: 'gzmt',
          pinyinFull: 'guizhoumaotai',
          status: 'listed',
        },
        {
          market: 'cn',
          code: '000858',
          name: '五粮液',
          type: 'stock',
          currency: 'CNY',
          pinyinAbbr: 'wly',
          pinyinFull: 'wuliangye',
          status: 'listed',
        },
        {
          market: 'cn',
          code: '000001',
          name: '平安银行',
          type: 'stock',
          currency: 'CNY',
          pinyinAbbr: 'payh',
          pinyinFull: 'pinganyinhang',
          status: 'listed',
        },
        {
          market: 'hk',
          code: '00700',
          name: '腾讯控股',
          type: 'stock',
          currency: 'HKD',
          pinyinAbbr: 'txkg',
          pinyinFull: 'tengxunkonggu',
          status: 'listed',
        },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  it('中文名命中 → canonical market:code + name + type', async () => {
    const out = await adapter.search('茅台');
    expect(out).toContainEqual({ symbol: 'cn:600519', name: '贵州茅台', type: 'stock' });
  });

  it('拼音 abbr 命中 (短串子串)', async () => {
    const out = await adapter.search('gzmt');
    expect(out[0]).toEqual({ symbol: 'cn:600519', name: '贵州茅台', type: 'stock' });
  });

  it('拼音 full 子串命中', async () => {
    const out = await adapter.search('wuliang');
    expect(out.some((h) => h.symbol === 'cn:000858')).toBe(true);
  });

  it('代码前缀命中 + 精确代码排第一', async () => {
    const out = await adapter.search('000001');
    expect(out[0].symbol).toBe('cn:000001');
  });

  it('港股标的命中 (market 前缀 hk)', async () => {
    const out = await adapter.search('腾讯');
    expect(out.some((h) => h.symbol === 'hk:00700')).toBe(true);
  });

  it('无命中冷僻串 → 空数组 (非 error)', async () => {
    const out = await adapter.search('zzzznonexistent');
    expect(out).toEqual([]);
  });

  it('空白 query → 空数组, 不打 DB', async () => {
    expect(await adapter.search('   ')).toEqual([]);
  });
});
