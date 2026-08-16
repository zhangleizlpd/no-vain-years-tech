import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setupEmptyDb, setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { FakeObjectStorage } from '../../src/integrations/oss/fake-object-storage.adapter';
import { type ResearchOssConfig } from '../../src/config';
import {
  IngestResearchReportUseCase,
  type IngestResearchReportInput,
} from '../../src/research/ingest-research-report.usecase';
import { ResearchIngestRejectedException } from '../../src/research/research-ingest-rejected.exception';
import { RESEARCH_QUOTA_BYTES } from '../../src/research/research-report.rules';

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
// 后续 task（T003 / T004 / T006）的行为断言各自另起 describe，与本 describe 平级 —— 它们取
// `setupIsolatedDb()`（已迁移好的模板克隆）+ **直接 new 贫血 usecase 打真 `PrismaService`**
// （体例同 optionsdesk-045.anchor.it.spec.ts），与本 describe 的空库 + migrate deploy 互不兼容。
//
// 🚨 **不走「收窄 boot + 真 HTTP」**（那是 057 report-ingest IT 的形态）：本片新增的回显字段先
// 落在 `IngestResearchReportResult`（usecase 返回类型），响应 DTO 要到 T007 才扩字段 ⇒ 经 HTTP
// 断言 `version` / `title` / `reportDate` 在 T003-T006 期间**恒取不到**。且 state_branch 7 要的是
// 同进程内真并发（`Promise.all` 两发），usecase 层才拿得到。通道层（multipart / guard / 413 /
// 401 / ProblemDetail 映射）已由 research-057.report-ingest.it.spec.ts 全量覆盖，此处不重复。

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

// ── 行为断言共用的装配件（T003 起）────────────────────────────────────────────
//
// OSS config 走**直接构造实参**而非 `process.env`：`@nestjs/config` 会跨独立 DI 容器缓存
// provider（057 report-ingest IT 文件头记录的那个坑），而这里根本不起容器 ⇒ 连坑的入口都没有。

const ALIYUN_OSS: ResearchOssConfig = {
  kind: 'aliyun',
  region: 'oss-cn-shanghai',
  bucket: 'nvy-research-oss-it',
  accessKeyId: 'LTAI-it-fake-ak',
  accessKeySecret: 'it-fake-sk',
};

/** 造一份指定大小的合法 PDF（`%PDF-` 魔数开头 + 填充）。`marker` 变 ⇒ 内容指纹变。 */
function pdfOfSize(bytes: number, marker = 'x'): Buffer {
  const head = Buffer.from('%PDF-1.4\n');
  const tail = Buffer.from('\n%%EOF\n');
  const fill = Buffer.alloc(Math.max(0, bytes - head.length - tail.length), marker);
  return Buffer.concat([head, fill, tail]);
}

function inputOf(
  over: {
    symbol?: string;
    guest?: string;
    /** 变它就是「另一份文件」—— 内容指纹随之变。 */
    marker?: string;
    title?: string;
    reportDate?: string;
    filename?: string;
  } = {},
): IngestResearchReportInput {
  return {
    uploader: { kind: 'guest', guestName: over.guest ?? 'friend1' },
    symbol: over.symbol ?? 'hk:01698',
    reportDate: over.reportDate ?? '2026-08-01',
    title: over.title ?? '某公司深度研报',
    file: {
      bytes: pdfOfSize(4096, over.marker ?? 'x'),
      filename: over.filename ?? 'report.pdf',
    },
  };
}

/**
 * `code` 落在 `HttpException` 的 response body 里（`{ code, message }`），**不是异常对象上的属性**
 * —— `rejects.toMatchObject({ code })` 会静默对不上（它比的是异常自身的字段）。
 */
async function expectRejectedWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  const err: unknown = await promise.then(
    () => new Error('期望被拒，实际成功了'),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ResearchIngestRejectedException);
  expect((err as ResearchIngestRejectedException).getResponse()).toMatchObject({ code });
}

