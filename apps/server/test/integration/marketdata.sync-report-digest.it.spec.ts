import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';

const SERVER_DIR = process.cwd();

/**
 * **日报取数 + findings 展开判据** IT（Testcontainers PG），照 044 / table-health 的谓词 IT 范式。
 *
 * 🚨🚨 **这是宪法 §II 的合规承重点**。仓内无 bash 测试框架 → 写在
 * `ops/jobs/marketdata-sync-report.sh` 里的判断无覆盖。#209 第 2 步把**取数 + findings 展开判据**
 * 下沉到 `ops/jobs/marketdata-sync-report.sql`，「那段判据已被真测」的全部重量压在本文件上。
 *
 * ⚠️ **本文件不覆盖该脚本的全部判据**：逐维度图标 / 计数 / 退出码仍在 `.sh` 里（既有债，本次
 * 蓄意不动 —— 与 044 零行诊断段「薄消费留 bash」是同一形状）。别据此以为脚本已零逻辑。
 *
 * 📌 **「改完 `.sql` 必须 `--skipNxCache`」这条已根治**（#220）：`{workspaceRoot}/ops/jobs/*.sql`
 * 已显式进 `nx.json` 的 `targetDefaults.test.inputs` ⇒ 直接 `nx test server <file>` 即可，
 * 缓存会正确失效。`--skipNxCache` 只是保险，不再是正确性前提。
 *
 * 🚨 那条 inputs **不能挪回 `namedInputs.sharedGlobals`** —— 实测 `sharedGlobals` 对 `test`
 * target 根本不生效（改根 `package.json` 同样命中缓存）。修法必须是**显式** inputs。
 *
 * ═══ 本文件的重点是三条 MUST 的变异，不是「跑得通」═══
 *
 * 判据存在的理由是 2026-08-27 排查出的「写了但没人读」：旧版展开条件是
 * `status NOT IN ('success','skipped')`，而多个写入点**蓄意不计 `failed`**（粒度是标的不是行）
 * ⇒ 那些行恒为 `success` ⇒ 写进去等于没写。prod 全表 53 行带真数组明细，**27 行因此永不展开**。
 */

/** 🚨 谓词单一真相源 —— **读文件**，绝不在此内联复制。 */
const REPORT_SQL = readFileSync(
  resolve(SERVER_DIR, '../../ops/jobs/marketdata-sync-report.sql'),
  'utf8',
);

interface ReportRow {
  sync_type: string;
  status: string;
  scanned: number;
  ok: number;
  skipped: number;
  failed: number;
  written: string;
  started_cst: string;
  unfinished: boolean;
  findings_digest: string;
}

