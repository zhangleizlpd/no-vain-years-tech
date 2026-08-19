import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import {
  SyncRunRecorder,
  addWritten,
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

    const stats: SyncRunStats = {
      scanned: 100,
      ok: 100,
      skipped: 0,
      failed: 0,
      written: 97,
      failedTargets: [],
    };
    await recorder.finish(id, 'success', stats, NOW);

    const done = await prisma.syncRun.findUniqueOrThrow({ where: { id } });
    expect(done.status).toBe('success');
    expect(done.scanned).toBe(100);
    expect(done.ok).toBe(100);
    expect(done.finishedAt).toEqual(NOW);
    expect(done.written).toBe(97); // 063 Phase 3.3: 落库侧的数, 与 scanned/ok 不是一回事
    expect(done.failedTargets).toBeNull(); // 无失败 → JsonNull
  });

  it('🚨 written 三态: 没有写路径上报 ⇒ 落 **null** 而不是 0 (063 Phase 3.3)', async () => {
    const id = await recorder.start('eod_bar');
    await recorder.finish(id, 'success', { ...emptyStats(), scanned: 5, ok: 5 }, NOW);

    const done = await prisma.syncRun.findUniqueOrThrow({ where: { id } });
    // null = 「本次没有任何写路径上报」; 0 = 「上报了, 且一行都没进」。折成 0 就等于让每个
    // 尚未接线的维度**恒报零写入** —— 假警报, 且长得像真故障。
    expect(done.written).toBeNull();
  });

  it('written 上报了 0 行 ⇒ 落 **0**, 与 null 可分辨 (这才是要抓的「全绿但没做事」)', async () => {
    const id = await recorder.start('eod_bar');
    const stats = { ...emptyStats(), scanned: 5, ok: 5 };
    addWritten(stats, 0); // 一轮全命中唯一键的 delta: 跑了、没抛、但一行都没进
    await recorder.finish(id, 'success', stats, NOW);

    const done = await prisma.syncRun.findUniqueOrThrow({ where: { id } });
    expect(done.written).toBe(0);
    expect(done.status).toBe('success'); // 状态照旧是绿的 —— 差别只在这一列上看得见
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
      written: null,
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
