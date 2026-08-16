import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { marketdataSyncConfig } from '../../src/config/marketdata.config';
import { OptionSnapshotCoverageCheck } from '../../src/marketdata/option-snapshot-coverage.check';
import { marketDateFor } from '../../src/marketdata/trading-day-gate';

const SERVER_DIR = process.cwd();

/**
 * **期权快照逐合约完整性谓词** IT（Testcontainers PG），047 T025a。范式照
 * `marketdata.table-health.it.spec.ts`。
 *
 * 🚨🚨 **这是宪法 §II 的合规承重点**：`ops/jobs/marketdata-snapshot-integrity.sh` 无法
 * RED-first ⇒ 判断全部下沉为 SQL 谓词，bash 只剩「跑谓词 → 打摘要 → exit」。
 * 「bash 无判断逻辑」这个论证的全部重量，压在「谓词在此被真测」上。
 *
 * 🚨 谓词是**单一共享产物**：本文件**读** `ops/jobs/marketdata-snapshot-integrity.sql`
 * 跑，探针 `ops/jobs/marketdata-snapshot-integrity.sh` 读**同一文件**跑（同目录同名兄弟）。
 * 绝不在此内联复制 SQL（复制 = drift = 论证作废）。
 *
 * 🚨🚨 **改完谓词必须 `--skipNxCache` 重跑本文件**：谓词在 `ops/` 下，**不在 server project 的
 * Nx inputs 里** ⇒ 只改 `.sql` 时 `nx test server <file>` 会命中缓存直接返绿（假绿，比假红危险）。
 *
 * ═══ 本文件的第二重职责：**把同一判据的两处实现钉在一起** ═══
 *
 * FR-045 的判据有两处实现，且合并不掉：
 *   · TS 侧 `option-snapshot-coverage.check.ts`（T021）—— 要逐票明细 + 可注入故障的单测，
 *     并驱动两级自动补救（T022）；跑在**采集进程内**。
 *   · 本谓词（T025a）—— 要**独立于采集进程**（FR-051）：app 整个挂掉、数据自然缺失时照样告警。
 * ⇒ 代价是同一判据两份代码。本文件的每个场景都**同时**跑两边并断言**逐票结论一致** —— 这是
 * 两者不 drift 的机器绊线。其中「9/10 覆盖」那条专门用来撞**阈值** drift（TS 侧阈值来自
 * `MARKETDATA_OPTION_COVERAGE_THRESHOLD`，SQL 侧写在 `config` CTE；改一处不改另一处 → 本条红）。
 *
 * ═══ 时间锚：**场景用例钉死日期，另有一条专测不钉** ═══
 * 谓词的「当日」默认 = `(now() AT TIME ZONE 'America/New_York')::date`（session_date 是 us 业务日），
 * 但可被 `current_setting('nvy.current_day', true)` 覆盖 —— 该注入点**只为本文件存在**，生产的
 * `.sh` 不传 `-v`、不设任何 GUC。
 *
 * 🚨 **为什么场景用例必须钉死**：谓词带一道 **ET 周末闸**（当日落在 ET 周六/周日 → exit 0 不判，
 * 见 `.sql` 文件头）。不钉死 ⇒ 本文件**在 ET 周末跑就整片假绿** —— 假绿比假红危险得多。
 *
 * 🚨 **钉死的代价 + 它怎么被补回来**：全钉死则 `now() AT TIME ZONE 'America/New_York'` 那支永不
 * 执行，谁把它改成 `Asia/Shanghai` 都没人发现。⇒ 另留一条**不注入**的用例（下面「当日 = ET 的
 * 今天」），拿**生产同一个** `marketDateFor(['us'], now)` 对谓词自己吐出的「当日」，守住时区判据。
 */

/** 🚨 谓词单一真相源 —— **读文件**，绝不在此内联复制。 */
const PREDICATE_SQL = readFileSync(
  resolve(SERVER_DIR, '../../ops/jobs/marketdata-snapshot-integrity.sql'),
  'utf8',
);

const DAY_MS = 86_400_000;

/**
 * 场景用例的「当日」锚 —— **固定的 us 交易日**（2026-06-10 周三），与墙上时钟无关。
 * 周末闸的三向可证伪用例另取同一周的周五/周六/周日（见文件末尾那组）。
 */
const TODAY = '2026-06-10';

