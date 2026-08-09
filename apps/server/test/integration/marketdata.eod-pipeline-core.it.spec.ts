import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import {
  DIMENSION_KEYS,
  DimensionExecutorRegistry,
  type DimensionKey,
} from '../../src/marketdata/dimension-executor';
import type { EodBarPort } from '../../src/marketdata/eod-bar.port';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 20:00 Asia/Shanghai (交易日)
const AS_OF = '2026-06-03';

// 016 T011 → 017 PR-7 改造: 旧聚合管线 run() 清退后, 同步核心语义经 executor 注册表直调
// 回归 (Testcontainers PG, mock adapters): 维度序执行 → 四类事实落库 + 连跑两次幂等无重复 +
// per-instrument 失败隔离 (failedTargets + 阈值告警) + HTTP-out-of-tx (事务回调内零 vendor
// 调用)。交易日 gate / due 过滤已分别归 tick 层 (tick-driver IT) — 不在 executor 面。
describe('016 T011 EOD sync core semantics via dimension executors (PR-7 form)', () => {
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

  /** 用 mock 当全部端口构建 executor 注册表; eodBar 可单独 override (注失败/spy)。 */
  function buildRegistry(eodBar?: EodBarPort): {
    registry: DimensionExecutorRegistry;
    mock: MockMarketDataAdapter;
  } {
    const mock = new MockMarketDataAdapter();
    const registry = new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      eodBar ?? mock,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
    );
    return { registry, mock };
  }

  /** 逐维直调 (worker 链序消费的等价控形; 019 T005 常量退役 → 键全集源 DIMENSION_KEYS,
   *  本测试各维度写不同表, 相对序无语义影响), 返 key→stats。 */
  async function runAll(
    registry: DimensionExecutorRegistry,
  ): Promise<Map<DimensionKey, { ok: number; failed: number; failedTargets: unknown[] }>> {
    const out = new Map<DimensionKey, { ok: number; failed: number; failedTargets: unknown[] }>();
    for (const key of DIMENSION_KEYS) {
      const { stats } = await registry.execute(key, { mode: 'delta', asOf: AS_OF, now: NOW });
      out.set(key, stats);
    }
    return out;
  }

  it('① 交易日全维度执行 → 四类事实落库 + per-dim SyncRun 全 success', async () => {
    const { registry } = buildRegistry();
    await runAll(registry);

    // mock universe 枚举 3 标的 (含北交所) → upsert。
    expect(await prisma.instrument.count()).toBe(3);
    // mock 仅 cn:600519 有事实数据 → DailyBar none 1 行 (020 T008 单口径) + 估值/财报/公司行动各 1。
    const maotai = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'cn', code: '600519' } },
      select: { id: true },
    });
    expect(await prisma.dailyBar.count({ where: { instrumentId: maotai.id } })).toBe(1);
    expect(await prisma.fundamentalSnapshot.count()).toBe(1);
    expect(await prisma.financialMetric.count()).toBe(1);
    expect(await prisma.corporateAction.count()).toBe(1);

    // per-dim SyncRun: 全维度各一行 sync:<dim>, 全 success (017 审计形态)。039 起 DIMENSION_KEYS
    // 增 short_selling (marketScope={hk}, mock universe 仅 cn → 工作集空, 0 落库但 SyncRun success)。
    const runs = await prisma.syncRun.findMany();
    expect(runs).toHaveLength(DIMENSION_KEYS.length);
    expect(runs.every((r) => r.status === 'success' && r.finishedAt !== null)).toBe(true);
  });

  it('② 同一交易日连跑两次 → 无重复行 (createMany skipDuplicates + upsert 自然键)', async () => {
    const { registry } = buildRegistry();
    await runAll(registry);
    await runAll(registry);

    expect(await prisma.instrument.count()).toBe(3);
    expect(await prisma.dailyBar.count()).toBe(1); // none 1 行, 不翻倍
    expect(await prisma.fundamentalSnapshot.count()).toBe(1);
    expect(await prisma.financialMetric.count()).toBe(1);
    expect(await prisma.corporateAction.count()).toBe(1);
  });

  it('③④ 单标 eod 抛错 → 隔离记 failedTargets + 达阈值 ERROR 告警, 其余维度照常', async () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    // eod 对全部 3 标的抛错 → 3 failures ≥ 阈值; fundamental/financial/corp 仍 mock 正常。
    const throwingEod: EodBarPort = {
      getBars: async () => Promise.reject(new Error('vendor 503')),
    };
    const { registry } = buildRegistry(throwingEod);

    const stats = await runAll(registry);

    // eod 三标的全失败 (per-instrument 隔离, 维度不顶层 throw)。
    const eod = stats.get('eod_bar');
    expect(eod?.failed).toBe(3);
    expect(
      (eod?.failedTargets as { step: string }[]).filter((t) => t.step === 'eod_bar'),
    ).toHaveLength(3);
    // 失败隔离: 其余维度仍落库 (corp 跃变锚定同用 eod 端口, 失败仅 WARN 不计 failed — FR-A05)。
    expect(await prisma.dailyBar.count()).toBe(0);
    expect(await prisma.fundamentalSnapshot.count()).toBe(1);
    // 阈值告警 (failed ≥ 3) + per-dim SyncRun: sync:eod_bar = failed (ok=0)。
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('alert threshold'));
    const run = await prisma.syncRun.findFirstOrThrow({ where: { syncType: 'sync:eod_bar' } });
    expect(run.status).toBe('failed');
    expect(run.failed).toBe(3);
    errorSpy.mockRestore();
  });

  it('⑤ HTTP-out-of-tx: 事务回调执行期间零 vendor 调用', async () => {
    const { registry, mock } = buildRegistry();
    let inTx = false;
    let httpDuringTx = 0;

    const realTx = prisma.$transaction.bind(prisma);
    vi.spyOn(prisma, '$transaction').mockImplementation(((arg: unknown, opts: unknown) => {
      inTx = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realTx as any)(arg, opts).finally(() => {
        inTx = false;
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
    // 任一 vendor 端口在 tx 开启期间被调 → 记一次违规。
    const origGetBars = mock.getBars.bind(mock);
    vi.spyOn(mock, 'getBars').mockImplementation(async (q) => {
      if (inTx) httpDuringTx++;
      return origGetBars(q);
    });

    await runAll(registry);

    expect(httpDuringTx).toBe(0);
    vi.restoreAllMocks();
  });
});
