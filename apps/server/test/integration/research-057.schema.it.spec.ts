import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupEmptyDb } from '../_support/isolated-db';
import { runMigrateDeploy } from '../_support/run-migrate';
import { PrismaService } from '../../src/security/prisma.service';

// 057 T005 schema IT: 第 11 个 bounded context research 的存储地基 (expand-only, ADR-0035)。
//
// **必须真 PG**: 本条被测对象**就是 `migrate deploy` 的产物本身** —— DDL 落没落 / 新 schema
// namespace 在不在册 / 唯一约束真不真拦 / 默认值是不是 DB 侧的。这些在任何 mock 或对
// schema.prisma 的静态读取里都不存在 ⇒ 取 `setupEmptyDb()`（三入口中「自己跑 migrate deploy
// 并验证其产物」那一个）。换成 `setupIsolatedDb()` 的模板克隆会把被测对象整个抽掉，
// **而且不会红、也不会变慢** —— 只是悄悄不再验证任何东西。
//
// 验 ① `research` namespace + 表真实存在 ② 幂等键**真拦**重复 ③ **反例**: 同字节换一个投递方
// **可以**插入（幂等键作用域是 per-投递方，不是全局 content_hash 唯一 —— 这是 spec
// Clarifications Q1 的机器表达；只验 ② 不验 ③ 的话，一个「全局 content_hash 唯一」的错误约束
// 同样全绿）④ 同投递方不同字节各自独立成行 (state_branch 4) ⑤ **symbol 无 FK**: 标的注册表里
// 根本不存在的 symbol 照样落库（「跨 ctx 面为 0」的反向断言）⑥ source/version 的默认值来自
// DB 侧 ⑦ report_date 是 DATE 而非 timestamp（研报日期是日历日不是时刻，混用会让「今天」跟着
// 容器时区漂）。
//
// 🚨 **058 有意改写了本文件的两处**（058 T003；改的是造数与键的列集合，不是这七条的意图）：
//   · 幂等键 057 是 (uploader_kind, uploader_ref, content_hash)，058 **放宽**为
//     (uploader_kind, uploader_ref, symbol, content_hash)（FR-019）—— 同一份文件换个标的重投
//     从此各自成行，②/③ 的标题与断言随之带上 symbol 维度。
//   · 058 新增取号键 (uploader_kind, uploader_ref, symbol, version)（FR-025）⇒ 同一条
//     (投递方, 标的) 线上的多行**必须显式给不同 version**，且跨 `it` 累积的行会互撞
//     ⇒ 本文件加 `beforeEach` TRUNCATE，每条 `it` 自持数据。
describe('057 research schema expand (Testcontainers PG migrate deploy)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupEmptyDb>>;

  const BASE = {
    symbol: 'hk:1698',
    reportDate: new Date('2026-08-01'),
    title: '某公司深度研报',
    contentHash: 'a'.repeat(64),
    sizeBytes: 2_020_387,
    originalFilename: 'report.pdf',
    objectKey: 'research/deadbeef/report.pdf',
    status: 'COMMITTED',
    uploaderKind: 'guest',
    uploaderRef: 'friend1',
  };

  beforeAll(async () => {
    db = await setupEmptyDb();
    process.env.DATABASE_URL = db.databaseUrl;

    runMigrateDeploy();

    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  // 058 起 (uploader_kind, uploader_ref, symbol, version) 唯一 ⇒ 跨 `it` 累积的行会互撞取号键。
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE research.research_report RESTART IDENTITY CASCADE');
  });

  it('research namespace 与 research_report 表真实存在', async () => {
    const schemas = await prisma.$queryRawUnsafe<{ schema_name: string }[]>(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'research'`,
    );
    expect(schemas.map((r) => r.schema_name)).toEqual(['research']);

    const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'research' ORDER BY table_name`,
    );
    expect(tables.map((r) => r.table_name)).toEqual(['research_report']);
  });

  it('幂等键 (uploader_kind, uploader_ref, symbol, content_hash) 真拦重复投递', async () => {
    const hash = 'b'.repeat(64);
    await prisma.researchReport.create({ data: { ...BASE, contentHash: hash } });

    // 🚨 第二行**显式换一个 version** —— 058 起表上有两个唯一键，不换号的话这一撞可能撞的是
    // 取号键 (…, symbol, version)，断言就变成了「P2002 出现过」而非「幂等键拦住了」。
    // 换了号之后，唯一可能撞的就只剩幂等键，这条才真的在验它。
    await expect(
      prisma.researchReport.create({
        data: { ...BASE, contentHash: hash, version: 2, title: '改了标题' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('反例：同字节换一个投递方可以插入（幂等键作用域是 per-投递方，非全局 content_hash）', async () => {
    const hash = 'c'.repeat(64);
    await prisma.researchReport.create({
      data: { ...BASE, contentHash: hash, uploaderRef: 'friend1' },
    });
    const second = await prisma.researchReport.create({
      data: { ...BASE, contentHash: hash, uploaderRef: 'friend2' },
    });

    // 两行元数据，但 object_key 相同 —— 对象只存一份（位置由 content_hash 单独导出）。
    const rows = await prisma.researchReport.findMany({
      where: { contentHash: hash },
      orderBy: { uploaderRef: 'asc' },
      select: { uploaderRef: true, objectKey: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].objectKey).toBe(rows[1].objectKey);
    expect(second.id).toBeDefined();
  });

  it('同投递方不同字节各自独立成行（同标的同日期的两份不同研报）', async () => {
    // 058 起这两行就是同一条 (投递方, 标的) 版本线上的第 1 / 第 2 版，故 version 显式给不同值
    // （057 时二者都走 DB 默认值 1；取号逻辑本身在 058 T004，此处只做造数）。
    const rows = await Promise.all([
      prisma.researchReport.create({
        data: { ...BASE, contentHash: 'd'.repeat(64), uploaderRef: 'friend3', version: 1 },
      }),
      prisma.researchReport.create({
        data: { ...BASE, contentHash: 'e'.repeat(64), uploaderRef: 'friend3', version: 2 },
      }),
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it('反例：symbol 无 FK —— 标的注册表里不存在的 symbol 照样落库（跨 ctx 面为 0）', async () => {
    const created = await prisma.researchReport.create({
      data: {
        ...BASE,
        symbol: 'cn:999999', // 刻意取一个 marketdata.instrument 里不可能有的代码
        contentHash: 'f'.repeat(64),
        uploaderRef: 'friend4',
      },
      select: { symbol: true },
    });
    expect(created.symbol).toBe('cn:999999');

    const fks = await prisma.$queryRawUnsafe<{ constraint_name: string }[]>(
      `SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_schema = 'research' AND table_name = 'research_report'
          AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(fks).toEqual([]);
  });

  it('source / version 的默认值由 DB 侧提供', async () => {
    const cols = await prisma.$queryRawUnsafe<{ column_name: string; column_default: string }[]>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_schema = 'research' AND table_name = 'research_report'
          AND column_name IN ('source', 'version') ORDER BY column_name`,
    );
    expect(cols).toEqual([
      { column_name: 'source', column_default: expect.stringContaining('自研') },
      { column_name: 'version', column_default: '1' },
    ]);
  });

  it('report_date 是 DATE 而非 timestamp（日历日，不随容器时区漂）', async () => {
    const cols = await prisma.$queryRawUnsafe<{ column_name: string; data_type: string }[]>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'research' AND table_name = 'research_report'
          AND column_name IN ('report_date', 'created_at') ORDER BY column_name`,
    );
    expect(cols).toEqual([
      { column_name: 'created_at', data_type: 'timestamp with time zone' },
      { column_name: 'report_date', data_type: 'date' },
    ]);
  });
});
