import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../../src/security/prisma.service';

const SERVER_DIR = process.cwd();

/**
 * 062 T011 — **交易日历视野探针**判据 IT (Testcontainers PG, US4 / FR-016 / FR-017 /
 * `state_branches` 13-15)。
 *
 * 🚨🚨 与 `marketdata.calendar-044.health.it.spec.ts` 一样, 这是宪法 §II 的合规承重点。
 * 仓内**无 bash 测试框架** ⇒ `marketdata-calendar-health.sh` 里的任何判断都必然无覆盖
 * (044 既定裁决)。因此本片新增的三档视野判据**全部下沉进同一个谓词 SQL**, bash 侧仍是
 * 「跑谓词 → 打摘要 → 透传退出码」零 if 零阈值。**改判据改 SQL**, 别在 bash / 本文件里
 * 内联复制 —— 两份必 drift, 一 drift「判断已被真测」就当场变成假话。
 *
 * 两个文件的**分工**(同一个谓词, 两个维度):
 * · 044 文件 —— 心跳维度 (liveness: 填充还活着吗), 视野在其 `beforeEach` 里恒健康。
 * · 本文件 —— 视野维度 (coverage: 视野还在往前走吗), 心跳在下面 `beforeEach` 里恒健康。
 * FR-017: 二者**并存且 MUST NOT 互相替代** —— 填充可以每晚成功 (心跳全绿) 而视野一天都不
 * 往前走 (源恒返旧数据 / 年历漏更), 反之亦然。故本文件末尾还有一组「心跳判据不回归」断言。
 *
 * ⚠️ **时钟不可控**: 谓词按设计自包含无参数, 用的是 DB 服务器的 `current_date` (UTC 口径)。
 * 因而「12 月 / 1 月」这类场景**只能靠数据表达**, 不能靠改时钟 —— 见下面 ④⑤ 两条的注释。
 */

/** 🚨 谓词单一真相源 —— **读文件**, 绝不在此内联复制 (复制 = drift = 论证作废)。 */
const PREDICATE_SQL = readFileSync(
  resolve(SERVER_DIR, '../../ops/jobs/marketdata-calendar-health.sql'),
  'utf8',
);

const DAY_MS = 86_400_000;
const MARKETS = ['cn', 'hk', 'us'] as const;
/** 各市场主源 (per-market, 与谓词内的 `watched` 清单对齐)。 */
const PRIMARY_SOURCE: Record<string, string> = { cn: 'tencent', hk: 'tencent', us: 'futu' };

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function toDbDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** 该日期所在年份的 12-31 (年末豁免的分界)。 */
function yearEndOf(date: string): string {
  return `${date.slice(0, 4)}-12-31`;
}

