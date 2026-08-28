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
  /** #210 逐维度耗时(秒)。文本形态: 数字串或哨兵 'NULL' (同 `written`, 理由见 SQL 注释)。 */
  elapsed_s: string;
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
    /**
     * 触发源 + 起跑时刻回拨(ms)。`latest` CTE 的选行判据「先 tick 后时刻」只有同时控住这两格
     * 才测得了 —— 窗口恒 60s (上面那条耗时用例钉着它), 故回拨的是**起点**, 终点跟着走。
     */
    origin: { triggeredBy?: string; startedMsAgo?: number } = {},
  ): Promise<void> {
    const startedAt = new Date(Date.now() - (origin.startedMsAgo ?? 60_000));
    await prisma.syncRun.create({
      data: {
        syncType,
        status,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 60_000),
        ...(origin.triggeredBy ? { triggeredBy: origin.triggeredBy } : {}),
        scanned: counts.scanned ?? 1,
        ok: counts.ok ?? 1,
        skipped: 0,
        failed: counts.failed ?? 0,
        findings: findings as never,
      },
    });
  }

  it('契约: 每维度一行, 恒 11 列 (bash 侧按位读 TSV 的前提)', async () => {
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
        'elapsed_s', // #210 逐维度耗时(秒); 'NULL' 哨兵同 written
      ].sort(),
    );
  });

  // ── #210 逐维度耗时 ────────────────────────────────────────────────────────────────
  it('耗时: 已收尾的行给出秒数 (seedRun 固定 60s 窗)', async () => {
    await seedRun('sync:eod_bar', 'success', null);
    const rows = await runPredicate();
    expect(rows[0]?.elapsed_s).toBe('60');
  });

  // 🚨 这一条是本列**唯一**容易做错的地方, 也是它必须被钉住的理由:
  //    `interrupted` 的 `finished_at` 是**收敛时刻**而不是打断时刻 (SyncRun.status 的 schema
  //    注释明写) ⇒ 它的 finished−started 不是耗时。不排除的话, 耗时统计会被一条 18 天的
  //    僵尸行整体拉长, 而报告看起来完全正常 —— 那正是本仓反复吃亏的静默偏差形态。
  it('🚨 耗时: interrupted 行不给耗时 (finished_at 是收敛时刻, 差值不是耗时)', async () => {
    await seedRun('sync:eod_bar', 'interrupted', null);
    const rows = await runPredicate();
    expect(rows[0]?.status).toBe('interrupted');
    expect(rows[0]?.elapsed_s).toBe('NULL');
  });

  it('耗时: 未收尾 (finished_at IS NULL) 的行不给耗时, 且走哨兵而非空字段', async () => {
    const now = new Date();
    await prisma.syncRun.create({
      data: {
        syncType: 'sync:eod_bar',
        status: 'running',
        startedAt: new Date(now.getTime() - 60_000),
        finishedAt: null,
        scanned: 1,
        ok: 1,
        skipped: 0,
        failed: 0,
      },
    });
    const rows = await runPredicate();
    expect(rows[0]?.unfinished).toBe(true);
    // 哨兵而非空串: 空字段会被 `IFS=$'\t'` 折叠掉, 其后各列在 bash 侧静默前移一位。
    expect(rows[0]?.elapsed_s).toBe('NULL');
  });

  it('🚨 latest: 按需轮排在 tick 之后, **不得**顶掉 tick 那一行', async () => {
    // 每维度只有一行 ⇒ 那一行必须代表「按计划跑的那一轮」。补救轮 (23:40) 恒排在夜链 (23:00)
    // 之后, 只按时刻取最新就会把「一次 1 票的补采」说成整个维度昨晚的成绩, 且夜链的 findings
    // 连带被顶掉 —— 而那正是 #261 要看的那份。
    await seedRun(
      'sync:hk_option_daily_snapshot',
      'success',
      [
        {
          kind: 'reject',
          symbol: 'hk:00700',
          step: 'option_snapshot_guard',
          rejected: 4,
          contracts: ['HK.TCH260929P630000'],
          violations: ['ask_below_intrinsic'],
          violationSamples: ['HK.TCH260929P630000: ask 0 低于无套利下界 171.75'],
        },
      ],
      { scanned: 3, ok: 3 },
      { triggeredBy: 'tick', startedMsAgo: 3_600_000 },
    );
    await seedRun(
      'sync:hk_option_daily_snapshot',
      'success',
      null,
      { scanned: 1, ok: 1 },
      { triggeredBy: 'same_day_retry', startedMsAgo: 60_000 },
    );

    const rows = await runPredicate();

    expect(rows).toHaveLength(1);
    expect(rows[0].scanned).toBe(3);
    expect(rows[0].findings_digest).toContain('hk:00700');
  });

  it('latest: 窗口内一轮 tick 都没有 → 仍展示最新那一行 (这是排序, 不是过滤)', async () => {
    // 「该维度今天没按计划跑」要靠别的判据喊, 不能靠让它从日报里整行消失来表达。
    await seedRun(
      'sync:hk_option_daily_snapshot',
      'success',
      null,
      { scanned: 1, ok: 1 },
      { triggeredBy: 'same_day_retry' },
    );

    const rows = await runPredicate();

    expect(rows.map((r) => r.sync_type)).toEqual(['sync:hk_option_daily_snapshot']);
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
        violationSamples: [
          'US.CPB270115P38000: PUT 的 Δ 符号非法: 0.12 (PUT 要求 ≤ 0, CALL 要求 ≥ 0)',
        ],
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
