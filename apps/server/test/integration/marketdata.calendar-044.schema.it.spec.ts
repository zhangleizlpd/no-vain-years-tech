import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupEmptyDb } from '../_support/isolated-db';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaService } from '../../src/security/prisma.service';

const SERVER_DIR = process.cwd();
const MONO_ROOT = resolve(SERVER_DIR, '../..');

// 044 T003 Phase 1 Independent Test: 日历填充心跳表 schema expand (expand-only, ADR-0035) —
// migrate deploy 后验 calendar_sync_health 表 + PK(market) + per-market 行可插 (市场级非标的级,
// 无 instrument FK) + check-server-moat 0 违规 (接线新表铁律: MODEL_OWNERSHIP 已声明 owner)。
// 纯数据层 (不动链路) ⇒ 立即编译绿。心跳的**行为**面 (成功更新 / 失败写 lastError 不动
// lastSuccessAt / servedBy 谓词) 归 T012 / T013，此处只验 schema 形态。
describe('044 calendar-sync-health schema expand (Testcontainers PG migrate deploy)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupEmptyDb>>;

  beforeAll(async () => {
    db = await setupEmptyDb();
    process.env.DATABASE_URL = db.databaseUrl;

    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: SERVER_DIR,
      env: process.env,
      stdio: 'inherit',
    });

    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  it('calendar_sync_health 表落 marketdata schema', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'marketdata' AND table_name = 'calendar_sync_health'`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(['calendar_sync_health']);
  });

  it('PK = (market) 单列 — 市场级非标的级 (无 instrument FK)', async () => {
    const pk = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'marketdata'
          AND tc.table_name = 'calendar_sync_health'
          AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position`,
    );
    expect(pk.map((r) => r.column_name)).toEqual(['market']);

    // 市场级 ⇒ 不得有任何 FK (标的级表才挂 instrument FK)。
    const fks = await prisma.$queryRawUnsafe<{ constraint_name: string }[]>(
      `SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_schema = 'marketdata' AND table_name = 'calendar_sync_health'
          AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(fks).toEqual([]);
  });

  it('per-market 行可插: 各市场一行互不干扰 + PK 拒同 market 重复', async () => {
    const now = new Date('2026-07-16T13:00:00Z');
    await prisma.calendarSyncHealth.create({
      data: { market: 'cn', lastSuccessAt: now, lastAttemptAt: now, servedBy: 'tencent' },
    });
    // 另一市场独立成行 (per-market 隔离: 一市场降级/失败不影响其余的心跳)。
    await prisma.calendarSyncHealth.create({
      data: {
        market: 'hk',
        lastAttemptAt: now,
        lastError: 'vendor down',
        servedBy: null, // 失败 → 不写 servedBy (只有成功才记服务方)
      },
    });

    // 同 market 再插 → PK 拒 (per-market 恒一行, upsert 语义的地基)。
    await expect(prisma.calendarSyncHealth.create({ data: { market: 'cn' } })).rejects.toThrow();

    const cn = await prisma.calendarSyncHealth.findUnique({ where: { market: 'cn' } });
    expect(cn?.servedBy).toBe('tencent');
    expect(cn?.lastSuccessAt).toEqual(now);
    expect(cn?.lastError).toBeNull();

    const hk = await prisma.calendarSyncHealth.findUnique({ where: { market: 'hk' } });
    expect(hk?.lastError).toBe('vendor down');
    expect(hk?.lastSuccessAt).toBeNull(); // 失败 → lastSuccessAt 保持空 → 心跳陈旧 → 探针告警
    expect(hk?.servedBy).toBeNull();

    expect(await prisma.calendarSyncHealth.count()).toBe(2);
  });

  it('全列 nullable 除 market: 新市场首次 upsert 可只落 market (心跳未知态)', async () => {
    const row = await prisma.calendarSyncHealth.create({ data: { market: 'us' } });
    expect(row.lastSuccessAt).toBeNull();
    expect(row.lastAttemptAt).toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.servedBy).toBeNull();
  });

  it('check-server-moat 0 违规 (接线新表铁律: calendarSyncHealth owner 已声明)', () => {
    // 漏声明 MODEL_OWNERSHIP → 脚本非零退出 (lefthook + CI 同门); 此处固化为 IT 断言。
    // ⚠️ 诚实标注: 探针只扫**被 src/** 访问**的 model (未访问的表漏声明它看不见) → 本断言在
    // T012 把 calendarSyncHealth 接进 service 前是**平凡绿**, 接线后才承重。留在此处作回归网。
    expect(() =>
      execFileSync('pnpm', ['tsx', 'scripts/checks/check-server-moat.ts'], {
        cwd: MONO_ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  }, 120_000);
});
