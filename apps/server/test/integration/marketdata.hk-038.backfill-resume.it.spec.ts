import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import type { EodBarPort } from '../../src/marketdata/eod-bar.port';
import type { FundamentalPort } from '../../src/marketdata/fundamental.port';
import type {
  EodBarPoint,
  EodBarQuery,
  FundamentalRangeQuery,
  FundamentalSnapshotDto,
} from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 (Asia/Shanghai 交易日)
const AS_OF = '2026-06-03';

// 038 T018 分夜续跑 / 幂等 (Testcontainers PG, test-local hk mock):
// 证港股回填的「分夜收敛」+「幂等重跑」—— 二者靠**现有 market-agnostic 机制**天然覆盖 hk,
// 无新增 backfill cursor (plan §回填 pacing 分夜收敛「靠自然键 upsert 幂等续跑」= 选最小方案;
// 已 grep 确认 dimension-executor.ts 续跑/幂等路径无 hk 特化硬编码, 仅 instrumentId/tradeDate/
// 自然键)。本 IT 锁定该行为对 hk 生效, 防未来回归:
//   ① delta 预算耗尽 → 下窗已同步 hk 标的经 pendingEodInstruments 跳过不重拉 (分夜收敛)。
//   ② eod_bar hk backfill 连跑两次 → daily_bar skipDuplicates 幂等不翻倍 (幂等重跑)。
//   ③ fundamental hk 区间 backfill 连跑两次 → (instrumentId,date) upsert 幂等不翻倍 (幂等重跑)。
//
// **vendor 边界 = test-local mock hk adapter** (非扩共享 MockMarketDataAdapter 塞 hk fixture —
// 后者 hk=no-data 以护 T006 seam IT); 落库/幂等/skip 经真 PG。
// 覆盖 spec state_branches: 幂等重跑 / 分夜收敛。
describe('038 T018 分夜续跑 / 幂等 (Testcontainers PG, test-local hk mock)', () => {
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
    await prisma.fundamentalSnapshot.deleteMany();
    await prisma.corporateAction.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T003 migration 已把 6 维扩到 {cn,hk}; 每例回到已知基线 (marketScope 含 hk + 清水位)。
    await prisma.syncDimension.updateMany({
      data: { marketScope: ['cn', 'hk'], lastWatermark: null },
    });
  });

  /** eod bar fixture 行 (仅结构占位, resume/幂等验证不看数值)。 */
  function bar(tradeDate: string, adjust: EodBarPoint['adjust']): EodBarPoint {
    return {
      tradeDate,
      adjust,
      open: '1',
      high: '1',
      low: '1',
      close: '1',
      changePct: null,
      prevClose: null,
      volume: null,
      amount: null,
      turnoverRate: null,
    };
  }

  /**
   * test-local hk eod 端口: served 集内 hk 标的返 bar。
   * delta (from==to) → 单 bar at targetDate (供 pendingEodInstruments 检测已同步);
   * backfill (from<to) → 区间内多行历史 (含 to)。记录 query 供「不重拉」断言。
   */
  class HkEodMock implements EodBarPort {
    readonly calls: EodBarQuery[] = [];
    constructor(private readonly served: ReadonlySet<string>) {}
    async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
      this.calls.push({ ...query });
      if (!this.served.has(query.symbol)) return [];
      const to = query.to ?? AS_OF;
      const from = query.from ?? to;
      const candidates = from === to ? [to] : ['2026-05-15', '2026-05-29', to];
      return candidates.filter((d) => d >= from && d <= to).map((d) => bar(d, query.adjust));
    }
  }

  /** test-local hk fundamental 端口: served 集内 hk 标的区间返 2 期日频 (delta 不用)。 */
  class HkFundamentalMock implements FundamentalPort {
    constructor(private readonly served: ReadonlySet<string>) {}
    async getFundamentals(): Promise<FundamentalSnapshotDto[]> {
      return [];
    }
    async getFundamentalsRange(query: FundamentalRangeQuery): Promise<FundamentalSnapshotDto[]> {
      if (!this.served.has(query.symbol)) return [];
      return ['2026-05-15', '2026-05-29'].map((date) => ({
        symbol: query.symbol,
        date,
        peTtm: '10.0000',
        peStatic: null,
        peDynamic: null,
        pb: null,
        ps: null,
        dividendYield: null,
        marketCap: null,
        circMarketCap: null,
        pePctlY3: null,
        pePctlY5: null,
        pbPctlY3: null,
        pbPctlY5: null,
      }));
    }
  }

  function buildRegistry(
    overrides: { eodBar?: EodBarPort; fundamental?: FundamentalPort } = {},
  ): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      overrides.eodBar ?? mock,
      overrides.fundamental ?? mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
      // backfillPacer 默认 disabled → 续跑/幂等验证不引入真 sleep 减速。
    );
  }

  /** seed N 只活跃 hk 标的 (currency HKD, id 升序 = 消费序), 返 canonical symbols。 */
  async function seedHk(n: number): Promise<string[]> {
    const symbols: string[] = [];
    for (let i = 1; i <= n; i++) {
      const code = `0000${i}`;
      await prisma.instrument.create({
        data: {
          market: 'hk',
          code,
          name: `hk${i}`,
          type: 'stock',
          currency: 'HKD',
          status: 'active',
        },
      });
      symbols.push(`hk:${code}`);
    }
    return symbols;
  }

  // ── ① 分夜收敛: delta 预算耗尽 → 下窗已同步 hk 标的跳过不重拉 ────────────
  it('① 分夜收敛: hk delta 预算耗尽 → 下窗经 pendingEodInstruments 跳过已同步 hk 标的 (不重拉)', async () => {
    const served = new Set(await seedHk(5));
    const eod = new HkEodMock(served);
    const spy = vi.spyOn(eod, 'getBars');

    // 窗1: 预算 2 → 前 2 只 hk 落库 (id 升序), 3 只顺延。
    await buildRegistry({ eodBar: eod }).execute('eod_bar', {
      mode: 'delta',
      asOf: AS_OF,
      now: NOW,
      maxEodInstruments: 2,
    });
    const w1 = new Set(spy.mock.calls.map((c) => c[0].symbol));
    expect(w1.size).toBe(2);
    spy.mockClear();

    // 窗2: 预算 2 → 下 2 只 (pending 天然排除窗1 已落库者)。
    await buildRegistry({ eodBar: eod }).execute('eod_bar', {
      mode: 'delta',
      asOf: AS_OF,
      now: NOW,
      maxEodInstruments: 2,
    });
    const w2 = new Set(spy.mock.calls.map((c) => c[0].symbol));

    // 窗2 不重拉窗1 已同步 hk 标的 (分夜续跑, 无谓重拉配额)。
    for (const s of w1) expect(w2.has(s)).toBe(false);
    // 累计 4 只 hk 落库 none 各 1 行, 无重复。
    expect(await prisma.dailyBar.count()).toBe(4);
  });

  // ── ② 幂等重跑: eod_bar hk backfill 连跑两次不翻倍 ──────────────────────
  it('② 幂等重跑: hk eod_bar backfill 连跑两次 → daily_bar skipDuplicates 幂等不翻倍', async () => {
    const served = new Set(await seedHk(5));
    const reg = buildRegistry({ eodBar: new HkEodMock(served) });
    const backfill = { mode: 'backfill' as const, asOf: AS_OF, now: NOW, backfillHistoryDays: 30 };

    await reg.execute('eod_bar', backfill);
    const after1 = await prisma.dailyBar.count();
    expect(after1).toBe(5 * 3); // 5 只 hk × 3 行区间历史

    await reg.execute('eod_bar', backfill); // 续跑 (幂等重锚)
    expect(await prisma.dailyBar.count()).toBe(after1); // 零新增行 = 自然键幂等
  });

  // ── ③ 幂等重跑: fundamental hk 区间 backfill 连跑两次不翻倍 ─────────────
  it('③ 幂等重跑: hk fundamental 区间 backfill 连跑两次 → (instrumentId,date) upsert 幂等不翻倍', async () => {
    const served = new Set(await seedHk(5));
    const reg = buildRegistry({ fundamental: new HkFundamentalMock(served) });
    const backfill = { mode: 'backfill' as const, asOf: AS_OF, now: NOW, backfillHistoryDays: 30 };

    await reg.execute('fundamental', backfill);
    const after1 = await prisma.fundamentalSnapshot.count();
    expect(after1).toBe(5 * 2); // 5 只 hk × 2 期日频

    await reg.execute('fundamental', backfill); // 续跑
    expect(await prisma.fundamentalSnapshot.count()).toBe(after1); // upsert 幂等
  });

  // ── ④ skip-complete: 老端 (date<=from) 已覆盖的 hk fundamental 股本窗跳过不重拉 ──────
  // incident 2026-07-12 P1 正解②: 补缺口时已回填股 skip → 不再全 2781 股全量重跑 → 避 host OOM。
  // 真 PG 走 coveredFundamentalIds 的 findMany({instrumentId:{in}, date:{lte}, distinct})。
  it('④ skip-complete: 老端已覆盖 hk fundamental 股 → 本窗跳过 (不 fetch、计 skipped、零新增)', async () => {
    const served = new Set(await seedHk(1));
    const inst = await prisma.instrument.findFirstOrThrow({ where: { market: 'hk' } });
    // 预置一行老端快照 (date=2020-01-01 ≤ from=AS_OF−30=2026-05-04) → 该股「老端已回填」。
    await prisma.fundamentalSnapshot.create({
      data: { instrumentId: inst.id, date: new Date('2020-01-01T00:00:00Z'), peTtm: '9.9' },
    });
    const fundamental = new HkFundamentalMock(served);
    const spy = vi.spyOn(fundamental, 'getFundamentalsRange');
    const backfill = { mode: 'backfill' as const, asOf: AS_OF, now: NOW, backfillHistoryDays: 30 };

    const { stats } = await buildRegistry({ fundamental }).execute('fundamental', backfill);

    expect(spy).not.toHaveBeenCalled(); // 连 HTTP 都省 (skip-complete)
    expect(stats).toMatchObject({ scanned: 0, ok: 0, skipped: 1, failed: 0 });
    expect(await prisma.fundamentalSnapshot.count()).toBe(1); // 仅预置那行, 零新增
  });

  // ── ⑤ grace-window: 最早行落在 (from, from+N] 的完整股也跳过 (吸收 from 边界漂移) ──────────
  // 精确 date<=from 会把最早行落在 from 之后几天的完整股误判未回填 → 白重拉 (2026-07-13 prod 实测多碰
  // ~260 股); grace-window (+SKIP_COMPLETE_GRACE_DAYS=30 天) 吸收。本例 from=AS_OF−30=2026-05-04,
  // 预置行 2026-05-20 严格在 (from, from+30=2026-06-03]: 精确判据 miss (会重拉)、grace 命中 (跳过)。
  it('⑤ grace-window: 最早行在 (from, from+30] 的完整 hk 股 → 仍跳过不重拉', async () => {
    const served = new Set(await seedHk(1));
    const inst = await prisma.instrument.findFirstOrThrow({ where: { market: 'hk' } });
    await prisma.fundamentalSnapshot.create({
      data: { instrumentId: inst.id, date: new Date('2026-05-20T00:00:00Z'), peTtm: '8.8' },
    });
    const fundamental = new HkFundamentalMock(served);
    const spy = vi.spyOn(fundamental, 'getFundamentalsRange');
    const backfill = { mode: 'backfill' as const, asOf: AS_OF, now: NOW, backfillHistoryDays: 30 };

    const { stats } = await buildRegistry({ fundamental }).execute('fundamental', backfill);

    expect(spy).not.toHaveBeenCalled(); // grace 命中 → 连 HTTP 都省 (精确 from 会 fetch)
    expect(stats).toMatchObject({ scanned: 0, ok: 0, skipped: 1, failed: 0 });
  });
});
