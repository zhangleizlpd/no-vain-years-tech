import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import { LixingerAnnouncementAdapter } from '../../src/marketdata/lixinger-announcement.adapter';
import type { AnnouncementPort } from '../../src/marketdata/announcement.port';
import type { VendorHttpClient, VendorRequest } from '../../src/marketdata/vendor-http-client';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';
// backfill 不传 backfillHistoryDays → from 由 seed historyDepth(3650, ~10yr) 驱动 (文本流可回填历史)。
const backfillInput = { mode: 'backfill' as const, asOf: AS_OF, now: NOW };
const TOKEN = 'test-token';
const BASE = 'https://open.lixinger.com/api';

/**
 * 公告**原始 vendor 响应** fixture (走真 LixingerAnnouncementAdapter 解析全管道): vendor `announcement`
 * 端点返区间内公告流, `date` 为 `+08:00` HK-local (probe verified)。含:
 *  - 多 date 行 (2016/2020/2024, 验区间回填多年)
 *  - 同 date (2024-12-31) 不同 linkUrl 两行 → NK (instrumentId,date,linkUrl) 两行都落 (linkUrl 天然唯一)
 *  - 数据行 (linkText/linkType/types 齐) → typed 元数据列全落
 *  - 缺 linkText/linkType/types 行 → null / 空数组 (vendor 缺字段容忍)
 * ⚠️ `date` `+08:00` → `lixDateOnly` slice(0,10) 正确无 off-by-one (2024-12-31 不退到 12-30, 异于 042 营收 UTC-Z)。
 */
const DEFAULT_ANNOUNCEMENTS: unknown[] = [
  {
    date: '2016-07-29T00:00:00+08:00',
    linkUrl: 'https://mock.hkex/2016/0729/a.pdf',
    linkText: '年度报告',
    linkType: 'PDF',
    types: ['fs'],
  },
  {
    date: '2024-12-31T00:00:00+08:00',
    linkUrl: 'https://mock.hkex/2024/1231/b.pdf',
    linkText: '翌日披露报表',
    linkType: 'PDF',
    types: ['ndd_r', 'srp'],
  },
  {
    // 同 date (2024-12-31) 不同 linkUrl → NK 两行都落 (不折叠丢真行)。
    date: '2024-12-31T00:00:00+08:00',
    linkUrl: 'https://mock.hkex/2024/1231/c.pdf',
    linkText: '股份购回报告',
    linkType: 'PDF',
    types: ['mr'],
  },
  {
    // 缺 linkText/linkType/types → null / 空数组 (vendor 缺字段容忍)。
    date: '2020-06-15T00:00:00+08:00',
    linkUrl: 'https://mock.hkex/2020/0615/d.pdf',
  },
];

