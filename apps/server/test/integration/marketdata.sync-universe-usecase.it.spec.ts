import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import type { InstrumentUniversePort } from '../../src/marketdata/instrument-universe.port';
import type { UniverseEntry } from '../../src/marketdata/marketdata.types';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';

/** 固定 entries 的 stub universe 端口 (T008 验 usecase upsert 不变式, 不经真 vendor)。 */
function stubPort(entries: UniverseEntry[]): InstrumentUniversePort {
  return { enumerate: async () => entries };
}

/** market-aware stub (S2-T3): 按 run() 读到的 marketScope 分市场返 entries — 验 marketScope 驱动枚举。 */
function marketAwarePort(byMarket: Record<string, UniverseEntry[]>): InstrumentUniversePort {
  return { enumerate: async (markets: string[]) => markets.flatMap((m) => byMarket[m] ?? []) };
}

// 016 T008 universe 同步 usecase IT (Testcontainers PG): upsert+pinyin / 重跑幂等 +
// syncTier·lixingerCompanyType 不被重置 (FR-S03) / 黑名单跳过 / 坏项隔离不整体失败。
describe('016 T008 SyncUniverseUseCase (Testcontainers PG)', () => {
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
    // 隔离: 每例清 instrument + blacklist (sync_run 不涉)。
    await prisma.instrument.deleteMany();
    await prisma.syncBlacklist.deleteMany();
  });

  it('新标的 → insert + pinyin 填充 (abbr/full) + syncTier 默认 2', async () => {
    const uc = new SyncUniverseUseCase(
      stubPort([{ market: 'cn', code: '600519', name: '贵州茅台' }]),
      prisma,
    );
    const stats = await uc.run();

    expect(stats).toMatchObject({ scanned: 1, ok: 1, skipped: 0, failed: 0 });
    const row = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'cn', code: '600519' } },
    });
    expect(row.name).toBe('贵州茅台');
    expect(row.pinyinAbbr).toBe('gzmt');
    expect(row.pinyinFull).toBe('guizhoumaotai');
    expect(row.syncTier).toBe(2); // schema 默认
    expect(row.lixingerCompanyType).toBeNull(); // 待 profile 富化
    expect(row.type).toBe('stock');
    expect(row.currency).toBe('CNY');
  });

  it('重跑幂等: 无重复行 + name/pinyin 刷新, 但 syncTier/lixingerCompanyType 不被重置 (FR-S03)', async () => {
    const uc1 = new SyncUniverseUseCase(
      stubPort([{ market: 'cn', code: '600519', name: '贵州茅台' }]),
      prisma,
    );
    await uc1.run();

    // 模拟下游富化: 改 syncTier + 缓存 fsType (后续同步不应重置)。
    await prisma.instrument.update({
      where: { market_code: { market: 'cn', code: '600519' } },
      data: { syncTier: 1, lixingerCompanyType: 'non_financial' },
    });

    // 重跑 (name 变更 → 应刷新 name/pinyin)。
    const uc2 = new SyncUniverseUseCase(
      stubPort([{ market: 'cn', code: '600519', name: '贵州茅台股份' }]),
      prisma,
    );
    const stats = await uc2.run();

    expect(stats).toMatchObject({ scanned: 1, ok: 1 });
    expect(await prisma.instrument.count()).toBe(1); // 无重复
    const row = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'cn', code: '600519' } },
    });
    expect(row.name).toBe('贵州茅台股份'); // name 刷新
    expect(row.pinyinAbbr).toBe('gzmtgf'); // pinyin 随 name 刷新
    expect(row.syncTier).toBe(1); // 不被重置回 2
    expect(row.lixingerCompanyType).toBe('non_financial'); // fsType 缓存保留
  });

  it('038 T008: hk 新标的 insert market=hk/HKD/pinyin/syncTier默认2; 既有 upsert 不覆盖 syncTier/fsType; 退市→inactive (active-only)', async () => {
    const uc = new SyncUniverseUseCase(
      stubPort([
        {
          market: 'hk',
          code: '00700',
          name: '腾讯控股',
          status: 'active',
          listingStatus: 'normally_listed',
        },
        {
          market: 'hk',
          code: '01234',
          name: '某退市港股',
          status: 'inactive', // 退市/停牌 → active-only 过滤 (存 inactive → loadActiveInstruments 排除)
          listingStatus: 'some_hk_delisted_status',
        },
      ]),
      prisma,
    );
    const stats = await uc.run();
    expect(stats).toMatchObject({ scanned: 2, ok: 2, failed: 0 });

    // ① hk 新标的: market=hk / currency=HKD (T004 currencyForMarket) / pinyin 填充 / syncTier 默认 2。
    const tencent = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'hk', code: '00700' } },
    });
    expect(tencent.market).toBe('hk');
    expect(tencent.currency).toBe('HKD');
    expect(tencent.pinyinAbbr).toMatch(/^[a-z]+$/); // pinyin 填充 (精确值 cn 用例已断言)
    expect(tencent.syncTier).toBe(2);
    expect(tencent.status).toBe('active');
    expect(tencent.lixingerCompanyType).toBeNull();

    // ② active-only: 退市 hk 标的存 inactive (不纳入同步工作集), listingStatus 原值存档。
    const delisted = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'hk', code: '01234' } },
    });
    expect(delisted.status).toBe('inactive');
    expect(delisted.listingStatus).toBe('some_hk_delisted_status');

    // ③ 既有 hk 标的重跑 upsert 不覆盖 syncTier / lixingerCompanyType (FR-S03 护下游缓存)。
    await prisma.instrument.update({
      where: { market_code: { market: 'hk', code: '00700' } },
      data: { syncTier: 0, lixingerCompanyType: 'reit' },
    });
    const uc2 = new SyncUniverseUseCase(
      stubPort([
        {
          market: 'hk',
          code: '00700',
          name: '腾讯控股',
          status: 'active',
          listingStatus: 'normally_listed',
        },
      ]),
      prisma,
    );
    await uc2.run();
    const after = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'hk', code: '00700' } },
    });
    expect(after.syncTier).toBe(0); // 不被重置回 2
    expect(after.lixingerCompanyType).toBe('reit'); // fsType 缓存保留
  });

  it('S2-T3: universe marketScope 含 us (migration 总开关) → run 枚举 us 标的 upsert market=us/currency=USD', async () => {
    // ① migration 已把 universe 维度 marketScope 扩到 cn/hk/us (us 枚举总开关)。
    const dim = await prisma.syncDimension.findUniqueOrThrow({
      where: { dimensionKey: 'universe' },
    });
    expect(dim.marketScope).toContain('us');

    // ② run() 读该 marketScope 驱动 enumerate — market-aware stub 仅在被问 us 时返 us 标的,
    //    故 us 落库 ⟺ marketScope 确含 us (证 migration 通电, 非硬编码)。
    const uc = new SyncUniverseUseCase(
      marketAwarePort({ us: [{ market: 'us', code: 'AAPL', name: '苹果' }] }),
      prisma,
    );
    const stats = await uc.run();
    expect(stats.ok).toBe(1);

    // ③ us 新标的: market=us / currency=USD (currencyForMarket us→USD, S2-T3)。
    const apple = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'us', code: 'AAPL' } },
    });
    expect(apple.market).toBe('us');
    expect(apple.currency).toBe('USD');
  });

  it('采集闸 needSync: create 按市场落值 (us→false / 其余→true); 人工开启后重跑 upsert 不被重置', async () => {
    // ① create 分支: us 新标的默认不采 (无锚不采), cn 默认采 (全量语义不变)。
    await new SyncUniverseUseCase(
      marketAwarePort({
        us: [{ market: 'us', code: 'PEP', name: '百事' }],
        cn: [{ market: 'cn', code: '600519', name: '贵州茅台' }],
      }),
      prisma,
    ).run();

    const pep = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'us', code: 'PEP' } },
    });
    expect(pep.needSync).toBe(false);
    const moutai = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'cn', code: '600519' } },
    });
    expect(moutai.needSync).toBe(true);

    // ② 人工开启该 us 标的 (过渡期 SQL; p4 后由「有无锚」驱动) → 再跑一轮 universe。
    await prisma.instrument.update({
      where: { market_code: { market: 'us', code: 'PEP' } },
      data: { needSync: true },
    });
    await new SyncUniverseUseCase(
      marketAwarePort({ us: [{ market: 'us', code: 'PEP', name: '百事公司' }] }),
      prisma,
    ).run();

    const after = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'us', code: 'PEP' } },
    });
    expect(after.name).toBe('百事公司'); // 证确实走了 update 路径 (否则本例假绿)
    expect(after.needSync).toBe(true); // 但采集闸不被覆盖 (受保护列)
  });

  it('黑名单命中 → 跳过未 insert (skipped 计数)', async () => {
    await prisma.syncBlacklist.create({
      data: { market: 'cn', code: '000666', reason: 'ST 退市风险测试' },
    });
    const uc = new SyncUniverseUseCase(
      stubPort([
        { market: 'cn', code: '600519', name: '贵州茅台' },
        { market: 'cn', code: '000666', name: '某黑名单股' },
      ]),
      prisma,
    );
    const stats = await uc.run();

    expect(stats).toMatchObject({ scanned: 2, ok: 1, skipped: 1, failed: 0 });
    expect(await prisma.instrument.count()).toBe(1);
    const blacklisted = await prisma.instrument.findUnique({
      where: { market_code: { market: 'cn', code: '000666' } },
    });
    expect(blacklisted).toBeNull(); // 黑名单未落库
  });

  it('坏项隔离: 单标 upsert 抛错 (name 超长) → failedTargets, 其余正常落库', async () => {
    const tooLong = 'X'.repeat(200); // VarChar(128) 溢出 → DB 抛
    const uc = new SyncUniverseUseCase(
      stubPort([
        { market: 'cn', code: '600519', name: '贵州茅台' },
        { market: 'cn', code: '600000', name: tooLong },
        { market: 'cn', code: '000001', name: '平安银行' },
      ]),
      prisma,
    );
    const stats = await uc.run();

    expect(stats.scanned).toBe(3);
    expect(stats.ok).toBe(2); // 两个正常标的落库
    expect(stats.failed).toBe(1);
    expect(stats.failedTargets).toHaveLength(1);
    expect(stats.failedTargets[0]).toMatchObject({ symbol: 'cn:600000', step: 'universe' });
    expect(await prisma.instrument.count()).toBe(2); // 坏项未阻断其余
  });
});
