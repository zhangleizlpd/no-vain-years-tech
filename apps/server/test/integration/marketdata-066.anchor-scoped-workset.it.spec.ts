import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { AnchorDrivenSyncGate } from '../../src/marketdata/anchor-driven-sync-gate';
import {
  DIMENSION_KEYS,
  loadWorkingSet,
  type ExecutorSyncDimensionRow,
} from '../../src/marketdata/dimension-executor';
import { SyncOptionContractUseCase } from '../../src/marketdata/sync-option-contract.usecase';
import { deriveStatus, emptyStats } from '../../src/marketdata/sync-run.recorder';
import type {
  OptionChainPort,
  OptionChainWindowQuery,
  OptionContractStatic,
  OptionExpiry,
} from '../../src/marketdata/option-chain.port';

// 066 T02 锚作用域工作集 IT (FR-006 / FR-007 / FR-008, SC-002 / SC-004 / SC-005, plan §A3)。
//
// ## 为什么**必须**要真 PG
//
// 被测面**就是一条 SQL 谓词**。工作集判据由 `loadWorkingSet` 的 `where` 表达, 而本 task 换掉的
// 正是这条 `where` —— 把 `instrument.findMany` mock 掉等于把被测对象整个抽掉 (体例与理由同
// `optionsdesk-046.underlying-iv.it.spec.ts` 的 ①)。另外三件也只有真库能验:
//   ① **「新旧判据同一集合」要求两条真查询跑在同一份数据上** —— 旧判据是
//      `AnchorDrivenSyncGate` 的双 `updateMany` 刷出 `needSync` 再读回, 那是一个单事务;
//   ② **`{cn,hk}` 既有维度逐元素不变** 要拿真的 `sync_dimension` 行 (`market_scope` 列) 算,
//      写死 scope 字面量会让「有人改了 seed」这件事永远不红;
//   ③ **SC-005 跨维度快照**要对**每一个**已注册维度取一次工作集, 靠的是模板库里那套真 seed 行。
//
// ⇒ PG 从 `test/_support/isolated-db.ts` 的 **`setupIsolatedDb()`** 取 (共享 PG 的模板克隆,
// 禁自起 Testcontainers)。装配 = 直接调纯导出 + 直接 new 贫血 use case 打真 `PrismaService`
// (样板 `optionsdesk-045.anchor.it.spec.ts`), 不起 Nest 容器。
describe('066 T02 锚作用域工作集 (Testcontainers PG, 真锚闸)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  const NOW = new Date('2026-08-21T14:00:00Z');

  /**
   * **旧判据**原文 (`needSync` 版), 蓄意在测里重写一遍而不是 import ——
   * 它就是本 task 要替换掉的那一条, import 实现等于拿被测对象证明自己。
   */
  async function legacyWorkingSet(scope: string[]): Promise<string[]> {
    const rows = await prisma.instrument.findMany({
      where: { market: { in: scope }, status: 'active', needSync: true },
      select: { market: true, code: true },
      orderBy: [{ syncTier: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => `${r.market}:${r.code}`).sort();
  }

  /** 新判据下某维度的工作集 (canonical symbol 升序, 便于逐元素比对)。 */
  async function workingSet(
    dim: Pick<ExecutorSyncDimensionRow, 'dimensionKey' | 'marketScope'>,
  ): Promise<string[]> {
    const rows = await loadWorkingSet(prisma, dim);
    return rows.map((r) => `${r.market}:${r.code}`).sort();
  }

  /** 真 `sync_dimension` 行 (模板库 seed); 尚未 seed 的维度 → null。 */
  async function realDim(
    key: string,
  ): Promise<Pick<ExecutorSyncDimensionRow, 'dimensionKey' | 'marketScope'> | null> {
    return prisma.syncDimension.findUnique({
      where: { dimensionKey: key },
      select: { dimensionKey: true, marketScope: true },
    });
  }

  async function seedInstrument(
    market: string,
    code: string,
    needSync: boolean,
    status = 'active',
  ): Promise<bigint> {
    const row = await prisma.instrument.create({
      data: {
        market,
        code,
        name: `${market}:${code}`,
        type: 'stock',
        currency: market === 'us' ? 'USD' : market === 'hk' ? 'HKD' : 'CNY',
        status,
        needSync,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** 真 `Anchor` 行 (optionsdesk schema)。判据只读 `ticker` 一列, 其余取合法最小集。 */
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

  // ── ① 美股等价性: 新旧判据同一集合 (FR-008) ──
  //
  // 🚨 三种行缺一不可, 且第三种 (无锚 + needSync=true) 是**唯一**能证伪的那种: 只造前两种时,
  // 「判据整个失效、全量放行」也会绿。
  it('① 美股: 新旧判据产出**同一集合** —— 有锚两种全进、无锚不进, 且新判据不依赖 needSync', async () => {
    await seedInstrument('us', 'AOS', true); // 有锚 + needSync=true (闸已开)
    await seedInstrument('us', 'PEP', false); // 有锚 + needSync=false (闸尚未开: seed 路径新建)
    await seedInstrument('us', 'LULU', true); // 无锚 + needSync=true (陈旧开闸态)
    await seedAnchor('us:AOS');
    await seedAnchor('us:PEP');

    const dim = (await realDim('option_contract'))!;
    expect(dim.marketScope).toEqual(['us']);

    // 闸**尚未**跑: 新判据已经是正确集合 —— `needSync` 不进谓词, 这一条就是它的证据。
    expect(await workingSet(dim)).toEqual(['us:AOS', 'us:PEP']);
    // 同一时刻旧判据是错的 (PEP 掉了、LULU 混进来) —— 两者只有在闸跑完后才等价。
    expect(await legacyWorkingSet(['us'])).toEqual(['us:AOS', 'us:LULU']);

    // 闸跑完 = 生产上 factExecutor 的前置步骤。此后旧判据收敛到锚集。
    expect(await new AnchorDrivenSyncGate(prisma).recalcSafely()).toEqual({ opened: 1, closed: 1 });

    const legacy = await legacyWorkingSet(['us']);
    const next = await workingSet(dim);
    expect(next).toEqual(legacy); // ← FR-008 的等价性断言本体
    expect(next).toEqual(['us:AOS', 'us:PEP']);
    expect(next).not.toContain('us:LULU');
  });

  // ── ② 港股真闸: `needSync` 恒真 ⇒ 旧判据零收窄, 新判据才收窄 (FR-006) ──
  it('② 港股: 无锚标的**不进**期权维度工作集 —— 而旧判据会把整个 hk universe 放进来', async () => {
    await seedInstrument('hk', '00700', true); // 有锚
    await seedInstrument('hk', '09988', true); // 无锚; hk 的 needSync 恒 true (闸不管 hk)
    await seedInstrument('hk', '01810', true); // 无锚
    await seedAnchor('hk:00700');

    // 闸跑完也不会动 hk 一行 —— ANCHOR_GATED_MARKETS = ['us'] (成对约束的另一半)。
    expect(await new AnchorDrivenSyncGate(prisma).recalcSafely()).toEqual({ opened: 0, closed: 0 });
    expect(await legacyWorkingSet(['hk'])).toEqual(['hk:00700', 'hk:01810', 'hk:09988']);

    // T04 尚未 seed 该维度行 ⇒ 用等价的合成行 (登记表已先行收录该 key, 排序铁律 2)。
    const hkChain = { dimensionKey: 'hk_option_contract', marketScope: ['hk'] };
    expect(await workingSet(hkChain)).toEqual(['hk:00700']);
  });

  // ── ③ 整库零港股锚: 工作集为空 + 零对外请求 + 判定成功 (SC-002 / FR-006) ──
  it('③ 零港股锚: 港股期权维度工作集为**空**, 对供应方请求数为 0, 且判定为**成功**', async () => {
    await seedInstrument('hk', '00700', true);
    await seedInstrument('hk', '09988', true);
    // 美股侧有锚 —— 证明「零港股锚」是按 scope 判的, 不是「整库零锚」才成立。
    await seedInstrument('us', 'AOS', true);
    await seedAnchor('us:AOS');

    const hkChain = { dimensionKey: 'hk_option_contract', marketScope: ['hk'] };
    const instruments = await loadWorkingSet(prisma, hkChain);
    expect(instruments).toEqual([]);

    // 空工作集喂进真 use case: 请求数 0 (端口一次都没被碰), 终态 success 而不是 failed。
    const chain = new RecordingChainPort();
    const stats = emptyStats();
    const exhausted = await new SyncOptionContractUseCase(chain, prisma).run(
      instruments,
      hkDimRow(),
      stats,
      { mode: 'delta', asOf: '2026-08-21', now: NOW },
    );

    expect(chain.calls).toEqual([]);
    expect(exhausted).toBe(false);
    expect(stats).toMatchObject({ scanned: 0, ok: 0, failed: 0, skipped: 0 });
    expect(deriveStatus(stats)).toBe('success');
  });

  // ── ④ 既有 {cn,hk} 维度工作集逐元素不变 (FR-007 / SC-004) ──
  it('④ 开通港股前后: `eod_bar` / `profile` 的工作集**逐元素不变**, 非锚港股仍在日线覆盖内', async () => {
    await seedInstrument('cn', '600519', true);
    await seedInstrument('hk', '00700', true);
    await seedInstrument('hk', '09988', true); // 永不建锚的港股: SC-004 的真实受害面
    await seedInstrument('hk', '00981', true);

    const eod = (await realDim('eod_bar'))!;
    const profile = (await realDim('profile'))!;
    expect(eod.marketScope).toEqual(['cn', 'hk']);

    const before = { eod: await workingSet(eod), profile: await workingSet(profile) };

    // 「开通港股」= 港股侧开始有锚 (T02 的可观测变量; 维度 seed 归 T04)。
    await seedAnchor('hk:00700');
    await new AnchorDrivenSyncGate(prisma).recalcSafely();

    expect(await workingSet(eod)).toEqual(before.eod);
    expect(await workingSet(profile)).toEqual(before.profile);
    // 逐元素: 无锚的 09988 / 00981 仍在日线工作集内 —— 掉出去 = 那两只永远没日线且不报错。
    expect(before.eod).toEqual(['cn:600519', 'hk:00700', 'hk:00981', 'hk:09988']);
  });

  // ── ⑤ 跨维度集合快照对比 (SC-005) ──
  //
  // 🚨 与 ①–④ 不是重复: 前四条验的是「判据」这一层, 这条验的是「**各维度覆盖的标的集合**」
  // 那一层 —— 对每一个已 seed 的维度各取一次快照, 逐维度逐元素比对美股侧。
  it('⑤ 开通港股前后: **全部**已注册维度的**美股侧**覆盖集合逐维度逐元素相同', async () => {
    await seedInstrument('us', 'AOS', true);
    await seedInstrument('us', 'PEP', false);
    await seedInstrument('us', 'LULU', true);
    await seedInstrument('cn', '600519', true);
    await seedInstrument('hk', '00700', true);
    await seedAnchor('us:AOS');
    await seedAnchor('us:PEP');
    await new AnchorDrivenSyncGate(prisma).recalcSafely();

    const snapshotUs = async (): Promise<Record<string, string[]>> => {
      const out: Record<string, string[]> = {};
      for (const key of DIMENSION_KEYS) {
        const dim = await realDim(key);
        if (dim === null) continue; // 尚未 seed 的维度 (港股三行归 T04)
        out[key] = (await workingSet(dim)).filter((s) => s.startsWith('us:'));
      }
      return out;
    };

    const before = await snapshotUs();
    // 快照非空且真覆盖了美股维度 —— 否则「全空 === 全空」是一条平凡绿。
    expect(before['option_contract']).toEqual(['us:AOS', 'us:PEP']);
    expect(before['us_equity_bar']).toEqual(['us:AOS', 'us:PEP']);

    // 开通港股: 港股锚 + 新的港股标的同时进场。
    await seedInstrument('hk', '09988', true);
    await seedAnchor('hk:00700');
    await new AnchorDrivenSyncGate(prisma).recalcSafely();

    expect(await snapshotUs()).toEqual(before);
  });

  /** 合成的 `hk_option_contract` 维度行 (T04 才 seed 真行; 本 task 只需 scope + key)。 */
  function hkDimRow(): ExecutorSyncDimensionRow {
    return {
      dimensionKey: 'hk_option_contract',
      enabled: true,
      cronExpr: '0 0 23 * * *',
      marketScope: ['hk'],
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
});

/**
 * 记账 `OPTION_CHAIN_PORT`: 断言 SC-002「请求数 = 0」必须是**真数请求次数** —— 「库里没落行」
 * 是间接推断 (工作集漏了 / vendor 返空 / 落库被拒, 三者在库侧一模一样)。
 */
class RecordingChainPort implements OptionChainPort {
  readonly calls: string[] = [];

  async getExpiryDates(symbol: string): Promise<OptionExpiry[]> {
    this.calls.push(`expiry:${symbol}`);
    return [];
  }

  async getChainWindow(query: OptionChainWindowQuery): Promise<OptionContractStatic[]> {
    this.calls.push(`chain:${query.symbol}`);
    return [];
  }
}
