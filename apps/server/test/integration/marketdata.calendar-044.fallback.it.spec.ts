import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';
import { CalendarSourceFallbackChain } from '../../src/marketdata/calendar-source-fallback-chain.adapter';
import { DbTradingCalendarAdapter } from '../../src/marketdata/db-trading-calendar.adapter';
import { isTradingDayGateOpen } from '../../src/marketdata/trading-day-gate';
import { TradingCalendarSyncService } from '../../src/marketdata/trading-calendar-sync.service';
import type { TradingCalendarSource } from '../../src/marketdata/trading-calendar-source.port';

/**
 * 044 T009 US1 多源降级集成 IT (Testcontainers PG, **真** `CalendarSourceFallbackChain` +
 * test-local mock 源)。验「链 → service → 真 PG → gate 读表」整条路: 主源健康时备源零打扰;
 * 主源挂时**自动降级、日历照常完整落库**、gate 照常开启; 一市场全链失败**不连坐**其余市场。
 *
 * ★ **本 feature 的立意**: 东财日历源被定向下线 → 填充静默停摆 2 天。根因不是「源挂了」而是
 * 「单点 + 无降级 + 无告警」⇒ 这里验的是**降级不中断**这一半 (告警那一半 = US3 / T012-T014)。
 *
 * ⚠️ **不重复既有覆盖** (B3 去重): 「幂等 (同 (market,date) 不翻倍)」与「单市场源抛错 → 续跑
 * 其余市场」已由 `marketdata.trading-calendar-sync.it.spec.ts` (`:93` / `:106`) 覆盖, 由
 * T001 (契约) / T012 (断言改写) 维护 —— **本文件只测新行为 (降级链)**, 不再造一份。
 *
 * 真 vendor 契约不在此验 (env-gated `marketdata.tencent.vendor`); 链的节点选择纯逻辑亦不在此
 * 重验 (`calendar-source-fallback-chain.adapter.spec.ts`) —— 此处补的是二者都覆盖不到的缝:
 * **链 + 真落库 + gate 的合成行为**。
 */

/** 填充窗 (日常 populate 恒 30 天窗)。 */
const FROM = '2026-06-16';
const TO = '2026-07-16';

/**
 * cn 窗内交易日 = 全部 23 个工作日 (含 **07-01**: 港股休市但 A 股开市 —— PoC 三方互证探针日,
 * 见 plan Guardrail 6「Connect 关闭 ≠ 市场休市」)。
 */
const CN_TRADING_DATES = [
  '2026-06-16',
  '2026-06-17',
  '2026-06-18',
  '2026-06-19',
  '2026-06-22',
  '2026-06-23',
  '2026-06-24',
  '2026-06-25',
  '2026-06-26',
  '2026-06-29',
  '2026-06-30',
  '2026-07-01',
  '2026-07-02',
  '2026-07-03',
  '2026-07-06',
  '2026-07-07',
  '2026-07-08',
  '2026-07-09',
  '2026-07-10',
  '2026-07-13',
  '2026-07-14',
  '2026-07-15',
  '2026-07-16',
];

/** hk 窗内交易日 = 工作日减 07-01 (香港特别行政区成立日休市) → 22 天。 */
const HK_TRADING_DATES = CN_TRADING_DATES.filter((d) => d !== '2026-07-01');

/** test-local 活源: 按 market 返预置日历 + 自报家门 (未预置的 market → throw, 模拟取数失败)。 */
function healthyNode(byMarket: Record<string, string[]>, servedBy: string): TradingCalendarSource {
  return {
    fetchTradingDates: vi.fn(async (market: string) => {
      const dates = byMarket[market];
      if (!dates) throw new Error(`[${servedBy}] 无 ${market} 数据`);
      return { dates, sessionKinds: {}, servedBy };
    }),
  };
}

/** test-local 死节点: 恒抛 (模拟 L1 vendor 被下线 / L2 静态表区间外)。 */
function deadNode(msg: string): TradingCalendarSource {
  return {
    fetchTradingDates: vi.fn(async () => {
      throw new Error(msg);
    }),
  };
}

/** syncRange 不读 cfg (仅 @Cron handleCron 读 tickEnabled) → IT 传最小占位。 */
const CFG = { tickEnabled: true } as unknown as MarketdataSyncConfig;

