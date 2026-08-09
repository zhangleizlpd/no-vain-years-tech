import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import { LixingerEmployeeAdapter } from '../../src/marketdata/lixinger-employee.adapter';
import type { EmployeePort } from '../../src/marketdata/employee.port';
import type { VendorHttpClient, VendorRequest } from '../../src/marketdata/vendor-http-client';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';
// backfill 不传 backfillHistoryDays → from 由 seed historyDepth(3650, ~10yr) 驱动 (报告期可回填历史)。
const backfillInput = { mode: 'backfill' as const, asOf: AS_OF, now: NOW };
const TOKEN = 'test-token';
const BASE = 'https://open.lixinger.com/api';

/**
 * 多报告期员工**原始 vendor 响应** fixture (走真 LixingerEmployeeAdapter 解析全管道): dataList 是「维度头行 +
 * 数据行」混合结构 (probe verified 形态)。date 用 `...+08:00` (裸 slice 已 HK-correct) 验 lixDateOnlyHk 幂等
 * 端到端落库。含:
 *  - 纯头行 (无 parentItemName + 无 value, 如 "按年龄分"/"流失率按性别分") → adapter 跳过、不落库
 *  - 顶层 value 行 (员工总数/总流失率, 无 parentItemName) → parentItemName 落哨兵 ''
 *  - 数据行 (有 parentItemName + typed value) → 落 typed 列
 *  - 尾随空格脏数据 (parentItemName/itemName 带空格) → adapter `.trim()` 归一
 *  - **🔑 同名 (parentItemName,itemName) number+percentage 两行** (Decision 6 probe 独有坑: 流失率按性别分‖男性 =
 *    {58812 number, 15.2 percentage}) → 都出、NK 含 displayType 才共存不丢
 *  - 缺值数据行 (有 parentItemName 缺 value) → value 落 null 不丢
 */
const MIXED_RAW_REPORTS: unknown[] = [
  {
    date: '2024-12-31T00:00:00+08:00', // HK-aware 幂等 → 2024-12-31
    declarationDate: '2025-03-20T00:00:00+08:00', // → 2025-03-20
    stockId: 1000000000000700,
    dataList: [
      { itemName: '员工总数', value: 58350, displayType: 'number' }, // 顶层 value 行 → parentItemName ''
      { itemName: '按年龄分' }, // 纯头行 → 跳
      { itemName: '30歲以下', parentItemName: '按年龄分', value: 18415, displayType: 'number' },
      // 尾随空格脏数据 → trim 归一。
      { itemName: '30-50歲 ', parentItemName: '按年龄分 ', value: 30000, displayType: 'number' },
      { itemName: '流失率按性别分' }, // 纯头行 → 跳
      // 🔑 同名 (流失率按性别分, 男性) number + percentage 两行 → 都出、NK 含 displayType 共存。
      { itemName: '男性', parentItemName: '流失率按性别分', value: 58812, displayType: 'number' },
      {
        itemName: '男性',
        parentItemName: '流失率按性别分',
        value: 15.2,
        displayType: 'percentage',
      },
      // 缺值数据行 → value null。
      { itemName: '未披露', parentItemName: '按地区分', displayType: 'number' },
    ],
    source: 'ds_task',
  },
  {
    date: '2023-12-31T00:00:00+08:00', // HK-aware → 2023-12-31
    declarationDate: '2024-03-20T00:00:00+08:00',
    stockId: 1000000000000700,
    dataList: [
      { itemName: '员工总数', value: 55000, displayType: 'number' }, // 顶层 value 行 → parentItemName ''
      { itemName: '总流失率', value: 13.1, displayType: 'percentage' }, // 顶层 value 行 → parentItemName ''
    ],
    source: 'ds_task',
  },
];

