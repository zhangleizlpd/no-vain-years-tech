import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import type { ShareholderSnapshotPort } from '../../src/marketdata/shareholder-snapshot.port';
import type {
  ShareholderSnapshotDto,
  ShareholderSnapshotRangeQuery,
} from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';
// backfill 不传 backfillHistoryDays → from 由 seed historyDepth(3650, ~10yr) 驱动 (报告期可回填历史)。
const backfillInput = { mode: 'backfill' as const, asOf: AS_OF, now: NOW };

// **SERIES 多报告期** 股东名册 fixture (跨年 3 个不同 date, date 升序; 嵌套 L/S/P payload)。覆盖三态:
//  ① L+S 两项 (嵌套 L/S 二维保真核心); ② L+第三类 P (HK SDI lending-pool, 不丢第三类); ③ 缺字段
//  (numOfSharesInterestedList/percentageOfIssuedVotingShares 整缺 → payload 存 null 不崩)。
// **非覆盖式快照** (probe verified SERIES): 3 个不同 date 行都落 (报告期×股东序列, date 进 NK 可回填)。
const SERIES_ROWS: ShareholderSnapshotDto[] = [
  {
    // ① 报告期 A: L 和 S 两项 (嵌套 L/S 二维保真核心)。
    date: '2016-06-15',
    shareholderName: 'JPMorgan Chase & Co.',
    contentHash: 'ss-2016-jpm',
    payload: {
      numOfSharesInterestedList: [
        { value: 500000000, sharesType: 'L' },
        { value: 20000000, sharesType: 'S' },
      ],
      percentageOfIssuedVotingShares: [
        { value: 0.05, sharesType: 'L' },
        { value: 0.002, sharesType: 'S' },
      ],
    },
  },
  {
    // ② 报告期 B: L + 第三类 P (嵌套无损, 不假定 L/S 二元 → 保留 P)。
    date: '2020-06-12',
    shareholderName: '马化腾',
    contentHash: 'ss-2020-pony',
    payload: {
      numOfSharesInterestedList: [
        { value: 804859700, sharesType: 'L' },
        { value: 10000000, sharesType: 'P' },
      ],
      percentageOfIssuedVotingShares: [
        { value: 0.0842, sharesType: 'L' },
        { value: 0.001, sharesType: 'P' },
      ],
    },
  },
  {
    // ③ 报告期 C: 缺字段 (整个 numOfSharesInterestedList/percentageOfIssuedVotingShares 缺) → payload 存 null。
    date: '2024-12-30',
    shareholderName: 'Naspers Limited',
    contentHash: 'ss-2024-naspers',
    payload: {
      numOfSharesInterestedList: null,
      percentageOfIssuedVotingShares: null,
    },
  },
];