// 043 T009 US2 公告集成 IT (Testcontainers PG, 真 LixingerAnnouncementAdapter + fake VendorHttpClient
// 埋原始 announcement fixture): 走全管道 (adapter 解析 date +08:00 lixDateOnly / types 数组 / 缺字段 null →
// executor mode-based createMany → 真 PG)。验 announcement hk backfill 多 date 元数据行落库 (typed 列齐 +
// types[]) + 连跑幂等 + 请求单数 stockCode+range + from=asOf−10yr (seed historyDepth 驱动, backfill 不超
// 10yr 硬上限) + date +08:00 lixDateOnly + (instrumentId,date,linkUrl) 幂等 (同 URL 折叠 / 同 date 不同
// linkUrl 各成行保留) + types 数组保真 + 缺 types 空数组 / 缺 linkText/linkType null + 空返回零行不崩 +
// marketScope={hk} 纳 hk 排除 cn + 单请求无分页 (per-stock 恰 1 rangeCall)。用真 adapter (非扩共享
// MockMarketDataAdapter, 后者 hk=no-data 护 seam) 端到端校真解析+落库。覆盖 state_branch: 公告文本流区间回填 /
// 公告超大表只存元数据 / 公告 linkUrl 天然唯一 NK / 公告无分页单请求 / 公告 ≤10yr 硬上限 403 / 公告 date 为
// +08:00 / 全部单数 stockCode+range 契约(announcement) / vendor 缺字段容忍(announcement)。
describe('043 T009 announcement 公告 (Testcontainers PG, 真 adapter + fake http)', () => {
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
    await prisma.announcement.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T002 migration seed 已把 announcement marketScope={hk} / historyDepth=3650; 显式复位保各例独立。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: 'announcement' },
      data: { marketScope: ['hk'], historyDepth: 3650 },
    });
  });

  /**
   * test-local fake VendorHttpClient: 记 calls (验请求走单数 stockCode + range startDate/endDate);
   * served 集内 stockCode 返给定 announcement rows (缺省多 date + 同 date 多 linkUrl fixture), 集外 → 空
   * data (无公告标的)。喂真 adapter 解析全管道 (date +08:00 lixDateOnly / types 数组 / 缺字段 null)。
   */
  class HkAnnouncementHttp {
    readonly calls: {
      stockCode: string;
      hasStartDate: boolean;
      hasEndDate: boolean;
      startDate?: string;
      endDate?: string;
      isArrayStockCodes: boolean;
    }[] = [];
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly rows: unknown[] = DEFAULT_ANNOUNCEMENTS,
    ) {}
    async request<T>(req: VendorRequest): Promise<T> {
      const body = JSON.parse(req.body ?? '{}') as {
        stockCode?: string;
        stockCodes?: unknown;
        startDate?: string;
        endDate?: string;
      };
      this.calls.push({
        stockCode: String(body.stockCode),
        hasStartDate: body.startDate !== undefined,
        hasEndDate: body.endDate !== undefined,
        startDate: body.startDate,
        endDate: body.endDate,
        isArrayStockCodes: body.stockCodes !== undefined,
      });
      const data = this.served.has(String(body.stockCode)) ? this.rows : [];
      return { code: 1, message: 'success', data } as T;
    }
  }

  function makeAdapter(http: HkAnnouncementHttp): AnnouncementPort {
    return new LixingerAnnouncementAdapter(http as unknown as VendorHttpClient, TOKEN, BASE);
  }

  function buildRegistry(announcement: AnnouncementPort): DimensionExecutorRegistry {
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
      undefined, // industryClassification → 默认 null-object
      announcement, // announcement (尾部)
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

  // ── ① backfill 区间回填: 多 date 元数据行 + typed 列齐 (linkUrl/linkText/linkType/types[]) + 单数 stockCode+range + date +08:00 + 单请求无分页 ──
  it('① announcement hk backfill → 多 date 元数据行落库 (typed 列齐 + types[]) + 单数 stockCode+range + date +08:00 lixDateOnly + 单请求无分页', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const http = new HkAnnouncementHttp(new Set(['00700']));
    const registry = buildRegistry(makeAdapter(http));

    const { stats } = await registry.execute('announcement', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    // 单请求无分页 (per-stock 恰 1 rangeCall) + 单数 stockCode + range startDate/endDate (非数组 stockCodes)。
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].stockCode).toBe('00700');
    expect(http.calls[0].isArrayStockCodes).toBe(false);
    expect(http.calls[0].hasStartDate).toBe(true);
    expect(http.calls[0].hasEndDate).toBe(true);
    expect(Boolean(http.calls[0].startDate! < http.calls[0].endDate!)).toBe(true);

    const rows = await prisma.announcement.findMany({
      where: { instrumentId: instId },
      orderBy: [{ date: 'asc' }, { linkUrl: 'asc' }],
    });
    // 4 行落库 (2016 / 2020 / 2024×2 同 date 不同 linkUrl)。
    expect(rows).toHaveLength(4);
    // date +08:00 → lixDateOnly slice 正确无 off-by-one (2024-12-31 保持不退到 12-30)。
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      '2016-07-29',
      '2020-06-15',
      '2024-12-31',
      '2024-12-31',
    ]);
    // typed 元数据列齐 (2016 数据行): linkUrl/linkText/linkType/types[] (只存元数据无 PDF 正文列)。
    const y2016 = rows.find((r) => r.linkUrl === 'https://mock.hkex/2016/0729/a.pdf')!;
    expect(y2016.linkText).toBe('年度报告');
    expect(y2016.linkType).toBe('PDF');
    expect(y2016.types).toEqual(['fs']); // text[] 数组保真

    const run = await prisma.syncRun.findFirstOrThrow({ where: { syncType: 'sync:announcement' } });
    expect(run.status).toBe('success');
  });

  // ── ② from=asOf−10yr: 文本流可回填历史 + backfill 不超 ≤10yr 硬上限 (seed historyDepth=3650 驱动) ──
  it('② announcement backfill from=asOf−historyDepth(3650, ~10yr) — 可回填历史 + 不超 ≤10yr 硬上限 (>10yr → vendor 403)', async () => {
    await seedInst('hk', '00700', '腾讯控股');
    const http = new HkAnnouncementHttp(new Set(['00700']));
    await buildRegistry(makeAdapter(http)).execute('announcement', backfillInput);

    const c = http.calls[0];
    // 线上实际发出的是**归一后**的窗口: 本端点 endDate 右开 → adapter +1 天 (见 adapter 内联注释)。
    // 端口语义仍是 to=asOf 的右闭区间, 这里断言的是 wire 形态。
    expect(c.endDate).toBe('2026-06-04'); // = AS_OF + 1
    const gapDays =
      (new Date(c.endDate!).getTime() - new Date(c.startDate!).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3651); // from = asOf − seed historyDepth(3650), 右开 +1
    // ⚠️ ≤10yr 硬上限 (>10yr → vendor 403) = 3652.5 天: 右开归一吃掉 1 天余量 (2.5 → 1.5 天),
    // 仍在限内。若日后把 historyDepth 提到 3652 会**撞 403** —— 这条断言就是那道闸。
    expect(gapDays).toBeLessThan(3652.5);
  });

  // ── ③ linkUrl 天然唯一 NK: 同 date 不同 linkUrl 各成行保留 / 同 linkUrl 重同步折叠幂等 ──
  it('③ (instrumentId,date,linkUrl) 幂等: 同 date 不同 linkUrl 各成行保留 + 连跑同 linkUrl 折叠不翻倍', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const registry = buildRegistry(makeAdapter(new HkAnnouncementHttp(new Set(['00700']))));

    await registry.execute('announcement', backfillInput);
    // 同 date (2024-12-31) 不同 linkUrl → 两行各保留 (NK linkUrl 判别, 不折叠)。
    const sameDate = await prisma.announcement.findMany({
      where: { instrumentId: instId, date: new Date('2024-12-31T00:00:00Z') },
      orderBy: { linkUrl: 'asc' },
    });
    expect(sameDate).toHaveLength(2);
    expect(sameDate.map((r) => r.linkUrl)).toEqual([
      'https://mock.hkex/2024/1231/b.pdf',
      'https://mock.hkex/2024/1231/c.pdf',
    ]);

    // 连跑第二次 → 同 (instrumentId,date,linkUrl) skipDuplicates 折叠幂等 (不翻倍)。
    await buildRegistry(makeAdapter(new HkAnnouncementHttp(new Set(['00700'])))).execute(
      'announcement',
      backfillInput,
    );
    expect(await prisma.announcement.count({ where: { instrumentId: instId } })).toBe(4);
  });

  // ── ④ vendor 缺字段容忍: 缺 linkText/linkType → null; 缺/空 types → 空数组 [] ──
  it('④ 缺字段容忍: 缺 linkText/linkType → null, 缺 types → 空数组 [] (不崩)', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    await buildRegistry(makeAdapter(new HkAnnouncementHttp(new Set(['00700'])))).execute(
      'announcement',
      backfillInput,
    );
    const missing = await prisma.announcement.findFirstOrThrow({
      where: { instrumentId: instId, linkUrl: 'https://mock.hkex/2020/0615/d.pdf' },
    });
    expect(missing.linkText).toBeNull();
    expect(missing.linkType).toBeNull();
    expect(missing.types).toEqual([]); // 缺 types → 空数组 (非 null)
  });

  // ── ⑤ 空返回零行不崩: 无公告标的 vendor 返 [] → 零落库、ok 非 failed、不阻塞其余标的 (per-stock 单 symbol) ──
  it('⑤ 无公告标的返 [] → 不写库、ok 非 failed、不阻塞其余标的 (per-stock 单 symbol)', async () => {
    const withAnn = await seedInst('hk', '00700', '腾讯控股'); // 有公告 (served)
    const noAnn = await seedInst('hk', '08001', '和记电讯香港'); // 无公告 (not served)
    const http = new HkAnnouncementHttp(new Set(['00700']));
    const { stats } = await buildRegistry(makeAdapter(http)).execute('announcement', backfillInput);

    // 两标的都 scanned+ok (08001 空返回不计 failed, 不阻塞 00700)。
    expect(stats).toMatchObject({ scanned: 2, ok: 2, failed: 0 });
    // per-stock 单 symbol: 2 标的 → 2 独立请求, 各单数 stockCode (非批量)。
    expect(http.calls).toHaveLength(2);
    expect(http.calls.map((c) => c.stockCode).sort()).toEqual(['00700', '08001']);
    expect(await prisma.announcement.count({ where: { instrumentId: withAnn } })).toBe(4);
    expect(await prisma.announcement.count({ where: { instrumentId: noAnn } })).toBe(0);
  });

  // ── ⑥ marketScope={hk}: 纳 hk 排除 cn (2 维度 marketScope 纳入) ──
  it('⑥ marketScope={hk} → 纳 hk 排除 cn (cn 标的不进工作集、零请求、零落库)', async () => {
    const hkId = await seedInst('hk', '00700', '腾讯控股');
    const cnId = await seedInst('cn', '600519', '贵州茅台');
    // 即便 served 含 cn stockCode, marketScope={hk} 也不请求 cn。
    const http = new HkAnnouncementHttp(new Set(['00700', '600519']));
    const { stats } = await buildRegistry(makeAdapter(http)).execute('announcement', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(http.calls.map((c) => c.stockCode)).toEqual(['00700']); // 仅 hk 请求
    expect(await prisma.announcement.count({ where: { instrumentId: hkId } })).toBe(4);
    expect(await prisma.announcement.count({ where: { instrumentId: cnId } })).toBe(0);
  });
});