describe('058 T003 幂等键放宽 =（投递方, 标的, 文件字节）(Testcontainers PG + 真 usecase)', () => {
  let prisma: PrismaService;
  let storage: FakeObjectStorage;
  let ingest: IngestResearchReportUseCase;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
    storage = new FakeObjectStorage();
    ingest = new IngestResearchReportUseCase(prisma, storage, ALIYUN_OSS);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE research.research_report RESTART IDENTITY CASCADE');
    storage.calls.length = 0;
  });

  it('state_branch 3 / FR-020: 同投递方 + 同标的 + 同字节重投（已完成态）→ 幂等返回首次那条', async () => {
    const first = await ingest.execute(inputOf({}));
    const second = await ingest.execute(inputOf({}));

    expect(second.reportId).toBe(first.reportId);
    expect(second.deduplicated).toBe(true);
    expect(await prisma.researchReport.count()).toBe(1);
    expect(storage.calls).toHaveLength(1); // 第二次完全没碰对象存储
  });

  it('state_branch 4 / FR-020: 撞自己名下的未完成行 → 就地续做，不新增行也不报冲突', async () => {
    storage.enqueue('indeterminate');
    await expect(ingest.execute(inputOf({}))).rejects.toBeInstanceOf(
      ResearchIngestRejectedException,
    );
    expect((await prisma.researchReport.findFirst())?.status).toBe('PENDING');

    const again = await ingest.execute(inputOf({}));
    expect(again.deduplicated).toBe(false); // 续做不是幂等命中：这一次真的写了对象

    const rows = await prisma.researchReport.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('COMMITTED');
    expect(storage.calls).toHaveLength(2); // 重传了一次（同字节写同位置是幂等重写）
  });

  it('state_branch 5 / FR-019 / FR-021 / SC-003 / SC-006: 同字节 + 不同标的 → 各自成行且复用同一归档对象', async () => {
    // 2026-08-16 实测那类错的补救动作：先投成 A 股代码，再用港股代码投**同一个文件**。
    // 057 的键不含 symbol ⇒ 第二次只会拿回第一条（deduplicated: true），错改不掉。
    const wrong = await ingest.execute(inputOf({ symbol: 'cn:601318' }));
    const right = await ingest.execute(inputOf({ symbol: 'hk:02318' }));

    expect(right.reportId).not.toBe(wrong.reportId); // 两行不同 id
    expect(right.deduplicated).toBe(false);
    expect(wrong.symbol).toBe('cn:601318'); // symbol 各自正确
    expect(right.symbol).toBe('hk:02318');
    expect(right.objectKey).toBe(wrong.objectKey); // objectKey 逐字节相同

    const rows = await prisma.researchReport.findMany({ orderBy: { id: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.symbol)).toEqual(['cn:601318', 'hk:02318']);
    expect(rows[0].objectKey).toBe(rows[1].objectKey);
    // 写了两次、但写的是同一个位置（同字节幂等重写）⇒ 归档侧占用的对象份数恒为 1（SC-006）。
    expect(storage.calls).toHaveLength(2);
    expect(new Set(storage.objectKeys).size).toBe(1);
  });

  it('state_branch 6（T003 半）/ FR-003: 不同投递方 + 同标的 + 同字节 → 各留一行，复用同一对象', async () => {
    const a = await ingest.execute(inputOf({ guest: 'friend1' }));
    const b = await ingest.execute(inputOf({ guest: 'friend2' }));

    expect(b.reportId).not.toBe(a.reportId);
    expect(b.deduplicated).toBe(false); // 归属不同 ⇒ 不是重复投递（057 归属完整性不得回退）
    expect(b.objectKey).toBe(a.objectKey);

    const rows = await prisma.researchReport.findMany({ orderBy: { uploaderRef: 'asc' } });
    expect(rows.map((r) => r.uploaderRef)).toEqual(['friend1', 'friend2']);
    // 「各自版本线均从 1 起」的断言在 T004（FR-011）—— 取号在那一片才实装。
  });

  it('state_branch 15 / FR-022: 同一条版本线上的多个版本各自全额计入配额（口径蓄意高估不变）', async () => {
    // 🚨 多版本靠**显式 version 直灌**而非连投 —— 取号（`MAX+1`）到 T004 才实装，此处若走
    // usecase 连投会撞取号唯一键。本条要证的是**配额口径**：同线多版本不因同属一条线（也不因
    // 共享同一归档对象）而合并计算。
    //
    // 必须多行填、不能一行填满：`size_bytes` 是 INTEGER（约 2.1GB 上限），配额是 8GB
    // （判据同 research-057.report-ingest.it.spec.ts 的 seedQuotaFilled 注释）。
    const CHUNK = 2_000_000_000;
    const versions = Math.ceil(RESEARCH_QUOTA_BYTES / CHUNK); // 5 版 × 2GB = 10GB > 8GB
    await prisma.researchReport.createMany({
      data: Array.from({ length: versions }, (_, i) => ({
        symbol: 'hk:01698',
        reportDate: new Date('2026-08-01T00:00:00.000Z'),
        title: `第 ${i + 1} 版`,
        version: i + 1,
        contentHash: `${i}`.padStart(64, 'z'),
        sizeBytes: CHUNK,
        originalFilename: 'old.pdf',
        objectKey: 'research/zzzzzzzz/report.pdf', // 刻意让 5 版共享同一个归档对象
        status: 'COMMITTED',
        uploaderKind: 'guest',
        uploaderRef: 'friend1',
      })),
    });

    const agg = await prisma.researchReport.aggregate({
      _sum: { sizeBytes: true },
      where: { uploaderKind: 'guest', uploaderRef: 'friend1' },
    });
    // 逐版全额相加 —— 若同线合并计一次（或按 objectKey 去重计一次），这里就是 CHUNK。
    expect(agg._sum.sizeBytes).toBe(versions * CHUNK);
    expect(agg._sum.sizeBytes).toBeGreaterThan(RESEARCH_QUOTA_BYTES);

    // ⇒ 同线再投一份合规文件也被配额拒，且不碰 OSS（闸在建行之前）。
    await expectRejectedWithCode(
      ingest.execute(inputOf({ marker: 'q' })),
      'RESEARCH_QUOTA_EXCEEDED',
    );
    expect(storage.calls).toHaveLength(0);
    expect(await prisma.researchReport.count()).toBe(versions);
  });
});
