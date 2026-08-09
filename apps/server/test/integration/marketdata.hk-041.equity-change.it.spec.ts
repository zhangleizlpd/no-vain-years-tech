import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import type { EquityChangePort } from '../../src/marketdata/equity-change.port';
import type {
  EquityChangeDto,
  EquityChangeRangeQuery,
} from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';
// backfill 不传 backfillHistoryDays → from 由 seed historyDepth(3650, ~10yr) 驱动 (事件流可回填历史)。
const backfillInput = { mode: 'backfill' as const, asOf: AS_OF, now: NOW };

// 多年股本变动事件 fixture (跨年, date 升序; 扁平列: capitalization/capitalizationH Decimal(24,0),
// changeReason VarChar(无界), declarationDate 可空 Date)。末行 = p3 探查报告实测 hk:00700 结构。
const MULTI_YEAR_ROWS: EquityChangeDto[] = [
  {
    date: '2016-06-15',
    capitalization: '9400000000',
    capitalizationH: '9400000000',
    changeReason: '配股',
    declarationDate: '2016-06-20',
  },
  {
    date: '2020-06-15',
    capitalization: '9500000000',
    capitalizationH: '9500000000',
    changeReason: '定期報告',
    declarationDate: '2020-06-22',
  },
  {
    date: '2024-12-31',
    capitalization: '9224914953',
    capitalizationH: '9224914953',
    changeReason: '定期報告',
    declarationDate: '2025-01-07',
  },
];

