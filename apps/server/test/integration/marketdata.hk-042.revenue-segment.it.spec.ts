import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import { LixingerRevenueSegmentAdapter } from '../../src/marketdata/lixinger-revenue-segment.adapter';
import type { RevenueSegmentPort } from '../../src/marketdata/revenue-segment.port';
import type { VendorHttpClient, VendorRequest } from '../../src/marketdata/vendor-http-client';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';
// backfill 不传 backfillHistoryDays → from 由 seed historyDepth(3650, ~10yr) 驱动 (报告期可回填历史)。
const backfillInput = { mode: 'backfill' as const, asOf: AS_OF, now: NOW };
const TOKEN = 'test-token';
const BASE = 'https://open.lixinger.com/api';

/**
 * 多报告期营收构成**原始 vendor 响应** fixture (走真 LixingerRevenueSegmentAdapter 解析全管道):
 * dataList 是「维度头行 + 数据行」混合结构 (probe verified 形态)。date 用 UTC `...T16:00:00.000Z`
 * (= 次日 00:00+08 HK) 验 HK-aware off-by-one 修正端到端落库 (裸 slice 会少 1 天)。含:
 *  - 纯头行 (无 parentItemName + 无 value, 如 "按服務類型分"/"按地區分") → adapter 跳过、不落库
 *  - 数据行 (有 parentItemName + typed value) → 落 typed 列
 *  - 尾随空格脏数据 (parentItemName/itemName 带空格) → adapter `.trim()` 归一
 *  - 缺值数据行 (有 parentItemName 缺 revenue, HSBC 英國场景) → 落 null 不丢
 *  - signed 负 revenue (HSBC 企業中心 −1e10) → 不取绝对值/不过滤
 *  - 顶层合計行 (无 parentItemName 有 value) → parentItemName 落哨兵 ''
 */
const MIXED_RAW_REPORTS: unknown[] = [
  {
    date: '2024-12-30T16:00:00.000Z', // HK-aware → 2024-12-31 (非裸 slice 的 2024-12-30)
    declarationDate: '2025-03-19T16:00:00.000Z', // HK-aware → 2025-03-20
    currency: 'CNY',
    dataList: [
      { itemName: '按服務類型分' }, // 纯头行 → 跳
      {
        itemName: '增值服務',
        parentItemName: '按服務類型分',
        revenue: 319168000000,
        costs: 137511000000,
        grossProfitMargin: 0.5692,
      },
      // 尾随空格脏数据 → trim 归一。
      {
        itemName: '其他 ',
        parentItemName: '按服務類型分 ',
        revenue: 10000000000,
        costs: 5000000000,
        grossProfitMargin: 0.5,
      },
      { itemName: '按地區分' }, // 纯头行 → 跳
      {
        itemName: '中國內地',
        parentItemName: '按地區分',
        revenue: 500000000000,
        costs: 200000000000,
        grossProfitMargin: 0.6,
      },
      // signed 负 revenue (企業中心)。
      {
        itemName: '企業中心',
        parentItemName: '按地區分',
        revenue: -10300000000,
        costs: 2000000000,
        grossProfitMargin: -0.1,
      },
      { itemName: '英國', parentItemName: '按地區分' }, // 缺值数据行 → null
      // 顶层合計 (无 parentItemName 有 value) → parentItemName 哨兵 ''。
      { itemName: '合計', revenue: 660257000000, costs: 340000000000, grossProfitMargin: 0.485 },
    ],
  },
  {
    date: '2023-12-30T16:00:00.000Z', // HK-aware → 2023-12-31
    declarationDate: '2024-03-19T16:00:00.000Z',
    currency: 'CNY',
    dataList: [
      { itemName: '按服務類型分' }, // 纯头行 → 跳
      {
        itemName: '增值服務',
        parentItemName: '按服務類型分',
        revenue: 300000000000,
        costs: 130000000000,
        grossProfitMargin: 0.5667,
      },
      { itemName: '合計', revenue: 550000000000, costs: 290000000000, grossProfitMargin: 0.4727 },
    ],
  },
];

