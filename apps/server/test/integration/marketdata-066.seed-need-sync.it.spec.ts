import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { AnchorDrivenSyncGate } from '../../src/marketdata/anchor-driven-sync-gate';
import {
  loadWorkingSet,
  type ExecutorSyncDimensionRow,
} from '../../src/marketdata/dimension-executor';
import { SyncOptionContractUseCase } from '../../src/marketdata/sync-option-contract.usecase';
import { emptyStats } from '../../src/marketdata/sync-run.recorder';
import type {
  OptionChainPort,
  OptionChainWindowQuery,
  OptionContractStatic,
  OptionExpiry,
} from '../../src/marketdata/option-chain.port';

// 066 T03 兜底 seed 的采集资格默认值 IT (FR-009, SC-006, plan §A4)。
//
// ## 为什么**必须**要真 PG
//
// 本 task 的后果面不是「写进 payload 的那个布尔值」, 而是「**那一行随后能不能被下游工作集
// 捞到**」—— 而工作集是一条 SQL 谓词。单测能断 `create.needSync === true` (已在
// `sync-option-contract.usecase.spec.ts` 断了), 但断不了 SC-006 的真实内容: 该行落库之后,
// 22:00 的 `eod_bar` 到底会不会采它。那需要真的写一行、真的用 `eod_bar` 的 `market_scope`
// 跑一次工作集查询。
//
// 🚨 **反例必须自己造**: 用 universe 已收录的港股票做断言毫无意义 —— 那行的 `needSync` 本来
// 就是 `true`, seed 的 create 分支**根本没跑**, 绿了什么都没证明。这里用一个 `Instrument`
// 表里**不存在**的港股代码建锚, 逼 seed 走 create。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取 (共享 PG 的模板克隆,
// 禁自起 Testcontainers)。装配 = 直接 new 贫血 use case 打真 `PrismaService`。
describe('066 T03 兜底 seed 的 needSync 默认值 (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  const INPUT = {
    mode: 'delta' as const,
    asOf: '2026-08-21',
    now: new Date('2026-08-21T14:00:00Z'),
  };

  /** vendor 端口: 本文件只走 seed 分支 (工作集恒空), 一次都不该被碰。 */
  class UnusedChainPort implements OptionChainPort {
    readonly calls: string[] = [];
    async getExpiryDates(symbol: string): Promise<OptionExpiry[]> {
      this.calls.push(symbol);
      return [];
    }
    async getChainWindow(q: OptionChainWindowQuery): Promise<OptionContractStatic[]> {
      this.calls.push(q.symbol);
      return [];
    }
  }

  function dimRow(dimensionKey: string, marketScope: string[]): ExecutorSyncDimensionRow {
    return {
      dimensionKey,
      enabled: true,
      cronExpr: '0 0 23 * * *',
      marketScope,
      adjustTypes: ['none'],
      batchSize: 1,
      historyDepth: null,
      retryMax: 3,
      misfirePolicy: 'fire-now',
      reAdjustLookbackDays: null,
      deltaLookbackDays: null,
      pausedUntil: null,
      lastWatermark: null,
    };
  }

  async function seedAnchor(ticker: string): Promise<void> {
    await prisma.anchor.create({
      data: {
        ticker,
        market: ticker.split(':')[0]!,
        v: '50',
        asof: new Date('2026-06-01T00:00:00Z'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
      },
    });
  }

  /** 跑一次链发现的**兜底 seed** 分支 (工作集空 ⇒ 只有 seed 会动库)。 */
  async function runSeed(marketScope: string[]): Promise<UnusedChainPort> {
    const chain = new UnusedChainPort();
    await new SyncOptionContractUseCase(chain, prisma).run(
      [],
      dimRow(marketScope[0] === 'hk' ? 'hk_option_contract' : 'option_contract', marketScope),
      emptyStats(),
      INPUT,
    );
    return chain;
  }

  async function needSyncOf(market: string, code: string): Promise<boolean | null> {
    const row = await prisma.instrument.findUnique({
      where: { market_code: { market, code } },
      select: { needSync: true },
    });
    return row?.needSync ?? null;
  }

  async function workingSetSymbols(key: string): Promise<string[]> {
    const dim = await prisma.syncDimension.findUnique({
      where: { dimensionKey: key },
      select: { dimensionKey: true, marketScope: true },
    });
    const rows = await loadWorkingSet(prisma, dim!);
    return rows.map((r) => `${r.market}:${r.code}`).sort();
  }

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
    await prisma.instrument.deleteMany();
    await prisma.anchor.deleteMany();
  });

  it('① 港股锚首建 Instrument 行 → 落 needSync = true (universe 未收录的次新股走的正是这条路)', async () => {
    // 09999 蓄意取一个库里**不存在**的港股代码 —— 存在的话 seed 直接 findUnique 命中返回,
    // create 分支根本不跑。
    expect(await needSyncOf('hk', '09999')).toBeNull();
    await seedAnchor('hk:09999');

    const chain = await runSeed(['hk']);

    expect(chain.calls).toEqual([]); // 工作集空 ⇒ 零对外请求, 本轮只有 seed 动了库
    expect(await needSyncOf('hk', '09999')).toBe(true);
  });

  it('② SC-006: 该行随后**能被 `eod_bar` 的工作集捞到** —— 这才是缺口的真实后果面', async () => {
    await seedAnchor('hk:09999');
    await runSeed(['hk']);

    // `eod_bar` 是 22:00 那条港股日线维度 (market_scope = {cn,hk}), 它的谓词读 needSync。
    expect(await workingSetSymbols('eod_bar')).toContain('hk:09999');

    // 🚨 反向钉死: 把这一行改回 false 就等于「那只标的永远没有日线」, 且零告警。
    await prisma.instrument.update({
      where: { market_code: { market: 'hk', code: '09999' } },
      data: { needSync: false },
    });
    expect(await workingSetSymbols('eod_bar')).not.toContain('hk:09999');
    // 而港股**没有任何东西**会把它刷回来: 采集闸只循环 ANCHOR_GATED_MARKETS = ['us']。
    expect(await new AnchorDrivenSyncGate(prisma).recalcSafely()).toEqual({ opened: 0, closed: 0 });
    expect(await needSyncOf('hk', '09999')).toBe(false);
  });

  it('③ 同一条 seed 路径下的**美股**标的仍落 needSync = false, 且由采集闸负责重算', async () => {
    await seedAnchor('us:ZZZZ');
    await runSeed(['us']);

    // 既有「无锚不采」成员制语义零变化: create 时关闸, 由下一轮 fact 前置的锚闸开闸
    // (SC-003 的「建锚 → 下一轮 cron → 进工作集」时序)。
    expect(await needSyncOf('us', 'ZZZZ')).toBe(false);

    expect(await new AnchorDrivenSyncGate(prisma).recalcSafely()).toEqual({ opened: 1, closed: 0 });
    expect(await needSyncOf('us', 'ZZZZ')).toBe(true);
  });
});
