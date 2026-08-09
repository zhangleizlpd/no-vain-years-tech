import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import type { EodBarPort } from '../../src/marketdata/eod-bar.port';
import type { EodBarPoint, EodBarQuery } from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';

// 038 T010 港股价量底座 eod_bar 扩 HK 集成 IT (Testcontainers PG, mock hk eod adapter):
// hk 摄取管线由 T001 (marketScope 工作集) + T002 (adapter /hk/ 路径插值) 缝隙贯通 —— 本 IT
// 证 hk 标的经 executor 的 eod 区间回填落 daily_bar (adjust=none) + 连跑两次 skipDuplicates 幂等。
// 用 **test-local hk eod mock** (非共享 MockMarketDataAdapter, 后者 hk=no-data 以护 T006 seam IT
// 「hk 进工作集但零落库」断言); 落库/幂等经真 PG。覆盖 state_branch「eod_bar hk 区间回填」。
describe('038 T010 eod_bar 扩 HK (Testcontainers PG, mock hk eod)', () => {
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
    await prisma.dailyBar.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    await prisma.watchlistItem.deleteMany();
    // T003 migration 已置 eod_bar marketScope={cn,hk}; 显式复位 + 清水位保各例独立。
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { marketScope: ['cn', 'hk'], lastWatermark: null },
    });
  });

  /** test-local hk eod adapter: hk:00700 返 3 个确定性区间 bar (跨年 → 证区间回填); 记录 query。 */
  class HkEodMock implements EodBarPort {
    readonly calls: EodBarQuery[] = [];
    async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
      this.calls.push(query);
      if (query.symbol !== 'hk:00700') return [];
      return ['2016-05-13', '2020-06-15', '2026-05-15'].map((tradeDate) => ({
        tradeDate,
        adjust: query.adjust,
        open: '380.0000',
        high: '385.0000',
        low: '378.0000',
        close: '382.0000',
        changePct: '0.5000',
        prevClose: null,
        volume: '12000000',
        amount: '4600000000.00',
        turnoverRate: '0.1300',
      }));
    }
  }

  function buildRegistry(eodBar: EodBarPort): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      eodBar,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
    );
  }

  async function seedHk(code: string, name: string): Promise<bigint> {
    const inst = await prisma.instrument.create({
      data: { market: 'hk', code, name, type: 'stock', currency: 'HKD', status: 'active' },
    });
    return inst.id;
  }

  it('① hk backfill eod → daily_bar (hk 标的, adjust=none) 区间回填落库', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const eod = new HkEodMock();
    const registry = buildRegistry(eod);

    const { stats } = await registry.execute('eod_bar', {
      mode: 'backfill',
      asOf: AS_OF,
      now: NOW,
      backfillHistoryDays: 3650, // ≤10yr 区间
    });

    expect(stats.ok).toBe(1);
    expect(stats.failed).toBe(0);
    const bars = await prisma.dailyBar.findMany({
      where: { instrumentId: instId },
      orderBy: { tradeDate: 'asc' },
    });
    expect(bars).toHaveLength(3);
    expect(bars.every((b) => b.adjust === 'none')).toBe(true); // 020 单口径 (forward/backward 读时换算)
    expect(bars[0].close.toString()).toBe('382'); // hk 价量落库
    // 区间范式: adapter 收到 none 口径 + from<to 区间 (per-stock candlestick, hk 与 A 股同构)。
    const q = eod.calls.find((c) => c.symbol === 'hk:00700');
    expect(q?.adjust).toBe('none');
    expect(Boolean(q?.from && q?.to && q.from < q.to)).toBe(true);
    const run = await prisma.syncRun.findFirstOrThrow({ where: { syncType: 'sync:eod_bar' } });
    expect(run.status).toBe('success');
  });

  it('② 连跑两次 → 无重复行 (createMany skipDuplicates 幂等)', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const registry = buildRegistry(new HkEodMock());
    const run = () =>
      registry.execute('eod_bar', {
        mode: 'backfill',
        asOf: AS_OF,
        now: NOW,
        backfillHistoryDays: 3650,
      });

    await run();
    await run();

    expect(await prisma.dailyBar.count({ where: { instrumentId: instId } })).toBe(3); // 不翻倍
  });

  it('③ marketScope={cn} → hk 标的不进 eod 工作集 (无回归护栏)', async () => {
    await seedHk('00700', '腾讯控股');
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { marketScope: ['cn'] },
    });
    const registry = buildRegistry(new HkEodMock());

    const { stats } = await registry.execute('eod_bar', {
      mode: 'backfill',
      asOf: AS_OF,
      now: NOW,
    });

    expect(stats.scanned).toBe(0); // hk 被 marketScope={cn} 过滤, 零落库
    expect(await prisma.dailyBar.count()).toBe(0);
  });
});
