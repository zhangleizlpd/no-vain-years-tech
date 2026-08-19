import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../../src/security/prisma.service';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';
import { CalendarSourceFallbackChain } from '../../src/marketdata/calendar-source-fallback-chain.adapter';
import { MarketRoutedCalendarSource } from '../../src/marketdata/market-routed-calendar-source.adapter';
import { TradingCalendarSyncService } from '../../src/marketdata/trading-calendar-sync.service';
import type { TradingCalendarSource } from '../../src/marketdata/trading-calendar-source.port';

const SERVER_DIR = process.cwd();

/**
 * 044 T013 — **交易日历健康谓词** IT (Testcontainers PG)。
 *
 * 🚨🚨 **这是宪法 §II 的合规承重点**, 不是一个普通 IT。
 *
 * 仓内**无 bash 测试框架** → `marketdata-calendar-health.sh` (T014) / `marketdata-sync-report.sh` (T015) 无法 RED-first, 直接撞
 * 宪法 §II (NON-NEGOTIABLE)。裁决 (d) = **把 bash 压到零逻辑**: 判断全部下沉为 SQL 谓词,
 * bash 只剩「跑谓词 → 映射退出码 → 打印摘要」(无分支/无阈值/无判断)。
 * ⇒ **「bash 无判断逻辑」这个论证的全部重量, 压在「谓词在此被真测」上**。本文件塌 = §II 合规塌。
 *
 * 🚨 **谓词是「单一共享产物」, 不是两份拷贝**: 本文件**读**
 * `ops/jobs/marketdata-calendar-health.sql` 跑, T014/T015 的 bash 读**同一文件**跑。若此处内联一份 SQL、bash 里再抄
 * 一份, 两份必 drift →「谓词已被真测」当场变成假话。故谓词设计成**自包含、无参数**
 * (阈值 26h 写死在 SQL 里 —— 传参就是把判断挪回 bash)。
 *
 * 阈值论证 (26h): 填充日跑 21:00 → 上次成功 = D 日 21:00; D+1 21:00 那次失败时心跳龄 = 24h
 * → 26h 闸在 D+1 23:00 触发 = 首次失败后 ~2h 告警, 满足 SC-003 (24h 内) 且不误报。
 */

/** 🚨 谓词单一真相源 —— **读文件**, 绝不在此内联复制 (复制 = drift = 论证作废)。 */
const PREDICATE_SQL = readFileSync(
  resolve(SERVER_DIR, '../../ops/jobs/marketdata-calendar-health.sql'),
  'utf8',
);

const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;

/** syncRange 不读 cfg (仅 @Cron handleCron 读 tickEnabled) → 最小占位。 */
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

/** 真链填充窗 (日常 populate 恒 30 天窗 → 恒受合理性闸保护, 不走短窗豁免)。 */
const FROM = '2026-06-16';
const TO = '2026-07-16';

/**
 * 窗内全部工作日 (周一~周五) = 一份**过得了合理性闸**的可信日历。
 * ⚠️ 用「1 天」这类稀薄假日历会被闸判为毒饵而降级 → 测的就不是心跳而是闸了 (真踩过)。
 */
const WEEKDAYS: string[] = (() => {
  const out: string[] = [];
  for (let t = Date.parse(`${FROM}T00:00:00Z`); t <= Date.parse(`${TO}T00:00:00Z`); t += DAY_MS) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
})();

/** test-local 活源: 按 market 返日历 + 自报家门 (未预置 → throw)。 */
function healthyNode(byMarket: Record<string, string[]>, servedBy: string): TradingCalendarSource {
  return {
    async fetchTradingDates(market: string) {
      const dates = byMarket[market];
      if (!dates) throw new Error(`[${servedBy}] 无 ${market} 数据`);
      return { dates, sessionKinds: {}, servedBy };
    },
  };
}

