import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';
import { CalendarSourceFallbackChain } from '../../src/marketdata/calendar-source-fallback-chain.adapter';
import { TradingCalendarSyncService } from '../../src/marketdata/trading-calendar-sync.service';
import type { TradingCalendarSource } from '../../src/marketdata/trading-calendar-source.port';

/**
 * 044 T011 US2 合理性闸集成 IT (Testcontainers PG, **真** `CalendarSourceFallbackChain` +
 * test-local mock 源)。验「闸 → 链 → service → 真 PG」整条路上**毒饵一行都进不了库**。
 *
 * ★ **为什么闸必须在集成层再验一遍** (纯函数单测已覆盖判据本身):
 * 事故形态是「vendor 200 + 空数组」—— **HTTP 层无异常、链无 throw、service 无 catch**, 三层
 * 各自「正常」, 合起来却把空日历写进了 `trading_day` 并让 gate 从此说谎。这种**缝里的 bug**
 * 只有真落库才照得出: 此处断言面是 **`trading_day` 的真实行数**, 不是 mock 的调用次数。
 *
 * ⚠️ **不重复既有覆盖** (B3 去重): 闸的判据/阈值/短窗豁免已由
 * `calendar-source-fallback-chain.adapter.spec.ts` 纯函数覆盖; 降级链本身由 T009
 * `marketdata.calendar-044.fallback.it.spec.ts` 覆盖 —— **本文件只补「闸 + 真落库」的合成行为**。
 *
 * 📌 **心跳只断言「不更新」**: 心跳**写入**是 T012 的事 (本文件不提前实现)。此处埋一行已知心跳,
 * 断言全链不合理时它**纹丝不动** —— 为 US3 铺垫「失败 → 心跳陈旧 → 探针告警」的因果链。
 */

/** 填充窗 (日常 populate 恒 30 天窗): 自然日 31 / 工作日 23 → 闸下界 `ceil(23 × 0.4)` = **10**。 */
const FROM = '2026-06-16';
const TO = '2026-07-16';

/** cn 窗内交易日 = 全部 23 个工作日 (含 07-01: 港股休市但 A 股开市) —— 合理, 稳过闸。 */
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

/** 「稀薄」毒饵: 5 个交易日 < 下界 10 —— 30 天窗真实值恒 ~20, 5 个只可能是源坏了。 */
const THIN_DATES = CN_TRADING_DATES.slice(0, 5);

/**
 * 🚨 **毒饵节点**: HTTP 200 + **空数组**, 不抛错、不报错 —— 044 事故的真实形态
 * (旧东财源被定向下线后即如此回应)。闸不在, 这就是一份「今天起没有交易日」的权威答复。
 */
function poisonNode(dates: string[], servedBy: string): TradingCalendarSource {
  return { fetchTradingDates: vi.fn(async () => ({ dates, servedBy })) };
}

/** test-local 健康源: 按 market 返预置日历 + 自报家门 (未预置的 market → throw)。 */
function healthyNode(byMarket: Record<string, string[]>, servedBy: string): TradingCalendarSource {
  return {
    fetchTradingDates: vi.fn(async (market: string) => {
      const dates = byMarket[market];
      if (!dates) throw new Error(`[${servedBy}] 无 ${market} 数据`);
      return { dates, servedBy };
    }),
  };
}

/** syncRange 不读 cfg (仅 @Cron handleCron 读 tickEnabled) → IT 传最小占位。 */
const CFG = { tickEnabled: true } as unknown as MarketdataSyncConfig;

/** 预埋心跳 (模拟「昨天填充成功过」): 全链不合理时它必须**保持原样**。 */
const SEEDED_SUCCESS_AT = new Date('2026-07-15T13:00:00Z');

