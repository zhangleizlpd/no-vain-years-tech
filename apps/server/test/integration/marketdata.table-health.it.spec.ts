import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../../src/security/prisma.service';

const SERVER_DIR = process.cwd();

/**
 * **marketdata 表级数据健康谓词** IT（Testcontainers PG），照 044 交易日历探针的 T013 范式。
 *
 * 🚨🚨 **这是宪法 §II 的合规承重点**，不是一个普通 IT。
 *
 * 仓内无 bash 测试框架 → `ops/jobs/marketdata-table-health.sh` 无法 RED-first，直接撞宪法 §II
 * （NON-NEGOTIABLE）。沿用 044 裁决 = **把 bash 压到零逻辑**：判断全部下沉为 SQL 谓词，bash 只剩
 * 「跑谓词 → 映射退出码 → 打印摘要」。⇒ **「bash 无判断逻辑」这个论证的全部重量，压在「谓词在此
 * 被真测」上**。本文件塌 = §II 合规塌。
 *
 * 🚨 谓词是**单一共享产物**：本文件**读** `ops/jobs/marketdata-table-health.sql` 跑，
 * 探针 `ops/jobs/marketdata-table-health.sh` 读**同一文件**跑（同目录同名兄弟）。
 * 绝不在此内联复制 SQL（复制 = drift = 论证作废）。
 *
 * 🚨🚨 **改完谓词必须 `--skipNxCache` 重跑本文件**：谓词在 `ops/` 下，**不在 server project 的
 * Nx inputs 里** ⇒ 只改 `.sql` 时 `nx test server <file>` 会**命中缓存直接返绿**（日志里那句
 * `Nx read the output from the cache`），根本没跑。这是「假绿」不是「假红」—— 危险得多，因为
 * 它长得跟通过一模一样。2026-08-04 扩两个新维度时当场踩中：把 AND 蓄意改成 OR 跑出 17/17 绿，
 * 加 `--skipNxCache` 后立刻红 1 条。**变异验证不加这个 flag = 白做。**
 *
 * ═══ 本文件的重点是**变异测试**，不是「跑得通」═══
 * 探针的价值 100% 在「故障时会不会红」。只断言健康态返 0 等于什么都没验 —— 一个 `SELECT 0`
 * 也能通过。故下面每条 `🚨` 用例都是**注入一种真实故障形态**，要求谓词翻红：
 * 这正是 2026-08-01 那次事故（四维度静默丢数 12 个交易日、SyncRun 全绿）里缺失的那道闸。
 *
 * ═══ 时间锚 ═══
 * 谓词用 `now() AT TIME ZONE 'Asia/Shanghai'` 取「今天」，并从 `trading_day` 表按**交易日**折龄。
 * 本 IT 因此**自己造日历**：把最近 K 个自然日全部登记为交易日 → rn=1 是今天、rn=2 是昨天…
 * ⇒ lag=2 的 expected_day = 今天−2，lag=3（connect_holding）= 今天−3。与真实周末/长假解耦，
 * 用例可确定复现。
 */

/** 🚨 谓词单一真相源 —— **读文件**，绝不在此内联复制。 */
const PREDICATE_SQL = readFileSync(
  resolve(SERVER_DIR, '../../ops/jobs/marketdata-table-health.sql'),
  'utf8',
);

const DAY_MS = 86_400_000;

/** Asia/Shanghai 今天（与谓词的时间锚一致）。 */
function shanghaiToday(): Date {
  const d = new Date(Date.now() + 8 * 3_600_000);
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
}

/** 今天 − n 天（UTC 零点 Date，直落 @db.Date 列）。 */
function daysAgo(n: number): Date {
  return new Date(shanghaiToday().getTime() - n * DAY_MS);
}

/** 今天 + n 天（同上）。前向覆盖类判据（到期阶梯右端 / 财报视野）用它造数据。 */
function daysAhead(n: number): Date {
  return daysAgo(-n);
}

/** 健康基线的到期阶梯右端：远超谓词的 +120d 门槛（正常态约 7–8 个月 + LEAPS）。 */
const FAR_EXPIRY_DAYS = 400;
/** 健康基线的财报前向视野右端：vendor 视野约 6 个月，同样远超 +120d 门槛。 */
const EARNINGS_HORIZON_DAYS = 180;

