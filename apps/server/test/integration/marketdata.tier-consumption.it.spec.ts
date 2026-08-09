import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import type { EodBarPort } from '../../src/marketdata/eod-bar.port';
import type { EodBarPoint, EodBarQuery } from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 (Asia/Shanghai 交易日)
const AS_OF = '2026-06-03';

/** 任一 symbol 在目标日返一根 bar 的记录型 eod adapter (per-instrument 调用序探针, D6)。 */
function recordingEod(date: string): { port: EodBarPort; calls: string[] } {
  const calls: string[] = [];
  const port: EodBarPort = {
    getBars: async (q: EodBarQuery): Promise<EodBarPoint[]> => {
      calls.push(q.symbol);
      return [
        {
          tradeDate: date,
          adjust: q.adjust,
          open: '1',
          high: '1',
          low: '1',
          close: '1',
          changePct: null,
          prevClose: null,
          volume: null,
          amount: null,
          turnoverRate: null,
        },
      ];
    },
  };
  return { port, calls };
}

/** 调用序去重保留首现序 (Set 插入序) — 020 后每标的 1 次 none 调用, 去重为防御性保留。 */
const firstSeen = (calls: string[]): string[] => [...new Set(calls)];

// 018 PR-2 tier 序消费 IT (Testcontainers PG-only, registry 直调): orderBy tier 序后
// T0 (自选并集) 全部先于 T2 消费 (FR-S03, SC-S02); maxEodInstruments 截断按 tier 序生效
// → T0 保底 + T2 顺延续跑零重复 (FR-S04, SC-S03); universe upsert 护值 + 黑名单 > tier
// 回归断言 (FR-S05/S09, SC-S05)。重算 = executor 前置自动发生 (018 T002), 无需预置 tier。
describe('018 PR-2 tier-ordered consumption + truncation floor + regressions', () => {
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
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    await prisma.watchlistItem.deleteMany();
    await prisma.group.deleteMany();
    await prisma.syncBlacklist.deleteMany();
  });

  /** registry: eod 口走注入 port (记录序/控量), 其余口 mock (蓝本 dimension-executor IT)。 */
  function buildRegistry(eodBar: EodBarPort): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      eodBar,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
    );
  }

  /** seed n 个活跃 cn 标的 (顺序 create → id 升序 = 既有稳定序), syncTier 默认 2。 */
  async function seedInstruments(codes: string[]): Promise<void> {
    for (const code of codes) {
      await prisma.instrument.create({
        data: {
          market: 'cn',
          code,
          name: `股${code}`,
          type: 'stock',
          currency: 'CNY',
          status: 'active',
        },
      });
    }
  }

  /** seed 一个自选组 + items (T0 信号源; custom 组绕开 @@unique(accountId, systemKind))。 */
  async function seedWatchlist(codes: string[]): Promise<void> {
    const group = await prisma.group.create({
      data: { accountId: 1001n, name: '自选', type: 'custom', order: 0 },
    });
    await prisma.watchlistItem.createMany({
      data: codes.map((code, i) => ({ groupId: group.id, market: 'cn', code, order: i })),
    });
  }

  /** 目标日已落 bar 的标的 code 集 (tier 无关, 验「谁被同步了」)。 */
  async function syncedCodes(): Promise<Set<string>> {
    const rows = await prisma.dailyBar.findMany({
      where: { tradeDate: new Date(`${AS_OF}T00:00:00Z`) },
      select: { instrument: { select: { code: true } } },
      distinct: ['instrumentId'],
    });
    return new Set(rows.map((r) => r.instrument.code));
  }

  it('T004 消费序: T0 (高 id 自选) 整体先于任何 T2, 同 tier 内保持 id 稳定序 (SC-S02)', async () => {
    // 自选挑 id 最大的两个 → 若仍按 id 序消费则 T0 排最后, 断言必红。
    await seedInstruments(['000001', '000002', '000003', '000004', '000005']);
    await seedWatchlist(['000004', '000005']);
    const { port, calls } = recordingEod(AS_OF);

    await buildRegistry(port).execute('eod_bar', { mode: 'delta', asOf: AS_OF, now: NOW });

    // 断言消费顺序而非仅最终状态 (D6): T0 符号集整体先于任何 T2 符号。
    expect(firstSeen(calls)).toEqual([
      'cn:000004',
      'cn:000005',
      'cn:000001',
      'cn:000002',
      'cn:000003',
    ]);
    // 前置重算证据: T0 由本次 executor 起手快照得出 (非预置 tier)。
    const hit = await prisma.instrument.findMany({
      where: { syncTier: 0 },
      select: { code: true },
    });
    expect(new Set(hit.map((i) => i.code))).toEqual(new Set(['000004', '000005']));
  });

  it('T005 截断保底 + 顺延续跑: 预算够 T0+部分 T2 → T0 全落库; 续跑进度锚跳过已同步, 零重复 (SC-S03)', async () => {
    await seedInstruments(['000001', '000002', '000003', '000004', '000005']);
    await seedWatchlist(['000004', '000005']); // T0 = 2 个 (高 id)
    const input = { mode: 'delta' as const, asOf: AS_OF, now: NOW };

    // 窗1: 预算 3 (> T0 数 2 且 < 总数 5) → T0 全保底 + 1 个 T2, 其余截断顺延。
    const win1 = recordingEod(AS_OF);
    const first = await buildRegistry(win1.port).execute('eod_bar', {
      ...input,
      maxEodInstruments: 3,
    });
    expect(first.budgetExhausted).toBe(true); // 017 顺延信号语义不变
    expect(first.stats.skipped).toBe(2); // 截断的 T2 计 skipped (非失败)
    expect(await syncedCodes()).toEqual(new Set(['000004', '000005', '000001']));

    // 窗2 (顺延续跑): pendingEodInstruments 进度锚跳过已同步, 剩余 T2 按 tier 序继续。
    const win2 = recordingEod(AS_OF);
    const second = await buildRegistry(win2.port).execute('eod_bar', {
      ...input,
      maxEodInstruments: 3,
    });
    expect(second.budgetExhausted).toBe(false);
    expect(firstSeen(win2.calls)).toEqual(['cn:000002', 'cn:000003']); // 已同步不重拉
    expect(await syncedCodes()).toEqual(
      new Set(['000001', '000002', '000003', '000004', '000005']),
    );
    // 零重复行: 5 标的 × none 1 行 (020 T008 单口径), 非翻倍。
    expect(await prisma.dailyBar.count()).toBe(5);
  });

  it('T006① universe upsert 护值: 既有标的 syncTier=0 经周更 upsert 后仍 0 (FR-S05 回归)', async () => {
    // 预置 T0 标的 (mock universe enumerate 含 600519 → 走 update 路径)。
    await prisma.instrument.create({
      data: {
        market: 'cn',
        code: '600519',
        name: '贵州茅台',
        type: 'stock',
        currency: 'CNY',
        status: 'active',
        syncTier: 0,
      },
    });

    await buildRegistry(new MockMarketDataAdapter()).execute('universe', {
      mode: 'delta',
      asOf: AS_OF,
      now: NOW,
    });

    const hit = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'cn', code: '600519' } },
    });
    expect(hit.syncTier).toBe(0); // 不被默认值覆盖
    // 新标的默认 2 等下次重算。
    const others = await prisma.instrument.findMany({ where: { code: { not: '600519' } } });
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((i) => i.syncTier === 2)).toBe(true);
  });

  it('采集闸: needSync=false 的标的不进工作集 (vendor 零调用 + 零落库), 其余照常同步', async () => {
    // 闸与 tier 正交: 三只均 T2 (无自选), 只有 needSync 差异 → 差异只可能来自闸。
    await seedInstruments(['000001', '000002', '000003']);
    await prisma.instrument.update({
      where: { market_code: { market: 'cn', code: '000002' } },
      data: { needSync: false },
    });

    const { port, calls } = recordingEod(AS_OF);
    await buildRegistry(port).execute('eod_bar', { mode: 'delta', asOf: AS_OF, now: NOW });

    // 全等断言 (非 not.toContain 单点): 闸若失效, 调用序必含 000002 → 本例必红。
    expect(firstSeen(calls)).toEqual(['cn:000001', 'cn:000003']);
    expect(await syncedCodes()).toEqual(new Set(['000001', '000003']));
    // 闸只挡工作集, 不动标的行本身 (仍在库供搜索 / 发现候选)。
    expect(await prisma.instrument.count()).toBe(3);
  });

  it('T006② 黑名单 > tier: 自选 (T0 候选) 标的入黑名单 → universe 不 insert + 维度同步零调用 (FR-S09)', async () => {
    await prisma.syncBlacklist.create({ data: { market: 'cn', code: '600519', reason: 'test' } });
    await seedWatchlist(['600519']); // 无论 tier 资格, 黑名单完全跳过

    const { port, calls } = recordingEod(AS_OF);
    const registry = buildRegistry(port);
    const input = { mode: 'delta' as const, asOf: AS_OF, now: NOW };
    await registry.execute('universe', input);
    await registry.execute('eod_bar', input);

    // 黑名单命中不 insert → 工作集无此标的 → vendor 零调用 (重算只更新存在的 Instrument 行)。
    expect(await prisma.instrument.count({ where: { code: '600519' } })).toBe(0);
    expect(calls).not.toContain('cn:600519');
    // 其余 universe 标的 (mock 另 2 个) 照常同步, 不受黑名单连坐。
    expect(firstSeen(calls)).toEqual(['cn:000001', 'cn:430047']);
  });
});
