import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { recordingOutboxPublisher } from '../_support/outbox-stub';
import { PrismaService } from '../../src/security/prisma.service';
import { AnchorDrivenSyncGate } from '../../src/marketdata/anchor-driven-sync-gate';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DIMENSION_KEYS, DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import { CreateAnchorUseCase } from '../../src/optionsdesk/create-anchor.usecase';
import { DeleteAnchorUseCase } from '../../src/optionsdesk/delete-anchor.usecase';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 (Asia/Shanghai 交易日)
const AS_OF = '2026-06-03';

// 045 T016 US4 采集闸集成 IT (**SC-003 / SC-007**) —— 真 PG 端到端: 建锚 → 重算 →
// `Instrument.needSync` 开闸 (零代码改动、零人工 SQL); 删锚 → 移出工作集且**已落库
// `daily_bar` 历史行一条不少**; `excluded=true` 的锚其标的**仍在**工作集; 锚表读取失败
// → 只 warn、`SyncRun` 不被置 failed。
//
// 覆盖 state_branch (矩阵 T016 行 4 条): 新建锚开闸 / 删锚移出且不删历史 /
// excluded 不参与闸 / 锚表读失败只 warn。
//
// 装配方式 = 直接 new usecase + 真 `PrismaService` (体例同 optionsdesk-045.anchor.it.spec.ts /
// .radar.it.spec.ts): 验证面是**落库口径**。唯一起 `DimensionExecutorRegistry` 的地方是
// 「读失败不污染 SyncRun」—— 那条断言的对象恰是 executor 顶层 catch 的行为, 非起不可。
describe('045 optionsdesk US4 采集闸集成 IT (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let gate: AnchorDrivenSyncGate;
  let createAnchor: CreateAnchorUseCase;
  let deleteAnchor: DeleteAnchorUseCase;

  const anchorInput = (ticker: string, excluded = false) => ({
    ticker,
    v: '50',
    asof: new Date('2026-06-30T00:00:00Z'),
    method: 'dcf',
    confidence: '8',
    excluded,
    excludeReason: excluded ? '仓位已满' : null,
  });

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;

    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
    gate = new AnchorDrivenSyncGate(prisma);
    createAnchor = new CreateAnchorUseCase(prisma, recordingOutboxPublisher());
    deleteAnchor = new DeleteAnchorUseCase(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE optionsdesk.anchor, optionsdesk.anchor_change RESTART IDENTITY',
    );
    await prisma.$executeRawUnsafe(
      'TRUNCATE marketdata.daily_bar, marketdata.instrument, marketdata.sync_run RESTART IDENTITY CASCADE',
    );
  });

  // ── fixture helpers ────────────────────────────────────────────────────────

  /**
   * 塞一行真 `Instrument`。`needSync` 默认按 `sync-universe.usecase.ts` 的 create 分支口径
   * (`market !== 'us'`) —— us 新标的落库即**不采**, 等锚来开闸。
   */
  async function seedInstrument(market: string, code: string, needSync?: boolean): Promise<bigint> {
    const row = await prisma.instrument.create({
      data: {
        market,
        code,
        name: `${market}:${code}`,
        type: 'stock',
        currency: market === 'us' ? 'USD' : market === 'hk' ? 'HKD' : 'CNY',
        status: 'active',
        needSync: needSync ?? market !== 'us',
      },
      select: { id: true },
    });
    return row.id;
  }

  async function seedBar(instrumentId: bigint, isoDate: string, close: string): Promise<void> {
    await prisma.dailyBar.create({
      data: {
        instrumentId,
        tradeDate: new Date(`${isoDate}T00:00:00.000Z`),
        adjust: 'none',
        open: close,
        high: close,
        low: close,
        close,
      },
    });
  }

  /**
   * 同步工作集 —— **判据逐字镜像** `dimension-executor.ts` 的 `loadActiveInstruments`
   * (`market in scope ∧ status='active' ∧ needSync=true`, tier 序)。工作集是 private 方法的
   * 产物, 这里复刻它的 where 是本 IT 断言「进没进工作集」的唯一手段; 两处必须同步改。
   */
  async function workingSet(markets: string[]): Promise<string[]> {
    const rows = await prisma.instrument.findMany({
      where: { market: { in: markets }, status: 'active', needSync: true },
      select: { market: true, code: true },
      orderBy: [{ syncTier: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => `${r.market}:${r.code}`);
  }

  async function needSyncOf(market: string, code: string): Promise<boolean | undefined> {
    const row = await prisma.instrument.findUnique({
      where: { market_code: { market, code } },
      select: { needSync: true },
    });
    return row?.needSync;
  }

  // ── state_branch: 新建锚 → 采集工作集自动纳入 (SC-003) ──────────────────────

  it('新建锚 → 下一轮前置重算把该标的纳入工作集 (SC-003: 零代码改动、零人工 SQL)', async () => {
    await seedInstrument('us', 'AOS'); // universe 落库即 needSync=false (无锚不采)
    expect(await needSyncOf('us', 'AOS')).toBe(false);
    expect(await workingSet(['us'])).toEqual([]);

    await createAnchor.execute(anchorInput('us:AOS'));
    // 建锚**不即时**开闸 (即时生效要 optionsdesk 跨 ctx 写 marketdata 的表, 护城河已禁);
    // 纳入发生在下一轮采集的前置重算 —— 与 SC-003「下一轮后台采集中被自动纳入」一致。
    expect(await needSyncOf('us', 'AOS')).toBe(false);

    const result = await gate.recalcSafely();

    expect(result).toEqual({ opened: 1, closed: 0 });
    expect(await needSyncOf('us', 'AOS')).toBe(true);
    expect(await workingSet(['us'])).toEqual(['us:AOS']);
  });

  it('第 8 只锚同样零改动纳入 + 重跑幂等 (零行变更)', async () => {
    const codes = ['AOS', 'CPB', 'LULU', 'PEP', 'PSKY', 'TAP', 'VICI'];
    for (const code of codes) {
      await seedInstrument('us', code);
      await createAnchor.execute(anchorInput(`us:${code}`));
    }
    await gate.recalcSafely();
    expect(await workingSet(['us'])).toHaveLength(7);

    // 第 8 只: 只建锚, 不碰任何代码 / 不跑任何人工 SQL。
    await seedInstrument('us', 'MO');
    await createAnchor.execute(anchorInput('us:MO'));
    expect(await gate.recalcSafely()).toEqual({ opened: 1, closed: 0 });
    expect(await workingSet(['us'])).toHaveLength(8);

    // 幂等: 锚集不变 ⇒ 重跑零行变更 (前置条件过滤生效, 不产生无谓写放大)。
    expect(await gate.recalcSafely()).toEqual({ opened: 0, closed: 0 });
  });

  // ── state_branch: 删除锚 → 移出工作集、历史数据不删 ─────────────────────────

  it('删锚 → 移出工作集, 且已落库 daily_bar 历史行**一条不少**', async () => {
    const id = await seedInstrument('us', 'TAP');
    await seedBar(id, '2026-06-01', '55.10');
    await seedBar(id, '2026-06-02', '54.30');
    const created = await createAnchor.execute(anchorInput('us:TAP'));
    await gate.recalcSafely();
    expect(await workingSet(['us'])).toEqual(['us:TAP']);

    await deleteAnchor.execute(created.id);
    const result = await gate.recalcSafely();

    expect(result).toEqual({ opened: 0, closed: 1 });
    expect(await needSyncOf('us', 'TAP')).toBe(false);
    expect(await workingSet(['us'])).toEqual([]);
    // 闸只管**要不要继续采**, 不是数据保留策略 —— 历史行是既成事实, 删锚 MUST NOT 连坐。
    expect(await prisma.dailyBar.count({ where: { instrumentId: id } })).toBe(2);
    // 标的本身也仍在 universe (全量入库供搜索, 与「要不要采」彻底分开)。
    expect(await prisma.instrument.count({ where: { market: 'us', code: 'TAP' } })).toBe(1);
  });

  // ── state_branch: excluded 不参与闸判定 (Guardrail 8 / FR-028) ──────────────

  it('🚨 excluded=true 的锚其标的**仍在**工作集 (锚=采集意愿, excluded=交易意愿)', async () => {
    await seedInstrument('us', 'PSKY');
    await createAnchor.execute(anchorInput('us:PSKY', true));

    await gate.recalcSafely();

    // 期权 EOD **无跨日补救**: 误停采一天就是永久断层, 而多采一只已排除的标的只是几次
    // API 调用 ⇒ 要彻底停采只能**删锚**, 不是打 excluded。
    expect(await needSyncOf('us', 'PSKY')).toBe(true);
    expect(await workingSet(['us'])).toEqual(['us:PSKY']);

    // 反证同一条边界: 把锚删掉 (而非改 excluded) 才关闸。
    const [anchor] = await prisma.anchor.findMany({ select: { id: true } });
    await deleteAnchor.execute(anchor!.id);
    await gate.recalcSafely();
    expect(await needSyncOf('us', 'PSKY')).toBe(false);
  });

  // ── state_branch: 锚表读取失败 → 采集侧只 warn 不上抛 (FR-029) ──────────────

  it('🚨 锚表读取失败 → 只 warn 返 null, 且 SyncRun 不被置 failed (FR-029)', async () => {
    await seedInstrument('us', 'CPB');
    await createAnchor.execute(anchorInput('us:CPB'));
    await gate.recalcSafely();
    expect(await needSyncOf('us', 'CPB')).toBe(true);

    const warn = vi.spyOn(
      (gate as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    );
    // 权限模拟不便在 superuser 容器里做 ⇒ 用「表不可见」等价制造读失败, 用完还原。
    await prisma.$executeRawUnsafe('ALTER TABLE optionsdesk.anchor RENAME TO anchor_broken_it');
    try {
      const result = await gate.recalcSafely();

      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      // 读失败 ⇒ 一行都不动: 拿不到锚集就按空集关闸 = 把在采标的全部误停。
      expect(await needSyncOf('us', 'CPB')).toBe(true);

      // 端到端: 前置重算失败 MUST NOT 冒泡到 executor 顶层 catch (那会把整条采集链记成
      // failed) —— 跑一轮真维度, SyncRun 收 success。
      const registry = buildRegistry(gate);
      await registry.execute('eod_bar', { mode: 'delta', asOf: AS_OF, now: NOW }, 'job-gate-1');

      const run = await prisma.syncRun.findFirst({ where: { syncType: 'sync:eod_bar' } });
      expect(run?.status).toBe('success');
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE optionsdesk.anchor_broken_it RENAME TO anchor');
      warn.mockRestore();
    }
  });

  // ── SC-007: cn/hk 同步范围 + 既有 22 维度运行状态零变化 ──────────────────────

  it('🚨 SC-007: cn/hk 既有标的同步范围零变化 (受闸市场恒为 us)', async () => {
    await seedInstrument('cn', '600519');
    await seedInstrument('cn', '000001');
    await seedInstrument('hk', '00700');
    await seedInstrument('us', 'VICI');
    const cnHkBefore = await workingSet(['cn', 'hk']);
    expect(cnHkBefore).toEqual(['cn:600519', 'cn:000001', 'hk:00700']);

    // 只有一只 us 锚, cn/hk 一只锚都没有 —— 若关闸路径误放到 cn/hk, 这里会被一次清空。
    await createAnchor.execute(anchorInput('us:VICI'));
    await gate.recalcSafely();

    expect(await workingSet(['cn', 'hk'])).toEqual(cnHkBefore);
    expect(await needSyncOf('cn', '600519')).toBe(true);
    expect(await needSyncOf('hk', '00700')).toBe(true);

    // cn/hk 锚同样不影响 cn/hk (它们本就全量采, 闸对其无意义)。
    await createAnchor.execute(anchorInput('cn:600519'));
    await gate.recalcSafely();
    expect(await workingSet(['cn', 'hk'])).toEqual(cnHkBefore);
  });

  it('🚨 SC-007: 既有同步维度的运行状态零变化 (闸只碰 needSync 一列)', async () => {
    // ⚠️ spec / plan 写的「22 维度」是**过时数字**, 且每次加维度都会把写死的数字再顶旧一次
    // (046 顶到 25、047 顶到 28)。SC-007 的不变量是「**零变化**」而非那个字面数字 ⇒ 行数改为从
    // DIMENSION_KEYS 派生 (只作「确实读到了全部 seed 行」的旁证), 真正承重的是下面整体比对前后快照。
    // 046/047 新增的维度均属 **marketdata** 模块, 与 FR-029「optionsdesk 不得注册进 SyncDimension」
    // 不矛盾 —— 闸仍然只碰 needSync 一列, 前后快照照样必须逐字段相等。
    const dimsBefore = await prisma.syncDimension.findMany({ orderBy: { dimensionKey: 'asc' } });
    expect(dimsBefore).toHaveLength(DIMENSION_KEYS.length);

    await seedInstrument('us', 'PEP');
    await createAnchor.execute(anchorInput('us:PEP'));
    await gate.recalcSafely();

    // 本 feature **不增同步维度**: 闸是维度的前置筛范围, 不是新维度 (FR-029 方向铁律 ——
    // optionsdesk MUST NOT 被注册进 SyncDimension / executor 钩子)。
    expect(await prisma.syncDimension.findMany({ orderBy: { dimensionKey: 'asc' } })).toEqual(
      dimsBefore,
    );
    // 重算不产生任何 SyncRun 行 (它是前置步骤, 不是自管 run 的维度)。
    expect(await prisma.syncRun.count()).toBe(0);
  });

  it('🚨 只碰 needSync 一列 (Guardrail 6 受保护列): syncTier / lixingerCompanyType 不被覆盖', async () => {
    await seedInstrument('us', 'LULU');
    await prisma.instrument.update({
      where: { market_code: { market: 'us', code: 'LULU' } },
      data: { syncTier: 0, lixingerCompanyType: 'other' },
    });
    await createAnchor.execute(anchorInput('us:LULU'));

    await gate.recalcSafely();

    const row = await prisma.instrument.findUnique({
      where: { market_code: { market: 'us', code: 'LULU' } },
      select: { needSync: true, syncTier: true, lixingerCompanyType: true },
    });
    expect(row).toEqual({ needSync: true, syncTier: 0, lixingerCompanyType: 'other' });
  });

  /**
   * `DimensionExecutorRegistry` 装配 (体例同 marketdata.dimension-executor.it.spec.ts)。
   * `anchorGate` 是构造器**最后一位**, 中间 17 位 (backfillPacer + 039-043 各端口) 全走
   * null-object 默认 ⇒ 用 `undefined` 占位。
   */
  function buildRegistry(anchorGate: AnchorDrivenSyncGate): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    const args = [
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      mock,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
      ...Array.from({ length: 17 }, () => undefined),
      anchorGate,
    ] as unknown as ConstructorParameters<typeof DimensionExecutorRegistry>;
    return new DimensionExecutorRegistry(...args);
  }
});
