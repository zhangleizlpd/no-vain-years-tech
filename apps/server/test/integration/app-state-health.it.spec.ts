import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';

const SERVER_DIR = process.cwd();

/**
 * **非 marketdata 侧应用状态健康谓词** IT（Testcontainers PG），照 044 / table-health 的谓词 IT 范式。
 *
 * 🚨🚨 **这是宪法 §II 的合规承重点**：`ops/jobs/app-state-health.sh` 是零逻辑 bash，「判断已被
 * 真测」的全部重量压在本文件上。本文件塌 = §II 合规塌。
 *
 * ═══ 重点是变异，不是「跑得通」═══
 * 探针的价值 100% 在「故障时会不会红」。只断言健康态返 0 等于什么都没验 —— 一个 `SELECT 0`
 * 也能通过。故下面每条 `🚨` 用例都**注入一种真实故障形态**并要求谓词翻红。
 *
 * ═══ 覆盖边界（说清楚没覆盖什么，比夸大覆盖面重要）═══
 * 判据 ① 取 **AND 语义**（全部 active 锚掉队才红）—— 单只停牌 / 退市 / 新建锚不判红，代价是
 * **单只锚长期掉队本谓词看不见**（summary 报 `fresh/total` 让它可见但不告警）。下面有一条用例
 * 专门把这个边界钉死，免得有人「顺手」把 AND 改成 OR 之后没人发现语义变了。
 */

/** 🚨 谓词单一真相源 —— **读文件**，绝不在此内联复制。 */
const PREDICATE_SQL = readFileSync(
  resolve(SERVER_DIR, '../../ops/jobs/app-state-health.sql'),
  'utf8',
);

const DAY_MS = 86_400_000;

/** Asia/Shanghai 今天（与谓词的时间锚一致）。 */
function shanghaiToday(): Date {
  const d = new Date(Date.now() + 8 * 3_600_000);
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
}

function daysAgo(n: number): Date {
  return new Date(shanghaiToday().getTime() - n * DAY_MS);
}