/** 谓词清单里的哨兵票（改谓词 VALUES 必须同步改这里，否则用例会以假绿通过）。 */
const SENTINELS = {
  cnBar: [
    ['cn', '600519'],
    ['cn', '000651'],
  ],
  hkBar: [
    ['hk', '00700'],
    ['hk', '00005'],
  ],
} as const;
const US_WHITELIST = ['PEP', 'AOS'] as const;
/** 指数维度的工作集 = 谓词里写死的两个代码常量（**不查 instrument**，见谓词该段注释）。 */
const US_INDEX_CODES = ['VIX', 'VVIX'] as const;

describe('marketdata 表级数据健康谓词 (Testcontainers PG, 与 marketdata-table-health.sh 共享同一 .sql)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  const instIds = new Map<string, bigint>();

  beforeAll(async () => {
    db = await setupIsolatedDb();
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    // 事实表先删（FK 指向 instrument），再删 instrument / 日历。
    // 047 期权三表：快照 FK→合约、合约与财报 FK→instrument ⇒ 严格按此序删。
    await prisma.optionDailySnapshot.deleteMany();
    await prisma.optionContract.deleteMany();
    await prisma.earningsEvent.deleteMany();
    await prisma.dailyBar.deleteMany();
    await prisma.connectHoldingDaily.deleteMany();
    await prisma.shortSellingDaily.deleteMany();
    await prisma.volatilityDaily.deleteMany();
    await prisma.fundamentalSnapshot.deleteMany();
    await prisma.underlyingIvDaily.deleteMany();
    await prisma.instrument.deleteMany();
    // us_index_daily 无 instrument FK（指数级），删除顺序与上面无关。
    await prisma.usIndexDaily.deleteMany();
    await prisma.tradingDay.deleteMany();
    instIds.clear();
  });

  /**
   * 跑谓词。`availKb` = 谓词唯一的入参（PG 数据卷可用 KB，047 FR-052a 磁盘水位判据的观测值）——
   * 生产由 `check.sh` 的一次 `df` 递进来，这里由用例注入。
   *
   * 🚨 `replaceAll` 是**psql `-v` 文本替换的等价物**（psql 的变量插值本就是纯文本代换），不是
   * 「另写一份 SQL」：谓词仍是**读同一个文件**跑，判据一个字都不在本文件里。
   * 默认给一个极大值 ⇒ 除磁盘用例外，其余用例的判定与磁盘那条无关。
   */
  async function runPredicate(availKb = 1_000_000_000): Promise<{
    exitCode: number;
    summary: string;
  }> {
    const sql = PREDICATE_SQL.replaceAll(':avail_kb', String(availKb));
    const rows = await prisma.$queryRawUnsafe<{ exit_code: number; summary: string }[]>(sql);
    // 契约（bash 零逻辑的前提）：恒单行两列 → bash 侧单次 `read` 读完，无需循环 = 无逻辑。
    expect(rows).toHaveLength(1);
    return { exitCode: rows[0].exit_code, summary: rows[0].summary };
  }

  async function seedInstrument(market: string, code: string, needSync = true): Promise<bigint> {
    const row = await prisma.instrument.create({
      data: {
        market,
        code,
        name: `${market}:${code}`,
        type: 'stock',
        currency: market === 'us' ? 'USD' : market === 'hk' ? 'HKD' : 'CNY',
        status: 'active',
        needSync,
      },
    });
    instIds.set(`${market}:${code}`, row.id);
    return row.id;
  }

  /** 最近 K 个自然日全登记为交易日（见文件头「时间锚」）。 */
  async function seedCalendar(markets: string[], days = 15): Promise<void> {
    const data = markets.flatMap((market) =>
      Array.from({ length: days }, (_, i) => ({ market, date: daysAgo(i) })),
    );
    await prisma.tradingDay.createMany({ data, skipDuplicates: true });
  }

  const barOf = (instrumentId: bigint, date: Date) => ({
    instrumentId,
    tradeDate: date,
    adjust: 'none',
    open: 1,
    high: 1,
    low: 1,
    close: 1,
  });

  /**
   * 全维度新鲜的基线：日历 + 哨兵票 + us 白名单 + 各事实表在 `ageDays` 天前有行。
   * ageDays 默认 0（今天），各用例按需把某一维度推陈旧。
   */
  async function seedAllFresh(ageDays = 0): Promise<void> {
    await seedCalendar(['cn', 'hk', 'us']);
    const d = daysAgo(ageDays);

    for (const [market, code] of [...SENTINELS.cnBar, ...SENTINELS.hkBar]) {
      const id = await seedInstrument(market, code);
      await prisma.dailyBar.create({ data: barOf(id, d) });
    }
    for (const [, code] of SENTINELS.hkBar) {
      const id = instIds.get(`hk:${code}`)!;
      await prisma.connectHoldingDaily.create({ data: { instrumentId: id, date: d } });
      await prisma.shortSellingDaily.create({ data: { instrumentId: id, date: d } });
      await prisma.volatilityDaily.create({
        data: { instrumentId: id, date: d, volatilityDays: 250 },
      });
    }
    // fundamental 哨兵 = 每市场 2 只（谓词按 (dim, market) 聚合 → 单点会退化成 OR）。
    for (const [market, code] of [...SENTINELS.cnBar, ...SENTINELS.hkBar]) {
      await prisma.fundamentalSnapshot.create({
        data: { instrumentId: instIds.get(`${market}:${code}`)!, date: d },
      });
    }
    for (const code of US_WHITELIST) {
      const id = await seedInstrument('us', code, true);
      await prisma.dailyBar.create({ data: barOf(id, d) });
      await prisma.underlyingIvDaily.create({ data: { instrumentId: id, date: d } });
    }
    // 指数维度不挂锚闸：工作集是常量，与上面的 need_sync 白名单无关。
    for (const code of US_INDEX_CODES) {
      await prisma.usIndexDaily.create({ data: { indexCode: code, date: d, close: 20 } });
    }
    // 047 M2b 三个新维度。链发现 / 快照的工作集 = us 锚里**已经有合约的那些**（见谓词该段）。
    for (const code of US_WHITELIST) {
      const id = instIds.get(`us:${code}`)!;
      await seedOptionLadder(code, id, [FAR_EXPIRY_DAYS], d);
      await prisma.earningsEvent.create({
        data: {
          instrumentId: id,
          earningsDate: daysAhead(EARNINGS_HORIZON_DAYS),
          pubType: 'AFTER',
          firstSeenAt: d,
        },
      });
    }
  }

  /**
   * 给一只票造「到期阶梯 + 逐日快照」。`expiryOffsets` = 各合约距今天的天数（阶梯右端由最大值
   * 决定，谓词判它 ≥ +120d）；`sessionDates` = 要落快照的交易日。
   */
  async function seedOptionLadder(
    code: string,
    instrumentId: bigint,
    expiryOffsets: number[],
    ...sessionDates: Date[]
  ): Promise<void> {
    for (const offset of expiryOffsets) {
      const contract = await prisma.optionContract.create({
        data: {
          market: 'us',
          code: `US.${code}${offset}P100000`,
          root: code,
          underlyingInstrumentId: instrumentId,
          expiryDate: daysAhead(offset),
          strikePrice: 100,
          optionType: 'PUT',
          isStandard: true,
        },
      });
      for (const sessionDate of sessionDates) {
        await prisma.optionDailySnapshot.create({
          data: {
            contractId: contract.id,
            sessionDate,
            source: 'eod',
            quoteAsOf: sessionDate,
            oiAsOf: sessionDate,
            greeksComplete: true,
          },
        });
      }
    }
  }

  /** 把某只票在某张表里的行整体后移到 `ageDays` 天前（模拟该票停止产出新数据）。 */
  async function pushStale(table: 'dailyBar', key: string, ageDays: number): Promise<void> {
    await prisma[table].updateMany({
      where: { instrumentId: instIds.get(key)! },
      data: { tradeDate: daysAgo(ageDays) },
    });
  }

  // ── ① 健康基线 + bash 侧依赖的输出契约 ──────────────────────────────────────────────────
  it('全维度新鲜 → 健康 exit 0', async () => {
    await seedAllFresh();

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(0);
    expect(summary).toContain('✅');
  });

  it('输出契约: 单行两列 + summary 无 tab/换行 (bash 单次 read 解析的前提)', async () => {
    await seedAllFresh();

    const { exitCode, summary } = await runPredicate();
    expect([0, 1]).toContain(exitCode); // 退出码直接就是 bash 的 exit
    expect(summary).not.toMatch(/[\t\n\r]/);
    expect(summary.length).toBeGreaterThan(0);
  });

  // ── ② 陈旧阈值两侧（lag=2 的 T+0 维度）────────────────────────────────────────────────
  it('数据落后 2 个交易日 (= 阈值上沿) → 仍健康 exit 0', async () => {
    await seedAllFresh(2);

    expect((await runPredicate()).exitCode).toBe(0);
  });

  it('🚨 数据落后 3 个交易日 (越阈值) → 不健康 exit 1', async () => {
    await seedAllFresh(3);

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('🔴');
  });

  // ── ③ AND 语义: 单票停牌不误报, 整维停摆才报 ────────────────────────────────────────────
  it('单只哨兵陈旧 (另一只新鲜) → 仍健康 exit 0 (个股停牌不误判为维度故障)', async () => {
    await seedAllFresh();
    await pushStale('dailyBar', 'cn:600519', 30);

    expect((await runPredicate()).exitCode).toBe(0);
  });

  /**
   * 🚨 这条守的是「**不被健康市场平均掉**」：`eod_bar` 的 marketScope 是 {cn,hk}，cn 侧整个停摆时
   * hk 侧仍新鲜。谓词首版按 `dim` 聚合 → 被这条用例当场抓出判绿（2026-08-02），遂改为按
   * (dim, market) 聚合。044 交易日历探针有同名教训。
   */
  it('🚨 单市场整体陈旧 (另一市场健康) → 不健康 exit 1, 摘要指认到 dim:market', async () => {
    await seedAllFresh();
    await pushStale('dailyBar', 'cn:600519', 30);
    await pushStale('dailyBar', 'cn:000651', 30);

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('eod_bar:cn');
    expect(summary).toContain('⚠陈旧');
    expect(summary).toContain('eod_bar:hk=2/2'); // hk 侧仍报健康 → 确实是「未被平均」而非全红
  });

  // ── ④ connect_holding 的 T+1 宽限 (lag=3, 与其余维度不同) ───────────────────────────────
  it('connect_holding 落后 3 个交易日 (T+1 宽限内) → 健康; 落后 4 个 → 不健康', async () => {
    await seedAllFresh();
    const ids = SENTINELS.hkBar.map(([, c]) => instIds.get(`hk:${c}`)!);

    await prisma.connectHoldingDaily.updateMany({
      where: { instrumentId: { in: ids } },
      data: { date: daysAgo(3) },
    });
    expect((await runPredicate()).exitCode).toBe(0);

    await prisma.connectHoldingDaily.updateMany({
      where: { instrumentId: { in: ids } },
      data: { date: daysAgo(4) },
    });
    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('connect_holding');
  });

  // ── ⑤ us 侧 OR 语义 + 空工作集 ─────────────────────────────────────────────────────────
  it('🚨 us 白名单任一只掉队 → 不健康 exit 1 (OR 语义: 每只都是 045 雷达锚定标的)', async () => {
    await seedAllFresh();
    await pushStale('dailyBar', 'us:AOS', 30);

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('us_equity_bar');
    expect(summary).toContain('⚠掉队');
  });

  it('🚨 us 工作集为空 (need_sync 全 false) → 不健康 exit 1 (空工作集也是要抓的签名)', async () => {
    await seedAllFresh();
    await prisma.instrument.updateMany({ where: { market: 'us' }, data: { needSync: false } });

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('us_equity_bar=0/0');
    // AND 语义下空工作集同样判红（fresh 计数为 0），不靠额外的 `count(*) = 0` 分支。
    expect(summary).toContain('underlying_iv_daily=0/0');
    // 🚨 指数维度**不挂锚闸**（046 FR-027）：零锚时它必须照常绿，否则「指数表盘不依赖锚」
    //    这条决策在监控面上被写反了。
    expect(summary).toContain('us_index_daily=2/2');
  });

  // ── ⑥ 沉默 ≠ 健康: 查不到东西一律判红, 绝不静默放行 ─────────────────────────────────────
  it('🚨 事实表整个空 → 不健康 exit 1 (空表被读成正常正是 044 事故的病灶形状)', async () => {
    await seedAllFresh();
    await prisma.volatilityDaily.deleteMany();

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('volatility');
  });

  it('🚨 整组哨兵票不在 instrument 表 → 不健康 exit 1 (LEFT JOIN 后 NULL 不得被读成健康)', async () => {
    await seedAllFresh();
    // 删 instrument（事实行随 onDelete: Cascade 一并消失）→ 该 (dim, market) 的哨兵全部查不到。
    await prisma.instrument.deleteMany({
      where: { id: { in: SENTINELS.hkBar.map(([, c]) => instIds.get(`hk:${c}`)!) } },
    });

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    // 「查不到」必须落成 0/2 判红，而不是因为没有行就跳过该 scope（那才是静默放行）。
    expect(summary).toContain('connect_holding:hk=0/2');
  });

  it('🚨 交易日历为空 → 算不出 expected_day → 不健康 exit 1 (fail-closed, 不静默放行)', async () => {
    await seedAllFresh();
    await prisma.tradingDay.deleteMany();

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('日历缺失');
  });

  // ── ⑦ underlying_iv_daily: AND 语义 (046 M2a 新维度) ────────────────────────────────────
  /**
   * 🚨 这条守的是「**无期权标的不该把探针钉成永久红**」—— 与它上面 us_equity_bar 的 OR 用例
   * 恰好相反，两条必须同时在，否则日后有人「统一一下语义」会把其中一侧悄悄改坏。
   * 依据：`overview` 对没有挂牌期权的标的**整行缺席**，executor 计 `skipped` 而非 `failed`。
   */
  it('单只锚拿不到新 IV (另一只新鲜) → 仍健康 exit 0 (无期权标的整行缺席是端口契约内的正常态)', async () => {
    await seedAllFresh();
    await prisma.underlyingIvDaily.deleteMany({
      where: { instrumentId: instIds.get('us:AOS')! },
    });

    expect((await runPredicate()).exitCode).toBe(0);
  });

  it('🚨 全部锚的 IV 都陈旧 → 不健康 exit 1 (维度级停摆才是本判据要抓的形态)', async () => {
    await seedAllFresh();
    await prisma.underlyingIvDaily.updateMany({ data: { date: daysAgo(30) } });

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toMatch(/underlying_iv_daily=0\/2@[\d-]+⚠陈旧/);
    // 同工作集的正股日线仍绿 → 坐实是逐维度判定，而非「us 段整体翻红」。
    expect(summary).toContain('us_equity_bar=2/2');
  });

  it('🚨 underlying_iv_daily 整表空 → 不健康 exit 1 (「上线 N 天 0 行」正是本探针的病灶形状)', async () => {
    await seedAllFresh();
    await prisma.underlyingIvDaily.deleteMany();

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('underlying_iv_daily=0/2');
  });

  // ── ⑧ us_index_daily: 两个固定代码 OR (无 instrument 关联) ──────────────────────────────
  it('🚨 VIX / VVIX 任一个陈旧 → 不健康 exit 1 (两个都是常量, 无「正常缺席」这回事)', async () => {
    await seedAllFresh();
    await prisma.usIndexDaily.updateMany({
      where: { indexCode: 'VVIX' },
      data: { date: daysAgo(30) },
    });

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toMatch(/us_index_daily=1\/2@[\d-]+⚠缺数/);
  });

  it('🚨 us_index_daily 整表空 → 不健康 exit 1 (它不挂锚闸, 零锚也该照常有数据)', async () => {
    await seedAllFresh();
    await prisma.usIndexDaily.deleteMany();

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('us_index_daily=0/2');
  });

  // ── ⑨ 047 M2b option_contract: 前向到期阶梯右端 (OR) ────────────────────────────────────
  /**
   * 🚨 这条抓的是「**跑了但少采一半**」：窗序列跑到一半 budget 耗尽 → 该票到期阶梯被截断。
   * 截断后近端合约仍在、快照照采 ⇒ 时间戳类判据、行数类判据、快照新鲜度**全都看不见**它。
   * （链发现是 `createMany(skipDuplicates)`，稳态零写入 ⇒ `updated_at` 判据在这里根本不成立。）
   */
  it('🚨 单只票的到期阶梯被截到 +30d (另一只完整) → 不健康 exit 1', async () => {
    await seedAllFresh();
    await prisma.optionContract.updateMany({
      where: { underlyingInstrumentId: instIds.get('us:AOS')! },
      data: { expiryDate: daysAhead(30) },
    });

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('option_contract=1/2@≥+120d⚠阶梯截断');
    // 快照那条不该被连坐（合约还在、当日快照还在）→ 坐实两条判据各判各的。
    expect(summary).toContain('option_daily_snapshot=2/2');
  });

  it('🚨 一只锚都没有合约 (空工作集) → 不健康 exit 1 (空工作集本身是要抓的签名)', async () => {
    await seedAllFresh();
    await prisma.optionDailySnapshot.deleteMany();
    await prisma.optionContract.deleteMany();

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('option_contract=0/0');
  });

  // ── ⑩ 047 M2b option_daily_snapshot: 数据年龄 (OR) ──────────────────────────────────────
  it('🚨 单只票当日无快照 (另一只有) → 不健康 exit 1 ("少采一半"的直接形态)', async () => {
    await seedAllFresh();
    await prisma.optionDailySnapshot.deleteMany({
      where: { contract: { underlyingInstrumentId: instIds.get('us:AOS')! } },
    });

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toMatch(/option_daily_snapshot=1\/2@[\d-]+⚠掉队/);
    // 合约表没动 → 阶梯那条仍绿。
    expect(summary).toContain('option_contract=2/2');
  });

  // ── ⑪ 047 M2b earnings_event: 市场级两条信号并联 ────────────────────────────────────────
  it('🚨 前向视野右端腰斩到 +90d (26 个窗只跑了一半) → 不健康 exit 1', async () => {
    await seedAllFresh();
    await prisma.earningsEvent.updateMany({ data: { earningsDate: daysAhead(90) } });

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('⚠视野');
  });

  it('🚨 视野右端仍在但 10 天没有新观察 → 不健康 exit 1 (整体停摆的快信号)', async () => {
    await seedAllFresh();
    await prisma.earningsEvent.updateMany({ data: { firstSeenAt: daysAgo(10) } });

    expect((await runPredicate()).exitCode).toBe(1);
  });

  it('🚨 earnings_event 整表空 → 不健康 exit 1 (「上线 N 天 0 行」同一病灶形状)', async () => {
    await seedAllFresh();
    await prisma.earningsEvent.deleteMany();

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(1);
    expect(summary).toContain('视野空表');
  });

  // ── ⑫ 047 M2b 磁盘水位 (FR-052a) ────────────────────────────────────────────────────────
  /** 把快照铺到最近 `days` 个自然日上（日历已登记 15 天全为交易日 → 交易日数 = days）。 */
  async function seedSnapshotHistory(days: number): Promise<void> {
    const contract = await prisma.optionContract.findFirstOrThrow();
    await prisma.optionDailySnapshot.createMany({
      data: Array.from({ length: days }, (_, i) => ({
        contractId: contract.id,
        sessionDate: daysAgo(i),
        source: 'eod',
        quoteAsOf: daysAgo(i),
        oiAsOf: daysAgo(i),
        greeksComplete: true,
      })),
      skipDuplicates: true,
    });
  }

  it('🚨 可用空间撑不到 90 天 → 不健康 exit 1 (阈值 = 实测日均增长 × 90d, 不是拍的百分比)', async () => {
    await seedAllFresh();
    await seedSnapshotHistory(12); // ≥ 10 个交易日 ⇒ 日均增长可算

    const { exitCode, summary } = await runPredicate(1); // 可用 1 KB
    expect(exitCode).toBe(1);
    expect(summary).toContain('⚠水位');
  });

  it('可用空间充裕 → 健康 exit 0 (同一批数据, 只换观测值 ⇒ 判据确实吃 avail 而非恒红)', async () => {
    await seedAllFresh();
    await seedSnapshotHistory(12);

    const { exitCode, summary } = await runPredicate(1_000_000_000);
    expect(exitCode).toBe(0);
    expect(summary).toContain('可撑');
  });

  it('样本不足 10 个交易日 → 判「样本不足」不告警 (上线首两周的正常空态, 但显式写进 summary)', async () => {
    await seedAllFresh();
    await seedSnapshotHistory(5);

    const { exitCode, summary } = await runPredicate(1); // 余量极低也不该红
    expect(exitCode).toBe(0);
    expect(summary).toContain('样本不足');
  });
});