// 042 T006 US1 营收构成集成 IT (Testcontainers PG, 真 LixingerRevenueSegmentAdapter + fake VendorHttpClient
// 埋原始 dataList 混合 fixture): 走全管道 (adapter 解析 dataList 头行判别/trim/HK-date → executor 区间落库 →
// 真 PG)。验 revenue_segment hk backfill 多期分部行落 (instrumentId,date,parentItemName,itemName) typed 列齐
// + 连跑幂等不翻倍 + 请求单数 stockCode + range (from<to) + from=asOf−10yr (seed historyDepth 驱动) + **纯头行
// 不落 + 有 parent 缺 value 落 null + trim 归一 + signed 负 revenue + 顶层 sentinel '' + HK-aware 日期无 off-by-one**
// + 空返回零行不崩 + marketScope={hk} 纳 hk 排除 cn。用真 adapter (非扩共享 MockMarketDataAdapter, 后者 hk=no-data
// 护 seam) 端到端校真解析+落库。覆盖 state_branch: 营收构成回填 / 全部单数 stockCode+range 契约(revenue) /
// 报告期可回填历史(revenue) / 3 维度 marketScope 纳入 / 嵌套 dataList 缺字段容忍(revenue 缺值行)。
describe('042 T006 revenue_segment 营收构成 (Testcontainers PG, 真 adapter + fake http)', () => {
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
    await prisma.revenueSegment.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T002 migration seed 已把 revenue_segment marketScope={hk} / historyDepth=3650; 显式复位保各例独立。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: 'revenue_segment' },
      data: { marketScope: ['hk'], historyDepth: 3650 },
    });
  });

  /**
   * test-local fake VendorHttpClient: 记 calls (验请求走单数 stockCode + range); served 集内 stockCode 返
   * 给定原始 reports (缺省混合多期 fixture), 集外 → 空 data (无营收披露标的)。喂真 adapter 解析全管道。
   */
  class HkRevenueSegmentHttp {
    readonly calls: { stockCode: string; startDate?: string; endDate?: string }[] = [];
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly reports: unknown[] = MIXED_RAW_REPORTS,
    ) {}
    async request<T>(req: VendorRequest): Promise<T> {
      const body = JSON.parse(req.body ?? '{}') as {
        stockCode?: string;
        startDate?: string;
        endDate?: string;
      };
      this.calls.push({
        stockCode: String(body.stockCode),
        startDate: body.startDate,
        endDate: body.endDate,
      });
      const data = this.served.has(String(body.stockCode)) ? this.reports : [];
      return { code: 1, message: 'success', data } as T;
    }
  }

  function makeAdapter(http: HkRevenueSegmentHttp): RevenueSegmentPort {
    return new LixingerRevenueSegmentAdapter(http as unknown as VendorHttpClient, TOKEN, BASE);
  }

  function buildRegistry(revenueSegment: RevenueSegmentPort): DimensionExecutorRegistry {
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
      revenueSegment, // revenueSegment (尾部)
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

  // ── ① backfill 多期分部行落库 + typed 列齐 + 纯头行不落 + 缺值 null + trim + signed 负 + sentinel + HK 日期 + 单数 stockCode+range ──
  it('① backfill → revenue_segment 多期分部行 typed 列齐 (纯头行不落/缺值 null/trim/signed 负/sentinel/HK 日期) + 单数 stockCode+range', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const http = new HkRevenueSegmentHttp(new Set(['00700']));
    const registry = buildRegistry(makeAdapter(http));

    const { stats } = await registry.execute('revenue_segment', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    // 请求走区间 (from<to) + per-stock 单数 stockCode (executor 层「单数 stockCode」契约)。
    expect(http.calls).toHaveLength(1);
    const q = http.calls[0];
    expect(q.stockCode).toBe('00700'); // 单数 stockCode (非数组)
    expect(Boolean(q.startDate && q.endDate && q.startDate < q.endDate)).toBe(true);

    const rows = await prisma.revenueSegment.findMany({
      where: { instrumentId: instId },
      orderBy: [{ date: 'asc' }, { parentItemName: 'asc' }, { itemName: 'asc' }],
    });
    // 2 报告期展开: 2024 期 6 数据子行 (2 纯头行跳) + 2023 期 2 子行 = 8。
    expect(rows).toHaveLength(8);

    // 🕐 HK-aware 日期端到端: UTC-Z 报告期 → 2024-12-31 / 2023-12-31 (非裸 slice 的 12-30, off-by-one 修正)。
    const dates = [...new Set(rows.map((r) => r.date.toISOString().slice(0, 10)))].sort();
    expect(dates).toEqual(['2023-12-31', '2024-12-31']);

    // 纯头行不落: 无 itemName='按服務類型分'/'按地區分' 的行 (adapter 已跳纯头行)。
    expect(rows.some((r) => r.itemName === '按服務類型分' || r.itemName === '按地區分')).toBe(
      false,
    );

    const find = (date: string, parent: string, item: string) =>
      rows.find(
        (r) =>
          r.date.toISOString().slice(0, 10) === date &&
          r.parentItemName === parent &&
          r.itemName === item,
      );

    // 数据行 typed 列齐 (2024 增值服務): revenue/costs Decimal(24,2), grossProfitMargin Decimal(10,6),
    // declarationDate HK-aware → 2025-03-20, currency 文本。
    const vas = find('2024-12-31', '按服務類型分', '增值服務')!;
    expect(vas).toBeDefined();
    expect(Number(vas.revenue)).toBe(319168000000);
    expect(Number(vas.costs)).toBe(137511000000);
    expect(Number(vas.grossProfitMargin)).toBe(0.5692);
    expect(vas.currency).toBe('CNY');
    expect(vas.declarationDate?.toISOString().slice(0, 10)).toBe('2025-03-20');

    // trim 归一: 尾随空格 parentItemName/itemName 已去 → 精确命中 (按服務類型分, 其他)。
    expect(find('2024-12-31', '按服務類型分', '其他')).toBeDefined();

    // 缺值数据行 (英國): revenue/costs/grossProfitMargin 落 null 不丢。
    const uk = find('2024-12-31', '按地區分', '英國')!;
    expect(uk).toBeDefined();
    expect(uk.revenue).toBeNull();
    expect(uk.costs).toBeNull();
    expect(uk.grossProfitMargin).toBeNull();

    // signed 负 revenue (企業中心): 不取绝对值/不过滤。
    const corp = find('2024-12-31', '按地區分', '企業中心')!;
    expect(Number(corp.revenue)).toBe(-10300000000);
    expect(Number(corp.grossProfitMargin)).toBe(-0.1);

    // 顶层合計行: parentItemName 哨兵 ''。
    const total = find('2024-12-31', '', '合計')!;
    expect(total).toBeDefined();
    expect(Number(total.revenue)).toBe(660257000000);

    const run = await prisma.syncRun.findFirstOrThrow({
      where: { syncType: 'sync:revenue_segment' },
    });
    expect(run.status).toBe('success');
  });

  // ── ② from=asOf−10yr: 报告期可回填历史 (seed historyDepth=3650 驱动, 未传 backfillHistoryDays) ──
  it('② backfill from=asOf−historyDepth(3650, ~10yr) — seed historyDepth 驱动可回填历史报告期', async () => {
    await seedInst('hk', '00700', '腾讯控股');
    const http = new HkRevenueSegmentHttp(new Set(['00700']));
    const registry = buildRegistry(makeAdapter(http));

    await registry.execute('revenue_segment', backfillInput);

    const q = http.calls[0];
    expect(q.endDate).toBe(AS_OF); // to = asOf
    const gapDays =
      (new Date(q.endDate as string).getTime() - new Date(q.startDate as string).getTime()) /
      86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − seed historyDepth (~10yr)
  });

  // ── ③ 幂等: backfill 连跑两次 → createMany skipDuplicates 不翻倍 (自然键 instrumentId,date,parentItemName,itemName) ──
  it('③ 幂等: backfill 连跑两次 → 自然键 (instrumentId,date,parentItemName,itemName) 不翻倍', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const http = new HkRevenueSegmentHttp(new Set(['00700']));
    const registry = buildRegistry(makeAdapter(http));

    await registry.execute('revenue_segment', backfillInput);
    await registry.execute('revenue_segment', backfillInput);

    expect(await prisma.revenueSegment.count({ where: { instrumentId: instId } })).toBe(8);
  });

  // ── ④ 空返回零行不崩: 无营收披露标的 vendor 返 0 行 → 零落库、ok 非 failed、不阻塞其余标的 ──
  it('④ 无营收披露标的返 [] → 不写库、ok 非 failed、不阻塞其余标的 (per-stock 单 symbol)', async () => {
    const withData = await seedInst('hk', '00700', '腾讯控股'); // 有营收披露 (served)
    const noData = await seedInst('hk', '08001', '和记电讯香港'); // 无营收披露 (not served)
    const http = new HkRevenueSegmentHttp(new Set(['00700']));
    const registry = buildRegistry(makeAdapter(http));

    const { stats } = await registry.execute('revenue_segment', backfillInput);

    // 两标的都 scanned+ok (08001 空返回不计 failed, 不阻塞 00700)。
    expect(stats).toMatchObject({ scanned: 2, ok: 2, failed: 0 });
    // per-stock 单 symbol: 2 标的 → 2 独立请求, 各单数 stockCode。
    expect(http.calls.map((c) => c.stockCode).sort()).toEqual(['00700', '08001']);
    expect(await prisma.revenueSegment.count({ where: { instrumentId: withData } })).toBe(8);
    expect(await prisma.revenueSegment.count({ where: { instrumentId: noData } })).toBe(0);
  });

  // ── ⑤ marketScope={hk}: 纳 hk 排除 cn (3 维度 marketScope 纳入) ──
  it('⑤ marketScope={hk} → 纳 hk 排除 cn (cn 标的不进工作集、零请求、零落库)', async () => {
    const hkId = await seedInst('hk', '00700', '腾讯控股');
    const cnId = await seedInst('cn', '600519', '贵州茅台');
    // 即便 served 含 cn stockCode, marketScope={hk} 也不请求 cn。
    const http = new HkRevenueSegmentHttp(new Set(['00700', '600519']));
    const registry = buildRegistry(makeAdapter(http));

    const { stats } = await registry.execute('revenue_segment', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(http.calls.map((c) => c.stockCode)).toEqual(['00700']); // 仅 hk 请求
    expect(await prisma.revenueSegment.count({ where: { instrumentId: hkId } })).toBe(8);
    expect(await prisma.revenueSegment.count({ where: { instrumentId: cnId } })).toBe(0);
  });
});