// 042 T009 US2 最新股东集成 IT (Testcontainers PG, test-local mock hk 埋含 L/S/P 嵌套 + 多 date fixture):
// shareholder_snapshot hk backfill 经 executor 区间模式落 (instrumentId,date,shareholderName,contentHash)
// 报告期股东行 + **嵌套 L/S/P 持股数量与占比完整保留不丢** (payload round-trip) + 缺型存 null 不崩 +
// **SERIES 多 date 行可回填** + (instrumentId,date,shareholderName,contentHash) 幂等 (同内容折叠、实质差异
// 保留) + 空返回零行 + marketScope={hk} 纳 hk 排除 cn。用 test-local mock hk adapter (非扩共享
// MockMarketDataAdapter, 后者 hk=no-data 护 seam); 落库经真 PG。覆盖 state_branch: 最新股东嵌套 L/S(payload) /
// 最新股东=报告期×股东序列(SERIES 多 date) / 全部单数 stockCode+range 契约(shareholder) / 嵌套 dataList 缺字段容忍(缺 L/S/P)。
describe('042 T009 shareholder_snapshot 最新股东 (Testcontainers PG, mock hk 含 L/S/P 嵌套 + 多 date)', () => {
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
    await prisma.shareholderSnapshot.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T002 migration seed 已把 shareholder_snapshot marketScope={hk} / historyDepth=3650; 显式复位保各例独立。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: 'shareholder_snapshot' },
      data: { marketScope: ['hk'], historyDepth: 3650 },
    });
  });

  /**
   * test-local hk shareholder-snapshot adapter: 记 rangeCalls (验请求走区间 + per-stock 单 symbol);
   * served 集内标的返给定 rows (缺省 SERIES 多报告期名册), 集外 → [] (无最新股东历史标的)。
   */
  class HkShareholderSnapshotMock implements ShareholderSnapshotPort {
    readonly rangeCalls: ShareholderSnapshotRangeQuery[] = [];
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly rows: ShareholderSnapshotDto[] = SERIES_ROWS,
    ) {}
    async getShareholderSnapshotRange(
      query: ShareholderSnapshotRangeQuery,
    ): Promise<ShareholderSnapshotDto[]> {
      this.rangeCalls.push(query);
      if (!this.served.has(query.symbol)) return [];
      return this.rows;
    }
  }

  function buildRegistry(
    opts: { shareholderSnapshot?: ShareholderSnapshotPort } = {},
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
      opts.shareholderSnapshot ?? mock, // shareholderSnapshot (尾部)
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

  // ── ① shareholder_snapshot hk 区间回填: SERIES 多 date 名册 + 嵌套 L/S/P 保真 (round-trip) + 请求单数 stockCode + range ──
  it('① shareholder_snapshot hk backfill → (instrumentId,date,shareholderName,contentHash) SERIES 多 date + 嵌套 L/S/P payload 完整保留 + 请求单数 stockCode + range', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const shareholderSnapshot = new HkShareholderSnapshotMock(new Set(['hk:00700']));
    const registry = buildRegistry({ shareholderSnapshot });

    const { stats } = await registry.execute('shareholder_snapshot', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    // 请求走区间 (from<to) + per-stock 单 symbol (executor 层「单数 stockCode」契约)。
    expect(shareholderSnapshot.rangeCalls).toHaveLength(1);
    const q = shareholderSnapshot.rangeCalls[0];
    expect(q.symbol).toBe('hk:00700');
    expect(Boolean(q.from && q.to && q.from < q.to)).toBe(true);

    const rows = await prisma.shareholderSnapshot.findMany({
      where: { instrumentId: instId },
      orderBy: { date: 'asc' },
    });
    // SERIES: 3 个不同 date 行都落 (非覆盖式快照, 报告期×股东序列)。
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      '2016-06-15',
      '2020-06-12',
      '2024-12-30',
    ]);
    expect(rows.map((r) => r.shareholderName)).toEqual([
      'JPMorgan Chase & Co.',
      '马化腾',
      'Naspers Limited',
    ]);
    // 嵌套 L/S 持股数量与占比完整保留不丢 (payload round-trip, 首行含 L 和 S 两维数值)。
    const first = rows[0].payload as {
      numOfSharesInterestedList: Array<{ value: number; sharesType: string }>;
      percentageOfIssuedVotingShares: Array<{ value: number; sharesType: string }>;
    };
    expect(first.numOfSharesInterestedList).toEqual([
      { value: 500000000, sharesType: 'L' },
      { value: 20000000, sharesType: 'S' },
    ]);
    expect(first.percentageOfIssuedVotingShares).toEqual([
      { value: 0.05, sharesType: 'L' },
      { value: 0.002, sharesType: 'S' },
    ]);
    // 第三类 P 保真 (次行 = 马化腾 报告期 B, 含 L + P): P 无损保留 (不假定 L/S 二元)。
    const second = rows[1].payload as {
      numOfSharesInterestedList: Array<{ value: number; sharesType: string }>;
    };
    expect(second.numOfSharesInterestedList).toEqual([
      { value: 804859700, sharesType: 'L' },
      { value: 10000000, sharesType: 'P' },
    ]);

    const run = await prisma.syncRun.findFirstOrThrow({
      where: { syncType: 'sync:shareholder_snapshot' },
    });
    expect(run.status).toBe('success');
  });

  // ── ② 缺 L/S/P 存 null 不崩: 整缺字段的行 (payload 存 null) 正常读回 ──
  it('② 缺字段 (numOfSharesInterestedList/percentageOfIssuedVotingShares 整缺) → payload 存 null (round-trip 不崩)', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const shareholderSnapshot = new HkShareholderSnapshotMock(new Set(['hk:00700']));
    const registry = buildRegistry({ shareholderSnapshot });

    await registry.execute('shareholder_snapshot', backfillInput);

    const rows = await prisma.shareholderSnapshot.findMany({
      where: { instrumentId: instId },
      orderBy: { date: 'asc' },
    });
    // 缺字段行 (2024, Naspers): payload 存 null (不崩)。
    const missing = rows[2].payload as {
      numOfSharesInterestedList: unknown;
      percentageOfIssuedVotingShares: unknown;
    };
    expect(missing.numOfSharesInterestedList).toBeNull();
    expect(missing.percentageOfIssuedVotingShares).toBeNull();
  });

  // ── ③ from=asOf−10yr: 报告期可回填历史 (seed historyDepth=3650 驱动, 未传 backfillHistoryDays) ──
  it('③ shareholder_snapshot backfill from=asOf−historyDepth(3650, ~10yr) — seed historyDepth 驱动可回填历史', async () => {
    await seedInst('hk', '00700', '腾讯控股');
    const shareholderSnapshot = new HkShareholderSnapshotMock(new Set(['hk:00700']));
    const registry = buildRegistry({ shareholderSnapshot });

    await registry.execute('shareholder_snapshot', backfillInput);

    const q = shareholderSnapshot.rangeCalls[0];
    expect(q.to).toBe(AS_OF); // to = asOf
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − seed historyDepth (~10yr)
  });

  // ── ④ 幂等 + NK 含 shareholderName: 连跑不翻倍 + 同日多大股东各落一行 (NK instrumentId,date,shareholderName,contentHash) ──
  it('④ 幂等: backfill 连跑两次不翻倍; 同日多大股东各一行 (NK 含 shareholderName 区分)', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    // 同日 (2024-12-30) 两大股东 → NK 含 shareholderName ⇒ 两行 (不因同 (instrumentId,date) 互相 skip)。
    const sameDayRows: ShareholderSnapshotDto[] = [
      {
        date: '2024-12-30',
        shareholderName: 'Naspers Limited',
        contentHash: 'sd-naspers',
        payload: { numOfSharesInterestedList: [{ value: 2215242300, sharesType: 'L' }] },
      },
      {
        date: '2024-12-30',
        shareholderName: 'JPMorgan Chase & Co.',
        contentHash: 'sd-jpm',
        payload: { numOfSharesInterestedList: [{ value: 500000000, sharesType: 'L' }] },
      },
    ];
    const shareholderSnapshot = new HkShareholderSnapshotMock(new Set(['hk:00700']), sameDayRows);
    const registry = buildRegistry({ shareholderSnapshot });

    await registry.execute('shareholder_snapshot', backfillInput);
    await registry.execute('shareholder_snapshot', backfillInput);

    // 同日两大股东各一行 (NK 含 shareholderName), 连跑两次仍 2 行 (skipDuplicates 幂等不翻倍)。
    const rows = await prisma.shareholderSnapshot.findMany({ where: { instrumentId: instId } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.shareholderName).sort()).toEqual([
      'JPMorgan Chase & Co.',
      'Naspers Limited',
    ]);
  });

  // ── ⑤ C1 扩键: 同 (instrumentId,date,shareholderName) 不同 contentHash → 多笔都落; 完全相同 → 折叠 (同内容折叠、实质差异保留) ──
  it('⑤ 同名同日不同 contentHash → 各落行不折叠; 完全相同行 (同 contentHash) → 折叠幂等', async () => {
    const instId = await seedInst('hk', '09988', '阿里巴巴');
    // JPMorgan 09988 2025-06-12 同日两笔: 持股不同 → contentHash 不同 → 各落行; + 第 3 笔真重复 (同 contentHash) → 折叠。
    const multiRows: ShareholderSnapshotDto[] = [
      {
        date: '2025-06-12',
        shareholderName: 'JPMorgan Chase & Co.',
        contentHash: 'jpm-hash-1',
        payload: { numOfSharesInterestedList: [{ value: 900000000, sharesType: 'L' }] },
      },
      {
        date: '2025-06-12',
        shareholderName: 'JPMorgan Chase & Co.',
        contentHash: 'jpm-hash-2', // 持股不同 → 不同 hash (实质差异保留)
        payload: { numOfSharesInterestedList: [{ value: 12000000, sharesType: 'P' }] },
      },
      {
        // 与第 1 笔完全相同 (同 contentHash) → vendor 真重复行 → skipDuplicates 折叠。
        date: '2025-06-12',
        shareholderName: 'JPMorgan Chase & Co.',
        contentHash: 'jpm-hash-1',
        payload: { numOfSharesInterestedList: [{ value: 900000000, sharesType: 'L' }] },
      },
    ];
    const shareholderSnapshot = new HkShareholderSnapshotMock(new Set(['hk:09988']), multiRows);
    const registry = buildRegistry({ shareholderSnapshot });

    await registry.execute('shareholder_snapshot', backfillInput);

    // 2 个不同 contentHash 各落行 (hash-1/2), 第 3 笔真重复 (hash-1) 折叠 → 共 2 行。
    const rows = await prisma.shareholderSnapshot.findMany({
      where: { instrumentId: instId },
      orderBy: { contentHash: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.contentHash)).toEqual(['jpm-hash-1', 'jpm-hash-2']);
    expect(rows.every((r) => r.shareholderName === 'JPMorgan Chase & Co.')).toBe(true);
  });

  // ── ⑥ 空返回零行不崩: 无最新股东历史标的 vendor 返 [] → 零落库、ok 非 failed、不阻塞 ──
  it('⑥ 无最新股东历史标的返 [] → 不写库、ok 非 failed、不阻塞其余标的 (per-stock 单 symbol)', async () => {
    const withHist = await seedInst('hk', '00700', '腾讯控股'); // 有最新股东史 (served)
    const noHist = await seedInst('hk', '08001', '和记电讯香港'); // 无最新股东史 (not served)
    const shareholderSnapshot = new HkShareholderSnapshotMock(new Set(['hk:00700']));
    const registry = buildRegistry({ shareholderSnapshot });

    const { stats } = await registry.execute('shareholder_snapshot', backfillInput);

    // 两标的都 scanned+ok (08001 空返回不计 failed, 不阻塞 00700)。
    expect(stats).toMatchObject({ scanned: 2, ok: 2, failed: 0 });
    // per-stock 单 symbol: 2 标的 → 2 独立 rangeCall, 各单 symbol (非批量)。
    expect(shareholderSnapshot.rangeCalls).toHaveLength(2);
    expect(shareholderSnapshot.rangeCalls.map((c) => c.symbol).sort()).toEqual([
      'hk:00700',
      'hk:08001',
    ]);
    expect(await prisma.shareholderSnapshot.count({ where: { instrumentId: withHist } })).toBe(3);
    expect(await prisma.shareholderSnapshot.count({ where: { instrumentId: noHist } })).toBe(0);
  });

  // ── ⑦ marketScope={hk}: 纳 hk 排除 cn (3 维度 marketScope 纳入) ──
  it('⑦ marketScope={hk} → 纳 hk 排除 cn (cn 标的不进工作集、零 rangeCall、零落库)', async () => {
    const hkId = await seedInst('hk', '00700', '腾讯控股');
    const cnId = await seedInst('cn', '600519', '贵州茅台');
    const shareholderSnapshot = new HkShareholderSnapshotMock(new Set(['hk:00700', 'cn:600519']));
    const registry = buildRegistry({ shareholderSnapshot });

    const { stats } = await registry.execute('shareholder_snapshot', backfillInput);

    // marketScope={hk} → 仅 hk 进工作集; cn 被排除 (即便 served 也不请求)。
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(shareholderSnapshot.rangeCalls.map((c) => c.symbol)).toEqual(['hk:00700']);
    expect(await prisma.shareholderSnapshot.count({ where: { instrumentId: hkId } })).toBe(3);
    expect(await prisma.shareholderSnapshot.count({ where: { instrumentId: cnId } })).toBe(0);
  });
});
