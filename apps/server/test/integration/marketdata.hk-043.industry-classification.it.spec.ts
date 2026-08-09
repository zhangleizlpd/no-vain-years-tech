import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import { LixingerIndustryClassificationAdapter } from '../../src/marketdata/lixinger-industry-classification.adapter';
import type { IndustryClassificationPort } from '../../src/marketdata/industry-classification.port';
import type { VendorHttpClient, VendorRequest } from '../../src/marketdata/vendor-http-client';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';
// industry_classification 覆盖式快照无 mode 分支 (delta/backfill 行为一致); 用 delta。
const input = { mode: 'delta' as const, asOf: AS_OF, now: NOW };
const TOKEN = 'test-token';
const BASE = 'https://open.lixinger.com/api';

/**
 * 所属行业**原始 vendor 响应** fixture (走真 LixingerIndustryClassificationAdapter 解析全管道):
 * vendor `industries` 端点返当前所属行业快照 (无 date), hsi 3 级层级 3 行 (probe verified 形态)。含:
 *  - L1/L2 数据行 (source/name/areaCode 齐) → typed 列全落
 *  - L3 数据行缺 name/areaCode → 落 null 不丢 (vendor 缺字段容忍)
 * ⚠️ vendor `stockCode` 字段实为**行业代码** (H70/H7020/H702015, 非个股 00700) → 落 industryCode 列。
 */
const DEFAULT_INDUSTRIES: unknown[] = [
  { areaCode: 'hk', stockCode: 'H70', source: 'hsi', name: '资讯科技业' }, // L1
  { areaCode: 'hk', stockCode: 'H7020', source: 'hsi', name: '软件与服务' }, // L2
  { stockCode: 'H702015', source: 'hsi' }, // L3 缺 name/areaCode → null
];

/** 重分类快照 fixture (覆盖式替换验证: 换成金融业层级, 验旧归属被整体替换无残留)。 */
const RECLASSIFIED_INDUSTRIES: unknown[] = [
  { areaCode: 'hk', stockCode: 'H50', source: 'hsi', name: '金融业' },
  { areaCode: 'hk', stockCode: 'H5010', source: 'hsi', name: '银行' },
];