/** `YYYY-MM-DD` → `@db.Date` 列的 UTC 零点 Date。 */
const day = (s: string): Date => new Date(`${s}T00:00:00Z`);

/** `YYYY-MM-DD` 偏移 n 天。 */
const shift = (s: string, n: number): string =>
  new Date(day(s).getTime() + n * DAY_MS).toISOString().slice(0, 10);

describe('期权快照逐合约完整性谓词 (Testcontainers PG, 与 check.sh 共享同一 .sql)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let check: OptionSnapshotCoverageCheck;
  /** 场景用例的「当日」——钉死的固定交易日，注入给谓词、同时喂给 TS 侧（见文件头「时间锚」）。 */
  const today = TODAY;
  const contractIds = new Map<string, bigint>();

  beforeAll(async () => {
    db = await setupIsolatedDb();
    prisma = new PrismaService(db.databaseUrl);
    // 🚨 阈值取**生产配置工厂**的真实结果（默认 1），不是测试里手写的常数 —— 手写就把
    // 「两边阈值同源」这条断言变成了自说自话。
    check = new OptionSnapshotCoverageCheck(prisma, marketdataSyncConfig());
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.optionDailySnapshot.deleteMany();
    await prisma.optionContract.deleteMany();
    await prisma.instrument.deleteMany();
    contractIds.clear();
  });

  async function seedInstrument(code: string): Promise<bigint> {
    const row = await prisma.instrument.create({
      data: {
        market: 'us',
        code,
        name: `us:${code}`,
        type: 'stock',
        currency: 'USD',
        status: 'active',
        needSync: true,
      },
    });
    return row.id;
  }

  /** 给一只票造 `count` 张合约（到期日默认远月；`expiryDate` 可指定到期日以造「大到期日」）。 */
  async function seedContracts(
    code: string,
    count: number,
    expiryDate = shift(today, 60),
  ): Promise<string[]> {
    const instrumentId = contractIds.has(`inst:${code}`)
      ? contractIds.get(`inst:${code}`)!
      : await seedInstrument(code).then((id) => {
          contractIds.set(`inst:${code}`, id);
          return id;
        });
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const contractCode = `US.${code}${expiryDate.replaceAll('-', '')}P${100 + i}000`;
      const row = await prisma.optionContract.create({
        data: {
          market: 'us',
          code: contractCode,
          root: code,
          underlyingInstrumentId: instrumentId,
          expiryDate: day(expiryDate),
          strikePrice: 100 + i,
          optionType: 'PUT',
          isStandard: true,
        },
      });
      contractIds.set(contractCode, row.id);
      codes.push(contractCode);
    }
    return codes;
  }

  async function seedSnapshots(
    codes: string[],
    sessionDate: string,
    source = 'eod',
  ): Promise<void> {
    await prisma.optionDailySnapshot.createMany({
      data: codes.map((c) => ({
        contractId: contractIds.get(c)!,
        sessionDate: day(sessionDate),
        source,
        quoteAsOf: day(sessionDate),
        oiAsOf: day(sessionDate),
        greeksComplete: true,
      })),
    });
  }

  /** 契约（bash 零逻辑的前提）：恒单行两列 → bash 侧单次 `read` 读完，无需循环 = 无逻辑。 */
  function assertSingleRow(rows: { exit_code: number; summary: string }[]): {
    exitCode: number;
    summary: string;
  } {
    expect(rows).toHaveLength(1);
    return { exitCode: rows[0].exit_code, summary: rows[0].summary };
  }

  /** 把「当日」钉死到 `currentDay` 再跑谓词（默认 = 钉死的场景锚 `TODAY`）。 */
  async function runPredicate(
    currentDay: string = today,
  ): Promise<{ exitCode: number; summary: string }> {
    const rows = await prisma.$transaction(async (tx) => {
      // `set_config(..., is_local => true)` = 事务级，出事务即失效 ⇒ 不污染连接池里这条连接、
      // 也不会漏到别的用例。走参数绑定而非拼串（`SET LOCAL` 不支持绑定）。
      await tx.$queryRaw`SELECT set_config('nvy.current_day', ${currentDay}, true)`;
      return tx.$queryRawUnsafe<{ exit_code: number; summary: string }[]>(PREDICATE_SQL);
    });
    return assertSingleRow(rows);
  }

  /**
   * **生产同款调用**：不注入任何 GUC ⇒ 谓词走 `now() AT TIME ZONE 'America/New_York'` 那支。
   * 只给「当日 = ET 的今天」那条时区用例使用（见文件头「时间锚」）。
   */
  async function runPredicateWithHostClock(): Promise<{ exitCode: number; summary: string }> {
    return assertSingleRow(
      await prisma.$queryRawUnsafe<{ exit_code: number; summary: string }[]>(PREDICATE_SQL),
    );
  }

  /** 从 summary 解析出被判缺的票（谓词逐票全列，degraded 的打 `⚠缺`）。 */
  const degradedFromSummary = (summary: string): string[] =>
    [...summary.matchAll(/([a-z]{2}:[A-Za-z0-9.]+)=\d+\/\d+⚠缺/g)].map((m) => m[1]).sort();

  /**
   * 🚨 **同判据两处实现的绊线**：同一批数据，SQL 与 TS 的**逐票结论必须一致**。
   * 返回两边一致的那份 degraded 票集，供各用例继续断言具体内容。
   */
  async function assertBothAgree(): Promise<{ exitCode: number; degraded: string[] }> {
    const { exitCode, summary } = await runPredicate();
    const tsReport = await check.evaluate(today);

    const sqlDegraded = degradedFromSummary(summary);
    const tsDegraded = tsReport.degraded.map((u) => u.symbol).sort();
    expect(sqlDegraded).toEqual(tsDegraded);
    // 退出码与 TS 侧的 status 必须同向（`no_subject` / `ok` 都是 0）。
    expect(exitCode).toBe(tsReport.status === 'degraded' ? 1 : 0);
    return { exitCode, degraded: sqlDegraded };
  }

  // ── ① 输出契约（bash 零逻辑的前提）─────────────────────────────────────────────────────
  it('输出契约: 单行两列 + summary 无 tab/换行', async () => {
    const pep = await seedContracts('PEP', 3);
    await seedSnapshots(pep, shift(today, -1));
    await seedSnapshots(pep, today);

    const { exitCode, summary } = await runPredicate();
    expect([0, 1]).toContain(exitCode);
    expect(summary).not.toMatch(/[\t\n\r]/);
    expect(summary.length).toBeGreaterThan(0);
  });

  // ── ② 健康基线 ────────────────────────────────────────────────────────────────────────
  it('基线日的存续合约当日全部到齐 → exit 0', async () => {
    const pep = await seedContracts('PEP', 10);
    const vici = await seedContracts('VICI', 4);
    await seedSnapshots([...pep, ...vici], shift(today, -1));
    await seedSnapshots([...pep, ...vici], today);

    const { exitCode, degraded } = await assertBothAgree();
    expect(exitCode).toBe(0);
    expect(degraded).toEqual([]);
  });

  // ── ③ 三向可证伪（SC-002）─────────────────────────────────────────────────────────────
  /**
   * 🚨 这条守的是「**小票整票消失不许被大票盖住**」：PEP 10 张全在、VICI 4 张全没，
   * 全局比值 10/14 = 71%，而真正的信号是 VICI 的 0/4。判据只看全局总数时这只票就消失了。
   */
  it('🚨 整票缺席 → exit 1 且逐票指认到那只票 (不被大票平均掉)', async () => {
    const pep = await seedContracts('PEP', 10);
    const vici = await seedContracts('VICI', 4);
    await seedSnapshots([...pep, ...vici], shift(today, -1));
    await seedSnapshots(pep, today); // VICI 整票缺席

    const { exitCode, degraded } = await assertBothAgree();
    expect(exitCode).toBe(1);
    expect(degraded).toEqual(['us:VICI']);
    expect((await runPredicate()).summary).toContain('us:VICI=0/4⚠缺');
  });

  /**
   * 🚨 这条同时是**阈值 drift 的绊线**：9/10 = 90%。阈值 100% ⇒ 两边都判红；任一侧被悄悄放宽到
   * 0.9 以下，`assertBothAgree` 立刻不一致。
   */
  it('🚨 一批存续合约缺失 (9/10) → exit 1, 且两侧阈值一致', async () => {
    const pep = await seedContracts('PEP', 10);
    await seedSnapshots(pep, shift(today, -1));
    await seedSnapshots(pep.slice(0, 9), today);

    const { exitCode, degraded } = await assertBothAgree();
    expect(exitCode).toBe(1);
    expect(degraded).toEqual(['us:PEP']);
  });

  /**
   * 🚨 **假阳性守卫**（SC-002 第 ③ 向）：只验「会响」证不了「不乱响」，而每月假红一次的告警
   * 等于没有告警。已到期的腿不进分母 ⇒ 大到期日次日分母自然缩小，**无需任何日期特判**
   * （🚫 MUST NOT 用交易日历打「今天是大到期日所以放宽」的补丁 —— 循环信任，044 同款）。
   */
  it('🚨 大到期日次日 (基线日一批合约当日已到期) → exit 0, 不假红', async () => {
    const alive = await seedContracts('PEP', 10);
    const expiring = await seedContracts('VICI', 4, shift(today, -1)); // 昨天到期
    await seedSnapshots([...alive, ...expiring], shift(today, -1));
    await seedSnapshots(alive, today); // 已到期的那批当日自然没有

    const { exitCode, degraded } = await assertBothAgree();
    expect(exitCode).toBe(0);
    expect(degraded).toEqual([]);
  });

  /**
   * 🚨 边界闭：**当日到期**的合约当日**仍可取快照**（Guardrail 7，官方「结束日期请输入今天或
   * 未来的日期」）⇒ 它必须进分母。写成 `>` 只在到期日当天整批放行，平时永远看不出来。
   */
  it('🚨 当日到期的合约仍进分母 (`>=` 不是 `>`) → 当日缺席即 exit 1', async () => {
    const expiringToday = await seedContracts('PEP', 4, today);
    await seedSnapshots(expiringToday, shift(today, -1));
    // 当日一张都没采到

    const { exitCode, degraded } = await assertBothAgree();
    expect(exitCode).toBe(1);
    expect(degraded).toEqual(['us:PEP']);
  });

  // ── ④ 空态：无对象 ≠ 0% ───────────────────────────────────────────────────────────────
  it('分母为空 (无更早的快照 / 首日 / 零锚) → exit 0 且显式写「无对象」, 不判 0%', async () => {
    const pep = await seedContracts('PEP', 5);
    await seedSnapshots(pep, today); // 只有当日，没有基线日

    const { exitCode, summary } = await runPredicate();
    expect(exitCode).toBe(0);
    expect(summary).toContain('无对象');
    expect((await check.evaluate(today)).status).toBe('no_subject');
  });

  it('全表空 → exit 0 (上线首日的正常空态)', async () => {
    const { exitCode, degraded } = await assertBothAgree();
    expect(exitCode).toBe(0);
    expect(degraded).toEqual([]);
  });

  // ── ⑤ 基线日取「最近**有数据**的更早日」而非日历上的昨天 ──────────────────────────────
  /**
   * 🚨 取日历日会**自我掩盖**：昨天也整体停摆 ⇒ 昨天的分母为空 ⇒ 判「无对象」⇒ 连续停摆期间
   * 天天绿。取「最近有数据的那天」则缺口一直挂着直到补回来。
   */
  it('🚨 前一天也整体停摆 → 基线回退到更早的有数据日, 缺口仍然报出来', async () => {
    const pep = await seedContracts('PEP', 6);
    await seedSnapshots(pep, shift(today, -5)); // 只有 5 天前有数据
    // 昨天、今天都没有

    const { exitCode, degraded } = await assertBothAgree();
    expect(exitCode).toBe(1);
    expect(degraded).toEqual(['us:PEP']);
    expect((await runPredicate()).summary).toContain(`基线日 ${shift(today, -5)}`);
  });

  // ── ⑥ 多来源去重（T022 的兜底补采行）──────────────────────────────────────────────────
  /**
   * 🚨 基线日同一合约可能有 `eod` + `premarket_backfill` 两行。分母不去重 ⇒ 靠兜底续命的票
   * 分母凭空翻倍 ⇒ **覆盖率恒判红**（而且看起来像真缺口）。
   */
  it('🚨 基线日同一合约的多来源行只算一个分母单位 (eod + premarket_backfill)', async () => {
    const pep = await seedContracts('PEP', 4);
    await seedSnapshots(pep, shift(today, -1), 'eod');
    await seedSnapshots(pep, shift(today, -1), 'premarket_backfill');
    await seedSnapshots(pep, today);

    const { exitCode, degraded } = await assertBothAgree();
    expect(exitCode).toBe(0);
    expect(degraded).toEqual([]);
    expect((await runPredicate()).summary).toContain('us:PEP=4/4');
  });

  // ── ⑦ ET 周末闸：非交易日不判（三向可证伪）────────────────────────────────────────────
  /**
   * 🚨 背景：timer 是 `*-*-* 08:00` **每日**跑 ⇒ 北京周日早（= ET 周六）、北京周一早（= ET 周日）
   * 各触发一次，而那两天 us 不开盘、当日本就无快照 ⇒ 逐票全 `0/N` 判红 = **每周两条假红**。
   *
   * 🚨 闸只认 `isodow`，**不查 `trading_day` 表** —— 查表就与采集管线的交易日闸同源，日历一坏
   * 两边一起闭嘴（044 病灶）。周六周日永远不是 us 交易日 ⇒ 砍掉它**零检测力损失**。
   *
   * 🚨 **本组刻意不走 `assertBothAgree`**：TS 侧（`option-snapshot-coverage.check.ts`）的交易日闸
   * 在**调用方**（采集管线既有的那道），非交易日压根调不到它 ⇒ 两侧在周末的行为本就不同，钉在
   * 一起是错的。判据本体（分母 / 分子 / 阈值）仍由前面各条逐票钉死，这里只验闸。
   */
  const FRIDAY = '2026-06-12';
  const SATURDAY = '2026-06-13';
  const SUNDAY = '2026-06-14';
  const MONDAY = '2026-06-15';

  /** 基线日（周五）全量快照、之后一张没采 —— 判据上这是「整票全缺」的最强红。 */
  async function seedFridayOnlyGap(): Promise<void> {
    const pep = await seedContracts('PEP', 10);
    const vici = await seedContracts('VICI', 4);
    await seedSnapshots([...pep, ...vici], FRIDAY);
  }

  it.each([
    ['ET 周六', SATURDAY],
    ['ET 周日', SUNDAY],
  ])('🚨 当日是 %s → exit 0 且显式写「非交易日不判」, 不假红', async (_label, weekendDay) => {
    await seedFridayOnlyGap();

    const { exitCode, summary } = await runPredicate(weekendDay);
    expect(exitCode).toBe(0);
    // **不静默**：仍然说清楚「今天为什么没判」—— 静默会被读成「判过了、没事」（044 病灶形状）。
    expect(summary).toContain('非交易日不判');
    expect(summary).toContain(`当日 ${weekendDay}`);
    expect(summary).not.toMatch(/[\t\n\r]/);
  });

  /**
   * 🚨 **反例向** —— 没有这条，上面两条什么都证不了（把判据整个删掉它俩也绿）。同一批数据把当日
   * 换成交易日必须判红；周末闸若写宽了（比如误把周一也算进去），本条当场红。
   */
  it('🚨 反例: 同一批数据当日换成交易日 (周一) → exit 1, 证明周末闸没把判据整个关掉', async () => {
    await seedFridayOnlyGap();

    const { exitCode, summary } = await runPredicate(MONDAY);
    expect(exitCode).toBe(1);
    expect(degradedFromSummary(summary)).toEqual(['us:PEP', 'us:VICI']);
  });

  // ── ⑧ 时区锚：不注入时「当日」必须是 ET 的今天 ────────────────────────────────────────
  /**
   * 🚨 上面所有场景都钉死了日期 ⇒ 谓词里 `now() AT TIME ZONE 'America/New_York'` 那支**永不执行**，
   * 谁把它改成 `Asia/Shanghai` 都没人发现。本条把它捞回来：**不注入** GUC 跑一次（= 生产同款调用），
   * 拿**生产同一个** `marketDateFor(['us'], now)` 对谓词自己吐出的「当日」。误取上海口径 ⇒ 北京
   * 上午跑时两者差一天 ⇒ 本条红。
   *
   * 不依赖 seed 数据、也不断言 exit code —— 交易日与周末两种 summary 都带 `当日 X`，故本条与墙上
   * 时钟落在星期几无关。
   */
  it('🚨 不注入时「当日」= ET 的今天 (守 Asia/Shanghai 漂移)', async () => {
    const { summary } = await runPredicateWithHostClock();

    expect(summary).toContain(`当日 ${marketDateFor(['us'], new Date())}`);
  });
});
