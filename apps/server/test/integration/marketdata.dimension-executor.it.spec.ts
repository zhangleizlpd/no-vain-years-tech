import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 (Asia/Shanghai 交易日)
const AS_OF = '2026-06-03';

// 017 T008 executor 直调 IT (Testcontainers PG, mock adapters): 4 fact 私有方法 +
// universe/profile 包装升格 executor 注册表后, 自管 `sync:<dim>` SyncRun (含 bullJobId
// 回链); PR-7 起为唯一执行面 (旧聚合 run() / aggregate-merge 已清退)。
describe('017 T008 dimension executor registry (per-dim SyncRun)', () => {
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
    await prisma.fundamentalSnapshot.deleteMany();
    await prisma.financialMetric.deleteMany();
    await prisma.corporateAction.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
  });

  function buildRegistry(): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      mock,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
    );
  }

  it('per-dim universe: instrument 落库 + SyncRun sync:universe 行 (bullJobId 回链)', async () => {
    const registry = buildRegistry();
    const { stats } = await registry.execute(
      'universe',
      { mode: 'delta', asOf: AS_OF, now: NOW },
      { bullJobId: 'job-universe-1', triggeredBy: 'tick' },
    );
    expect(stats.failed).toBe(0);
    expect(await prisma.instrument.count()).toBeGreaterThan(0);

    const runs = await prisma.syncRun.findMany({ where: { syncType: 'sync:universe' } });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('success');
    // #202 来历两列走到真库 (migration + @db.Date 映射一起验): 触发源逐字来自调用方,
    // as_of 恒取 `input.asOf` —— executor 不许有第二个业务日口径。
    expect(runs[0]?.triggeredBy).toBe('tick');
    expect(runs[0]?.asOf?.toISOString()).toBe(`${AS_OF}T00:00:00.000Z`);
    expect(runs[0]?.bullJobId).toBe('job-universe-1');
    // 🚨 finished_at 是**真实收尾时刻**, 不是 input.now (= job 起点)。这里曾断言
    // `toEqual(NOW)` —— 那正是缺陷本身: finished_at ≈ started_at ⇒ 一轮跑了多久永远
    // 读不出来 (2026-08-09 prod 实测, 一轮 241 秒的链发现表里只差 44 毫秒)。
    expect(runs[0]?.finishedAt).not.toEqual(NOW);
    expect(runs[0]?.finishedAt?.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('per-dim eod_bar: DailyBar 落库 + SyncRun sync:eod_bar 行 + 计数一致', async () => {
    const registry = buildRegistry();
    await registry.execute('universe', { mode: 'delta', asOf: AS_OF, now: NOW });
    const { stats } = await registry.execute(
      'eod_bar',
      { mode: 'delta', asOf: AS_OF, now: NOW },
      { bullJobId: 'job-eod-7' },
    );
    expect(stats.ok).toBeGreaterThan(0);
    expect(await prisma.dailyBar.count()).toBeGreaterThan(0);

    const run = await prisma.syncRun.findFirst({ where: { syncType: 'sync:eod_bar' } });
    expect(run?.status).toBe('success');
    expect(run?.bullJobId).toBe('job-eod-7');
    expect(run?.ok).toBe(stats.ok);
    // 水位推进 (016 语义保持): lastWatermark = now。
    const dim = await prisma.syncDimension.findUnique({ where: { dimensionKey: 'eod_bar' } });
    expect(dim?.lastWatermark).toEqual(NOW);
  });

  it('per-dim 顶层异常: SyncRun 收 failed 不留 running 悬挂行 + 异常上抛 (worker attempts 语义源)', async () => {
    const registry = buildRegistry();
    // 不先跑 universe → instrument 空集不报错; 用不存在的维度行触发顶层 throw:
    await prisma.syncDimension.delete({ where: { dimensionKey: 'eod_bar' } });
    try {
      await expect(
        registry.execute(
          'eod_bar',
          { mode: 'delta', asOf: AS_OF, now: NOW },
          { bullJobId: 'job-eod-fail' },
        ),
      ).rejects.toThrow();
      const run = await prisma.syncRun.findFirst({ where: { syncType: 'sync:eod_bar' } });
      expect(run?.status).toBe('failed');
      expect(run?.bullJobId).toBe('job-eod-fail');
    } finally {
      // 还原 seed 行 (其他用例依赖 6 维度行)。
      await prisma.syncDimension.create({
        data: {
          dimensionKey: 'eod_bar',
          cronExpr: '0 0 22 * * *',
          vendor: 'lixinger',
          marketScope: ['cn'],
          adjustTypes: ['none', 'forward', 'backward'],
          batchSize: 1,
          priority: 8,
        },
      });
    }
  });
});