describe('044 US2 合理性闸 (Testcontainers PG, 真链 + 真落库: 毒饵零污染)', () => {
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
    await prisma.calendarSyncHealth.deleteMany();
  });

  /** 装配「真链 + service」(节点由各 it 注入, 模拟毒饵/健康组合)。 */
  function serviceWith(nodes: TradingCalendarSource[]): TradingCalendarSyncService {
    return new TradingCalendarSyncService(new CalendarSourceFallbackChain(nodes), prisma, CFG);
  }

  const datesOf = async (market: string): Promise<string[]> =>
    (await prisma.tradingDay.findMany({ where: { market }, orderBy: { date: 'asc' } })).map((r) =>
      r.date.toISOString().slice(0, 10),
    );

  it('🚨 L1 返**空数组** (200 + 空, 毒饵) → 闸判失败 → 降级 L2 → 日历**完整**落库', async () => {
    const l1 = poisonNode([], 'tencent');
    const l2 = healthyNode({ cn: CN_TRADING_DATES }, 'static');

    const results = await serviceWith([l1, l2]).syncRange(['cn'], FROM, TO);

    // 闸不在时: L1 的空被当成「区间无交易日」→ fetched 0 / inserted 0 → 日历静默停摆。
    expect(results).toEqual([{ market: 'cn', fetched: 23, inserted: 23 }]);
    expect(await datesOf('cn')).toEqual(CN_TRADING_DATES);
    expect(l2.fetchTradingDates).toHaveBeenCalledOnce();
  });

  it('🚨 L1 返**稀薄日历** (5 < 下界 10) → 闸判失败 → 降级 L2 → 落库的是 L2 的完整日历', async () => {
    const l1 = poisonNode(THIN_DATES, 'tencent');
    const l2 = healthyNode({ cn: CN_TRADING_DATES }, 'static');

    const results = await serviceWith([l1, l2]).syncRange(['cn'], FROM, TO);

    expect(results).toEqual([{ market: 'cn', fetched: 23, inserted: 23 }]);
    // 🚨 断言全等而非「包含」: L1 那 5 天**一天都不该**混进库 (闸判失败 = 整个答复作废, 非取并集)。
    expect(await datesOf('cn')).toEqual(CN_TRADING_DATES);
  });

  it('L1 不合理 + L2 命中 → 链透传 servedBy="static" (降级可观测; 落库/告警见 T012-T014)', async () => {
    const chain = new CalendarSourceFallbackChain([
      poisonNode([], 'tencent'),
      healthyNode({ cn: CN_TRADING_DATES }, 'static'),
    ]);

    const { dates, servedBy } = await chain.fetchTradingDates('cn', FROM, TO);

    expect(dates).toEqual(CN_TRADING_DATES);
    // 填充「成功」但已降级运行 —— 降级 ≠ 健康 (FR-014)。
    expect(servedBy).toBe('static');
  });

  it('🚨 **全链皆「成功但不合理」→ 链显式 throw** (禁静默返空 —— 返空会被 service 当成「区间无交易日」)', async () => {
    // 两层都 HTTP 200、都不抛 —— 这正是本 feature 的立意: **不响亮的成功比失败更危险**。
    const chain = new CalendarSourceFallbackChain([
      poisonNode(THIN_DATES, 'tencent'),
      poisonNode(THIN_DATES.slice(0, 2), 'static'),
    ]);

    // 🚨 断言 throw 而非「返空」: 二者在 service 返回值上**长得一模一样** (都是 fetched:0),
    // 唯有 throw 才让失败可被 T012 记 lastError / 心跳不更新 → 探针告警。
    await expect(chain.fetchTradingDates('cn', FROM, TO)).rejects.toThrow(/合理性闸/);
  });

  it('🚨 **全链皆「成功但不合理」→ 填充显式失败 + 日历表零污染** (毒饵一行都不得写进 trading_day)', async () => {
    // ⚠️ 毒饵刻意用**非空**稀薄日历: 闸若失效, L1 这 5 天会真的落库 → 本断言才照得出反例。
    // (用空数组当毒饵则「闸拦下」与「静默写 0 行」在库里长得一样 —— 测了个寂寞。)
    const results = await serviceWith([
      poisonNode(THIN_DATES, 'tencent'),
      poisonNode(THIN_DATES.slice(0, 2), 'static'),
    ]).syncRange(['cn'], FROM, TO);

    // 显式失败 = 计 0 且不抛 (保 FR-004「一市场坏不拖垮全局」); 失败的**可观测化** (lastError) 见 T012。
    expect(results).toEqual([{ market: 'cn', fetched: 0, inserted: 0 }]);
    // 🚨 零污染: 宁可日历空着 (gate fail-open, 响亮陈旧) 也不写半份假日历 (gate 据假表说谎)。
    expect(await prisma.tradingDay.count()).toBe(0);
  });

  it('🚨 全链不合理 → **心跳纹丝不动** (lastSuccessAt/servedBy 保持旧值 → 陈旧 → 探针告警)', async () => {
    await prisma.calendarSyncHealth.create({
      data: { market: 'cn', lastSuccessAt: SEEDED_SUCCESS_AT, servedBy: 'tencent' },
    });

    // 毒饵用**非空**稀薄日历: 闸失效时这是一次「成功」填充 → T012 会刷新心跳 → 本断言转红。
    await serviceWith([
      poisonNode(THIN_DATES, 'tencent'),
      poisonNode(THIN_DATES.slice(0, 2), 'static'),
    ]).syncRange(['cn'], FROM, TO);

    const health = await prisma.calendarSyncHealth.findUnique({ where: { market: 'cn' } });
    // 🚨 「本次跑过」绝不等于「本次成功」: 心跳被这次失败刷新 = 探针永远看不到故障 = 静默停摆重演。
    expect(health?.lastSuccessAt).toEqual(SEEDED_SUCCESS_AT);
    expect(health?.servedBy).toBe('tencent');
    // 日历同样零污染 (毒饵那 5 天不得落库)。
    expect(await prisma.tradingDay.count()).toBe(0);
  });

  it('🚨 per-market 闸独立: cn 毒饵全链失败 + hk L1 健康 → hk 照常落库, cn 零行, 整体不失败', async () => {
    // L1: hk 健康 / cn 返稀薄毒饵 (**非空** → 闸失效时会真落库, 反例可见); L2: 两市场都答不了。
    const l1: TradingCalendarSource = {
      fetchTradingDates: vi.fn(async (market: string) =>
        market === 'hk'
          ? { dates: CN_TRADING_DATES.filter((d) => d !== '2026-07-01'), servedBy: 'tencent' }
          : { dates: THIN_DATES, servedBy: 'tencent' },
      ),
    };
    const l2 = healthyNode({}, 'static');

    const results = await serviceWith([l1, l2]).syncRange(['cn', 'hk'], FROM, TO);

    expect(results).toEqual([
      { market: 'cn', fetched: 0, inserted: 0 },
      { market: 'hk', fetched: 22, inserted: 22 },
    ]);
    // cn 被闸拦下 → 零行; hk 不被连坐 (闸是 per-market 的判定, 非全局熔断)。
    expect(await prisma.tradingDay.count({ where: { market: 'cn' } })).toBe(0);
    expect(await datesOf('hk')).toHaveLength(22);
  });

  it('健康 L1 (23 天, 远高于下界 10) → 闸放行, 一次过 (闸不打扰正常路径)', async () => {
    const l1 = healthyNode({ cn: CN_TRADING_DATES }, 'tencent');
    const l2 = healthyNode({ cn: CN_TRADING_DATES }, 'static');

    const results = await serviceWith([l1, l2]).syncRange(['cn'], FROM, TO);

    expect(results).toEqual([{ market: 'cn', fetched: 23, inserted: 23 }]);
    expect(await datesOf('cn')).toEqual(CN_TRADING_DATES);
    // 闸对健康主源零副作用: L2 一次都不该被打。
    expect(l2.fetchTradingDates).not.toHaveBeenCalled();
  });
});