describe('062 T011 交易日历视野探针判据 (Testcontainers PG, 与 marketdata-calendar-health.sh 共享同一 .sql)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  /** DB 服务器 (UTC) 口径的今天 —— 判据里的 `current_date` 就是它, 埋数据一律相对它算。 */
  let today: string;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    prisma = new PrismaService(db.databaseUrl);
    const [{ d }] = await prisma.$queryRawUnsafe<{ d: string }[]>(
      `SELECT to_char(current_date, 'YYYY-MM-DD') AS d`,
    );
    today = d;
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.calendarSyncHealth.deleteMany();
    await prisma.calendarCoverage.deleteMany();
    await prisma.tradingDay.deleteMany();
    // 心跳恒健康 ⇒ 本文件里任何一条红都只能来自**视野**判据 (最后一组反过来)。
    for (const market of MARKETS) {
      await prisma.calendarSyncHealth.create({
        data: {
          market,
          lastSuccessAt: new Date(Date.now() - 3600_000),
          lastAttemptAt: new Date(),
          servedBy: PRIMARY_SOURCE[market],
        },
      });
    }
  });

  async function runPredicate(): Promise<{ exitCode: number; summary: string }> {
    const rows =
      await prisma.$queryRawUnsafe<{ exit_code: number; summary: string }[]>(PREDICATE_SQL);
    expect(rows).toHaveLength(1); // 恒单行 → bash 侧 `read` 一次读完, 无需循环 (= 无逻辑)。
    return { exitCode: rows[0].exit_code, summary: rows[0].summary };
  }

  /** 埋覆盖声明 + `(今天, coveredTo]` 内的交易日行 (= 判据要数的「余量」)。 */
  async function seedHorizon(
    market: string,
    coveredTo: string,
    forwardTradingDays: string[],
  ): Promise<void> {
    await prisma.calendarCoverage.upsert({
      where: { market },
      create: {
        market,
        coveredFrom: toDbDate(addDays(today, -30)),
        coveredTo: toDbDate(coveredTo),
        servedBy: PRIMARY_SOURCE[market],
      },
      update: { coveredTo: toDbDate(coveredTo) },
    });
    if (forwardTradingDays.length > 0) {
      await prisma.tradingDay.createMany({
        data: forwardTradingDays.map((d) => ({ market, date: toDbDate(d) })),
        skipDuplicates: true,
      });
    }
  }

  /** 三市场同形埋视野 (余量 = `runwayDays` 个交易日, 终点 = 今天 + `runwayDays` 天)。 */
  async function seedAllHorizon(runwayDays: number): Promise<string> {
    const coveredTo = addDays(today, runwayDays);
    const forward = Array.from({ length: runwayDays }, (_, i) => addDays(today, i + 1));
    for (const market of MARKETS) await seedHorizon(market, coveredTo, forward);
    return coveredTo;
  }

  /**
   * 「视野过近」这一档的预期退出码。
   *
   * 🚨 这个条件分支**就是判据本身** (FR-016 的年末豁免), 不是测试为了不 flaky 打的补丁:
   * 终点一旦抵达当年 12-31, 视野再短也不告警 (次年年历尚未发布, 年末自然收缩)。跑在
   * 12/29-12/31 那几天时, 「今天 + 2 天」本就已抵年末 ⇒ 判绿是**正确**行为。写死 `1` 会
   * 让这条在年末假红, 而假红的下场就是有人回头去「修」判据 —— 那正是 Guardrail 11 警告的事。
   */
  function expectedShortHorizonExit(coveredTo: string): number {
    return coveredTo >= yearEndOf(today) ? 0 : 1;
  }

  // ── ① 视野充裕 → 绿, 且摘要给出每市场的 covered_to 与余量 (FR-016) ────────────────────────
  it('三市场余量 8 个交易日 → 健康 exit 0, 摘要含每市场的 covered_to 与余量', async () => {
    const coveredTo = await seedAllHorizon(8);

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(0);
    expect(summary).toContain('✅');
    for (const market of MARKETS) expect(summary).toContain(market);
    // 摘要须能让人直接读出「停在哪天、还剩几个交易日」(US4 AS1「指明是哪个市场、停在哪天」)。
    expect(summary).toContain(coveredTo);
    expect(summary).toContain('8');
  });

  // ── ② 视野过近 (state_branch 14 / SC-003) ─────────────────────────────────────────────────
  it('🚨 三市场余量仅 2 个交易日且未抵当年末 → 不健康 exit 1 (state_branch 14)', async () => {
    const coveredTo = await seedAllHorizon(2);

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(expectedShortHorizonExit(coveredTo));
    if (expectedShortHorizonExit(coveredTo) === 1) {
      expect(summary).toContain('🔴');
      expect(summary).toContain('视野过近');
    }
  });

  it('🚨 覆盖终点恰为今天 (余量 0) 且未抵当年末 → 不健康 exit 1', async () => {
    for (const market of MARKETS) await seedHorizon(market, today, []);

    expect((await runPredicate()).exitCode).toBe(expectedShortHorizonExit(today));
  });

  it('视野判据逐市场取: 单市场视野过近即不健康 (不被视野充裕的市场平均掉)', async () => {
    await seedAllHorizon(8);
    const near = addDays(today, 1);
    await seedHorizon('hk', near, [near]);

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(expectedShortHorizonExit(near));
    if (expectedShortHorizonExit(near) === 1) expect(summary).toContain('hk');
  });

  // ── ③ 视野落后于今天 (更靠前的一档, 且文案与「视野过近」可区分) ───────────────────────────
  it('🚨 覆盖终点早于今天 → 不健康 exit 1, 文案是「视野落后」而非「视野过近」', async () => {
    for (const market of MARKETS) await seedHorizon(market, addDays(today, -1), []);

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('视野落后');
  });

  // ── ④ 年末豁免 (state_branch 15 / SC-008) ────────────────────────────────────────────────
  /**
   * ⚠️ 时钟不可控 ⇒ 「时值 12 月」这个场景**只能由数据表达**: 覆盖终点 = **当年 12-31** 且
   * 余量为 0 —— 那正是 12 月下旬的形状 (次年年历尚未发布, 视野只能停在当年末)。若没有年末
   * 豁免, 这条会因余量 0 判红 ⇒ 每年 12 月一条修不掉的常亮告警 ⇒ 训练出「这条可以忽略」。
   */
  it('🚨 覆盖终点已抵当年 12-31 且余量为 0 (年末收缩期) → 健康 exit 0 (SC-008 零假告警)', async () => {
    const yearEnd = yearEndOf(today);
    for (const market of MARKETS) await seedHorizon(market, yearEnd, []);

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(0);
    expect(summary).toContain('✅');
  });

  // ── ⑤ 🚨🚨 Guardrail 11 的机器化: 跨年后必须转红 ─────────────────────────────────────────
  /**
   * 🚨🚨 **年末豁免只在「当年」成立。** 跨年那一刻「当年」变成新年 ⇒ 旧年 12-31 的终点
   * `< current_date` ⇒ 落进「视野落后」档、**必红**, 直到次年年历的年更 PR 合入才自动转绿。
   * **这正是设计**: 年历没更就该响。谁把豁免延到次年 (或加一个「1 月宽限期」), 这条立刻红。
   *
   * ⚠️ 时钟不可控 ⇒ 用「终点 = **上一年** 12-31、今天在当年」表达「时钟到了 1 月 2 日」——
   * 语义完全等价 (跨年后旧年末就是一个已经过去的日期), 且全年任一天跑都成立。
   */
  it('🚨🚨 覆盖终点 = 上一年 12-31 (跨年后年历未更) → 必须 exit 1, MUST NOT 被年末豁免放行', async () => {
    const lastYearEnd = `${Number(today.slice(0, 4)) - 1}-12-31`;
    for (const market of MARKETS) {
      await prisma.calendarCoverage.upsert({
        where: { market },
        create: {
          market,
          coveredFrom: toDbDate(`${lastYearEnd.slice(0, 4)}-01-01`),
          coveredTo: toDbDate(lastYearEnd),
          servedBy: PRIMARY_SOURCE[market],
        },
        update: { coveredTo: toDbDate(lastYearEnd) },
      });
    }

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('🔴');
  });

  // ── ⑥ 声明整体缺失 → 更高一档, 且与「视野过近」可区分 (US4 AS4) ───────────────────────────
  it('🚨 覆盖声明整体缺失 → 不健康 exit 1, 文案是「无覆盖声明」且不与「视野过近」混淆', async () => {
    // 心跳三行健康、`calendar_coverage` 空表 = 首次上线 / 声明被清空的形状。
    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('无覆盖声明');
    expect(summary).not.toContain('视野过近');
  });

  it('🚨 单市场声明缺失 → 不健康 exit 1 且摘要指认该市场 (沉默 ≠ 健康, 与心跳同域)', async () => {
    await seedAllHorizon(8);
    await prisma.calendarCoverage.delete({ where: { market: 'us' } });

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('us');
    expect(summary).toContain('无覆盖声明');
  });

  // ── ⑦ FR-017: 心跳四条判据**不回归** (视野恒健康, 只动心跳) ───────────────────────────────
  //    心跳答「填充还活着吗」, 视野答「视野还在往前走吗」—— 二者 MUST NOT 互相替代。
  //    加了视野判据之后, 下面四条必须**照样**红: 视野绿不得把心跳的红盖掉。
  it('🚨 心跳不回归: 视野充裕但 cn 心跳越 26h → 仍 exit 1', async () => {
    await seedAllHorizon(8);
    await prisma.calendarSyncHealth.update({
      where: { market: 'cn' },
      data: { lastSuccessAt: new Date(Date.now() - 27 * 3600_000) },
    });

    expect((await runPredicate()).exitCode).toBe(1);
  });

  it('🚨 心跳不回归: 视野充裕但 cn 由非主源服务 (降级) → 仍 exit 1', async () => {
    await seedAllHorizon(8);
    await prisma.calendarSyncHealth.update({
      where: { market: 'cn' },
      data: { servedBy: 'static' },
    });

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('降级');
  });

  it('🚨 心跳不回归: 视野充裕但 hk 心跳行缺失 → 仍 exit 1', async () => {
    await seedAllHorizon(8);
    await prisma.calendarSyncHealth.delete({ where: { market: 'hk' } });

    expect((await runPredicate()).exitCode).toBe(1);
  });

  it('🚨 心跳不回归: 视野充裕但 us 从未成功过 (last_success_at NULL) → 仍 exit 1', async () => {
    await seedAllHorizon(8);
    await prisma.calendarSyncHealth.update({
      where: { market: 'us' },
      data: { lastSuccessAt: null, servedBy: null },
    });

    expect((await runPredicate()).exitCode).toBe(1);
  });

  // ── ⑧ 谓词形状契约 (bash 零逻辑的前提, 加了视野判据后仍成立) ──────────────────────────────
  it('🚨 加了视野判据后谓词仍恒返单行两列 (exit_code ∈ {0,1} + 单行摘要)', async () => {
    await seedAllHorizon(8);
    const healthy = await runPredicate();
    for (const market of MARKETS) await seedHorizon(market, addDays(today, -1), []);
    const unhealthy = await runPredicate();

    expect([healthy.exitCode, unhealthy.exitCode]).toEqual([0, 1]);
    for (const s of [healthy.summary, unhealthy.summary]) {
      expect(s).not.toMatch(/[\t\n\r]/);
      expect(s.length).toBeGreaterThan(0);
    }
  });
});
