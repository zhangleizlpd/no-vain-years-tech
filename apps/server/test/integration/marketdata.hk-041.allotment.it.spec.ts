import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import type { AllotmentPort } from '../../src/marketdata/allotment.port';
import type { AllotmentDto, AllotmentRangeQuery } from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';
// backfill 不传 backfillHistoryDays → from 由 seed historyDepth(3650, ~10yr) 驱动 (事件流可回填历史)。
const backfillInput = { mode: 'backfill' as const, asOf: AS_OF, now: NOW };

// 多年配股事件 fixture (跨年, date 升序; payload 整存 vendor 原始行)。**合成占位样本** (字段 schema 未知,
// 港股配股极罕见零样本 → probe 全 0 行; 首个真实样本待 T018 真调二次确认字段)。
// 类型断言而非补字段: 占位样本蓄意只带 date+payload (真实字段待 T018 真调校真), DTO 后来收紧的
// exDate/allotmentRatio/allotmentPrice/currency 在本套件的消费路径 (事件流 date 排序 + payload 整存) 用不到。
const MULTI_YEAR_ROWS = [
  { date: '2016-03-10', payload: { date: '2016-03-10', ratio: '1:2', subscriptionPrice: '5.00' } },
  {
    date: '2020-05-20',
    payload: {
      date: '2020-05-20',
      ratio: '1:5',
      subscriptionPrice: '10.50',
      someVendorField: 'rights',
    },
  },
] as unknown as AllotmentDto[];

