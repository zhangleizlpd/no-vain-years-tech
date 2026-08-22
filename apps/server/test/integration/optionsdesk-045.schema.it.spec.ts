import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupEmptyDb } from '../_support/isolated-db';
import { runMigrateDeploy } from '../_support/run-migrate';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaService } from '../../src/security/prisma.service';

const SERVER_DIR = process.cwd();
const MONO_ROOT = resolve(SERVER_DIR, '../..');

// 045 T005 Phase 1 Independent Test: optionsdesk 新 schema + 两表落地 (expand-only, ADR-0035) —
// migrate deploy 后验 ① 两表在 optionsdesk schema ② 锚表 ticker 唯一约束真生效 (重复插撞 P2002,
// FR-001「同一 ticker MUST NOT 存在两条有效锚」) ③ 痕迹表可插且**删锚后痕迹行仍在** (anchorId
// 无 FK relation ⇒ 不级联, FR-031: 删锚本身也是一条痕迹) ④ check-server-moat 0 违规。
// 纯数据层形态验证 —— 写侧行为 (生效 L 层求值 / 回落链 / 痕迹落同 tx) 归 T006–T008 与 T011。
describe('045 optionsdesk schema expand (Testcontainers PG migrate deploy)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupEmptyDb>>;

  const anchorSeed = {
    ticker: 'us:TAP',
    // 065 T03 起 NOT NULL + `ck_anchor_market` ⇒ 必填。🚨 override `ticker` 的用法 (下面
    // 「痕迹可插」那条) 必须同步 override 本列, 否则种出 market 与 ticker 不一致的行。
    market: 'us',
    v: '50',
    asof: new Date('2026-08-01T00:00:00Z'),
    method: 'dcf',
    confidence: '8.5', // Decimal(4,2): 模型可出非整值
    confidenceSource: 'manual',
    lLevelEffective: 'L2',
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

  it('anchor + anchor_change + anchor_submission 三表落 optionsdesk schema', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'optionsdesk'
        ORDER BY table_name`,
    );
    // anchor_submission 是 059 加的待审收件箱（同 schema，不新建 namespace）。
    expect(rows.map((r) => r.table_name)).toEqual(['anchor', 'anchor_change', 'anchor_submission']);
  });

  it('FR-001 ticker 唯一约束: 重复插撞 P2002 且库内仍只一行', async () => {
    const created = await prisma.anchor.create({ data: anchorSeed });
    expect(created.ticker).toBe(anchorSeed.ticker);
    // 派生位默认空 (人工位三列 + 投影列 + 状态机列均 nullable, 建锚只录事实)。
    expect(created.vManual).toBeNull();
    expect(created.lLevelManual).toBeNull();
    expect(created.positionCapManual).toBeNull();
    expect(created.lastClose).toBeNull();
    expect(created.breachStartedOn).toBeNull();
    expect(created.excluded).toBe(false);

    // 同 ticker 再插 → 唯一索引拒 (并发建锚的串行化地基; 写侧据此 catch → 409, T006 EC-7)。
    const dup = await prisma.anchor
      .create({ data: { ...anchorSeed, v: '60', method: 'multiples' } })
      .then(
        () => null,
        (e: unknown) => e as { code?: string; meta?: { target?: unknown } },
      );
    expect(dup?.code).toBe('P2002');

    expect(await prisma.anchor.count({ where: { ticker: anchorSeed.ticker } })).toBe(1);
    const still = await prisma.anchor.findUnique({ where: { ticker: anchorSeed.ticker } });
    expect(still?.method).toBe(anchorSeed.method); // 冲突方零副作用: 既有行未被覆盖
  });

  it('唯一性落在 ticker 单列 (uk_anchor_ticker) —— canonical `market:code` 是身份', async () => {
    // ⚠️ Prisma 的 `@unique(map: ...)` 建的是**唯一索引**而非 table constraint ⇒ 查 pg_indexes,
    // information_schema.table_constraints 看不见它 (查错表会得到「零约束」的假阴性)。
    const idx = await prisma.$queryRawUnsafe<{ indexname: string; indexdef: string }[]>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'optionsdesk' AND tablename = 'anchor'
          AND indexdef LIKE 'CREATE UNIQUE INDEX%'
        ORDER BY indexname`,
    );
    // 唯一索引恰两条: PK(id) + ticker 业务键。多出第三条 = 有人偷加了别的唯一维度。
    expect(idx.map((r) => r.indexname)).toEqual(['anchor_pkey', 'uk_anchor_ticker']);
    expect(idx[1]?.indexdef).toContain('(ticker)');
  });

  it('FR-031 痕迹可插 + 删锚后痕迹行仍在 (不级联, 删锚本身也是一条痕迹)', async () => {
    const anchor = await prisma.anchor.create({ data: { ...anchorSeed, ticker: 'us:VICI' } });

    // ① 一次字段级变更 (一行 = 一次变更, 非一行一字段)。
    await prisma.anchorChange.create({
      data: {
        anchorId: anchor.id,
        changedFields: ['confidence', 'lLevelEffective'],
        beforeValues: { confidence: '8.5', lLevelEffective: 'L2' },
        source: 'manual',
      },
    });
    // ② 删锚那条痕迹存整行快照, source 可分辨模型/人工。
    await prisma.anchorChange.create({
      data: {
        anchorId: anchor.id,
        changedFields: ['__deleted__'],
        beforeValues: { ticker: anchor.ticker, v: anchor.v.toString(), method: anchor.method },
        source: 'model',
      },
    });

    await prisma.anchor.delete({ where: { id: anchor.id } });
    expect(await prisma.anchor.findUnique({ where: { id: anchor.id } })).toBeNull();

    // 主行没了, 痕迹全在 —— PIT 还原 (SC-011) 的地基; 普通编辑/删除覆盖不掉它。
    const trail = await prisma.anchorChange.findMany({
      where: { anchorId: anchor.id },
      orderBy: { changedAt: 'asc' },
    });
    expect(trail).toHaveLength(2);
    expect(trail.map((t) => t.source)).toEqual(['manual', 'model']);
    expect(trail[0]?.changedFields).toEqual(['confidence', 'lLevelEffective']);
    expect(trail[1]?.beforeValues).toMatchObject({ ticker: 'us:VICI' });
  });

  it('anchor_change 零 FK 约束 —— 不级联是结构保证, 不靠调用方自觉', async () => {
    const fks = await prisma.$queryRawUnsafe<{ constraint_name: string }[]>(
      `SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_schema = 'optionsdesk' AND table_name = 'anchor_change'
          AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(fks).toEqual([]);
  });

  it('check-server-moat 0 违规 (anchor / anchorChange owner 已声明 optionsdesk)', () => {
    // 漏声明 MODEL_OWNERSHIP → 脚本非零退出 (lefthook + CI 同门); 此处固化为回归网。
    // ⚠️ 诚实标注: 探针只扫**被 src/** 访问**的 model —— 两表接进 usecase (T006 起) 后本断言
    // 才承重, 在此之前是平凡绿。
    expect(() =>
      execFileSync('pnpm', ['tsx', 'scripts/checks/check-server-moat.ts'], {
        cwd: MONO_ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  }, 120_000);
});
