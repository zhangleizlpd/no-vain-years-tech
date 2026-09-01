import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupEmptyDb } from '../_support/isolated-db';
import { runMigrateDeploy } from '../_support/run-migrate';
import { PrismaService } from '../../src/security/prisma.service';
import {
  closeSettleBufferMinutes,
  oiRefreshedAtEod,
} from '../../src/marketdata/market-session.rules';
import { computeNext } from '../../src/marketdata/sync-tick-driver';

const SERVER_DIR = process.cwd();

/**
 * 073 港股期权两轮采集 IT (Testcontainers PG `migrate deploy`)。
 *
 * ## 为什么用 `setupEmptyDb()` + 自己跑 `migrate deploy`
 *
 * 本片被测对象之一**就是那条 migration**。共享 PG 的模板克隆拿到的是「migration 已经跑完」
 * 的库 —— 断言照样绿, 但绿的是模板, 不是本片新写的 SQL。⇒ 走
 * `marketdata-066.hk-dimension-seed.it.spec.ts` 同一档: 空库 + `runMigrateDeploy()`,
 * 顺带把「migration 在空库单向可用」也验掉 (跑不通就在 beforeAll 当场炸)。
 *
 * ## 🚨 本文件断的是**性质**, 不是 cron 字符串
 *
 * `expect(cronExpr).toBe('0 20 16 * * *')` 对 `0 20 16 * * 1-5` 这类不违反任何 FR 的改动
 * 同样会红, 而对「把 16:20 改成 16:05」这种**真的踩闸**的改动给不出任何解释。⇒ 一律折成
 * 下一触发时刻, 再拿仓内既有的判据函数 (`closeSettleBufferMinutes` / `oiRefreshedAtEod`) 去问。
 */

/** 本片新增的 migration —— 单一真相源, 读文件, 绝不内联复制。 */
const MIGRATION_SQL = readFileSync(
  resolve(
    SERVER_DIR,
    'prisma/migrations/20260901_1502_split_hk_option_collection_into_two_rounds/migration.sql',
  ),
  'utf8',
);

const HK_CHAIN = 'hk_option_contract';
const HK_SNAPSHOT = 'hk_option_daily_snapshot';
const HK_IV = 'hk_underlying_iv_daily';
const HK_OI_SETTLE = 'hk_option_oi_settle';

/** 港股收盘 16:00 —— 与 `MARKET_SESSION` 同源的事实, 此处只作断言基准的可读锚。 */
const HK_CLOSE_MINUTE = 16 * 60;

