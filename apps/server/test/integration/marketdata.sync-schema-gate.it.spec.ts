import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import type { TradingCalendarPort } from '../../src/marketdata/trading-calendar.port';
import { isTradingDayGateOpen } from '../../src/marketdata/trading-day-gate';
import { SyncRunRecorder, emptyStats } from '../../src/marketdata/sync-run.recorder';
import { DIMENSION_KEYS } from '../../src/marketdata/dimension-executor';

// 016 T005 PR1 集成 IT (Testcontainers PG): PR1 Independent Test 全量 —
// ① migrate deploy 3 配置/审计表 + seed 6 维度行; ② 交易日 gate 非交易日 → recorder
// SyncRun=skipped + **下游 vendor 零调用**; ③ 交易日 → gate open → 下游执行 + success。
describe('016 PR1 sync schema + trading-day gate (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let recorder: SyncRunRecorder;
  const NOW = new Date('2026-06-03T22:00:00Z');

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
    recorder = new SyncRunRecorder(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  /** PR1 级最小管线骨架: gate 短路 → recordSkipped + 零下游; gate open → 下游 + success。 */
  async function runGated(calendar: TradingCalendarPort, vendorWork: () => void): Promise<bigint> {
    const open = await isTradingDayGateOpen(calendar, 'cn', '2026-06-03');
    if (!open) return recorder.recordSkipped('eod_pipeline', NOW);
    const id = await recorder.start('eod_pipeline');
    vendorWork(); // 下游 vendor 同步 (PR3 真接); 交易日才走。
    await recorder.finish(id, 'success', { ...emptyStats(), scanned: 1, ok: 1 }, NOW);
    return id;
  }

  it('migrate deploy → 3 配置/审计表 + 017 依赖边表 + seed 全维度行 (行数 ≡ DIMENSION_KEYS)', async () => {
    const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'marketdata' AND table_name LIKE 'sync_%' ORDER BY table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      'sync_blacklist',
      'sync_dependency', // 017 T005
      'sync_dimension',
      'sync_run',
    ]);
    // 从 DIMENSION_KEYS 派生: 本断言钉的是「migrate deploy 后 seed 落全」, 不是某个具体数字。
    expect(await prisma.syncDimension.count()).toBe(DIMENSION_KEYS.length);
  });

  it('非交易日 → SyncRun=skipped + 下游 vendor 零调用', async () => {
    const vendorWork = vi.fn();
    const calendar: TradingCalendarPort = {
      classify: vi.fn(async () => 'non-trading' as const),
      lastClosedSession: async () => null,
      previousTradingDay: async () => null,
    };
    const id = await runGated(calendar, vendorWork);

    expect(vendorWork).not.toHaveBeenCalled(); // 整管线短路, 不打 vendor
    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id } });
    expect(run.status).toBe('skipped');
    expect(run.scanned).toBe(0);
  });

  it('交易日 → gate open → 下游执行 + SyncRun=success', async () => {
    const vendorWork = vi.fn();
    const calendar: TradingCalendarPort = {
      classify: vi.fn(async () => 'trading' as const),
      lastClosedSession: async () => null,
      previousTradingDay: async () => null,
    };
    const id = await runGated(calendar, vendorWork);

    expect(vendorWork).toHaveBeenCalledOnce();
    const run = await prisma.syncRun.findUniqueOrThrow({ where: { id } });
    expect(run.status).toBe('success');
    expect(run.ok).toBe(1);
  });
});