// 043 T006 US1 所属行业集成 IT (Testcontainers PG, 真 LixingerIndustryClassificationAdapter + fake
// VendorHttpClient 埋原始 industries fixture): 走全管道 (adapter 解析 vendor stockCode→industryCode →
// executor 覆盖式 deleteMany+createMany → 真 PG)。验 industry_classification hk 运行 3 级层级 3 行落库
// (industryCode/source/name 齐) + 覆盖式重跑旧归属被换无残留 + 空返回跳过不 wipe + 请求单数 stockCode 无 date
// + stockCode→industryCode 消歧 + (instrumentId,source,industryCode) 幂等 + marketScope={hk} 纳 hk 排除 cn。
// 用真 adapter (非扩共享 MockMarketDataAdapter, 后者 hk=no-data 护 seam) 端到端校真解析+落库。覆盖 state_branch:
// 所属行业覆盖式快照 / 所属行业空返回不 wipe / 所属行业代码字段消歧 / industries 3 级层级路径 / 2 维度 marketScope 纳入。
describe('043 T006 industry_classification 所属行业 (Testcontainers PG, 真 adapter + fake http)', () => {
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

  beforeEach(async () => {
    await prisma.industryClassification.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T002 migration seed 已把 industry_classification marketScope={hk}; 显式复位保各例独立。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: 'industry_classification' },
      data: { marketScope: ['hk'] },
    });
  });

  /**
   * test-local fake VendorHttpClient: 记 calls (验请求走单数 stockCode + 覆盖式无 date/无 startDate);
   * served 集内 stockCode 返给定 industries rows (缺省 3 级层级 fixture), 集外 → 空 data (无归属标的)。
   * 喂真 adapter 解析全管道。
   */
  class HkIndustriesHttp {
    readonly calls: { stockCode: string; hasDate: boolean; hasRange: boolean }[] = [];
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly rows: unknown[] = DEFAULT_INDUSTRIES,
    ) {}
    async request<T>(req: VendorRequest): Promise<T> {
      const body = JSON.parse(req.body ?? '{}') as {
        stockCode?: string;
        date?: string;
        startDate?: string;
        endDate?: string;
      };
      this.calls.push({
        stockCode: String(body.stockCode),
        hasDate: body.date !== undefined,
        hasRange: body.startDate !== undefined || body.endDate !== undefined,
      });
      const data = this.served.has(String(body.stockCode)) ? this.rows : [];
      return { code: 1, message: 'success', data } as T;
    }
  }

  function makeAdapter(http: HkIndustriesHttp): IndustryClassificationPort {
    return new LixingerIndustryClassificationAdapter(
      http as unknown as VendorHttpClient,
      TOKEN,
      BASE,
    );
  }

  function buildRegistry(
    industryClassification: IndustryClassificationPort,
  ): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      mock,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
      undefined, // backfillPacer → 默认 disabled()
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      undefined, // hotSnapshot → 默认 null-object
      undefined, // buyback → 默认 null-object
      undefined, // equityChange → 默认 null-object
      undefined, // shareholderChange → 默认 null-object
      undefined, // allotment → 默认 null-object
      undefined, // revenueSegment → 默认 null-object
      undefined, // shareholderSnapshot → 默认 null-object
      undefined, // employee → 默认 null-object
      industryClassification, // industryClassification (尾部)
    );
  }

  async function seedInst(market: string, code: string, name: string): Promise<bigint> {
    const inst = await prisma.instrument.create({
      data: {
        market,
        code,
        name,
        type: 'stock',
        currency: market === 'hk' ? 'HKD' : 'CNY',
        status: 'active',
        lixingerCompanyType: 'non',
      },
    });
    return inst.id;
  }

  // ── ① 3 级层级 3 行落库 + typed 列齐 + 单数 stockCode 无 date + stockCode→industryCode 消歧 + 缺字段 null ──
  it('① industry_classification hk → 3 级层级 3 行 (industryCode/source/name) + 单数 stockCode 无 date + stockCode→industryCode 消歧 + 缺 name/areaCode null', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const http = new HkIndustriesHttp(new Set(['00700']));
    const registry = buildRegistry(makeAdapter(http));

    const { stats } = await registry.execute('industry_classification', input);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    // 请求: per-stock 单数 stockCode + 覆盖式无 date/无 startDate/无 endDate。
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].stockCode).toBe('00700'); // 单数 stockCode (executor per-stock)
    expect(http.calls[0].hasDate).toBe(false); // 覆盖式快照: 无 date
    expect(http.calls[0].hasRange).toBe(false); // 无 startDate/endDate

    const rows = await prisma.industryClassification.findMany({
      where: { instrumentId: instId },
    });
    // 3 级层级 3 行全落 (不去重)。
    expect(rows).toHaveLength(3);
    // 🔑 stockCode→industryCode 消歧: vendor stockCode 字段 (H70/H7020/H702015 行业代码) 落 industryCode 列
    //    (非个股 00700); collation-无关 → JS 排序对比。
    expect([...rows.map((r) => r.industryCode)].sort()).toEqual(['H70', 'H7020', 'H702015']);
    // NK 组件 source 齐 (全 hsi)。
    expect(rows.every((r) => r.source === 'hsi')).toBe(true);
    // L1 name/areaCode 齐。
    const l1 = rows.find((r) => r.industryCode === 'H70')!;
    expect(l1.name).toBe('资讯科技业');
    expect(l1.areaCode).toBe('hk');
    // L3 缺 name/areaCode → null (vendor 缺字段容忍)。
    const l3 = rows.find((r) => r.industryCode === 'H702015')!;
    expect(l3.name).toBeNull();
    expect(l3.areaCode).toBeNull();

    const run = await prisma.syncRun.findFirstOrThrow({
      where: { syncType: 'sync:industry_classification' },
    });
    expect(run.status).toBe('success');
  });

  // ── ② 覆盖式重跑: 旧归属被当前快照整体替换、无残留 ──
  it('② 覆盖式重跑 → 旧归属被当前快照整体替换、无残留 (H70/H7020/H702015 → H50/H5010)', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    // 首跑: 3 级 hsi 层级 (H70/H7020/H702015)。
    await buildRegistry(makeAdapter(new HkIndustriesHttp(new Set(['00700'])))).execute(
      'industry_classification',
      input,
    );
    expect(await prisma.industryClassification.count({ where: { instrumentId: instId } })).toBe(3);

    // 重跑: vendor 返重分类快照 (H50/H5010) → 覆盖式单 tx deleteMany+createMany 整体替换。
    await buildRegistry(
      makeAdapter(new HkIndustriesHttp(new Set(['00700']), RECLASSIFIED_INDUSTRIES)),
    ).execute('industry_classification', input);

    const rows = await prisma.industryClassification.findMany({ where: { instrumentId: instId } });
    // 旧归属 (H70/H7020/H702015) 无残留, 仅当前快照 (H50/H5010)。
    expect([...rows.map((r) => r.industryCode)].sort()).toEqual(['H50', 'H5010']);
  });

  // ── ③ 空返回跳过不 wipe: 既有归属保留 ──
  it('③ 空返回 → 跳过 mutate 不 wipe (既有归属保留, 计 ok 非 failed)', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    // 首跑落 3 行。
    await buildRegistry(makeAdapter(new HkIndustriesHttp(new Set(['00700'])))).execute(
      'industry_classification',
      input,
    );
    expect(await prisma.industryClassification.count({ where: { instrumentId: instId } })).toBe(3);

    // 重跑: served 空 → 00700 返 [] → 空返回跳过 mutate, 既有 3 行保留不 wipe (interim, plan Decision 3)。
    const { stats } = await buildRegistry(makeAdapter(new HkIndustriesHttp(new Set()))).execute(
      'industry_classification',
      input,
    );
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 }); // ok 非 failed
    expect(await prisma.industryClassification.count({ where: { instrumentId: instId } })).toBe(3); // 不 wipe
  });

  // ── ④ 幂等: 连跑两次 → 覆盖式替换 (instrumentId,source,industryCode) 不翻倍 (稳定 3 行) ──
  it('④ 幂等: 连跑两次 → (instrumentId,source,industryCode) 不翻倍 (稳定 3 行)', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const registry = buildRegistry(makeAdapter(new HkIndustriesHttp(new Set(['00700']))));
    await registry.execute('industry_classification', input);
    await registry.execute('industry_classification', input);
    expect(await prisma.industryClassification.count({ where: { instrumentId: instId } })).toBe(3);
  });

  // ── ⑤ marketScope={hk}: 纳 hk 排除 cn (2 维度 marketScope 纳入) ──
  it('⑤ marketScope={hk} → 纳 hk 排除 cn (cn 标的不进工作集、零请求、零落库)', async () => {
    const hkId = await seedInst('hk', '00700', '腾讯控股');
    const cnId = await seedInst('cn', '600519', '贵州茅台');
    // 即便 served 含 cn stockCode, marketScope={hk} 也不请求 cn。
    const http = new HkIndustriesHttp(new Set(['00700', '600519']));
    const registry = buildRegistry(makeAdapter(http));

    const { stats } = await registry.execute('industry_classification', input);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(http.calls.map((c) => c.stockCode)).toEqual(['00700']); // 仅 hk 请求
    expect(await prisma.industryClassification.count({ where: { instrumentId: hkId } })).toBe(3);
    expect(await prisma.industryClassification.count({ where: { instrumentId: cnId } })).toBe(0);
  });
});