describe('073 两轮采集 seed + 时刻窗口 (Testcontainers PG migrate deploy)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupEmptyDb>>;

  beforeAll(async () => {
    db = await setupEmptyDb();
    process.env.DATABASE_URL = db.databaseUrl;

    runMigrateDeploy();

    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  it('轮2 维度行落库, 取值逐列 (market_scope 恰为 {hk} / futu lane / 无 backfill 语义)', async () => {
    const row = await prisma.syncDimension.findUnique({
      where: { dimensionKey: HK_OI_SETTLE },
      select: {
        enabled: true,
        marketScope: true,
        queueLane: true,
        batchSize: true,
        historyDepth: true,
        retryMax: true,
        priority: true,
      },
    });
    expect(row).toEqual({
      // 归属判据已在代码里落地且有单测钉住 ⇒ 不存在 066 那次「开了会静默写错标签」的窗口。
      enabled: true,
      // 🚨 恰为 {hk}: 掺进 us 会撞 `exchangeCalendarDateForScope` 的 scope 日历 throw。
      marketScope: ['hk'],
      // 漏登记会落回 default lane, 与理杏仁那条夜间链排队 (#210)。
      queueLane: 'futu',
      // get_option_snapshot 官方批量上限, 同主轮。
      batchSize: 400,
      // 期权快照无跨日补救 (vendor 不给历史交易日的快照) ⇒ 本维度没有 backfill 语义。
      historyDepth: null,
      retryMax: 3,
      priority: 5,
    });
  });

  it('🚨 主轮两维前移后仍晚于收盘定稿缓冲解除 (16:10) —— 早于它写入会被 close-write 闸挡下', async () => {
    const rows = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [HK_CHAIN, HK_SNAPSHOT] } },
      select: { dimensionKey: true, cronExpr: true },
      orderBy: { dimensionKey: 'asc' },
    });
    expect(rows).toHaveLength(2);

    // 2026-08-24 周一 12:00 Asia/Shanghai —— 让 computeNext 落在同一自然日内。
    const now = new Date('2026-08-24T04:00:00Z');
    // 下界 = 收盘 + 该市场的定稿缓冲 (HKEX CAS 16:08–16:10 随机收市 ⇒ 官方收盘价最早 16:10)。
    // 🚨 取自 `closeSettleBufferMinutes('hk')` 而不是写死 10: 那个值改了本例必须跟着动,
    //    而写死会让「有人把缓冲调大、cron 却没跟着挪」这件事静默通过。
    const bufferMinutes = closeSettleBufferMinutes('hk');
    // 基点是**当地午夜**, 再加「收盘分钟 + 缓冲」。⚠️ 拿一个已经带钟点的 UTC 时刻当基点,
    // 加上去的是第二天的分钟数, 而断言只会说「日期不对」。
    const hkMidnightMs = Date.UTC(2026, 7, 24, 0, 0) - 8 * 60 * 60_000;
    const lowerBoundMs = hkMidnightMs + (HK_CLOSE_MINUTE + bufferMinutes) * 60_000;

    for (const row of rows) {
      const next = computeNext(row.cronExpr, now);
      expect(
        next.getTime(),
        `${row.dimensionKey} 的 cron "${row.cronExpr}" 触发早于 close-write 闸解除 ` +
          `(收盘 16:00 + ${bufferMinutes}min) —— 那一刻官方收盘价还不存在`,
      ).toBeGreaterThanOrEqual(lowerBoundMs);
    }
    // 📌 **上界断言随 073 T009 的「盘口台阶上界」常量落地后补在这里** —— 那个常量是样本期
    //    结论 (不是物理常数), 单点定义在 `market-session.rules.ts`。在它存在之前写一个字面量
    //    上界, 等于把一个待定的判据钉成事实。这不是遗漏。
  });

  it('🚨 主轮两维仍在**同一 tick** (依赖边只在同一 tick 内装配, ADR-0049 §3)', async () => {
    const rows = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [HK_CHAIN, HK_SNAPSHOT] } },
      select: { dimensionKey: true, cronExpr: true },
    });
    const now = new Date('2026-08-24T04:00:00Z');
    const byKey = new Map(rows.map((r) => [r.dimensionKey, computeNext(r.cronExpr, now)]));
    expect(
      byKey.get(HK_SNAPSHOT)?.getTime(),
      '链发现与快照不同 tick ⇒ 分进两棵 flow 树 ⇒ 依赖边静默失效 (#210 的根因)',
    ).toBe(byKey.get(HK_CHAIN)?.getTime());
  });

  it('🚨 轮2 的触发时刻上 OI **已定稿** —— 判据用 `oiRefreshedAtEod` 自己问, 不数分钟', async () => {
    const row = await prisma.syncDimension.findUniqueOrThrow({
      where: { dimensionKey: HK_OI_SETTLE },
      select: { cronExpr: true },
    });
    const now = new Date('2026-08-24T04:00:00Z'); // 12:00 Asia/Shanghai
    const next = computeNext(row.cronExpr, now);
    expect(
      oiRefreshedAtEod('hk', '2026-08-24', next),
      `轮2 cron "${row.cronExpr}" 落在 OI 定稿之前 ⇒ 每晚都会走 use case 那条 skip 分支, ` +
        `OI 永远回填不上 (而采集本身全绿)`,
    ).toBe(true);
  });

  it('🚨 轮2 与主轮**不在同一 tick** —— 这正是「不给它连依赖边」的理由', async () => {
    const rows = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [HK_SNAPSHOT, HK_OI_SETTLE] } },
      select: { dimensionKey: true, cronExpr: true },
    });
    const now = new Date('2026-08-24T04:00:00Z');
    const byKey = new Map(rows.map((r) => [r.dimensionKey, computeNext(r.cronExpr, now)]));
    expect(byKey.get(HK_OI_SETTLE)?.getTime()).not.toBe(byKey.get(HK_SNAPSHOT)?.getTime());
  });

  it('🚨 轮2 **零依赖边** (裁决落成断言: 跨 tick 的边装不上, 连了是空话)', async () => {
    const edges = await prisma.syncDependency.findMany({
      where: { OR: [{ upstream: HK_OI_SETTLE }, { downstream: HK_OI_SETTLE }] },
    });
    expect(edges).toEqual([]);
  });

  it('IV 那行本片不动, 仍留 23:00 档 (前移是条件项 FR-017, 待探针定型)', async () => {
    const row = await prisma.syncDimension.findUniqueOrThrow({
      where: { dimensionKey: HK_IV },
      select: { cronExpr: true },
    });
    const now = new Date('2026-08-24T04:00:00Z');
    const next = computeNext(row.cronExpr, now);
    expect(next.getTime()).toBeGreaterThan(new Date('2026-08-24T14:00:00Z').getTime());
  });

  // 🚨 FR-012 的**唯一**机械守卫。
  //
  // 「改 cron_expr 必须同条 migration 置 next_fire_at = NULL」这条约束今天只写在
  // `schema.prisma` 的列注释与 20260827_2112 的正文里 —— 而漏掉它的表现是**改动静默滞后一个
  // 周期**, 无报错、无红、cron 列也确实是新值。
  // 🚫 **在库里断言 next_fire_at IS NULL 证明不了这件事**: 空库 `migrate deploy` 之后那一列
  //    本来就全是 NULL (从没触发过), 断言恒真。⇒ 判据只能落在 migration 文本上。
  it('FR-012 改了 cron 的那两行, 同条 migration 里被复位 next_fire_at', () => {
    const retimed = [HK_CHAIN, HK_SNAPSHOT];
    const resetStatement = MIGRATION_SQL.split(';').find(
      (stmt) => /SET\s+"next_fire_at"\s*=\s*NULL/i.test(stmt) && /UPDATE/i.test(stmt),
    );
    expect(
      resetStatement,
      'migration 里没有 next_fire_at 复位语句 —— 改动会滞后一个周期',
    ).toBeDefined();
    for (const key of retimed) {
      expect(resetStatement, `复位语句漏了 ${key}`).toContain(`'${key}'`);
    }
  });
});
