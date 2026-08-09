import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import { HOT_TYPES, LixingerHotAdapter } from '../../src/marketdata/lixinger-hot.adapter';
import type { HotSnapshotPort } from '../../src/marketdata/hot-snapshot.port';
import type { HotSnapshotDto, HotSnapshotQuery } from '../../src/marketdata/marketdata.types';
import type { VendorHttpClient } from '../../src/marketdata/vendor-http-client';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';
// hot 无 mode 分支, 复用 delta input (mode 值不影响行为)。
const input = { mode: 'delta' as const, asOf: AS_OF, now: NOW };

// 040 T009 US2 热度精选快照集成 IT (Testcontainers PG, test-local mock hk, 固定 mock last_data_date
// 驱累积/覆盖两分支): hot_snapshot 经 executor **无 mode × HOT_TYPES type 循环** 按自然键
// (instrumentId, hotType, dataDate=last_data_date) upsert 落库 —— 4 type 各一行 + payload 异构存原始字段 +
// 按 dataDate 累积 (同 dataDate 覆盖同行、变则落新行) + 幂等 + 忽略异常 key "undefined" (真 adapter 路径) +
// param 契约 (stockCodes[] 数组 + 无日期) + marketScope={hk} 纳 hk 排 cn。落库经真 PG。
// 覆盖 state_branch: 热度快照按数据日期累积 / 热度不可回填 / 热度精选 type / hot payload 异构 /
// vendor 数据质量容错 / param 契约三分 (hot 侧, executor)。
describe('040 T009 hot_snapshot 快照累积 (Testcontainers PG, mock hk)', () => {
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
    await prisma.hotSnapshot.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T002 (040 Phase 1) migration seed 已把 hot_snapshot marketScope={hk} + historyDepth=NULL;
    // 显式复位保各例独立 (不篡改 seed 语义, 只固定测试起点)。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: 'hot_snapshot' },
      data: { marketScope: ['hk'], historyDepth: null },
    });
  });

  /**
   * test-local hk hot adapter: 记 calls (验请求走 stockCodes[] 数组 + 无日期), 每次调用经 rowsFor
   * 闭包生成 DTO (测试可控 dataDate 驱累积/覆盖两分支)。served 集外 → [] (无数据标的)。
   */
  class HkHotMock implements HotSnapshotPort {
    readonly calls: HotSnapshotQuery[] = [];
    constructor(private readonly rowsFor: (q: HotSnapshotQuery) => HotSnapshotDto[]) {}
    async getHotSnapshot(query: HotSnapshotQuery): Promise<HotSnapshotDto[]> {
      this.calls.push(query);
      return this.rowsFor(query);
    }
  }

  function buildRegistry(opts: { hotSnapshot?: HotSnapshotPort }): DimensionExecutorRegistry {
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
      opts.hotSnapshot ?? mock, // hotSnapshot (尾部)
    );
  }

  async function seedHk(code: string, name: string): Promise<bigint> {
    const inst = await prisma.instrument.create({
      data: {
        market: 'hk',
        code,
        name,
        type: 'stock',
        currency: 'HKD',
        status: 'active',
        lixingerCompanyType: 'non',
      },
    });
    return inst.id;
  }

  // 各 type 异构 payload (照 p3 探查报告 §hot 字段样本; 每 type 结构不同)。
  function heteroPayload(hotType: string): Record<string, unknown> {
    const byType: Record<string, Record<string, unknown>> = {
      ss: { ass_m: 0.12, ass_s: 1000, ass_s_cap_r: 0.05, stockCode: '00700' },
      tr: { tr_d1: 0.02, tr_d5: 0.015, tr_d20: 0.011, spc: 380, stockCode: '00700' },
      capita: { stn: 50000, stn_mc_pc: 0.3, stn_toi_pc: 0.12, stockCode: '00700' },
      rep: { rs_m1: 0.9, rs_m3: 0.85, rs_last: 1.1, stockCode: '00700' },
    };
    return byType[hotType] ?? { stockCode: '00700' };
  }

  // ── ① 4 type 落库 + payload 异构存原始字段 (热度精选 type / hot payload 异构) ──
  it('① 4 type (ss/tr/capita/rep) → 每 (instrumentId,hotType,dataDate) 落行 + payload 异构存原始字段', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const hot = new HkHotMock((q) => [
      { hotType: q.hotType, dataDate: '2026-06-01', payload: heteroPayload(q.hotType) },
    ]);
    const registry = buildRegistry({ hotSnapshot: hot });

    const { stats } = await registry.execute('hot_snapshot', input);

    expect(stats).toMatchObject({
      scanned: HOT_TYPES.length,
      ok: HOT_TYPES.length,
      failed: 0,
    });
    const rows = await prisma.hotSnapshot.findMany({
      where: { instrumentId: instId },
      orderBy: { hotType: 'asc' },
    });
    expect(rows).toHaveLength(HOT_TYPES.length);
    expect(rows.map((r) => r.hotType).sort()).toEqual([...HOT_TYPES].sort());
    // payload 异构存: ss 与 tr 字段结构完全不同, 均整存原始字段。
    const ss = rows.find((r) => r.hotType === 'ss')!;
    expect(ss.payload).toMatchObject({ ass_m: 0.12, ass_s: 1000, ass_s_cap_r: 0.05 });
    const tr = rows.find((r) => r.hotType === 'tr')!;
    expect(tr.payload).toMatchObject({ tr_d1: 0.02, tr_d20: 0.011, spc: 380 });
    const run = await prisma.syncRun.findFirstOrThrow({ where: { syncType: 'sync:hot_snapshot' } });
    expect(run.status).toBe('success');
  });

  // ── ② 按 dataDate 累积: 同 last_data_date 覆盖同行不新增; 变则落新行 (前向序列) + 幂等 ──
  it('② 按 dataDate 累积: 同 last_data_date 再跑 → 覆盖同行不新增; last_data_date 变 → 落新行 (前向序列)', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    let currentDate = '2026-06-01';
    const hot = new HkHotMock((q) => [
      { hotType: q.hotType, dataDate: currentDate, payload: { m: q.hotType, d: currentDate } },
    ]);
    const registry = buildRegistry({ hotSnapshot: hot });

    // 首跑: 每 type 1 行 (dataDate=2026-06-01)。
    await registry.execute('hot_snapshot', input);
    expect(await prisma.hotSnapshot.count({ where: { instrumentId: instId } })).toBe(
      HOT_TYPES.length,
    );

    // 同 dataDate 再跑 → 覆盖同行不新增 (幂等)。
    await registry.execute('hot_snapshot', input);
    expect(await prisma.hotSnapshot.count({ where: { instrumentId: instId } })).toBe(
      HOT_TYPES.length,
    );

    // dataDate 变 → 落新行 (前向累积, 不覆盖旧日期)。
    currentDate = '2026-06-02';
    await registry.execute('hot_snapshot', input);
    expect(await prisma.hotSnapshot.count({ where: { instrumentId: instId } })).toBe(
      HOT_TYPES.length * 2,
    );
    // 同一 (instrumentId, hotType='ss') 现有 2 个 dataDate (前向序列)。
    const ssRows = await prisma.hotSnapshot.findMany({
      where: { instrumentId: instId, hotType: 'ss' },
      orderBy: { dataDate: 'asc' },
    });
    expect(ssRows.map((r) => r.dataDate.toISOString().slice(0, 10))).toEqual([
      '2026-06-01',
      '2026-06-02',
    ]);
  });

  // ── ③ 同 dataDate payload 更新 → 覆盖同行反映最新值 (upsert update, SC-002/003) ──
  it('③ 同 dataDate payload 变化 → 覆盖同行反映最新值 (upsert update, 不新增)', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    let payloadVal = 1;
    const hot = new HkHotMock((q) => [
      { hotType: q.hotType, dataDate: '2026-06-01', payload: { m: q.hotType, v: payloadVal } },
    ]);
    const registry = buildRegistry({ hotSnapshot: hot });

    await registry.execute('hot_snapshot', input);
    payloadVal = 2; // 同 dataDate, payload 更新
    await registry.execute('hot_snapshot', input);

    expect(await prisma.hotSnapshot.count({ where: { instrumentId: instId } })).toBe(
      HOT_TYPES.length,
    ); // 覆盖不新增
    const ss = await prisma.hotSnapshot.findFirstOrThrow({
      where: { instrumentId: instId, hotType: 'ss' },
    });
    expect(ss.payload).toMatchObject({ v: 2 }); // 反映最新值
  });

  // ── ④ vendor 数据质量容错: 真 adapter + stub http, rep payload 含异常 key "undefined" → 落库无 undefined key ──
  it('④ vendor 数据质量容错: hot payload 含异常 key "undefined" → 真 adapter 忽略, 落库 payload 无 undefined key (FR-007)', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    // 真 LixingerHotAdapter + stub http: 返含 "undefined" 异常 key 的 rep 快照 (vendor 数据质量)。
    // stub 忽略 path → 4 type 均得此响应 (executor 循环 4 次, 各落 1 行, 均已剥离 undefined key)。
    const stubHttp = {
      request: async () => ({
        code: 1,
        message: 'success',
        data: [
          {
            rs_m1: 0.9,
            rs_last: 1.1,
            undefined: 'garbage-value',
            last_data_date: '2026-06-01T00:00:00+08:00',
            stockCode: '00700',
          },
        ],
      }),
    } as unknown as VendorHttpClient;
    const realAdapter = new LixingerHotAdapter(
      stubHttp,
      'test-token',
      'https://open.lixinger.com/api',
    );
    const registry = buildRegistry({ hotSnapshot: realAdapter });

    await registry.execute('hot_snapshot', input);

    const rows = await prisma.hotSnapshot.findMany({ where: { instrumentId: instId } });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // 异常 key "undefined" 已被 adapter 忽略, 落库 payload 不含之。
      expect(Object.keys(r.payload as object)).not.toContain('undefined');
      // 正常字段保留 (payload 整存)。
      expect(r.payload).toMatchObject({ rs_m1: 0.9, rs_last: 1.1 });
    }
  });

  // ── ⑤ 热度不可回填 + param 契约 (hot 侧): backfill 模式与 delta 同行为, 请求 stockCodes[] 数组 + 无日期 ──
  it('⑤ 热度不可回填: backfill 模式与 delta 同行为 (无 mode 分支, 只拉当前快照) + param 契约 stockCodes[] 数组无日期', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const hot = new HkHotMock((q) => [
      { hotType: q.hotType, dataDate: '2026-06-01', payload: { m: q.hotType } },
    ]);
    const registry = buildRegistry({ hotSnapshot: hot });

    // backfill 模式 (含 backfillHistoryDays) → hot 忽略 mode/历史深度, 仍只拉当前快照 1 行/type (不回填历史)。
    await registry.execute('hot_snapshot', {
      mode: 'backfill',
      asOf: AS_OF,
      now: NOW,
      backfillHistoryDays: 3650,
    });
    expect(await prisma.hotSnapshot.count({ where: { instrumentId: instId } })).toBe(
      HOT_TYPES.length,
    ); // 与 delta 同 = 每 type 1 行, 无历史回填

    // param 契约三分 (hot 侧): 请求 stockCodes[] 数组 + 无 from/to (快照)。
    expect(hot.calls).toHaveLength(HOT_TYPES.length);
    for (const c of hot.calls) {
      expect(Array.isArray(c.stockCodes)).toBe(true);
      expect(c.stockCodes).toEqual(['hk:00700']);
      expect(c).not.toHaveProperty('from');
      expect(c).not.toHaveProperty('to');
    }
  });

  // ── ⑥ marketScope={hk} → hk 标的入工作集处理、cn 标的排除 (2 维度 marketScope 纳入, hot 侧) ──
  it('⑥ marketScope={hk} → hk 标的入工作集处理, cn 标的排除 (2 维度 marketScope 纳入)', async () => {
    const hkId = await seedHk('00700', '腾讯控股');
    const cnInst = await prisma.instrument.create({
      data: {
        market: 'cn',
        code: '600519',
        name: '贵州茅台',
        type: 'stock',
        currency: 'CNY',
        status: 'active',
      },
    });
    const hot = new HkHotMock((q) => [
      { hotType: q.hotType, dataDate: '2026-06-01', payload: heteroPayload(q.hotType) },
    ]);
    const registry = buildRegistry({ hotSnapshot: hot });

    const { stats } = await registry.execute('hot_snapshot', input);

    // 仅 hk 标的入工作集 (marketScope={hk}) → cn 从不被请求。
    expect(stats).toMatchObject({ scanned: HOT_TYPES.length, ok: HOT_TYPES.length, failed: 0 });
    expect(hot.calls.every((c) => c.stockCodes.every((s) => s === 'hk:00700'))).toBe(true);
    expect(await prisma.hotSnapshot.count({ where: { instrumentId: hkId } })).toBe(
      HOT_TYPES.length,
    );
    expect(await prisma.hotSnapshot.count({ where: { instrumentId: cnInst.id } })).toBe(0);
  });
});
