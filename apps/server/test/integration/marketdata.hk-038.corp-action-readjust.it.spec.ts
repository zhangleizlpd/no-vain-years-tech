import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import type { CorporateActionPort } from '../../src/marketdata/corporate-action.port';
import type { EodBarPort } from '../../src/marketdata/eod-bar.port';
import type {
  CorporateActionDto,
  EodBarPoint,
  EodBarQuery,
} from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';
const deltaInput = { mode: 'delta' as const, asOf: AS_OF, now: NOW };

// 038 T015 US2 corporate_action 扩 HK + 复权重锚 集成 IT (Testcontainers PG, mock hk):
// hk 公司行动经 T001 (marketScope 工作集) + T002 (/hk/company/dividend 路径插值) 缝隙进入同一
// syncCorporateActions 管线 —— upsertCorporateActions 返最小新 exDate → 触发该 hk 标的
// adjustment_factor 重锚 (沿 020 anchorFactorJumps 机制, 本地不重算; 重拉理杏仁已复权 backward)。
// 用 test-local mock hk corp-action + backward eod adapter; 落库/重锚/幂等经真 PG。
// 覆盖 state_branch: corporate_action hk 触发复权。
describe('038 T015 corporate_action 扩 HK + 复权重锚 (Testcontainers PG, mock hk)', () => {
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
    await prisma.adjustmentFactor.deleteMany();
    await prisma.corporateAction.deleteMany();
    await prisma.dailyBar.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    await prisma.syncDimension.update({
      where: { dimensionKey: 'corporate_action' },
      data: { marketScope: ['cn', 'hk'] },
    });
  });

  /** test-local hk corp-action adapter: 按 symbol 返预置分红事件 (含 exDate)。 */
  class HkCorpActionMock implements CorporateActionPort {
    readonly calls: string[] = [];
    constructor(private readonly bySymbol: Map<string, CorporateActionDto[]>) {}
    async getCorporateActions(symbol: string): Promise<CorporateActionDto[]> {
      this.calls.push(symbol);
      return this.bySymbol.get(symbol) ?? [];
    }
  }

  /**
   * test-local hk backward eod adapter: 供 anchorNewFactorVersion 拉 backward 已复权序列 (transient,
   * 不落库)。backward 跨除权连续 (无跳空) → 与含跳空的 none 相邻比值之比 = 单事件复权跃变。
   */
  class HkBackwardEodMock implements EodBarPort {
    readonly calls: EodBarQuery[] = [];
    constructor(private readonly bySymbol: Map<string, EodBarPoint[]>) {}
    async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
      this.calls.push(query);
      return this.bySymbol.get(query.symbol) ?? [];
    }
    backwardCallCount(): number {
      return this.calls.filter((c) => c.adjust === 'backward').length;
    }
  }

  function backwardBar(tradeDate: string, close: string): EodBarPoint {
    return {
      tradeDate,
      adjust: 'backward',
      open: close,
      high: close,
      low: close,
      close,
      changePct: null,
      prevClose: null,
      volume: null,
      amount: null,
      turnoverRate: null,
    };
  }

  function buildRegistry(opts: {
    corporateAction: CorporateActionPort;
    eodBar: EodBarPort;
  }): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      opts.eodBar,
      mock,
      mock,
      opts.corporateAction,
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

  /** 除权前后的 none 日线 (含分红跳空): ex-1 close 100, ex 日 close 98。 */
  async function seedNoneBars(instrumentId: bigint): Promise<void> {
    await prisma.dailyBar.createMany({
      data: [
        {
          instrumentId,
          tradeDate: new Date('2026-05-14T00:00:00Z'),
          adjust: 'none',
          open: '100',
          high: '100',
          low: '100',
          close: '100',
          changePct: null,
          prevClose: null,
          volume: null,
          amount: null,
          turnoverRate: null,
        },
        {
          instrumentId,
          tradeDate: new Date('2026-05-15T00:00:00Z'),
          adjust: 'none',
          open: '98',
          high: '98',
          low: '98',
          close: '98',
          changePct: null,
          prevClose: null,
          volume: null,
          amount: null,
          turnoverRate: null,
        },
      ],
    });
  }

  // ── ① hk corp-action 新增 → 落库 (instrumentId,exDate,type) + 触发 factor 重锚 ──────
  it('① hk 分红新增 → corporate_action 落库 + 触发该标的 adjustment_factor 重锚 (沿 020 跃变锚定)', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    await seedNoneBars(instId);
    const corp = new HkCorpActionMock(
      new Map([
        [
          'hk:00700',
          [
            {
              symbol: 'hk:00700',
              exDate: '2026-05-15',
              type: 'dividend',
              payload: { dividend: 2, currency: 'HKD' },
            },
          ],
        ],
      ]),
    );
    // backward 跨除权连续 (ex-1 与 ex 日 close 均 100, 无跳空)。
    const eod = new HkBackwardEodMock(
      new Map([['hk:00700', [backwardBar('2026-05-14', '100'), backwardBar('2026-05-15', '100')]]]),
    );
    const registry = buildRegistry({ corporateAction: corp, eodBar: eod });

    const { stats } = await registry.execute('corporate_action', deltaInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(corp.calls).toEqual(['hk:00700']); // hk 标的进工作集 (marketScope 纳 hk)

    // corp-action 落 (instrumentId, exDate, type)。
    const actions = await prisma.corporateAction.findMany({ where: { instrumentId: instId } });
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('dividend');
    expect(actions[0].exDate.toISOString().slice(0, 10)).toBe('2026-05-15');

    // 🚨 新增事件仍触发 anchorNewFactorVersion, 但锚定已零 vendor 外呼 (旧口径此处为 1 次
    // backward 重拉 —— 那次拉取正是已证伪的反推口径的输入)。
    expect(eod.backwardCallCount()).toBe(0);
    const factors = await prisma.adjustmentFactor.findMany({ where: { instrumentId: instId } });
    expect(factors).toHaveLength(1);
    expect(factors[0].exDate.toISOString().slice(0, 10)).toBe('2026-05-15');
    // 条款 f = 前收/(前收 − 派息) = 100/(100−2) = 100/98 ≈ 1.0204。
    expect(Number(factors[0].factorBackward)).toBeCloseTo(100 / 98, 4);

    const run = await prisma.syncRun.findFirstOrThrow({
      where: { syncType: 'sync:corporate_action' },
    });
    expect(run.status).toBe('success');
  });

  // ── ② 无新增重跑 → 零重锚 (D7: 仅新增事件触发, 幂等) ──────────────────────────────
  it('② 无新增 corp-action 重跑 → factor 不翻倍 (D7 仅新增触发, 幂等)', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    await seedNoneBars(instId);
    const corp = new HkCorpActionMock(
      new Map([
        [
          'hk:00700',
          [
            {
              symbol: 'hk:00700',
              exDate: '2026-05-15',
              type: 'dividend',
              payload: { dividend: 2, currency: 'HKD' },
            },
          ],
        ],
      ]),
    );
    const eod = new HkBackwardEodMock(
      new Map([['hk:00700', [backwardBar('2026-05-14', '100'), backwardBar('2026-05-15', '100')]]]),
    );
    const registry = buildRegistry({ corporateAction: corp, eodBar: eod });

    await registry.execute('corporate_action', deltaInput); // 首跑: 新增 → 重锚
    await registry.execute('corporate_action', deltaInput); // 重跑: 无新增 → 零重锚

    // 两跑都零 backward 外呼 (锚定走本地四表); 幂等性改由「行数不翻倍」承载。
    expect(eod.backwardCallCount()).toBe(0);
    expect(await prisma.corporateAction.count({ where: { instrumentId: instId } })).toBe(1); // 不翻倍
    expect(await prisma.adjustmentFactor.count({ where: { instrumentId: instId } })).toBe(1); // 不翻倍
  });
});