/**
 * 前瞻源占位 (062 T004 起 `TradingCalendarSyncService` 的第 4 个依赖)。本文件只走
 * `syncRange` (历史段) —— 前瞻段由 `marketdata.calendar-062.horizon.it.spec.ts` 专门覆盖。
 * 故此处放一个**碰到即抛**的占位: 若哪天历史段意外触达前瞻源, 测试会当场红而不是静默走通。
 */
const NO_FORWARD: TradingCalendarSource = {
  fetchTradingDates: async () => {
    throw new Error('[test] 本文件的用例不应触达前瞻源');
  },
};

describe('044 US1 日历源多源降级 (Testcontainers PG, 真 fallback 链 + 真落库)', () => {
  let prisma: PrismaService;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.tradingDay.deleteMany();
    await prisma.calendarCoverage.deleteMany();
  });

  /** 装配「真链 + service」(节点由各 it 注入, 模拟各层健康/故障组合)。 */
  function serviceWith(nodes: TradingCalendarSource[]): TradingCalendarSyncService {
    return new TradingCalendarSyncService(
      new CalendarSourceFallbackChain(nodes),
      prisma,
      CFG,
      NO_FORWARD,
    );
  }

  const datesOf = async (market: string): Promise<string[]> =>
    (await prisma.tradingDay.findMany({ where: { market }, orderBy: { date: 'asc' } })).map((r) =>
      r.date.toISOString().slice(0, 10),
    );

  it('L1 成功 → 结果落库 + **不调 L2** (主源健康时备源零打扰)', async () => {
    const l1 = healthyNode({ cn: CN_TRADING_DATES }, 'tencent');
    const l2 = healthyNode({ cn: CN_TRADING_DATES }, 'static');

    const results = await serviceWith([l1, l2]).syncRange(['cn'], FROM, TO);

    expect(results).toEqual([{ market: 'cn', fetched: 23, inserted: 23 }]);
    expect(await datesOf('cn')).toEqual(CN_TRADING_DATES);
    // 🚨 L1 健康 → L2 一次都不该被打 (链短路)。
    expect(l2.fetchTradingDates).not.toHaveBeenCalled();
  });

  it('L1 成功 → 落库后 gate 据表判定 (交易日 trading / 窗内周末 non-trading, 填充前 unknown)', async () => {
    const gate = new DbTradingCalendarAdapter(prisma);
    // 填充前: 表空 + 无覆盖声明 → **unknown** (062 T006 起; 改动前是「近窗零行 ⇒ fail-open
    // true」)。经调用点的机械映射 `!== 'non-trading'` 后 gate 仍开 —— 空表照样不静默停摆整管线。
    expect(await gate.classify('cn', '2026-06-20')).toBe('unknown');
    expect(await isTradingDayGateOpen(gate, 'cn', '2026-06-20')).toBe(true);

    await serviceWith([healthyNode({ cn: CN_TRADING_DATES }, 'tencent')]).syncRange(
      ['cn'],
      FROM,
      TO,
    );

    // 填充后: 覆盖声明已推到 [FROM, TO] ⇒ 据表真判定, 不再靠放行侧兜底。
    expect(await gate.classify('cn', '2026-07-13')).toBe('trading'); // 周一, 表内有行
    expect(await gate.classify('cn', '2026-06-20')).toBe('non-trading'); // 周六, 声明内无行
  });

  it('🚨 L1 抛错 (源被下线) → 自动降级 L2 → 日历**完整**落库 + gate 照常开启', async () => {
    const l1 = deadNode('[tencent] 端点 503');
    const l2 = healthyNode({ cn: CN_TRADING_DATES }, 'static');

    const results = await serviceWith([l1, l2]).syncRange(['cn'], FROM, TO);

    // 降级后填充照常成功 —— 这就是「不中断」: 源挂了但同步没停。
    expect(results).toEqual([{ market: 'cn', fetched: 23, inserted: 23 }]);
    expect(await datesOf('cn')).toEqual(CN_TRADING_DATES);
    expect(l2.fetchTradingDates).toHaveBeenCalledOnce();

    const gate = new DbTradingCalendarAdapter(prisma);
    expect(await gate.classify('cn', '2026-07-13')).toBe('trading');
    expect(await gate.classify('cn', '2026-06-20')).toBe('non-trading');
  });

  it('🚨 降级后结果与 L1 成功时**同构** (service 返回值 + 落库行逐一等值)', async () => {
    // ① L1 健康路径。
    const healthy = await serviceWith([
      healthyNode({ cn: CN_TRADING_DATES }, 'tencent'),
      healthyNode({ cn: CN_TRADING_DATES }, 'static'),
    ]).syncRange(['cn'], FROM, TO);
    const healthyRows = await datesOf('cn');

    await prisma.tradingDay.deleteMany();
    await prisma.calendarCoverage.deleteMany();

    // ② L1 挂 → L2 接住 (同一份日历数据)。
    const degraded = await serviceWith([
      deadNode('[tencent] 端点被定向下线'),
      healthyNode({ cn: CN_TRADING_DATES }, 'static'),
    ]).syncRange(['cn'], FROM, TO);
    const degradedRows = await datesOf('cn');

    // 同构 = 消费侧无从分辨走了哪层 (降级对下游透明); 「是否降级」只由 servedBy 心跳暴露 (T012)。
    expect(degraded).toEqual(healthy);
    expect(degradedRows).toEqual(healthyRows);
  });

  it('🚨 per-market 降级独立: hk 全链失败 + cn L1 成功 → cn 照常落库, hk 零行, 整体不失败', async () => {
    // L1: 只有 cn 有数据 (hk 抛); L2: 静态表两市场都答不了 (模拟年更漏跑 → 区间外) → hk 全链失败。
    const l1 = healthyNode({ cn: CN_TRADING_DATES }, 'tencent');
    const l2 = deadNode('[static] 请求区间未被静态表覆盖范围完全包含');

    const results = await serviceWith([l1, l2]).syncRange(['cn', 'hk'], FROM, TO);

    // hk 全链失败 → 计 0 且**不抛**; cn 不被连坐, 照常落库 (FR-004「一市场坏不拖垮全局」)。
    expect(results).toEqual([
      { market: 'cn', fetched: 23, inserted: 23 },
      { market: 'hk', fetched: 0, inserted: 0 },
    ]);
    expect(await datesOf('cn')).toEqual(CN_TRADING_DATES);
    expect(await prisma.tradingDay.count({ where: { market: 'hk' } })).toBe(0);
  });

  it('per-market 降级独立: cn 由 L1 服务 + hk 降级 L2 → 两市场各自落库互不干扰', async () => {
    // L1 只答得了 cn (hk 抛) → hk 独立降级到 L2, cn 仍走 L1 —— 降级是 per-market 的, 非全局开关。
    const l1 = healthyNode({ cn: CN_TRADING_DATES }, 'tencent');
    const l2 = healthyNode({ hk: HK_TRADING_DATES }, 'static');

    const results = await serviceWith([l1, l2]).syncRange(['cn', 'hk'], FROM, TO);

    expect(results).toEqual([
      { market: 'cn', fetched: 23, inserted: 23 },
      { market: 'hk', fetched: 22, inserted: 22 },
    ]);
    expect(await datesOf('cn')).toEqual(CN_TRADING_DATES);
    // hk 少 07-01 (特区成立日休市) —— 降级到静态源后该市场日历仍**正确**, 非「能跑就行」。
    expect(await datesOf('hk')).toEqual(HK_TRADING_DATES);
    expect(await datesOf('hk')).not.toContain('2026-07-01');
  });

  it('L1 失效 + L2 命中 → 链透传 servedBy="static" (降级可观测手柄; 落库/告警见 T012-T014)', async () => {
    const chain = new CalendarSourceFallbackChain([
      deadNode('[tencent] 端点被定向下线'),
      healthyNode({ cn: CN_TRADING_DATES }, 'static'),
    ]);

    const { dates, servedBy } = await chain.fetchTradingDates('cn', FROM, TO);

    expect(dates).toEqual(CN_TRADING_DATES);
    // 🚨 填充「成功」但**已降级运行** —— 降级 ≠ 健康 (FR-014): servedBy 是让这一事实不静默的载体。
    expect(servedBy).toBe('static');
  });
});
