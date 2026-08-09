import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import {
  SyncRunRecorder,
  deriveStatus,
  emptyStats,
  type SyncRunStats,
} from '../../src/marketdata/sync-run.recorder';

// 016 T004: SyncRunRecorder 生命周期 (Testcontainers PG)。开 running → 收 4 终态 + 计数 +
// failedTargets(Json) + finishedAt 落 marketdata.sync_run; deriveStatus 计数派生。
describe('016 SyncRunRecorder lifecycle (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let recorder: SyncRunRecorder;
  const NOW = new Date('2026-06-03T22:30:00Z');

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

  it('start → running 行; finish(success) → 计数 + finishedAt 落库', async () => {
    const id = await recorder.start('eod_bar');
    const running = await prisma.syncRun.findUniqueOrThrow({ where: { id } });
    expect(running.status).toBe('running');
    expect(running.finishedAt).toBeNull();

    const stats: SyncRunStats = { scanned: 100, ok: 100, skipped: 0, failed: 0, failedTargets: [] };
    await recorder.finish(id, 'success', stats, NOW);

    const done = await prisma.syncRun.findUniqueOrThrow({ where: { id } });
    expect(done.status).toBe('success');
    expect(done.scanned).toBe(100);
    expect(done.ok).toBe(100);
    expect(done.finishedAt).toEqual(NOW);
    expect(done.failedTargets).toBeNull(); // 无失败 → JsonNull
  });

  it('🚨 finish 不传第 4 参 → 落**真实收尾时刻** (不是调用方的逻辑 now)', async () => {
    const id = await recorder.start('eod_bar');
    const before = new Date();
    await recorder.finish(id, 'success', { ...emptyStats(), scanned: 1, ok: 1 });
    const after = new Date();

    const done = await prisma.syncRun.findUniqueOrThrow({ where: { id } });
    const at = done.finishedAt;
    expect(at).not.toBeNull();
    expect(at!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(at!.getTime()).toBeLessThanOrEqual(after.getTime());

    // 刻意**不**拿 finished_at 跟 started_at 比: 后者是 PG `now()`, 而容器化 PG 在
    // macOS 上跑在自带时钟的 VM 里, 跨时钟断言会变成随机红。上面两条只用 app 自己
    // 这一个时钟, 已经把「写的是收尾时刻不是逻辑 now」钉死。
  });

  it('finish(partial) → failedTargets(Json) 落库可审计', async () => {
    const id = await recorder.start('eod_bar');
    const stats: SyncRunStats = {
      scanned: 10,
      ok: 8,
      skipped: 0,
      failed: 2,
      failedTargets: [
        { symbol: 'cn:600519', step: 'eod_bar', error: 'timeout' },
        { symbol: 'cn:000001', step: 'fundamental', error: '429' },
      ],
    };
    await recorder.finish(id, deriveStatus(stats), stats, NOW);

    const done = await prisma.syncRun.findUniqueOrThrow({ where: { id } });
    expect(done.status).toBe('partial');
    expect(done.failed).toBe(2);
    expect(done.failedTargets).toEqual(stats.failedTargets);
  });

  it('recordSkipped → 非交易日短路一行 status=skipped (零计数)', async () => {
    const id = await recorder.recordSkipped('eod_pipeline', NOW);
    const row = await prisma.syncRun.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('skipped');
    expect(row.scanned).toBe(0);
    expect(row.finishedAt).toEqual(NOW);
  });

  it('deriveStatus: 全 ok=success / 有失败有成功=partial / 全失败=failed', () => {
    expect(deriveStatus({ ...emptyStats(), scanned: 5, ok: 5 })).toBe('success');
    expect(deriveStatus({ ...emptyStats(), scanned: 5, ok: 3, failed: 2 })).toBe('partial');
    expect(deriveStatus({ ...emptyStats(), scanned: 5, failed: 5 })).toBe('failed');
  });
});
