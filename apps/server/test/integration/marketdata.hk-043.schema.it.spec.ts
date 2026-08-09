import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';

// 表名 (sorted) — dimension_key 与表名一致 (industry_classification/announcement)。
const NEW_TABLES = ['announcement', 'industry_classification'];
const NEW_DIMS = ['announcement', 'industry_classification'];
// 期望 seed 画像 (T002 migration): market_scope={hk} + cron 统一夜频 (FR-011) '0 0 22 * * *' (共用
// master INV-3 错峰夜窗, 异于 042 报告期季频); freshness/history_depth 二档 —— industry_classification
// slow-drift+history_depth=NULL (覆盖式无历史, 不纳回填); announcement continuous-daily+history_depth=3650
// (10yr 可回填); priority 逐维度 (US1 industry_classification > US2 announcement, 均 < p1 核心 6 维 5-10)。
const NIGHTLY_CRON = '0 0 22 * * *';
const EXPECTED_DIM = {
  industry_classification: {
    depth: null as number | null,
    priority: 2,
    freshness: 'slow-drift',
    cron: NIGHTLY_CRON,
  },
  announcement: {
    depth: 3650 as number | null,
    priority: 1,
    freshness: 'continuous-daily',
    cron: NIGHTLY_CRON,
  },
} as const;

