import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import type { VendorHttpClient, VendorRequest } from '../../src/marketdata/vendor-http-client';
import { LixingerCompanyProfileAdapter } from '../../src/marketdata/lixinger-company-profile.adapter';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';

const LIX_BASE = 'https://open.lixinger.com/api';

/** /cn/company 返 {stockCode, fs_type} 的 fake http; 记录 request 次数供「零外呼」断言。 */
function makeCompanyHttp(byCode: Record<string, string>): {
  http: VendorHttpClient;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async (req: VendorRequest) => {
    const body = JSON.parse(req.body ?? '{}') as { stockCodes?: string[] };
    const data = (body.stockCodes ?? [])
      .filter((c) => byCode[c])
      .map((c) => ({ stockCode: c, fsTableType: byCode[c] }));
    return { data };
  });
  return { http: { request } as unknown as VendorHttpClient, request };
}

// 016 T010 PR3 profile 富化垂直 IT (Testcontainers PG): 缺 lixingerCompanyType 的 cn 标的
// → COMPANY_PROFILE_PORT(LixingerCompanyProfileAdapter, fake /cn/company) → 缓存回写落库;
// 已缓存标的零外呼。
describe('016 T010 profile enrichment vertical (lixinger /cn/company → cache writeback)', () => {
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
  });

  async function seedInstrument(code: string, lixingerCompanyType: string | null): Promise<void> {
    await prisma.instrument.create({
      data: {
        market: 'cn',
        code,
        name: code,
        type: 'stock',
        currency: 'CNY',
        status: 'active',
        ...(lixingerCompanyType ? { lixingerCompanyType } : {}),
      },
    });
  }

  it('① 缺 fsType 的标的富化后 lixingerCompanyType 落库', async () => {
    await seedInstrument('600519', null); // 非金融
    await seedInstrument('601398', null); // 银行
    const { http, request } = makeCompanyHttp({ '600519': 'non_financial', '601398': 'bank' });

    const stats = await new SyncProfileUseCase(
      new LixingerCompanyProfileAdapter(http, 'tok', LIX_BASE, prisma),
      prisma,
    ).run();

    expect(stats).toMatchObject({ scanned: 2, ok: 2, failed: 0 });
    expect(request).toHaveBeenCalledTimes(1); // 单批
    const rows = await prisma.instrument.findMany({ orderBy: { code: 'asc' } });
    expect(rows.map((r) => r.lixingerCompanyType)).toEqual(['non_financial', 'bank']);
  });

  it('③ 038 T009: hk reit 标的富化 → lixingerCompanyType=reit 落库 (房托 fsType 解锁; bank 常规同构)', async () => {
    await prisma.instrument.create({
      data: {
        market: 'hk',
        code: '00823',
        name: '领展房产基金',
        type: 'stock',
        currency: 'HKD',
        status: 'active',
      },
    });
    await prisma.instrument.create({
      data: {
        market: 'hk',
        code: '00939',
        name: '建设银行',
        type: 'stock',
        currency: 'HKD',
        status: 'active',
      },
    });
    const { http, request } = makeCompanyHttp({ '00823': 'reit', '00939': 'bank' });

    const stats = await new SyncProfileUseCase(
      new LixingerCompanyProfileAdapter(http, 'tok', LIX_BASE, prisma),
      prisma,
    ).run();

    expect(stats).toMatchObject({ scanned: 2, ok: 2, failed: 0 });
    const reit = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'hk', code: '00823' } },
    });
    expect(reit.lixingerCompanyType).toBe('reit'); // hk 房托 fsType 解锁落库
    const bank = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'hk', code: '00939' } },
    });
    expect(bank.lixingerCompanyType).toBe('bank'); // 常规 fsType 与 A 股同构
    // market 段路由到 /hk/company (非 /cn/company)。
    const url = String((request.mock.calls[0][0] as { url: string }).url);
    expect(url).toContain('/hk/company');
  });

  it('② 已缓存标的零外呼 (不在缺失查询集)', async () => {
    await seedInstrument('600519', 'non_financial'); // 已缓存
    const { http, request } = makeCompanyHttp({ '600519': 'non_financial' });

    const stats = await new SyncProfileUseCase(
      new LixingerCompanyProfileAdapter(http, 'tok', LIX_BASE, prisma),
      prisma,
    ).run();

    expect(stats).toMatchObject({ scanned: 0, ok: 0, failed: 0 });
    expect(request).not.toHaveBeenCalled(); // 零外呼
  });
});
