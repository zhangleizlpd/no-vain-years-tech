import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { exchangeCalendarDate } from '../../src/marketdata/session-clock';

// 采集维度 `market_scope` 的**全局不变量**（不属于任何一个 feature，故独立成文件）。
//
// ## 为什么必须是机器闸
//
// 「别把日历会分叉的市场掺进同一个 scope」这条今天只有**一道运行期防线** ——
// `exchangeCalendarDateForScope` 在 scope 内各市场算出的日历日不同时 throw。而那道防线
// **恰好在伤害发生的时段睡着**（2026-08-23 实测）：
//
// | 北京时刻 | hk 日历日 | us 日历日 | `{us,hk}` |
// | --- | --- | --- | --- |
// | 00:00 – 11:59 | D | D-1 | **抛** |
// | 12:00 – 23:59 | D | D | **不抛** |
//
// 三个夜间 cron（22:00 / 23:00 / 23:30）**全部落在不抛的那半边** ⇒ 一个被误配成 `{us,hk}`
// 的采集维度会：CI 全绿（测试用捏造 scope + 固定时钟）、每晚 cron 正常跑完、监控一片祥和，
// 而**每个「港股休市、美股开市」的日子对港股全量发一轮请求**（tick payload 无 `markets`
// 字段 ⇒ 混 scope 维度的工作集恒为全 scope）—— 这一条**根本不抛**，纯静默。直到某天上午
// 有人跑一次回填或建一只锚才突然炸，且现场看不出跟几个月前那次 seed 有关。
//
// ⇒ 本文件把它提前到「seed 那一刻就红」。
//
// ## 与 `marketdata-066.hk-dimension-seed.it.spec.ts` 的分工
//
// 那边断的是**066 那三行**的白名单快照（混 `{us,hk}` 的维度恰为 `{universe}`）——
// 特定 feature 的意图留痕。本文件是它的**严格推广**：不限 `{us,hk}`（`{us,cn}` 同样红），
// 判据是「算出来的日期会不会分叉」而不是市场名字的组合，且覆盖**全部**已 seed 的行。
//
// ## 存储选型
//
// 走模板克隆 `setupIsolatedDb()`（migration 已跑完）而**不是** `setupEmptyDb()` + 自跑
// migrate：本文件的被测对象是「全部 migration 跑完之后的 seed 数据整体」，不是某一份
// migration 的产物。要验后者见 `optionsdesk-045.schema.it.spec.ts` 那一档。
describe('采集维度 market_scope 全局不变量 (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  /**
   * 已在 `session-clock.ts` 的 `EXCHANGE_TIME_ZONE` 里登记时区的市场。
   *
   * 🚨 未登记的市场**不会抛**，`exchangeCalendarDate` 静默回落到宿主时区（`Asia/Shanghai`）
   * ⇒ 一个 `jp` 维度会被当成 cn 口径算「今天」，而那种偏差不报错、只让数字差一天。
   * 该常量在 session-clock 里是模块私有的，这里按值域复制一份 —— 两边漂了本条会红。
   */
  const REGISTERED_MARKETS = ['cn', 'hk', 'us'];

  /**
   * **刻意允许**日历分叉的 scope —— 每加一个都必须在这里写明理由。
   *
   * - `universe`：meta 维度，`asOf` 不往任何一行上盖日戳，scope 只是给交易日闸用的元数据。
   *   它走 `resolveAsOfForDimension`，那条对跨时区 scope **刻意回落宿主日而不是抛**
   *   （极性与 `exchangeCalendarDateForScope` 相反，见 `sync-asof.rules.ts`）。
   */
  const INTENTIONAL_DIVERGENT_SCOPE = ['universe'];

  /**
   * 探针时刻：两个 DST 档（1 月 / 7 月）× 24 个整点。
   * us 与 hk/cn 的日历日只在北京时间的上半天分叉 —— 单一时刻的探针会漏掉它。
   */
  const PROBES: Date[] = ['2026-01-15', '2026-07-15'].flatMap((day) =>
    Array.from({ length: 24 }, (_, h) => new Date(`${day}T${String(h).padStart(2, '0')}:00:00Z`)),
  );

  /** scope 在任一探针时刻算出 >1 个日历日 ⇒ 分叉。复杂度 O(scope 长度 × 探针数)，均为常数。 */
  function scopeDiverges(scope: readonly string[]): boolean {
    if (scope.length < 2) return false;
    return PROBES.some((now) => new Set(scope.map((m) => exchangeCalendarDate(m, now))).size > 1);
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

  it('🚨 日历会分叉的 scope 恰为白名单 —— 任何采集维度被顺手扩了 scope 都在这里红', async () => {
    const rows = await prisma.syncDimension.findMany({
      select: { dimensionKey: true, marketScope: true },
      orderBy: { dimensionKey: 'asc' },
    });
    expect(rows.length).toBeGreaterThan(0); // 空库会让下面两条恒真

    const divergent = rows.filter((r) => scopeDiverges(r.marketScope)).map((r) => r.dimensionKey);
    expect(divergent).toEqual(INTENTIONAL_DIVERGENT_SCOPE);
  });

  it('🚨 scope 里出现的市场全部已登记时区 —— 未登记的会静默按宿主口径算「今天」', async () => {
    const rows = await prisma.syncDimension.findMany({ select: { marketScope: true } });
    const seen = [...new Set(rows.flatMap((r) => r.marketScope))].sort();
    expect(seen.filter((m) => !REGISTERED_MARKETS.includes(m))).toEqual([]);
  });

  it('📌 探针自身够得着那条分叉 —— 否则上面两条是恒真的假绿', () => {
    expect(scopeDiverges(['us', 'hk'])).toBe(true);
    expect(scopeDiverges(['us', 'cn'])).toBe(true);
    expect(scopeDiverges(['cn', 'hk'])).toBe(false); // 恒 UTC+8 且均无 DST
  });
});