// 043 T003 Phase 1 Independent Test: 港股分类文本 2 张 market-agnostic 事实表 schema expand
// (expand-only, ADR-0035) — migrate deploy 后验 2 表 + 2 唯一约束 + announcement 时序索引 +
// instrument FK cascade + 2 sync_dimension seed 行 (marketScope={hk}/cron 夜频/freshness 二档/
// history_depth 二档) + 2 universe→dim soft 边。纯数据层 (不动 TS executor) ⇒ 立即编译绿。
// 覆盖 state_branch: `新表 market-agnostic` / `依赖 universe` (soft 边) / `2 维度 marketScope 纳入` (seed 层) /
// `cron 夜频二档` (seed cron/freshness/history) / `公告历史 10yr 可回填` (seed history_depth=3650)。
describe('043 hk classification-text schema expand (Testcontainers PG migrate deploy)', () => {
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

  it('2 张新事实表落库 (marketdata schema, 无 hk_* 前缀 → market-agnostic)', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'marketdata' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      NEW_TABLES,
    );
    expect(rows.map((r) => r.table_name)).toEqual(NEW_TABLES);
  });

  it('2 唯一约束索引 + announcement (instrument_id,date) 时序索引存在', async () => {
    const expected = [
      'ix_announcement_instrument_date', // 时序索引护超大表最近 N 日扫描 (plan Decision 7)
      'uk_announcement_instrument_date_link', // 公告 NK 3 列, linkUrl 天然唯一
      'uk_industry_classification_instrument_source_code', // 所属行业 NK 3 列, source 纳 NK
    ];
    const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'marketdata' AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      expected,
    );
    expect(rows.map((r) => r.indexname)).toEqual(expected);
  });

  it('instrument FK cascade: 删 instrument 连带删 2 张表子行 (含 3 级层级 industries + types[] announcement)', async () => {
    const inst = await prisma.instrument.create({
      data: {
        market: 'hk',
        code: '00700',
        name: '腾讯控股',
        type: 'stock',
        currency: 'HKD',
        status: 'active',
      },
    });
    // 3 级层级 3 行/股 (probe 00700 → H70/H7020/H702015, source=hsi, areaCode=hk)。
    await prisma.industryClassification.createMany({
      data: [
        {
          instrumentId: inst.id,
          source: 'hsi',
          industryCode: 'H70',
          name: '資訊科技業',
          areaCode: 'hk',
        },
        {
          instrumentId: inst.id,
          source: 'hsi',
          industryCode: 'H7020',
          name: '軟件服務',
          areaCode: 'hk',
        },
        {
          instrumentId: inst.id,
          source: 'hsi',
          industryCode: 'H702015',
          name: '數碼解決方案服務',
          areaCode: 'hk',
        },
      ],
    });
    await prisma.announcement.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2026-01-02'),
        linkUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0102/2026010200001.pdf',
        linkText: '翌日披露報表',
        linkType: 'PDF',
        types: ['ndd_r'],
      },
    });

    await prisma.instrument.delete({ where: { id: inst.id } });

    expect(await prisma.industryClassification.count({ where: { instrumentId: inst.id } })).toBe(0);
    expect(await prisma.announcement.count({ where: { instrumentId: inst.id } })).toBe(0);
  });

  it('唯一约束: 所属行业 NK (instrument,source,industry_code) — 3 级层级不撞 / source 纳 NK / 重复拒', async () => {
    const inst = await prisma.instrument.create({
      data: {
        market: 'hk',
        code: '00005',
        name: '滙豐控股',
        type: 'stock',
        currency: 'HKD',
        status: 'active',
      },
    });
    // 3 级层级 (同 source 不同 industryCode) → 全落, 不撞。
    await prisma.industryClassification.create({
      data: {
        instrumentId: inst.id,
        source: 'hsi',
        industryCode: 'H50',
        name: '金融業',
        areaCode: 'hk',
      },
    });
    await prisma.industryClassification.create({
      data: {
        instrumentId: inst.id,
        source: 'hsi',
        industryCode: 'H5010',
        name: '銀行',
        areaCode: 'hk',
      },
    });
    await prisma.industryClassification.create({
      data: {
        instrumentId: inst.id,
        source: 'hsi',
        industryCode: 'H501010',
        name: '銀行',
        areaCode: 'hk',
      },
    });
    // source 纳 NK: 同 industryCode 不同 source → 允许 (未来多分类体系 GICS/申万/hsi 无缝)。
    await prisma.industryClassification.create({
      data: {
        instrumentId: inst.id,
        source: 'gics',
        industryCode: 'H50',
        name: 'Financials',
        areaCode: 'hk',
      },
    });
    // 同三列自然键 → 拒。
    await expect(
      prisma.industryClassification.create({
        data: {
          instrumentId: inst.id,
          source: 'hsi',
          industryCode: 'H50',
          name: 'dup',
          areaCode: 'hk',
        },
      }),
    ).rejects.toThrow();
    expect(await prisma.industryClassification.count({ where: { instrumentId: inst.id } })).toBe(4);
  });

  it('唯一约束: 公告 NK (instrument,date,link_url) — 同 URL 折叠 / 不同 URL 保留 / types[] 保真 + 缺字段容忍', async () => {
    const inst = await prisma.instrument.create({
      data: {
        market: 'hk',
        code: '00001',
        name: '長和',
        type: 'stock',
        currency: 'HKD',
        status: 'active',
      },
    });
    const date = new Date('2026-02-02');
    const urlA = 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0202/A.pdf';
    const urlB = 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0202/B.pdf';
    await prisma.announcement.create({
      data: {
        instrumentId: inst.id,
        date,
        linkUrl: urlA,
        linkText: '公告A',
        linkType: 'PDF',
        types: ['dividend', 'fs'],
      },
    });
    // 同 date 不同 linkUrl → 允许 (linkUrl 天然唯一, 不同 URL 保留); 缺 linkText/linkType → null, 缺 types → []。
    await prisma.announcement.create({
      data: { instrumentId: inst.id, date, linkUrl: urlB },
    });
    // 同三列自然键 (同 URL) → 拒 (折叠)。
    await expect(
      prisma.announcement.create({
        data: {
          instrumentId: inst.id,
          date,
          linkUrl: urlA,
          linkText: 'dup',
          linkType: 'PDF',
          types: [],
        },
      }),
    ).rejects.toThrow();
    expect(await prisma.announcement.count({ where: { instrumentId: inst.id, date } })).toBe(2);

    // types[] 保真 (Postgres text[] 数组保序) + 缺字段容忍 (linkText/linkType null, types 空数组)。
    const rowA = await prisma.announcement.findFirst({
      where: { instrumentId: inst.id, linkUrl: urlA },
    });
    expect(rowA?.types).toEqual(['dividend', 'fs']);
    const rowB = await prisma.announcement.findFirst({
      where: { instrumentId: inst.id, linkUrl: urlB },
    });
    expect(rowB?.linkText).toBeNull();
    expect(rowB?.linkType).toBeNull();
    expect(rowB?.types).toEqual([]);
  });

  it('seed 2 维度行: marketScope=[hk] + cron 夜频二档 + freshness/history_depth 二档 + priority<核心', async () => {
    const dims = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [...NEW_DIMS] } },
    });
    expect(dims).toHaveLength(2);
    for (const dim of dims) {
      const expected = EXPECTED_DIM[dim.dimensionKey as keyof typeof EXPECTED_DIM];
      expect(dim.marketScope).toEqual(['hk']); // 覆盖 state_branch `2 维度 marketScope 纳入`
      expect(dim.enabled).toBe(true);
      expect(dim.vendor).toBe('lixinger');
      expect(dim.batchSize).toBe(1);
      expect(dim.adjustTypes).toEqual(['none']); // 分类/文本无复权
      expect(dim.historyDepth).toBe(expected.depth); // industry=null (覆盖式无历史) / announcement=3650 (10yr)
      expect(dim.priority).toBe(expected.priority);
      expect(dim.cronExpr).toBe(expected.cron); // FR-011 统一夜频
      expect(dim.freshnessProfile).toBe(expected.freshness); // 二档
      expect(dim.slaHours).toBeNull(); // 不做新鲜度 gating
    }
    // 优先级严格低于 p1 核心 6 维 (5-10) → 核心先吃共享令牌桶。
    const core = await prisma.syncDimension.findMany({
      where: {
        dimensionKey: {
          in: ['universe', 'profile', 'eod_bar', 'fundamental', 'financial', 'corporate_action'],
        },
      },
    });
    const maxNew = Math.max(...dims.map((d) => d.priority));
    const minCore = Math.min(...core.map((d) => d.priority));
    expect(maxNew).toBeLessThan(minCore);
  });

  it('seed cron 夜频二档 (FR-011): 2 维均夜频 0 0 22 * * * + freshness 二档 (slow-drift / continuous-daily)', async () => {
    const dims = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [...NEW_DIMS] } },
    });
    const byKey = new Map(dims.map((d) => [d.dimensionKey, d]));
    // 2 维统一夜频, 无季/日/周频差异 (异于 042 季频)。
    expect(dims.map((d) => d.cronExpr).filter((c) => c === NIGHTLY_CRON)).toHaveLength(2);
    // freshness 二档: 分类罕变 slow-drift / 文本流每日新披露 continuous-daily。
    expect(byKey.get('industry_classification')?.freshnessProfile).toBe('slow-drift');
    expect(byKey.get('announcement')?.freshnessProfile).toBe('continuous-daily');
    // history_depth 二档: 覆盖式无历史 (NULL) / 10yr 可回填 (3650)。
    expect(byKey.get('industry_classification')?.historyDepth).toBeNull();
    expect(byKey.get('announcement')?.historyDepth).toBe(3650);
  });

  it('seed 2 universe→dim soft 边 (依赖 universe, 全 soft)', async () => {
    const edges = await prisma.syncDependency.findMany({
      where: { upstream: 'universe', downstream: { in: [...NEW_DIMS] } },
      orderBy: { downstream: 'asc' },
    });
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.mode === 'soft')).toBe(true);
    expect(edges.map((e) => e.downstream)).toEqual([...NEW_DIMS].sort());
  });
});