describe('044 US3 交易日历健康谓词 (Testcontainers PG, 与 marketdata-calendar-health.sh / marketdata-sync-report.sh 共享同一 .sql)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  /**
   * 📌 **062 T011 增补**: 同一个谓词自 062 起多了**视野档** (三档, 见 .sql 头部) —— 本文件测的是
   * **心跳档**, 故在每个用例开跑前把视野埋成恒健康, 让这里的每一条红都只能来自心跳判据。
   * 视野档自己的用例在 `marketdata.calendar-062.horizon-probe.it.spec.ts` (那边反过来把心跳
   * 埋成恒健康)。两文件的分工 = FR-017「两档并存且互不替代」在测试面的落法。
   *
   * ⚠️ 相对 `current_date` 埋 (不写死年份): 视野判据全部是「相对今天」的, 写死日期明年必假红。
   * 覆盖区间刻意**包住下面真链用例的填充窗** (FROM..TO), 于是 `advanceCoverage` 合并后区间不变
   * —— 真链跑完视野仍健康, 这些用例照样只在测心跳。
   */
  async function seedHealthyHorizon(): Promise<void> {
    const now = Date.now();
    const iso = (t: number): Date =>
      new Date(new Date(t).toISOString().slice(0, 10) + 'T00:00:00Z');
    for (const market of ['cn', 'hk', 'us']) {
      await prisma.calendarCoverage.upsert({
        where: { market },
        create: {
          market,
          coveredFrom: iso(now - 400 * DAY_MS),
          coveredTo: iso(now + 20 * DAY_MS),
          servedBy: market === 'us' ? 'futu' : 'tencent',
        },
        update: { coveredFrom: iso(now - 400 * DAY_MS), coveredTo: iso(now + 20 * DAY_MS) },
      });
      // 余量 10 个交易日 (> 阈值 5) —— 蓄意**不靠年末豁免**兜底: 靠豁免的话, 哪天有人改动豁免
      // 表达式, 本文件会跟着一起红, 而它根本不测那件事。
      await prisma.tradingDay.createMany({
        data: Array.from({ length: 10 }, (_, i) => ({ market, date: iso(now + (i + 1) * DAY_MS) })),
        skipDuplicates: true,
      });
    }
  }

  beforeEach(async () => {
    await prisma.calendarSyncHealth.deleteMany();
    await prisma.calendarCoverage.deleteMany();
    await prisma.tradingDay.deleteMany();
    await seedHealthyHorizon();
  });

  /** 跑谓词 → 与 bash 侧完全相同的两列输出 (exit_code 直接就是 bash 的退出码)。 */
  async function runPredicate(): Promise<{ exitCode: number; summary: string }> {
    const rows =
      await prisma.$queryRawUnsafe<{ exit_code: number; summary: string }[]>(PREDICATE_SQL);
    expect(rows).toHaveLength(1); // 恒单行 → bash 侧 `read` 一次读完, 无需循环 (= 无逻辑)。
    return { exitCode: rows[0].exit_code, summary: rows[0].summary };
  }

  /** 埋心跳: ageHours=null → 从未成功 (last_success_at NULL)。 */
  async function seedHealth(
    market: string,
    ageHours: number | null,
    servedBy: string | null,
  ): Promise<void> {
    const lastSuccessAt = ageHours === null ? null : new Date(Date.now() - ageHours * HOUR_MS);
    await prisma.calendarSyncHealth.upsert({
      where: { market },
      create: { market, lastSuccessAt, lastAttemptAt: new Date(), servedBy },
      update: { lastSuccessAt, servedBy },
    });
  }

  /**
   * 主源健康的基线。🚨 **主源是 per-market 的**: cn/hk = tencent, us = futu
   * (sellput-viz Phase 1 #5 换源后)。
   */
  async function seedAllHealthy(): Promise<void> {
    await seedHealth('cn', 1, 'tencent');
    await seedHealth('hk', 1, 'tencent');
    await seedHealth('us', 1, 'futu');
  }

  // ── ① 26h 陈旧阈值 (两侧) ────────────────────────────────────────────────────────────────
  it('25h 心跳 (阈值内) → 健康 exit 0', async () => {
    await seedAllHealthy();
    await seedHealth('cn', 25, 'tencent');

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(0);
    expect(summary).toContain('✅');
  });

  it('🚨 27h 心跳 (越阈值) → 不健康 exit 1 (首次失败后 ~2h 告警, SC-003)', async () => {
    await seedAllHealthy();
    await seedHealth('cn', 27, 'tencent');

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('🔴');
    expect(summary).toContain('cn'); // 摘要须指认坏在哪个市场 (人读可诊断)。
  });

  it('陈旧判据逐市场取: 单市场陈旧即不健康 (不被健康市场平均掉)', async () => {
    await seedAllHealthy();
    await seedHealth('hk', 30, 'tencent');

    expect((await runPredicate()).exitCode).toBe(1);
  });

  // ── ② servedBy 降级信号 (FR-014) ─────────────────────────────────────────────────────────
  it('servedBy="tencent" (主源) + 新鲜 → 正常 exit 0', async () => {
    await seedAllHealthy();

    expect((await runPredicate()).exitCode).toBe(0);
  });

  it('🚨 servedBy="static" → 降级运行 → 不健康 exit 1 (心跳新鲜也告警: 降级 ≠ 健康)', async () => {
    await seedAllHealthy();
    await seedHealth('cn', 1, 'static'); // L1 死、L2 接住 → 填充成功、心跳新鲜。

    const { exitCode, summary } = await runPredicate();
    // 🚨 若这里放行, 降级就会静默运行数月, 直到跨年静态表耗尽才全盘爆炸 —— 本 feature
    // 立意就是消灭静默降级, 不能自己留一个。
    expect(exitCode).toBe(1);
    expect(summary).toContain('降级');
  });

  it('🚨 主源恢复 (servedBy 变回 "tencent") → 降级信号自动解除 exit 0 (无需人工清标志位)', async () => {
    await seedAllHealthy();
    await seedHealth('cn', 1, 'static');
    expect((await runPredicate()).exitCode).toBe(1);

    await seedHealth('cn', 1, 'tencent'); // 次日 L1 复活 → 心跳自报家门变回主源。
    expect((await runPredicate()).exitCode).toBe(0);
  });

  // ── ③ 沉默 ≠ 健康 (缺行 / 从未成功) ──────────────────────────────────────────────────────
  it('🚨 心跳表空 (从未填充过) → 不健康 exit 1 (空集不得被读成健康)', async () => {
    // min(NULL) = NULL → 若谓词直接拿聚合比阈值, 空表会「没有任何行超 26h」→ 假绿。
    // 这正是 044 的病灶形状 (沉默被当成健康), 谓词必须由固定市场清单 LEFT JOIN 驱动。
    expect((await runPredicate()).exitCode).toBe(1);
  });

  it('🚨 单市场心跳行缺失 (hk 从未写过) → 不健康 exit 1', async () => {
    await seedHealth('cn', 1, 'tencent');

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('hk');
  });

  it('心跳行存在但 last_success_at 为 NULL (只失败过、从未成功) → 不健康 exit 1', async () => {
    await seedAllHealthy();
    await seedHealth('cn', null, null);

    expect((await runPredicate()).exitCode).toBe(1);
  });

  // ── ④ us 纳入监控 + per-market 主源 (sellput-viz Phase 1 #5; 反转 044 原「us 排除」) ──────
  //    044 原文把 us 排除在监控外, 理由是「静态层不覆盖 us ⇒ us 陈旧无备源可用、也无从修」。
  //    换源后 us 有 [富途 L1, 腾讯 L2] 两个走不同物理通路的活源 ⇒ 该理由失效; 而 6 个
  //    {us}-only 期权维度即将拿 us 日历判交易日闸 ⇒ 不监控它 = 044 事故换到 us 重演。
  it('🚨 us 陈旧 → 不健康 exit 1 (换源后 us 已是受监控市场)', async () => {
    await seedAllHealthy();
    await seedHealth('us', 27, 'futu');

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('us');
  });

  it('🚨 us 心跳行缺失 → 不健康 exit 1 (沉默 ≠ 健康, 与 cn/hk 同域)', async () => {
    await seedAllHealthy();
    await prisma.calendarSyncHealth.delete({ where: { market: 'us' } });

    expect((await runPredicate()).exitCode).toBe(1);
  });

  it('🚨 us 由腾讯 (它的 L2) 服务 → 判降级 exit 1 (富途 L1 挂了必须有人知道)', async () => {
    await seedAllHealthy();
    await seedHealth('us', 1, 'tencent');

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('降级');
  });

  it('🚨 主源比对是 per-market 的: cn 由 futu 服务同样判降级 (不是全局一个主源常量)', async () => {
    await seedAllHealthy();
    await seedHealth('cn', 1, 'futu'); // cn 的主源是 tencent —— futu 对 cn 而言不是主源。

    expect((await runPredicate()).exitCode).toBe(1);
  });

  it('三市场各由自己的主源服务 (cn/hk=tencent, us=futu) → 健康 exit 0', async () => {
    await seedAllHealthy();

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(0);
    // 摘要须把三个市场都报出来 (人读可诊断)。
    for (const m of ['cn', 'hk', 'us']) expect(summary).toContain(m);
  });

  // ── ⑤ 真链 → 心跳 → 谓词 全程贯通 (T012 写入端 ↔ 本谓词读取端 对得上) ────────────────────
  /**
   * 生产接线的形状: 按市场路由到两条链 (cn/hk → 腾讯主源; us → 富途主源)。谓词的
   * per-market 主源比对必须与它对得上, 否则正常运行会被判降级。
   */
  function routedSource(): TradingCalendarSource {
    const tencentChain = new CalendarSourceFallbackChain([
      healthyNode({ cn: WEEKDAYS, hk: WEEKDAYS }, 'tencent'),
    ]);
    const futuChain = new CalendarSourceFallbackChain([healthyNode({ us: WEEKDAYS }, 'futu')]);
    return new MarketRoutedCalendarSource({ cn: tencentChain, hk: tencentChain, us: futuChain });
  }

  it('真链跑成功 → 心跳落库 → 谓词判健康 exit 0 (写入端与读取端契约对齐)', async () => {
    const svc = new TradingCalendarSyncService(routedSource(), prisma, CFG, NO_FORWARD);

    await svc.syncRange(['cn', 'hk', 'us'], FROM, TO);

    // 谓词不认识 service, 只认识库里那三行 —— 这一条断言把两端焊在一起 (含 us 的主源名
    // 'futu': 接线侧改了自报家门而谓词没跟着改, 这里会当场红)。
    expect((await runPredicate()).exitCode).toBe(0);
  });

  it('🚨 长假语义: 重跑「成功但零新增」→ 心跳照旧刷新 → 谓词仍判健康 (SC-005 不误报)', async () => {
    const svc = new TradingCalendarSyncService(routedSource(), prisma, CFG, NO_FORWARD);

    await svc.syncRange(['cn', 'hk', 'us'], FROM, TO);
    const second = await svc.syncRange(['cn', 'hk', 'us'], FROM, TO);

    // 零新增 = 长假每晚的常态 (填充成功, 只是没有新交易日)。
    expect(second.every((r) => r.inserted === 0)).toBe(true);
    // 谓词判 **liveness 而非 freshness** ⇒ 春节连放 7 天也不会天天喊「日历坏了」。
    expect((await runPredicate()).exitCode).toBe(0);
  });

  it('🚨 真链全失败 → 心跳不刷新 → 陈旧越阈 → 谓词判不健康 exit 1 (事故的完整因果链)', async () => {
    // 昨天成功过 (27h 前), 今天全链失败 —— 044 事故第 2 天的精确形状。
    await seedAllHealthy();
    await seedHealth('cn', 27, 'tencent');
    const dead = new CalendarSourceFallbackChain([
      {
        async fetchTradingDates(): Promise<never> {
          throw new Error('[tencent] 端点被定向下线');
        },
      },
    ]);
    const svc = new TradingCalendarSyncService(dead, prisma, CFG, NO_FORWARD);

    const results = await svc.syncRange(['cn'], FROM, TO);

    // 失败留痕但不刷 lastSuccessAt (T012) → 谓词看得见陈旧 → 探针告警。
    expect(results).toEqual([{ market: 'cn', fetched: 0, inserted: 0 }]);
    const cn = await prisma.calendarSyncHealth.findUnique({ where: { market: 'cn' } });
    expect(cn?.lastError).toContain('端点被定向下线');
    expect((await runPredicate()).exitCode).toBe(1);
  });

  // ── ⑥ 谓词形状契约 (bash 零逻辑的前提) ──────────────────────────────────────────────────
  it('🚨 谓词恒返单行两列 (exit_code ∈ {0,1} + 单行摘要) → bash 无需任何分支即可映射', async () => {
    await seedAllHealthy();
    const healthy = await runPredicate();
    await seedHealth('cn', 99, 'static'); // 双条件同时成立。
    const unhealthy = await runPredicate();

    // exit_code 直接就是退出码 ⇒ bash 只需 `exit "$rc"`, 不做任何判断。
    expect([healthy.exitCode, unhealthy.exitCode]).toEqual([0, 1]);
    // 摘要单行无 tab/换行 ⇒ bash 单次 `IFS=$'\t' read -r rc summary` 即可解析, 无循环/无分支。
    for (const s of [healthy.summary, unhealthy.summary]) {
      expect(s).not.toMatch(/[\t\n\r]/);
      expect(s.length).toBeGreaterThan(0);
    }
  });
});
