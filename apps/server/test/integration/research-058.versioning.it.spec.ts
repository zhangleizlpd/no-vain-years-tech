import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setupEmptyDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';

const SERVER_DIR = process.cwd();
const MIGRATIONS_DIR = resolve(SERVER_DIR, 'prisma/migrations');

// 058 研报归档「同标的多版本 + 元数据回声」的 IT 汇总文件。
//
// **本 describe（T001）必须是真 PG**: 被测对象**就是 migration 的产物本身** —— 旧幂等键有没有
// 真被换掉 / 新取号键有没有真建上 / 它们的列集合与列序对不对。这些在任何 mock 或对
// schema.prisma 的静态读取里都不存在（读 schema.prisma 只能证明「声明了」，证明不了「迁上去
// 了」）⇒ 取 `setupEmptyDb()`（三入口中「自己跑 migrate deploy 并验证其产物」那一个）。换成
// `setupIsolatedDb()` 的模板克隆会把被测对象整个抽掉，**而且不会红、也不会变慢** —— 只是悄悄
// 不再验证任何东西（同 research-057.schema.it.spec.ts 的取舍）。
//
// 后续 task（T003 / T004 / T006）的行为断言各自另起 describe，与本 describe 平级 —— 它们要的是
// 「收窄 boot + 真 HTTP」的 harness（`setupIsolatedDb()` + `narrowTestModule`，体例见
// research-057.report-ingest.it.spec.ts），与本 describe 的空库 + migrate deploy 互不兼容。

/**
 * 定位本片的 migration —— 靠**内容**（取号键的名字）而不是目录名。
 * 目录名含生成时刻的时间戳（ADR-0035 §1 的 `YYYYMMDD_HHMM_` 体例），写死会在任何一次重生成后
 * 静默失配成「找不到 ⇒ 断言被跳过」。
 */
function find058Migration(): { dir: string; sql: string } {
  const hits = readdirSync(MIGRATIONS_DIR)
    .filter((e) => statSync(join(MIGRATIONS_DIR, e)).isDirectory())
    .map((dir) => ({ dir, sqlPath: join(MIGRATIONS_DIR, dir, 'migration.sql') }))
    .map((m) => ({ dir: m.dir, sql: readFileSync(m.sqlPath, 'utf8') }))
    .filter((m) => m.sql.includes('uk_research_report_version_line'));

  expect(hits.map((h) => h.dir)).toHaveLength(1); // 拆成两次迁移 = 上线顺序问题，这里就该红
  return hits[0];
}

describe('058 T001 research_report 两个唯一键 (Testcontainers PG migrate deploy)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupEmptyDb>>;

  // 057 形态：三条各自 (uploader_kind, uploader_ref, symbol) 唯一、version 走 DB 默认值的记录。
  // prod 上线前的既有 3 行就是这个形态（plan A1 已核对）。
  const BASE = {
    reportDate: new Date('2026-08-01'),
    title: '某公司深度研报',
    sizeBytes: 2_020_387,
    originalFilename: 'report.pdf',
    status: 'COMMITTED',
    uploaderKind: 'guest',
  };

  const LEGACY_ROWS = [
    { ...BASE, symbol: 'hk:01698', uploaderRef: 'friend1', contentHash: 'a'.repeat(64) },
    { ...BASE, symbol: 'cn:601318', uploaderRef: 'friend1', contentHash: 'b'.repeat(64) },
    { ...BASE, symbol: 'hk:01698', uploaderRef: 'friend2', contentHash: 'c'.repeat(64) },
  ].map((r) => ({ ...r, objectKey: `research/${r.contentHash.slice(0, 8)}/report.pdf` }));

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

  it('FR-019 / FR-025 两个唯一键真落地，且 057 的旧幂等键已消失', async () => {
    // ⚠️ Prisma 的 `@@unique(map: ...)` 建的是**唯一索引**而非 table constraint ⇒ 查 pg_indexes；
    // information_schema.table_constraints 看不见它（查错表会得到「零约束」的假阴性）。
    const idx = await prisma.$queryRawUnsafe<{ indexname: string; indexdef: string }[]>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'research' AND tablename = 'research_report'
          AND indexdef LIKE 'CREATE UNIQUE INDEX%'
        ORDER BY indexname`,
    );

    // 恰三条：PK + 放宽后的幂等键 + 新的取号键。多出第四条 = 有人偷加了别的唯一维度；
    // 旧的 uk_research_report_uploader_content 留着 = 放宽没生效（同字节换标的仍会被拒）。
    expect(idx.map((r) => r.indexname)).toEqual([
      'research_report_pkey',
      'uk_research_report_uploader_symbol_content',
      'uk_research_report_version_line',
    ]);

    const byName = new Map(idx.map((r) => [r.indexname, r.indexdef]));
    // 列集合逐列断言：少一列 = 版本线串到别的投递方 / 别的标的头上（FR-003 / FR-011）。
    expect(byName.get('uk_research_report_uploader_symbol_content')).toContain(
      '(uploader_kind, uploader_ref, symbol, content_hash)',
    );
    expect(byName.get('uk_research_report_version_line')).toContain(
      '(uploader_kind, uploader_ref, symbol, version)',
    );
  });

  it('FR-026 / SC-007 state_branch 16: 上线前形态的既有记录照常落库，version 保持 1', async () => {
    for (const row of LEGACY_ROWS) {
      // version 刻意不显式给 —— 走 DB 默认值，与 057 已落库的既有行同一条路径。
      await prisma.researchReport.create({ data: row });
    }

    const rows = await prisma.researchReport.findMany({
      orderBy: [{ uploaderRef: 'asc' }, { symbol: 'asc' }],
      select: { uploaderRef: true, symbol: true, version: true },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.version)).toEqual([1, 1, 1]);
    expect(rows.map((r) => `${r.uploaderRef}/${r.symbol}`)).toEqual([
      'friend1/cn:601318',
      'friend1/hk:01698',
      'friend2/hk:01698',
    ]);
  });

  it('FR-026 结构保证: 本次 migration 的 SQL 里没有 UPDATE / ALTER COLUMN', () => {
    const { sql } = find058Migration();

    // 「既有记录的版本号不被改写」在**结构上不可能**，这比跑一遍数据再断言更强：
    // 只要 migration 里没有任何行级写与列改型，就没有任何路径能碰到既有 version。
    // 注释也一并扫（本文件的注释刻意不出现这两个词），宁可严一格。
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/ALTER\s+COLUMN/i);

    // 反向：它确实做了该做的三件事（否则上面两条 not.toMatch 在空文件上也全绿）。
    expect(sql).toMatch(/DROP INDEX[\s\S]*uk_research_report_uploader_content/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX[\s\S]*uk_research_report_uploader_symbol_content/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX[\s\S]*uk_research_report_version_line/);
  });

  it('migration 产物与 schema.prisma 对 research_report 零漂移 (prisma migrate diff)', () => {
    // 已 migrate deploy 的库 → schema.prisma 的差集。**不断言全局空** —— 本仓有一处恒定漂移：
    // GIN 三元组拼音索引由 raw SQL 建，prisma 表达不了、每次 diff 都想删它
    // （scripts/prisma-migrate.ts 专门 scrub 这条）。故把断言收窄到本片负责的那张表：
    // schema.prisma 声明了而 migration 没建（或反之）时，差集里必然出现 research_report。
    const res = spawnSync(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--script',
      ],
      { cwd: SERVER_DIR, env: process.env, encoding: 'utf8' },
    );

    expect(res.status).toBe(0);
    expect(res.stdout ?? '').not.toMatch(/research_report/);
  }, 120_000);
});