// 041 T009 US2 股本变动事件集成 IT (Testcontainers PG, test-local mock hk 埋 rangeCalls):
// equity_change hk backfill 经 executor 区间模式落 (instrumentId,date) 多年事件行 (扁平列齐) + 连跑幂等
// (createMany skipDuplicates 自然键) + 请求单数 stockCode + range (from<to) + 空返回零行不崩 +
// marketScope={hk} 纳 hk 排除 cn。用 test-local mock hk adapter (非扩共享 MockMarketDataAdapter,
// 后者 hk=no-data 护 seam); 落库经真 PG。覆盖 state_branch: 股本变动回填 / 全部单数 stockCode+range
// 契约(equity) / 事件流可回填历史(equity)。
describe('041 T009 equity_change 股本变动事件 (Testcontainers PG, mock hk)', () => {
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
    await prisma.equityChange.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T002 migration seed 已把 equity_change marketScope={hk} / historyDepth=3650; 显式复位保各例独立。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: 'equity_change' },
      data: { marketScope: ['hk'], historyDepth: 3650 },
    });
  });

  /**
   * test-local hk equity-change adapter: 记 rangeCalls (验请求走区间 + per-stock 单 symbol);
   * served 集内标的返给定 rows (缺省多年跨年事件), 集外 → [] (无股本变动历史标的)。
   */
  class HkEquityChangeMock implements EquityChangePort {
    readonly rangeCalls: EquityChangeRangeQuery[] = [];
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly rows: EquityChangeDto[] = MULTI_YEAR_ROWS,
    ) {}
    async getEquityChangeRange(query: EquityChangeRangeQuery): Promise<EquityChangeDto[]> {
      this.rangeCalls.push(query);
      if (!this.served.has(query.symbol)) return [];
      return this.rows;
    }
  }

  function buildRegistry(
    opts: { equityChange?: EquityChangePort } = {},
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
      opts.equityChange ?? mock, // equityChange (尾部)
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

  // ── ① equity_change hk 区间回填: 多年事件 + 扁平列齐 + 请求单数 stockCode + range (from<to) ──
  it('① equity_change hk backfill → equity_change (instrumentId,date) 多年事件扁平列齐 + 请求单数 stockCode + range', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const equityChange = new HkEquityChangeMock(new Set(['hk:00700']));
    const registry = buildRegistry({ equityChange });

    const { stats } = await registry.execute('equity_change', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    // 请求走区间 (from<to) + per-stock 单 symbol (executor 层「单数 stockCode」契约)。
    expect(equityChange.rangeCalls).toHaveLength(1);
    const q = equityChange.rangeCalls[0];
    expect(q.symbol).toBe('hk:00700');
    expect(Boolean(q.from && q.to && q.from < q.to)).toBe(true);

    const rows = await prisma.equityChange.findMany({
      where: { instrumentId: instId },
      orderBy: { date: 'asc' },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      '2016-06-15',
      '2020-06-15',
      '2024-12-31',
    ]);
    // 扁平列齐 (末行 2024-12-31): capitalization/capitalizationH → Decimal(24,0), changeReason → 文本,
    // declarationDate → 可空 Date。
    const last = rows[2];
    expect(Number(last.capitalization)).toBe(9224914953); // Decimal(24,0)
    expect(Number(last.capitalizationH)).toBe(9224914953);
    expect(last.changeReason).toBe('定期報告');
    expect(last.declarationDate?.toISOString().slice(0, 10)).toBe('2025-01-07');

    const run = await prisma.syncRun.findFirstOrThrow({
      where: { syncType: 'sync:equity_change' },
    });
    expect(run.status).toBe('success');
  });

  // ── ② from=asOf−10yr: 事件流可回填历史 (seed historyDepth=3650 驱动, 未传 backfillHistoryDays) ──
  it('② equity_change backfill from=asOf−historyDepth(3650, ~10yr) — seed historyDepth 驱动可回填历史', async () => {
    await seedInst('hk', '00700', '腾讯控股');
    const equityChange = new HkEquityChangeMock(new Set(['hk:00700']));
    const registry = buildRegistry({ equityChange });

    await registry.execute('equity_change', backfillInput);

    const q = equityChange.rangeCalls[0];
    expect(q.to).toBe(AS_OF); // to = asOf
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − seed historyDepth (~10yr)
  });

  // ── ③ 幂等: backfill 连跑两次 → createMany skipDuplicates 不翻倍 (自然键 instrumentId,date) ──
  it('③ 幂等: equity_change backfill 连跑两次 → 自然键 (instrumentId,date) 不翻倍', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const equityChange = new HkEquityChangeMock(new Set(['hk:00700']));
    const registry = buildRegistry({ equityChange });

    await registry.execute('equity_change', backfillInput);
    await registry.execute('equity_change', backfillInput);

    expect(await prisma.equityChange.count({ where: { instrumentId: instId } })).toBe(3);
  });

  // ── ④ 空返回零行不崩: 无股本变动历史标的 vendor 返 [] → 零落库、ok 非 failed、不阻塞 ──
  it('④ 无股本变动历史标的返 [] → 不写库、ok 非 failed、不阻塞其余标的 (per-stock 单 symbol)', async () => {
    const withHist = await seedInst('hk', '00700', '腾讯控股'); // 有股本变动史 (served)
    const noHist = await seedInst('hk', '08001', '和记电讯香港'); // 无股本变动史 (not served)
    const equityChange = new HkEquityChangeMock(new Set(['hk:00700']));
    const registry = buildRegistry({ equityChange });

    const { stats } = await registry.execute('equity_change', backfillInput);

    // 两标的都 scanned+ok (08001 空返回不计 failed, 不阻塞 00700)。
    expect(stats).toMatchObject({ scanned: 2, ok: 2, failed: 0 });
    // per-stock 单 symbol: 2 标的 → 2 独立 rangeCall, 各单 symbol (非批量)。
    expect(equityChange.rangeCalls).toHaveLength(2);
    expect(equityChange.rangeCalls.map((c) => c.symbol).sort()).toEqual(['hk:00700', 'hk:08001']);
    expect(await prisma.equityChange.count({ where: { instrumentId: withHist } })).toBe(3);
    expect(await prisma.equityChange.count({ where: { instrumentId: noHist } })).toBe(0);
  });

  // ── ⑤ marketScope={hk}: 纳 hk 排除 cn (4 维度 marketScope 纳入) ──
  it('⑤ marketScope={hk} → 纳 hk 排除 cn (cn 标的不进工作集、零 rangeCall、零落库)', async () => {
    const hkId = await seedInst('hk', '00700', '腾讯控股');
    const cnId = await seedInst('cn', '600519', '贵州茅台');
    const equityChange = new HkEquityChangeMock(new Set(['hk:00700', 'cn:600519']));
    const registry = buildRegistry({ equityChange });

    const { stats } = await registry.execute('equity_change', backfillInput);

    // marketScope={hk} → 仅 hk 进工作集; cn 被排除 (即便 served 也不请求)。
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(equityChange.rangeCalls.map((c) => c.symbol)).toEqual(['hk:00700']);
    expect(await prisma.equityChange.count({ where: { instrumentId: hkId } })).toBe(3);
    expect(await prisma.equityChange.count({ where: { instrumentId: cnId } })).toBe(0);
  });
});