// 041 T015 US4 配股事件集成 IT (Testcontainers PG, mock hk: 1 标的有配股 fixture + 余标的空):
// allotment hk backfill 经 executor 区间模式落 (instrumentId,date) payload 行 (字段 schema 未知零样本整存) +
// **多数标的零行、管道收敛不崩不阻塞** (港股配股极罕见 US4/SC-004 核心) + (instrumentId,date) 幂等 (连跑不翻倍) +
// 请求单数 stockCode + range (from<to) + marketScope={hk} 纳 hk 排除 cn。用 test-local mock hk adapter
// (非扩共享 MockMarketDataAdapter, 后者 hk=no-data 护 seam); 落库经真 PG。覆盖 state_branch: 配股罕见零样本 /
// 全部单数 stockCode+range 契约(allotment)。
describe('041 T015 allotment 配股事件 (Testcontainers PG, mock hk 罕见零样本)', () => {
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
    await prisma.allotmentEvent.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T002 migration seed 已把 allotment marketScope={hk} / historyDepth=3650; 显式复位保各例独立。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: 'allotment' },
      data: { marketScope: ['hk'], historyDepth: 3650 },
    });
  });

  /**
   * test-local hk allotment adapter: 记 rangeCalls (验请求走区间 + per-stock 单 symbol);
   * served 集内标的返给定 rows (缺省多年跨年配股事件), 集外 → [] (**无配股历史标的, 港股绝大多数**)。
   */
  class HkAllotmentMock implements AllotmentPort {
    readonly rangeCalls: AllotmentRangeQuery[] = [];
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly rows: AllotmentDto[] = MULTI_YEAR_ROWS,
    ) {}
    async getAllotmentRange(query: AllotmentRangeQuery): Promise<AllotmentDto[]> {
      this.rangeCalls.push(query);
      if (!this.served.has(query.symbol)) return [];
      return this.rows;
    }
  }

  function buildRegistry(opts: { allotment?: AllotmentPort } = {}): DimensionExecutorRegistry {
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
      opts.allotment ?? mock, // allotment (尾部)
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

  // ── ① allotment hk 区间回填: 命中标的落 payload 行 + 请求单数 stockCode + range (from<to) ──
  it('① allotment hk backfill → allotment_event (instrumentId,date) 落 payload 行 (整存) + 请求单数 stockCode + range', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const allotment = new HkAllotmentMock(new Set(['hk:00700']));
    const registry = buildRegistry({ allotment });

    const { stats } = await registry.execute('allotment', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    // 请求走区间 (from<to) + per-stock 单 symbol (executor 层「单数 stockCode」契约)。
    expect(allotment.rangeCalls).toHaveLength(1);
    const q = allotment.rangeCalls[0];
    expect(q.symbol).toBe('hk:00700');
    expect(Boolean(q.from && q.to && q.from < q.to)).toBe(true);
    expect(q.to).toBe(AS_OF); // to = asOf
    // from = asOf − seed historyDepth (3650, ~10yr) → 事件流可回填历史。
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3650);

    const rows = await prisma.allotmentEvent.findMany({
      where: { instrumentId: instId },
      orderBy: { date: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      '2016-03-10',
      '2020-05-20',
    ]);
    // payload 整存 vendor 原始行无损 (字段 schema 未知零样本, round-trip)。
    expect(rows[1].payload).toEqual({
      date: '2020-05-20',
      ratio: '1:5',
      subscriptionPrice: '10.50',
      someVendorField: 'rights',
    });

    const run = await prisma.syncRun.findFirstOrThrow({ where: { syncType: 'sync:allotment' } });
    expect(run.status).toBe('success');
  });

  // ── ② 港股极罕见零样本: 多数标的零行、管道收敛不崩不阻塞 (1 有配股 + 余标的空) ──
  it('② 多数标的零行: 无配股历史标的返 [] → 不写库、ok 非 failed、不阻塞命中标的 (US4/SC-004 零样本核心)', async () => {
    const withHist = await seedInst('hk', '00700', '腾讯控股'); // 有配股史 (served, 罕见命中)
    const noHist1 = await seedInst('hk', '08001', '和记电讯香港'); // 无配股史 (港股绝大多数)
    const noHist2 = await seedInst('hk', '00939', '建设银行'); // 无配股史
    const allotment = new HkAllotmentMock(new Set(['hk:00700']));
    const registry = buildRegistry({ allotment });

    const { stats } = await registry.execute('allotment', backfillInput);

    // 三标的都 scanned+ok (零样本标的空返回不计 failed, 不阻塞命中标的 00700)。
    expect(stats).toMatchObject({ scanned: 3, ok: 3, failed: 0 });
    // per-stock 单 symbol: 3 标的 → 3 独立 rangeCall, 各单 symbol (非批量)。
    expect(allotment.rangeCalls).toHaveLength(3);
    expect(allotment.rangeCalls.map((c) => c.symbol).sort()).toEqual([
      'hk:00700',
      'hk:00939',
      'hk:08001',
    ]);
    // 命中标的落库; 多数标的零行 (管道收敛)。
    expect(await prisma.allotmentEvent.count({ where: { instrumentId: withHist } })).toBe(2);
    expect(await prisma.allotmentEvent.count({ where: { instrumentId: noHist1 } })).toBe(0);
    expect(await prisma.allotmentEvent.count({ where: { instrumentId: noHist2 } })).toBe(0);
  });

  // ── ③ 幂等: backfill 连跑两次 → createMany skipDuplicates 不翻倍 (自然键 instrumentId,date) ──
  it('③ 幂等: allotment backfill 连跑两次 → 自然键 (instrumentId,date) 不翻倍', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const allotment = new HkAllotmentMock(new Set(['hk:00700']));
    const registry = buildRegistry({ allotment });

    await registry.execute('allotment', backfillInput);
    await registry.execute('allotment', backfillInput);

    expect(await prisma.allotmentEvent.count({ where: { instrumentId: instId } })).toBe(2);
  });

  // ── ④ marketScope={hk}: 纳 hk 排除 cn (4 维度 marketScope 纳入) ──
  it('④ marketScope={hk} → 纳 hk 排除 cn (cn 标的不进工作集、零 rangeCall、零落库)', async () => {
    const hkId = await seedInst('hk', '00700', '腾讯控股');
    const cnId = await seedInst('cn', '600519', '贵州茅台');
    const allotment = new HkAllotmentMock(new Set(['hk:00700', 'cn:600519']));
    const registry = buildRegistry({ allotment });

    const { stats } = await registry.execute('allotment', backfillInput);

    // marketScope={hk} → 仅 hk 进工作集; cn 被排除 (即便 served 也不请求)。
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(allotment.rangeCalls.map((c) => c.symbol)).toEqual(['hk:00700']);
    expect(await prisma.allotmentEvent.count({ where: { instrumentId: hkId } })).toBe(2);
    expect(await prisma.allotmentEvent.count({ where: { instrumentId: cnId } })).toBe(0);
  });
});
