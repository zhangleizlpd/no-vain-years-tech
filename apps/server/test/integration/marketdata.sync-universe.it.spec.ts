import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import type { VendorHttpClient, VendorRequest } from '../../src/marketdata/vendor-http-client';
import { EastmoneyUniverseAdapter } from '../../src/marketdata/eastmoney-universe.adapter';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';

const CLIST_BASE = 'https://push2.eastmoney.com';

/** 单页 clist fixture (含沪/深/北交所) — 经真 EastmoneyUniverseAdapter 解析路径。 */
function makeClistHttp(diff: unknown[]): VendorHttpClient {
  const request = vi.fn(async (_req: VendorRequest) => ({ data: { total: diff.length, diff } }));
  return { request } as unknown as VendorHttpClient;
}

// 016 T009 PR2 集成 IT (Testcontainers PG): EastmoneyUniverseAdapter(mock clist) →
// SyncUniverseUseCase → DB 垂直集成。PR2 Independent Test ①②③: clist 解析含北交所 →
// canonical+pinyin 落库 / 重跑幂等(syncTier·fsType 不重置) / 黑名单跳过。
// (④ env-gated 真东财 clist 解析见 marketdata.eastmoney.vendor, SC-S08。)
describe('016 PR2 universe sync vertical (clist adapter → usecase → PG)', () => {
  let prisma: PrismaService;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.instrument.deleteMany();
    await prisma.syncBlacklist.deleteMany();
  });

  function usecase(diff: unknown[]): SyncUniverseUseCase {
    const adapter = new EastmoneyUniverseAdapter(makeClistHttp(diff), CLIST_BASE);
    return new SyncUniverseUseCase(adapter, prisma);
  }

  it('① clist 含北交所 → canonical market:code + pinyin 落库', async () => {
    const stats = await usecase([
      { f12: '600519', f13: 1, f14: '贵州茅台' }, // 沪
      { f12: '000001', f13: 0, f14: '平安银行' }, // 深
      { f12: '830799', f13: 0, f14: '艾融软件' }, // 北交所
    ]).run();

    expect(stats).toMatchObject({ scanned: 3, ok: 3, failed: 0 });
    const rows = await prisma.instrument.findMany({ orderBy: { code: 'asc' } });
    expect(rows.map((r) => `${r.market}:${r.code}`)).toEqual([
      'cn:000001',
      'cn:600519',
      'cn:830799', // 北交所收录
    ]);
    const maotai = rows.find((r) => r.code === '600519');
    expect(maotai?.pinyinAbbr).toBe('gzmt');
    expect(maotai?.pinyinFull).toBe('guizhoumaotai');
  });

  it('② 重跑幂等: 无重复 + name 更新, syncTier/lixingerCompanyType 不被重置', async () => {
    await usecase([{ f12: '600519', f13: 1, f14: '贵州茅台' }]).run();
    await prisma.instrument.update({
      where: { market_code: { market: 'cn', code: '600519' } },
      data: { syncTier: 1, lixingerCompanyType: 'non_financial' },
    });

    await usecase([{ f12: '600519', f13: 1, f14: '贵州茅台股份' }]).run();

    expect(await prisma.instrument.count()).toBe(1);
    const row = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'cn', code: '600519' } },
    });
    expect(row.name).toBe('贵州茅台股份');
    expect(row.syncTier).toBe(1);
    expect(row.lixingerCompanyType).toBe('non_financial');
  });

  it('③ code ∈ SyncBlacklist → 跳过未 insert', async () => {
    await prisma.syncBlacklist.create({
      data: { market: 'cn', code: '830799', reason: '北交所流动性测试排除' },
    });
    const stats = await usecase([
      { f12: '600519', f13: 1, f14: '贵州茅台' },
      { f12: '830799', f13: 0, f14: '艾融软件' },
    ]).run();

    expect(stats).toMatchObject({ scanned: 2, ok: 1, skipped: 1 });
    expect(await prisma.instrument.count()).toBe(1);
    expect(
      await prisma.instrument.findUnique({
        where: { market_code: { market: 'cn', code: '830799' } },
      }),
    ).toBeNull();
  });
});