// 042 T012 US3 员工集成 IT (Testcontainers PG, 真 LixingerEmployeeAdapter + fake VendorHttpClient 埋原始
// dataList 混合 fixture): 走全管道 (adapter 解析 dataList 头行判别/trim/HK-date/**同名 number+percentage 两行都出** →
// executor 区间落库 → 真 PG)。验 employee hk backfill 多期落库 (instrumentId,date,parentItemName,itemName,displayType)
// typed 列齐 + **同名 number+percentage 两行经 displayType 进 NK 幂等共存不丢** + displayType 语义保真 + key trim +
// value 缺 null + 单数 stockCode + range (from<to) + from=asOf−10yr (seed historyDepth 驱动) + 幂等不翻倍 + 空返回零行
// 不崩 + marketScope={hk} 纳 hk 排除 cn。用真 adapter (非扩共享 MockMarketDataAdapter, 后者 hk=no-data 护 seam) 端到端
// 校真解析+落库 (port-mock 的 DTO 流已去重, 覆盖不到「两行都出」— 唯真 adapter+fake http 走全管道能验)。覆盖 state_branch:
// 员工回填 / 全部单数 stockCode+range 契约(employee) / 报告期可回填历史(employee) / 嵌套 dataList 缺字段容忍(employee value 缺)。
describe('042 T012 employee 员工 (Testcontainers PG, 真 adapter + fake http)', () => {
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
    await prisma.employeeSnapshot.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T002 migration seed 已把 employee marketScope={hk} / historyDepth=3650; 显式复位保各例独立。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: 'employee' },
      data: { marketScope: ['hk'], historyDepth: 3650 },
    });
  });

  /**
   * test-local fake VendorHttpClient: 记 calls (验请求走单数 stockCode + range); served 集内 stockCode 返
   * 给定原始 reports (缺省混合多期 fixture), 集外 → 空 data (无员工披露标的)。喂真 adapter 解析全管道。
   */
  class HkEmployeeHttp {
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

  function makeAdapter(http: HkEmployeeHttp): EmployeePort {
    return new LixingerEmployeeAdapter(http as unknown as VendorHttpClient, TOKEN, BASE);
  }

  function buildRegistry(employee: EmployeePort): DimensionExecutorRegistry {
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
      employee, // employee (尾部)
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

  // ── ① backfill 多期落库 + typed 列齐 + 纯头行不落 + 顶层 sentinel + trim + 缺值 null + 同名两行共存 + HK 日期 + 单数 stockCode+range ──
  it('① backfill → employee 多期行 typed 列齐 (纯头行不落/顶层 sentinel/trim/缺值 null/同名 number+percentage 两行共存/HK 日期) + 单数 stockCode+range', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const http = new HkEmployeeHttp(new Set(['00700']));
    const registry = buildRegistry(makeAdapter(http));

    const { stats } = await registry.execute('employee', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    // 请求走区间 (from<to) + per-stock 单数 stockCode (executor 层「单数 stockCode」契约)。
    expect(http.calls).toHaveLength(1);
    const q = http.calls[0];
    expect(q.stockCode).toBe('00700'); // 单数 stockCode (非数组)
    expect(Boolean(q.startDate && q.endDate && q.startDate < q.endDate)).toBe(true);

    const rows = await prisma.employeeSnapshot.findMany({
      where: { instrumentId: instId },
      orderBy: [
        { date: 'asc' },
        { parentItemName: 'asc' },
        { itemName: 'asc' },
        { displayType: 'asc' },
      ],
    });
    // 2 报告期展开: 2024 期 6 数据子行 (2 纯头行跳) + 2023 期 2 顶层行 = 8。
    expect(rows).toHaveLength(8);

    // 🕐 HK-aware 日期端到端: +08:00 报告期 → 2024-12-31 / 2023-12-31 (幂等无害)。
    const dates = [...new Set(rows.map((r) => r.date.toISOString().slice(0, 10)))].sort();
    expect(dates).toEqual(['2023-12-31', '2024-12-31']);

    // 纯头行不落: 无 itemName='按年龄分'/'流失率按性别分' 的行 (adapter 已跳纯头行)。
    expect(rows.some((r) => r.itemName === '按年龄分' || r.itemName === '流失率按性别分')).toBe(
      false,
    );

    const find = (date: string, parent: string, item: string, dt: string) =>
      rows.find(
        (r) =>
          r.date.toISOString().slice(0, 10) === date &&
          r.parentItemName === parent &&
          r.itemName === item &&
          r.displayType === dt,
      );

    // 顶层 value 行: parentItemName 哨兵 ''; value Decimal(20,4); declarationDate HK-aware → 2025-03-20。
    const total = find('2024-12-31', '', '员工总数', 'number')!;
    expect(total).toBeDefined();
    expect(Number(total.value)).toBe(58350);
    expect(total.declarationDate?.toISOString().slice(0, 10)).toBe('2025-03-20');

    // trim 归一: 尾随空格 parentItemName/itemName 已去 → 精确命中 (按年龄分, 30-50歲)。
    expect(find('2024-12-31', '按年龄分', '30-50歲', 'number')).toBeDefined();

    // 🔑 同名 (流失率按性别分, 男性) number + percentage 两行经 displayType 进 NK 共存不丢 + 语义保真。
    const numRow = find('2024-12-31', '流失率按性别分', '男性', 'number')!;
    const pctRow = find('2024-12-31', '流失率按性别分', '男性', 'percentage')!;
    expect(numRow).toBeDefined();
    expect(pctRow).toBeDefined();
    expect(Number(numRow.value)).toBe(58812); // headcount 语义
    expect(Number(pctRow.value)).toBe(15.2); // percentage 语义
    // 同 (date, parentItemName, itemName) 两行, 仅 display_type 区分 → 都在 (NK 含 display_type)。
    expect(
      rows.filter((r) => r.parentItemName === '流失率按性别分' && r.itemName === '男性'),
    ).toHaveLength(2);

    // 缺值数据行 (未披露): value 落 null 不丢。
    const missing = find('2024-12-31', '按地区分', '未披露', 'number')!;
    expect(missing).toBeDefined();
    expect(missing.value).toBeNull();

    const run = await prisma.syncRun.findFirstOrThrow({ where: { syncType: 'sync:employee' } });
    expect(run.status).toBe('success');
  });

  // ── ② from=asOf−10yr: 报告期可回填历史 (seed historyDepth=3650 驱动, 未传 backfillHistoryDays) ──
  it('② backfill from=asOf−historyDepth(3650, ~10yr) — seed historyDepth 驱动可回填历史报告期', async () => {
    await seedInst('hk', '00700', '腾讯控股');
    const http = new HkEmployeeHttp(new Set(['00700']));
    const registry = buildRegistry(makeAdapter(http));

    await registry.execute('employee', backfillInput);

    const q = http.calls[0];
    expect(q.endDate).toBe(AS_OF); // to = asOf
    const gapDays =
      (new Date(q.endDate as string).getTime() - new Date(q.startDate as string).getTime()) /
      86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − seed historyDepth (~10yr)
  });

  // ── ③ 幂等: backfill 连跑两次 → createMany skipDuplicates 不翻倍 (自然键含 displayType) ──
  it('③ 幂等: backfill 连跑两次 → 自然键 (instrumentId,date,parentItemName,itemName,displayType) 不翻倍 (同名两行各自幂等)', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const http = new HkEmployeeHttp(new Set(['00700']));
    const registry = buildRegistry(makeAdapter(http));

    await registry.execute('employee', backfillInput);
    await registry.execute('employee', backfillInput);

    expect(await prisma.employeeSnapshot.count({ where: { instrumentId: instId } })).toBe(8);
    // 同名两行连跑后仍恰 2 行 (displayType 进 NK → 各自 skipDuplicates 折叠, 不因重跑翻 4 行)。
    expect(
      await prisma.employeeSnapshot.count({
        where: { instrumentId: instId, parentItemName: '流失率按性别分', itemName: '男性' },
      }),
    ).toBe(2);
  });

  // ── ④ 空返回零行不崩: 无员工披露标的 vendor 返 0 行 → 零落库、ok 非 failed、不阻塞其余标的 ──
  it('④ 无员工披露标的返 [] → 不写库、ok 非 failed、不阻塞其余标的 (per-stock 单 symbol)', async () => {
    const withData = await seedInst('hk', '00700', '腾讯控股'); // 有员工披露 (served)
    const noData = await seedInst('hk', '08001', '和记电讯香港'); // 无员工披露 (not served)
    const http = new HkEmployeeHttp(new Set(['00700']));
    const registry = buildRegistry(makeAdapter(http));

    const { stats } = await registry.execute('employee', backfillInput);

    // 两标的都 scanned+ok (08001 空返回不计 failed, 不阻塞 00700)。
    expect(stats).toMatchObject({ scanned: 2, ok: 2, failed: 0 });
    // per-stock 单 symbol: 2 标的 → 2 独立请求, 各单数 stockCode。
    expect(http.calls.map((c) => c.stockCode).sort()).toEqual(['00700', '08001']);
    expect(await prisma.employeeSnapshot.count({ where: { instrumentId: withData } })).toBe(8);
    expect(await prisma.employeeSnapshot.count({ where: { instrumentId: noData } })).toBe(0);
  });

  // ── ⑤ marketScope={hk}: 纳 hk 排除 cn (3 维度 marketScope 纳入) ──
  it('⑤ marketScope={hk} → 纳 hk 排除 cn (cn 标的不进工作集、零请求、零落库)', async () => {
    const hkId = await seedInst('hk', '00700', '腾讯控股');
    const cnId = await seedInst('cn', '600519', '贵州茅台');
    // 即便 served 含 cn stockCode, marketScope={hk} 也不请求 cn。
    const http = new HkEmployeeHttp(new Set(['00700', '600519']));
    const registry = buildRegistry(makeAdapter(http));

    const { stats } = await registry.execute('employee', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(http.calls.map((c) => c.stockCode)).toEqual(['00700']); // 仅 hk 请求
    expect(await prisma.employeeSnapshot.count({ where: { instrumentId: hkId } })).toBe(8);
    expect(await prisma.employeeSnapshot.count({ where: { instrumentId: cnId } })).toBe(0);
  });
});
