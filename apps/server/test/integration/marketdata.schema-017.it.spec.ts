import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { DIMENSION_KEYS } from '../../src/marketdata/dimension-executor';

// 017 T005 PR-2 Independent Test: PG 真相层 schema expand (expand-only, ADR-0035) —
// SyncDimension + next_fire_at/misfire_policy、SyncRun + bull_job_id、新表 sync_dependency
// + seed 6 边 (universe→* 全 soft ×5 + profile→fundamental hard, FR-S02 第一道拦截)。
// 既有行 next_fire_at 全 NULL (不回填, clarify Q1: NULL = 未物化哨兵, tick 懒初始化)。
describe('017 marketdata scheduler schema expand (Testcontainers PG migrate deploy)', () => {
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

  it('sync_dependency 表落库 (marketdata schema)', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'marketdata' AND table_name = 'sync_dependency'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('sync_dimension 新列: next_fire_at (timestamptz, nullable) + misfire_policy (varchar16, default fire-now)', async () => {
    const cols = await prisma.$queryRawUnsafe<
      {
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }[]
    >(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'marketdata' AND table_name = 'sync_dimension'
         AND column_name IN ('next_fire_at', 'misfire_policy')
       ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(['misfire_policy', 'next_fire_at']);
    const misfire = cols.find((c) => c.column_name === 'misfire_policy');
    expect(misfire?.is_nullable).toBe('NO');
    expect(misfire?.column_default).toContain('fire-now');
    const nextFire = cols.find((c) => c.column_name === 'next_fire_at');
    expect(nextFire?.data_type).toBe('timestamp with time zone');
    expect(nextFire?.is_nullable).toBe('YES');
  });

  it('sync_run 新列: bull_job_id (varchar64, nullable)', async () => {
    const cols = await prisma.$queryRawUnsafe<
      { column_name: string; character_maximum_length: number; is_nullable: string }[]
    >(
      `SELECT column_name, character_maximum_length, is_nullable FROM information_schema.columns
       WHERE table_schema = 'marketdata' AND table_name = 'sync_run' AND column_name = 'bull_job_id'`,
    );
    expect(cols).toHaveLength(1);
    expect(cols[0]?.character_maximum_length).toBe(64);
    expect(cols[0]?.is_nullable).toBe('YES');
  });

  it('seed 28 边: universe→* 全 soft (含 039 5 + 040 2 + 041 4 + 042 3 + 043 2 港股维度 + 046 underlying_iv_daily + 047 option_contract/earnings_event) + profile→fundamental hard + corp→eod hard (019 T011) + option_contract→option_daily_snapshot hard (047 FR-031)', async () => {
    const edges = await prisma.$queryRawUnsafe<
      { upstream: string; downstream: string; mode: string }[]
    >(
      `SELECT upstream, downstream, mode FROM "marketdata"."sync_dependency"
       ORDER BY upstream, downstream`,
    );
    expect(edges).toEqual([
      { upstream: 'corporate_action', downstream: 'eod_bar', mode: 'hard' }, // 019 T011 (FR-S08)。
      // 047 T003 FR-031: 无合约表即无从取快照 ⇒ 链发现失败必须断下游 (failParentOnFailure)。
      { upstream: 'option_contract', downstream: 'option_daily_snapshot', mode: 'hard' },
      { upstream: 'profile', downstream: 'fundamental', mode: 'hard' },
      { upstream: 'universe', downstream: 'allotment', mode: 'soft' }, // 041 T001
      { upstream: 'universe', downstream: 'announcement', mode: 'soft' }, // 043 T002 ('allotment' < 'announcement' < 'buyback')
      { upstream: 'universe', downstream: 'buyback', mode: 'soft' }, // 041 T001
      { upstream: 'universe', downstream: 'connect_holding', mode: 'soft' }, // 039 T001
      { upstream: 'universe', downstream: 'corporate_action', mode: 'soft' },
      // 047 T003: soft 边**只定执行序、不构成工作集闸** —— 别读成给财报维度挂了锚闸 (FR-035a 明禁)。
      { upstream: 'universe', downstream: 'earnings_event', mode: 'soft' }, // 047 T003 ('corporate_action' < 'earnings_event' < 'employee')
      { upstream: 'universe', downstream: 'employee', mode: 'soft' }, // 042 T002 ('employee' < 'eod_bar': 'm' < 'o')
      { upstream: 'universe', downstream: 'eod_bar', mode: 'soft' },
      { upstream: 'universe', downstream: 'equity_change', mode: 'soft' }, // 041 T001
      { upstream: 'universe', downstream: 'financial', mode: 'soft' },
      { upstream: 'universe', downstream: 'fund_company_holding', mode: 'soft' }, // 039 T001
      { upstream: 'universe', downstream: 'fund_holding', mode: 'soft' }, // 039 T001
      { upstream: 'universe', downstream: 'fundamental', mode: 'soft' },
      { upstream: 'universe', downstream: 'hot_snapshot', mode: 'soft' }, // 040 T002
      { upstream: 'universe', downstream: 'index_membership', mode: 'soft' }, // 039 T001
      { upstream: 'universe', downstream: 'industry_classification', mode: 'soft' }, // 043 T002 ('index_membership' < 'industry_classification' < 'profile')
      // 🚨 047 option_daily_snapshot 刻意**无 universe 入边** —— 它的工作集来自 option_contract
      // 而非 Instrument; 多一条入边会让它在 Kahn 拓扑里多一个前驱, 与上面那条 hard 边争相邻位。
      { upstream: 'universe', downstream: 'option_contract', mode: 'soft' }, // 047 T003 ('industry_classification' < 'option_contract' < 'profile')
      { upstream: 'universe', downstream: 'profile', mode: 'soft' },
      { upstream: 'universe', downstream: 'revenue_segment', mode: 'soft' }, // 042 T002
      { upstream: 'universe', downstream: 'shareholder_change', mode: 'soft' }, // 041 T001
      { upstream: 'universe', downstream: 'shareholder_snapshot', mode: 'soft' }, // 042 T002
      { upstream: 'universe', downstream: 'short_selling', mode: 'soft' }, // 039 T001
      { upstream: 'universe', downstream: 'underlying_iv_daily', mode: 'soft' }, // 046 T002 ('short_selling' < 'underlying_iv_daily' < 'us_equity_bar')
      // 🚨 046 us_index_daily 刻意**无入边** —— 它不读 Instrument, 与 universe 无数据依赖;
      // 连一条边等于把「指数不依赖锚/不依赖标的注册」(FR-027) 在依赖图上写反。无入边 ⇒ Kahn 拓扑里是根。
      { upstream: 'universe', downstream: 'us_equity_bar', mode: 'soft' }, // sellput-viz ('short_selling' < 'us_equity_bar' < 'volatility')
      { upstream: 'universe', downstream: 'volatility', mode: 'soft' }, // 040 T002
    ]);
  });

  it('既有 sync_dimension 行: next_fire_at 全 NULL (不回填) + misfire_policy 全 fire-now (default 落到既有行)', async () => {
    const dims = await prisma.$queryRawUnsafe<
      { dimension_key: string; next_fire_at: Date | null; misfire_policy: string }[]
    >(`SELECT dimension_key, next_fire_at, misfire_policy FROM "marketdata"."sync_dimension"`);
    // 从 DIMENSION_KEYS 派生: 本断言钉的是「既有行的两列默认值」, 行数只是「读到了全部 seed 行」
    // 的旁证 —— 写死数字会让每次加维度都在这里假红。
    expect(dims).toHaveLength(DIMENSION_KEYS.length);
    expect(dims.every((d) => d.next_fire_at === null)).toBe(true);
    expect(dims.every((d) => d.misfire_policy === 'fire-now')).toBe(true);
  });

  // ── T007 PR-2 集成 IT 增量 ──────────────────────────────────────────────────

  it('uk_sync_dependency_edge: 重复边 insert 拒 (typed client 经 generate 可用)', async () => {
    await expect(
      prisma.syncDependency.create({
        data: { upstream: 'universe', downstream: 'profile', mode: 'hard' },
      }),
    ).rejects.toThrow();
  });

  it('seed migration idempotent — 再跑 ON CONFLICT DO NOTHING 不重复行', async () => {
    // 模拟 deploy 重放 seed 语句 (migration.sql 同款)。
    await prisma.$executeRawUnsafe(
      `INSERT INTO "marketdata"."sync_dependency" ("upstream", "downstream", "mode")
       VALUES ('universe', 'profile', 'soft'), ('profile', 'fundamental', 'hard')
       ON CONFLICT ("upstream", "downstream") DO NOTHING`,
    );
    // 🚫 边数**不从 DIMENSION_KEYS 派生** —— 依赖边与维度不是一一对应 (us_index_daily /
    // option_daily_snapshot 刻意无 universe 入边, option_contract→option_daily_snapshot 是额外
    // 的 hard 边)。此处 28 与维度数 28 相等纯属巧合, 派生会把巧合固化成假约束。
    expect(await prisma.syncDependency.count()).toBe(28); // 017 seed 6 + 019 T011 corp→eod + 039 universe→5 港股维度 + 040 universe→volatility/hot_snapshot + 041 universe→4 事件流维度 + 042 universe→3 报告期维度 + 043 universe→2 分类文本维度 + 046 universe→underlying_iv_daily (us_index_daily 刻意无边) + 047 universe→option_contract/earnings_event + option_contract→option_daily_snapshot hard。
  });
});