describe('#209 日报 findings 展开判据 (Testcontainers PG)', () => {
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

  // DISTINCT ON (sync_type) ⇒ 用例之间必须互不残留, 否则前一条的行会顶掉后一条。
  beforeEach(async () => {
    await prisma.syncRun.deleteMany({});
  });

  async function runPredicate(): Promise<ReportRow[]> {
    return prisma.$queryRawUnsafe<ReportRow[]>(REPORT_SQL);
  }

  /** 落一行**已收尾**的 sync_run（窗口内）。`findings` 直接给 JSON 值, 含 JSON `null` 这一态。 */
  async function seedRun(
    syncType: string,
    status: string,
    findings: unknown,
    counts: { scanned?: number; ok?: number; failed?: number } = {},
  ): Promise<void> {
    const now = new Date();
    await prisma.syncRun.create({
      data: {
        syncType,
        status,
        startedAt: new Date(now.getTime() - 60_000),
        finishedAt: now,
        scanned: counts.scanned ?? 1,
        ok: counts.ok ?? 1,
        skipped: 0,
        failed: counts.failed ?? 0,
        findings: findings as never,
      },
    });
  }

  it('契约: 每维度一行, 恒 10 列 (bash 侧按位读 TSV 的前提)', async () => {
    await seedRun('sync:eod_bar', 'success', null);
    const rows = await runPredicate();

    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'failed',
        'findings_digest',
        'ok',
        'scanned',
        'skipped',
        'started_cst',
        'status',
        'sync_type',
        'unfinished',
        'written',
      ].sort(),
    );
  });

  it('🚨 MUST ①: status=success 的行也要展开 —— 这正是「写了但没人读」的那一半', async () => {
    // 硬门拒绝**蓄意不计 failed** ⇒ deriveStatus 给出 success ⇒ 旧判据在这里短路。
    // prod 实测: us:CPB 的拒绝 08-21 / 08-22 两晚都落了库, 两行都是 success, 日报一次没显示过。
    await seedRun('sync:option_daily_snapshot', 'success', [
      {
        kind: 'reject',
        symbol: 'us:CPB',
        step: 'option_snapshot_guard',
        rejected: 1,
        contracts: ['US.CPB270115P38000'],
        violations: ['delta_sign'],
      },
    ]);

    const [row] = await runPredicate();
    expect(row.status).toBe('success'); // 行本身仍是绿的 —— 判据不改判, 只改可见性
    expect(row.findings_digest).toContain('reject');
    // 违规码是 #198 的全部目的: 「撞的是哪条门」必须进 digest, 否则修了等于没修。
    expect(row.findings_digest).toContain('delta_sign');
    expect(row.findings_digest).toContain('us:CPB');
  });

  it('🚨 MUST ②: findings 是 JSON 标量 null 时 digest 为空串, **不能**打印 "null"', async () => {
    // 空态存的是 Prisma.JsonNull ⇒ SQL 层不是 NULL 而是 JSON `null`。
    // prod 实测全表 749 行如此 ⇒ 用 `IS NOT NULL` 写判据, 每一行空态都会打印一个 `null`。
    await seedRun('sync:us_equity_bar', 'success', null);

    const [row] = await runPredicate();
    expect(row.findings_digest).toBe('');
    expect(row.findings_digest).not.toContain('null');
  });

  it('🚨 MUST ③: 无 kind 的历史 entry 归 legacy 桶, **不得**被丢掉', async () => {
    // kind 是 #214 才加的 ⇒ 回填进来的历史 entry 形如 {symbol, step, error}, 没有判别字段。
    // 只认 `kind='...'` 会把上线前的全部明细静默丢掉。
    await seedRun('sync:buyback', 'partial', [
      { symbol: 'cn:600519', step: 'buyback', error: 'timeout' },
    ]);

    const [row] = await runPredicate();
    expect(row.findings_digest).toContain('legacy');
    expect(row.findings_digest).toContain('buyback');
  });

  it('多 kind 混合 → 按 kind 分组计数, 顺序稳定', async () => {
    await seedRun('sync:earnings_event', 'success', [
      { kind: 'notice', step: 'earnings_instrument_unmatched', detail: { unmatched: 2 } },
      { kind: 'notice', step: 'earnings_date_changed', detail: { changed: 1 } },
      { kind: 'failure', symbol: 'us:PEP', step: 'earnings_event', error: '429' },
    ]);

    const [row] = await runPredicate();
    expect(row.findings_digest).toContain('notice×2');
    expect(row.findings_digest).toContain('failure×1');
    // 分组顺序按 kind 字母序 ⇒ failure 在 notice 前, 输出可确定断言。
    expect(row.findings_digest.indexOf('failure')).toBeLessThan(
      row.findings_digest.indexOf('notice'),
    );
  });

  it('skip / interrupt 的 reason 进 digest (它们本就恒为非问题态, 旧判据同样看不见)', async () => {
    await seedRun('sync:hot_snapshot', 'skipped', [{ kind: 'skip', reason: '上游未就绪' }]);

    const [row] = await runPredicate();
    expect(row.findings_digest).toContain('skip');
    expect(row.findings_digest).toContain('上游未就绪');
  });

  it('digest 单行且有长度上限 (bash 侧 TSV 解析的前提)', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      kind: 'failure',
      symbol: `cn:${String(600000 + i)}`,
      step: 'eod_bar',
      error: 'timeout\nwith\tcontrol\rchars',
    }));
    await seedRun('sync:eod_bar', 'partial', many, { scanned: 60, failed: 60 });

    const [row] = await runPredicate();
    expect(row.findings_digest).not.toMatch(/[\t\n\r]/);
    expect(row.findings_digest.length).toBeLessThanOrEqual(300);
    expect(row.findings_digest).toContain('failure×60');
  });
});
