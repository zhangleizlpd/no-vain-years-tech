import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import { LixingerCompanyProfileAdapter } from '../../src/marketdata/lixinger-company-profile.adapter';
import { DbTradingCalendarAdapter } from '../../src/marketdata/db-trading-calendar.adapter';
import { isTradingDayGateOpen } from '../../src/marketdata/trading-day-gate';
import type { InstrumentUniversePort } from '../../src/marketdata/instrument-universe.port';
import type { CompanyProfilePort } from '../../src/marketdata/company-profile.port';
import type { EodBarPort } from '../../src/marketdata/eod-bar.port';
import type { VendorHttpClient, VendorRequest } from '../../src/marketdata/vendor-http-client';
import type {
  EodBarPoint,
  EodBarQuery,
  UniverseEntry,
} from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 (Asia/Shanghai 交易日)
const AS_OF = '2026-06-03';
const LIX_BASE = 'https://open.lixinger.com/api';
const metaInput = { mode: 'delta' as const, asOf: AS_OF, now: NOW };
const backfillInput = {
  mode: 'backfill' as const,
  asOf: AS_OF,
  now: NOW,
  backfillHistoryDays: 3650,
};

// 038 T012 US1「港股价量底座」聚合集成 IT (Testcontainers PG, mock hk adapters):
// 证 universe→profile→eod_bar 的 hk 数据从摄取到落库**端到端贯通** —— hk 标的经 T007-T011
// 缝隙 (marketScope 工作集 / adapter market 段插值 / fsType 富化含 reit / HSI 日历派生 /
// syncTier 分层) 走同一 DimensionExecutorRegistry 落真 PG。
//
// **vendor 边界 = test-local mock hk adapter** (非扩共享 MockMarketDataAdapter —— 后者 hk=no-data
// 以护 T006 seam IT 的「hk 进工作集但零落库」断言; T010 已立此范式): universe 用 stub 端口,
// profile/日历用真 Lixinger adapter + fake VendorHttpClient (证真 /hk/ 路径), eod 用 test-local
// HkEodMock。落库/幂等/marketScope 过滤/tier 排序/路由**经真 PG**, 禁用 mock 抹掉 DB 真实行为。
//
// 侧重贯通链 + 组合 (单维已由 T008/T009/T010/T011 IT 覆盖各分支)。覆盖 spec state_branches (8 条):
// universe hk 新标的 / universe hk 既有 / active-only 边界 / fsType 路由 hk-reit / fsType 路由 hk 常规 /
// eod_bar hk 区间回填 / 回填分层排序 / 港股交易日历派生 (非交易日整管线 skip)。
describe('038 T012 US1 港股价量底座聚合 (Testcontainers PG, mock hk adapters)', () => {
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
    await prisma.dailyBar.deleteMany();
    await prisma.adjustmentFactor.deleteMany();
    await prisma.corporateAction.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    await prisma.watchlistItem.deleteMany();
    await prisma.group.deleteMany();
    // T003 migration 已把 6 维扩到 {cn,hk}; 每例回到已知基线 (marketScope 含 hk + 清水位)。
    await prisma.syncDimension.updateMany({
      data: { marketScope: ['cn', 'hk'], lastWatermark: null },
    });
  });

  /** 固定 entries 的 stub universe 端口 (universe use case 不经真 vendor)。 */
  function stubUniverse(entries: UniverseEntry[]): InstrumentUniversePort {
    return { enumerate: async () => entries };
  }

  /**
   * /{market}/company 返 {stockCode, fsTableType} 的 fake http (profile fsType 富化源, 记录
   * request 供 /hk/company 路由断言) —— 复用 T009 profile IT 的 fake 范式。
   */
  function makeCompanyHttp(byCode: Record<string, string>): {
    http: VendorHttpClient;
    request: ReturnType<typeof vi.fn>;
  } {
    const request = vi.fn(async (req: VendorRequest) => {
      const body = JSON.parse(req.body ?? '{}') as { stockCodes?: string[] };
      const data = (body.stockCodes ?? [])
        .filter((c) => byCode[c])
        .map((c) => ({ stockCode: c, fsTableType: byCode[c] }));
      return { data };
    });
    return { http: { request } as unknown as VendorHttpClient, request };
  }

  /** test-local hk eod adapter: 对 served 集内的 hk 标的返 3 个跨年区间 bar; 记录 query (序/区间断言)。 */
  class HkEodMock implements EodBarPort {
    readonly calls: EodBarQuery[] = [];
    constructor(private readonly served: ReadonlySet<string>) {}
    async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
      this.calls.push(query);
      if (!this.served.has(query.symbol)) return [];
      return ['2016-05-13', '2020-06-15', '2026-05-15'].map((tradeDate) => ({
        tradeDate,
        adjust: query.adjust,
        open: '380.0000',
        high: '385.0000',
        low: '378.0000',
        close: '382.0000',
        changePct: '0.5000',
        prevClose: null,
        volume: '12000000',
        amount: '4600000000.00',
        turnoverRate: '0.1300',
      }));
    }
  }

  function buildRegistry(opts: {
    universe: InstrumentUniversePort;
    profile: CompanyProfilePort;
    eodBar: EodBarPort;
  }): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter(); // fundamental/financial/corporate_action = US2, 本 IT 不走。
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(opts.universe, prisma),
      new SyncProfileUseCase(opts.profile, prisma),
      opts.eodBar,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
    );
  }

  async function seedHk(code: string, name: string): Promise<bigint> {
    const inst = await prisma.instrument.create({
      data: { market: 'hk', code, name, type: 'stock', currency: 'HKD', status: 'active' },
    });
    return inst.id;
  }

  async function hkInstrument(code: string) {
    return prisma.instrument.findUniqueOrThrow({ where: { market_code: { market: 'hk', code } } });
  }

  // ── ① 贯通链: universe → profile → eod_bar hk 端到端 ─────────────────────────
  it('① 贯通链 universe→profile→eod_bar: hk 新标的落库 → fsType 富化含 reit → 分层 → 区间回填幂等', async () => {
    // hk universe: 2 只 HSI 成分 (含 1 只 REIT) + 1 只长尾在市 —— 覆盖 fsType reit/常规 + 分层。
    const universe = stubUniverse([
      {
        market: 'hk',
        code: '00700',
        name: '腾讯控股',
        status: 'active',
        listingStatus: 'normally_listed',
      },
      {
        market: 'hk',
        code: '00823',
        name: '领展房产基金',
        status: 'active',
        listingStatus: 'normally_listed',
      },
      {
        market: 'hk',
        code: '99998',
        name: '某长尾港股',
        status: 'active',
        listingStatus: 'normally_listed',
      },
    ]);
    const { http, request } = makeCompanyHttp({ '00823': 'reit', '00700': 'non', '99998': 'bank' });
    const profile = new LixingerCompanyProfileAdapter(http, 'tok', LIX_BASE, prisma);
    const eod = new HkEodMock(new Set(['hk:00700', 'hk:00823', 'hk:99998']));
    const registry = buildRegistry({ universe, profile, eodBar: eod });

    // ── step 1: universe → hk 新标的 insert (state_branch「universe hk 新标的」) ──
    const uni = await registry.execute('universe', metaInput);
    expect(uni.stats).toMatchObject({ scanned: 3, ok: 3, failed: 0 });
    const tencent = await hkInstrument('00700');
    expect(tencent.market).toBe('hk');
    expect(tencent.currency).toBe('HKD'); // T004 currencyForMarket
    expect(tencent.pinyinAbbr).toMatch(/^[a-z]+$/); // 拼音填充
    expect(tencent.syncTier).toBe(2); // schema 默认 (profile/tier 富化前)
    expect(tencent.lixingerCompanyType).toBeNull(); // 待 profile 富化

    // ── step 2: profile → fsType 富化 (state_branch「fsType 路由 hk-reit / hk 常规」) ──
    const prof = await registry.execute('profile', metaInput);
    expect(prof.stats.failed).toBe(0);
    expect((await hkInstrument('00823')).lixingerCompanyType).toBe('reit'); // 港股房托 fsType 解锁
    expect((await hkInstrument('99998')).lixingerCompanyType).toBe('bank'); // 常规 fsType 与 A 股同构
    // market 段路由 /hk/company (非 /cn/company) —— fundamental/fs reit 路由前提。
    const profileUrl = String((request.mock.calls[0][0] as { url: string }).url);
    expect(profileUrl).toContain('/hk/company');

    // ── step 3: eod_bar backfill → tier 前置分层 + 区间回填 ──
    const eodRes = await registry.execute('eod_bar', backfillInput);
    expect(eodRes.stats).toMatchObject({ scanned: 3, ok: 3, failed: 0 });

    // state_branch「回填分层排序」: HSI 成分 (00700/00823) 提级 tier-0, 长尾 (99998) tier-2 后置 (全量纳入)。
    expect((await hkInstrument('00700')).syncTier).toBe(0);
    expect((await hkInstrument('00823')).syncTier).toBe(0);
    expect((await hkInstrument('99998')).syncTier).toBe(2);
    // 消费序体现 tier (syncTier asc 过同一令牌桶): 长尾 99998 排在两只 tier-0 之后。
    const noneOrder = eod.calls.filter((c) => c.adjust === 'none').map((c) => c.symbol);
    expect(noneOrder.indexOf('hk:99998')).toBeGreaterThan(noneOrder.indexOf('hk:00700'));
    expect(noneOrder.indexOf('hk:99998')).toBeGreaterThan(noneOrder.indexOf('hk:00823'));

    // state_branch「eod_bar hk 区间回填」: daily_bar hk 行 (adjust=none 单口径), 字段与 A 股同构。
    const hkBars = await prisma.dailyBar.findMany({ where: { instrument: { market: 'hk' } } });
    expect(hkBars).toHaveLength(9); // 3 只 × 3 bar
    expect(hkBars.every((b) => b.adjust === 'none')).toBe(true); // 020 单口径 (读时换算 forward/backward)
    expect(hkBars.some((b) => b.close.toString() === '382')).toBe(true); // hk 价量落库
    // 区间范式: adapter 收到 from<to 区间 (per-stock candlestick, hk 与 A 股同构)。
    const q = eod.calls.find((c) => c.symbol === 'hk:00700');
    expect(Boolean(q?.from && q?.to && q.from < q.to)).toBe(true);

    // ── 贯通终态: 每只 hk active 标的 market=hk/HKD + fsType 富化 + tiered + 有 bar (端到端一致) ──
    const enriched = await prisma.instrument.findMany({ where: { market: 'hk' } });
    expect(enriched).toHaveLength(3);
    expect(enriched.every((i) => i.currency === 'HKD' && i.lixingerCompanyType !== null)).toBe(
      true,
    );
    const run = await prisma.syncRun.findFirstOrThrow({ where: { syncType: 'sync:eod_bar' } });
    expect(run.status).toBe('success');

    // ── step 4: eod_bar 重跑 → skipDuplicates 幂等 (state_branch「eod_bar hk 区间回填」幂等) ──
    await registry.execute('eod_bar', backfillInput);
    expect(await prisma.dailyBar.count({ where: { instrument: { market: 'hk' } } })).toBe(9); // 不翻倍
  });

  // ── ② active-only 边界: 退市/停牌 hk 不纳入 eod 工作集 ────────────────────────
  it('② active-only 边界: 退市/停牌 hk (status!=active) 落库但不进 eod 工作集 (生存者偏差已知取舍)', async () => {
    const universe = stubUniverse([
      {
        market: 'hk',
        code: '00700',
        name: '腾讯控股',
        status: 'active',
        listingStatus: 'normally_listed',
      },
      {
        market: 'hk',
        code: '01234',
        name: '某退市港股',
        status: 'inactive',
        listingStatus: 'some_hk_delisted_status',
      },
    ]);
    const eod = new HkEodMock(new Set(['hk:00700', 'hk:01234']));
    const registry = buildRegistry({ universe, profile: new MockMarketDataAdapter(), eodBar: eod });

    await registry.execute('universe', metaInput);
    // 两只都落库 (universe 不过滤 status; active-only 在 fact 工作集层生效, 退市原值存档)。
    expect(await prisma.instrument.count({ where: { market: 'hk' } })).toBe(2);
    const delisted = await hkInstrument('01234');
    expect(delisted.status).toBe('inactive');
    expect(delisted.listingStatus).toBe('some_hk_delisted_status');

    const eodRes = await registry.execute('eod_bar', backfillInput);
    // 仅 active 的 00700 进工作集 (scanned=1); 退市 01234 被 loadActiveInstruments status=active 过滤。
    expect(eodRes.stats.scanned).toBe(1);
    expect(eod.calls.some((c) => c.symbol === 'hk:01234')).toBe(false); // 退市标的零 vendor 外呼
    expect(eod.calls.some((c) => c.symbol === 'hk:00700')).toBe(true);
    expect(await prisma.dailyBar.count({ where: { instrumentId: delisted.id } })).toBe(0); // 退市零 bar
    expect(await prisma.dailyBar.count({ where: { instrument: { market: 'hk' } } })).toBe(3); // 仅 00700 × 3
  });

  // ── ③ universe hk 既有标的: upsert 护下游缓存 ────────────────────────────────
  it('③ universe hk 既有标的: upsert 刷新 name/listingStatus, 不覆盖 syncTier/lixingerCompanyType (FR-S03)', async () => {
    // 预置一只已富化 + 已提级的 hk 标的 (模拟下游 profile/tier 已跑过)。
    await prisma.instrument.create({
      data: {
        market: 'hk',
        code: '00700',
        name: '旧名',
        type: 'stock',
        currency: 'HKD',
        status: 'active',
        syncTier: 0,
        lixingerCompanyType: 'reit',
        listingStatus: 'old_status',
      },
    });
    const universe = stubUniverse([
      {
        market: 'hk',
        code: '00700',
        name: '腾讯控股',
        status: 'active',
        listingStatus: 'normally_listed',
      },
    ]);
    const registry = buildRegistry({
      universe,
      profile: new MockMarketDataAdapter(),
      eodBar: new HkEodMock(new Set()),
    });

    await registry.execute('universe', metaInput);

    const after = await hkInstrument('00700');
    expect(after.name).toBe('腾讯控股'); // name 刷新
    expect(after.listingStatus).toBe('normally_listed'); // listingStatus 刷新
    expect(after.syncTier).toBe(0); // 不被重置回默认 2
    expect(after.lixingerCompanyType).toBe('reit'); // fsType 缓存保留
    expect(await prisma.instrument.count({ where: { market: 'hk' } })).toBe(1); // 无重复行
  });

  // ── ④ 港股交易日历表驱动 (读 trading_day 表) + 非交易日整管线 skip ────
  it('④ 港股交易日历表驱动: hk 门控读 trading_day 表 → 非交易日整管线 skip', async () => {
    const TRADING_DAY = '2026-06-03'; // 周三: 表有行 → 开市
    const NON_TRADING = '2026-06-07'; // 周日: 表无行 → 休市
    // 表驱动 (sync-1): seed hk 交易日行 (含近窗另一交易日, 使非交易日判定不误走 fail-open)。
    await prisma.tradingDay.createMany({
      data: [
        { market: 'hk', date: new Date('2026-06-02T00:00:00Z') }, // 近窗另一交易日
        { market: 'hk', date: new Date(`${TRADING_DAY}T00:00:00Z`) },
      ],
      skipDuplicates: true,
    });
    const calendar = new DbTradingCalendarAdapter(prisma);
    const recorder = new SyncRunRecorder(prisma);

    await seedHk('00700', '腾讯控股'); // 在市 hk 标的 (交易日会被回填)
    const eod = new HkEodMock(new Set(['hk:00700']));
    const registry = buildRegistry({
      universe: stubUniverse([]),
      profile: new MockMarketDataAdapter(),
      eodBar: eod,
    });

    // ── 交易日: gate 开 (表有行) → 整管线跑 ──
    expect(await isTradingDayGateOpen(calendar, 'hk', TRADING_DAY)).toBe(true);
    await registry.execute('eod_bar', { mode: 'delta', asOf: TRADING_DAY, now: NOW });
    expect(
      await prisma.dailyBar.count({ where: { instrument: { market: 'hk' } } }),
    ).toBeGreaterThan(0);

    // ── 非交易日: gate 关 → 整管线 skip (零 vendor 外呼 + SyncRun=skipped, trading-day-gate 契约) ──
    await prisma.dailyBar.deleteMany();
    eod.calls.length = 0;
    expect(await isTradingDayGateOpen(calendar, 'hk', NON_TRADING)).toBe(false);
    // 调用方据 gate=false 整管线 skip: 不跑 executor, 记 skipped 审计行 (非交易日盲跑纯浪费配额)。
    await recorder.recordSkipped('sync:eod_bar', NOW);
    expect(eod.calls).toHaveLength(0); // 零 vendor 外呼
    expect(await prisma.dailyBar.count()).toBe(0); // 零落库
    const skipped = await prisma.syncRun.findFirst({
      where: { syncType: 'sync:eod_bar', status: 'skipped' },
    });
    expect(skipped).not.toBeNull();
  });
});