describe('#209 app-state-health 谓词 (Testcontainers PG)', () => {
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
    await prisma.anchor.deleteMany({});
    await prisma.outboxEvent.deleteMany({});
    await prisma.tradingDay.deleteMany({});
  });

  async function runPredicate(): Promise<{ exitCode: number; summary: string }> {
    const rows =
      await prisma.$queryRawUnsafe<{ exit_code: number; summary: string }[]>(PREDICATE_SQL);
    // 契约（bash 零逻辑的前提）：恒单行两列 → bash 侧单次 `read` 读完，无需循环 = 无逻辑。
    expect(rows).toHaveLength(1);
    return { exitCode: rows[0].exit_code, summary: rows[0].summary };
  }

  /** 把最近 K 个自然日全部登记为交易日 ⇒ rn=1 是今天、rn=3 是今天−2（= expected_day）。 */
  async function seedCalendar(market: string, days = 10): Promise<void> {
    await prisma.tradingDay.createMany({
      data: Array.from({ length: days }, (_, i) => ({
        market,
        date: daysAgo(i),
        sessionKind: 'full',
      })),
      skipDuplicates: true,
    });
  }

  async function seedAnchor(
    ticker: string,
    market: string,
    lastCloseDaysAgo: number | null,
    excluded = false,
  ): Promise<void> {
    await prisma.anchor.create({
      data: {
        ticker,
        market,
        v: '100.0000',
        asof: shanghaiToday(),
        method: 'manual',
        confidence: '0.80',
        confidenceSource: 'manual',
        lLevelEffective: 'L2',
        excluded,
        ...(lastCloseDaysAgo === null
          ? {}
          : { lastClose: '99.0000', lastCloseDate: daysAgo(lastCloseDaysAgo) }),
      },
    });
  }

  async function seedOutbox(createdMinutesAgo: number, published: boolean): Promise<void> {
    const created = new Date(Date.now() - createdMinutesAgo * 60_000);
    await prisma.outboxEvent.create({
      data: {
        eventType: 'test.event',
        payload: {},
        createdAt: created,
        ...(published ? { publishedAt: created } : {}),
      },
    });
  }

  it('健康态: 锚新鲜 + outbox 无积压 → exit 0', async () => {
    await seedCalendar('us');
    await seedAnchor('us:AAA', 'us', 0);
    await seedAnchor('us:BBB', 'us', 1);
    await seedOutbox(60, true); // 已派发, 不计
    await seedOutbox(1, false); // 未派发但未超期, 不计

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(0);
    expect(summary).toContain('anchor_close=2/2');
    expect(summary).toContain('outbox_stuck=0');
    expect(summary).not.toContain('⚠');
  });

  it('🚨 判据①: **全部** active 锚的收盘价掉队 → exit 1 (整体停摆)', async () => {
    // 这正是 sync-anchor-last-close.scheduler 的真实故障形态: catch → logger.error → return null,
    // 不落 sync_run ⇒ 除本谓词外没有任何东西看得见。
    await seedCalendar('us');
    await seedAnchor('us:AAA', 'us', 5);
    await seedAnchor('us:BBB', 'us', 7);

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('⚠整体停摆');
    expect(summary).toContain('anchor_close=0/2');
  });

  it('🚨 覆盖边界: 只有**部分**锚掉队 ⇒ **不判红**, 但计数必须可见', async () => {
    // AND 语义的代价钉在这里。有人把 AND 改成 OR 时, 本条会红 —— 那是**语义变更的信号**,
    // 不是 bug: 改之前先想清楚停牌 / 退市 / 新建锚怎么排除。
    await seedCalendar('us');
    await seedAnchor('us:AAA', 'us', 0);
    await seedAnchor('us:STALE', 'us', 9);

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(0);
    expect(summary).toContain('anchor_close=1/2');
    expect(summary).not.toContain('⚠整体停摆');
  });

  it('excluded 锚不参与判定 (它本就不该有新报价)', async () => {
    await seedCalendar('us');
    await seedAnchor('us:AAA', 'us', 0);
    await seedAnchor('us:DEAD', 'us', 30, true);

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(0);
    expect(summary).toContain('anchor_close=1/1');
  });

  it('🚨 判据②: active 锚为 0 → exit 1 (空工作集也是要抓的签名)', async () => {
    await seedCalendar('us');
    await seedAnchor('us:DEAD', 'us', 0, true); // 只有 excluded

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('⚠空工作集');
  });

  it('🚨 判据③: **任一**市场算不出 expected_day → exit 1 (逐市场 fail-closed)', async () => {
    // 🚨 这条**必须是混合市场**, 否则它测不到 ③: 日历全缺时所有锚都算不新鲜 ⇒ 判据 ① 先触发,
    // ③ 永无独立生效的机会 —— 初版正是这么写的, 「让 ③ 永不触发」的变异跑出 8/8 全绿才暴露。
    // 这里 us 有日历且锚新鲜(① 不触发、② 不触发), hk 无日历 ⇒ 只有 ③ 能让它红。
    await seedCalendar('us');
    await seedAnchor('us:AAA', 'us', 0);
    await seedAnchor('hk:00700', 'hk', 0); // hk 没有 trading_day ⇒ expected_day NULL

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('⚠日历缺失');
  });

  it('日历全缺时报「日历缺失」而不是「整体停摆」(顺序承重: 判不了 > 判出来是坏的)', async () => {
    // 两者同时为真。报成「整体停摆」会把人引向采集侧, 而真正该修的是日历。
    await seedCalendar('us', 2); // 只有 2 天 ⇒ 取不到 rn=3
    await seedAnchor('us:AAA', 'us', 0);

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('⚠日历缺失');
    expect(summary).not.toContain('⚠整体停摆');
  });

  it('🚨 判据④: outbox 有超期未派发事件 → exit 1 (relay 停摆)', async () => {
    // OutboxEventCronPublisher 是 @Cron EVERY_10_SECONDS ⇒ 15 分钟 = 90 倍余量。
    // 一条事件超期 = relay 真的停了, 不是排队。
    await seedCalendar('us');
    await seedAnchor('us:AAA', 'us', 0);
    await seedOutbox(30, false);

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('⚠relay 停摆');
    expect(summary).toContain('outbox_stuck=1');
  });

  it('契约: summary 单行、无 tab/换行 (bash 单次 read 解析的前提)', async () => {
    await seedCalendar('us');
    await seedAnchor('us:AAA', 'us', 0);

    const { summary } = await runPredicate();
    expect(summary).not.toMatch(/[\t\n\r]/);
  });
});
