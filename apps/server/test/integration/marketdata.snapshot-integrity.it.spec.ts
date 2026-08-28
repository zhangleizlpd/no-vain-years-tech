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
    await prisma.tradingDay.deleteMany();
    await prisma.calendarCoverage.deleteMany();
    await seedCalendar();
    contractIds.clear();
  });

  /**
   * us 交易日历的**默认**布景（#276 三态闸的前提）：`[TODAY-60, TODAY+60]` 全部工作日为交易日，
   * 覆盖声明恰为同一区间。
   *
   * 🚨 **每个用例都要它** —— 少了它，`current_day` 落在「无声明」⇒ 三态判 `unknown` ⇒ 闸
   * fail-closed 判红，本文件所有场景用例会整片变红且看起来像判据坏了。⇒ 放 `beforeEach`
   * 而非 `beforeAll`：假期档那条用例要**删掉其中一行**，不能污染别的用例。
   *
   * 🚫 **MUST NOT 只 seed `trading_day` 不 seed `calendar_coverage`**：那样无行的日子会落
   * `unknown` 而不是 `non-trading`，正是三态要分开的那两格。
   */
  async function seedCalendar(): Promise<void> {
    const from = shift(TODAY, -60);
    const to = shift(TODAY, 60);
    const days: Date[] = [];
    for (let d = day(from).getTime(); d <= day(to).getTime(); d += DAY_MS) {
      const date = new Date(d);
      // 周末不进 `trading_day`（真实形态如此）——它们落 `non-trading`，与 isodow 闸结论一致。
      if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) days.push(date);
    }
    await prisma.tradingDay.createMany({
      data: days.map((date) => ({ market: 'us', date, sessionKind: 'whole' })),
    });
    await prisma.calendarCoverage.create({
      data: { market: 'us', coveredFrom: day(from), coveredTo: day(to), servedBy: 'futu' },
    });
  }

  async function seedInstrument(code: string, market = 'us'): Promise<bigint> {
    const row = await prisma.instrument.create({
      data: {
        market,
        code,
        name: `${market}:${code}`,
        type: 'stock',
        currency: market === 'hk' ? 'HKD' : 'USD',
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
    market = 'us',
  ): Promise<string[]> {
    const key = `inst:${market}:${code}`;
    const instrumentId = contractIds.has(key)
      ? contractIds.get(key)!
      : await seedInstrument(code, market).then((id) => {
          contractIds.set(key, id);
          return id;
        });
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const contractCode = `${market.toUpperCase()}.${code}${expiryDate.replaceAll('-', '')}P${100 + i}000`;
      const row = await prisma.optionContract.create({
        data: {
          market,
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
    const tsReport = await check.evaluate('us', today);

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

  // ── #231 存在性层：名册驱动，缺席不靠历史分母 ─────────────────────────────────────────
  /**
   * 🚨 **本判据的病灶形状**（#231，`us:ALB` 实撞）：一只票**连缺两轮**时，它在基线日也没有行
   * ⇒ 不进分母 ⇒ 判据对它**无输出** ⇒ ✅ 绿。与 Prometheus「实例从服务发现消失后
   * `avg by (job)(up)` returning nothing rather than alerting」逐字同构 —— 期望源取自被监控
   * 数据自身，数据消失把期望一起带走。
   *
   * ⇒ 缺席**必须**用**名册**判（`need_sync` 工作集 ∧ 有未到期合约），与历史分母无关。
   * 承重断言 = 第二轮仍然 exit 1；第一轮绿是错的方向（那轮全局基线本来就能抓到）。
   */
  it('🚨 单票连缺两轮 → 第二轮仍 exit 1 (缺席走名册, 不靠基线日有没有它)', async () => {
    const pep = await seedContracts('PEP', 10);
    const vici = await seedContracts('VICI', 4);
    await seedSnapshots([...pep, ...vici], shift(today, -2));
    // 第一轮：VICI 缺席（基线日 = T-2，它在那天有行 ⇒ 老判据也抓得到）
    await seedSnapshots(pep, shift(today, -1));
    // 第二轮：VICI 继续缺席，而基线日已滑到 T-1 —— 那天它就没有行了
    await seedSnapshots(pep, today);

    const { exitCode, degraded } = await assertBothAgree();
    expect(exitCode).toBe(1);
    expect(degraded).toEqual(['us:VICI']);
    expect((await runPredicate()).summary).toContain('us:VICI');
  });

  /**
   * 🚨 **假阳性守卫**：名册 = 采集侧同源的工作集（`need_sync`，它是锚闸 `anchor-driven-sync-gate`
   * 对锚表重算后的**物化结果**）。删锚 ⇒ 下一轮闸把 `need_sync` 置 false ⇒ 该票离开名册。
   * 不挂这道闸的话，删锚之后那只票会因「名册还记得它」而永久判红。
   */
  it('🚨 不在工作集的票 (need_sync=false) 连缺不判红 (删锚不得变成永久假红)', async () => {
    const pep = await seedContracts('PEP', 10);
    const gone = await seedContracts('VICI', 4);
    await seedSnapshots([...pep, ...gone], shift(today, -2));
    await seedSnapshots(pep, shift(today, -1));
    await seedSnapshots(pep, today);
    await prisma.instrument.updateMany({ where: { code: 'VICI' }, data: { needSync: false } });

    const { exitCode, degraded } = await assertBothAgree();
    expect(exitCode).toBe(0);
    expect(degraded).toEqual([]);
  });

  /**
   * 🚨 **假阳性守卫**：名册要求「**有未到期合约**」。合约全到期的票本就无可采，
   * 留在名册里等于每天假红一次 —— 同「大到期日次日不假红」那条的方向。
   */
  it('🚨 名册里合约全已到期的票 → 不进名册, 不判红', async () => {
    const pep = await seedContracts('PEP', 10);
    const dead = await seedContracts('VICI', 4, shift(today, -1)); // 昨天到期
    await seedSnapshots([...pep, ...dead], shift(today, -2));
    await seedSnapshots(pep, shift(today, -1));
    await seedSnapshots(pep, today);

    const { exitCode, degraded } = await assertBothAgree();
    expect(exitCode).toBe(0);
    expect(degraded).toEqual([]);
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
    expect((await check.evaluate('us', today)).status).toBe('no_subject');
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

  // ── #255 跨市场隔离：港股行 MUST NOT 进 us 判定 ───────────────────────────────────────
  //
  // 🚨 这两条是 **invariance metamorphic relation**（往输入里加一批与被测对象无关的数据，输出
  //    必须不变）。#255 之前本谓词与 TS 侧的 baseline / denom / collected 三处都没有市场谓词
  //    —— 那个前提不是写成字面量，是写成**没有过滤条件**，所以没有任何既有用例会因它失效而红。
  it('🚨 #255 港股整票缺口 MUST NOT 改变 us 的逐票结论（两侧同时验）', async () => {
    const pep = await seedContracts('PEP', 10);
    await seedSnapshots(pep, shift(today, -1));
    await seedSnapshots(pep, today);

    const before = await assertBothAgree();
    const beforeSummary = (await runPredicate()).summary;
    expect(before.degraded).toEqual([]);

    // 港股：基线日有 10 张、当日一张都没有 = 一个**整票缺口**。跨市场泄漏时它会被算进 us 的
    // 分母并判 `hk:00700` 缺 —— 那正是 2026-08-28 08:00 把港股票交给美股补救器的那条路。
    const tencent = await seedContracts('00700', 10, shift(today, 60), 'hk');
    await seedSnapshots(tencent, shift(today, -1));

    expect(await assertBothAgree()).toEqual(before);
    // SQL 侧摘要**逐字节**不变 —— 逐票数字也不许动，不只是 degraded 集合。
    expect((await runPredicate()).summary).toBe(beforeSummary);
  });

  it('🚨 #255 基线日按市场取: us 昨日无行而港股有行时，基线必须退到 us 自己有行的那天', async () => {
    // 现实原型 = 2026-10-01 / 2026-10-19（`trading_day` 实查: us `whole`、hk 无行）的镜像：
    // 一个「一边开市、另一边休市」的日子。不按市场取基线时，`max(session_date)` 会选中只有
    // 对方市场行的那天 ⇒ us 分母整个来自港股 ⇒ 判据对 us **无输出**（假绿）。
    const pep = await seedContracts('PEP', 10);
    await seedSnapshots(pep, shift(today, -3));
    await seedSnapshots(pep, today);

    const tencent = await seedContracts('00700', 10, shift(today, 60), 'hk');
    await seedSnapshots(tencent, shift(today, -1)); // 只有港股有行的那一天

    const report = await check.evaluate('us', today);
    expect(report.baselineDate).toBe(shift(today, -3));
    expect(report.status).toBe('ok');
    expect(await assertBothAgree()).toEqual({ exitCode: 0, degraded: [] });
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

  // ── ⑦b 公众假期闸：三态 non-trading / unknown（#276）───────────────────────────────────
  /**
   * 🚨 本组存在的理由：⑦ 那道 isodow 闸**只挡周末**。美股公众假期是工作日 ⇒ 闸放行 ⇒ 当日零
   * 快照 ⇒ 存在性层判全票缺席 ⇒ **假红**。2026-08-28 对 prod 注入 `2026-09-07`（劳动节）实测
   * `exit 1` + 106 票全 `0/N⚠缺`，约 9–10 次/年。
   *
   * 判据 = `trading-day.rules.ts` 的三态（`trading` / `non-trading` / `unknown`），本组三条各钉一格。
   */

  /** 布景：TODAY 有完整数据（供基线与名册），当日换成一个**没有快照**的工作日。 */
  async function seedHolidayScene(): Promise<string> {
    const pep = await seedContracts('PEP', 2);
    await seedSnapshots(pep, today);
    // TODAY+7 = 2026-06-17（周三），本文件其余用例都不碰它。
    return shift(today, 7);
  }

  it('🚨 公众假期 (工作日但不在 trading_day, 且落在已声明覆盖区间内) → exit 0, 不假红', async () => {
    const holiday = await seedHolidayScene();
    // 把它从交易日历里摘掉 = 制造一个「填过了、确实休市」的工作日。
    await prisma.tradingDay.delete({
      where: { market_date: { market: 'us', date: day(holiday) } },
    });

    const { exitCode, summary } = await runPredicate(holiday);
    expect(exitCode).toBe(0);
    expect(summary).toContain('非交易日不判');
    expect(summary).toContain(`当日 ${holiday}`);
    // 🚨 必须说明是**哪一档**放行的 —— 与周末档的文案不可混（混了就分不出闸走了哪条路）。
    expect(summary).toContain('不在 us 交易日历');
    expect(summary).not.toContain('ET 周末');
    expect(summary).not.toMatch(/[\t\n\r]/);
  });

  /**
   * 🚨 **反例向 ①** —— 同一个日子、同一批数据，只要它**在** `trading_day` 里就必须判红。
   * 没有这条，上面那条等于「把判据整个关掉」也能绿。
   */
  it('🚨 反例: 同一个工作日留在 trading_day 里 → exit 1 (证明假期闸没把判据整个关掉)', async () => {
    const workday = await seedHolidayScene(); // 不删 trading_day 那一行

    const { exitCode, summary } = await runPredicate(workday);
    expect(exitCode).toBe(1);
    expect(degradedFromSummary(summary)).toEqual(['us:PEP']);
  });

  /**
   * 🚨 **反例向 ②（极性）** —— 「无行」有两种：填过了确实没有（`non-trading`，放行）与根本没填到
   * 这儿（`unknown`，判红）。把后者读成前者正是 `check-trading-day-read.ts` 记的那个 closed-world
   * 病。本条钉死极性：覆盖区间**之外**的日子 MUST 判红，MUST NOT 静默 exit 0。
   */
  it('🚨 当日落在覆盖声明之外 → exit 1 fail-closed, 且说清是「判不出」不是「没事」', async () => {
    await seedHolidayScene();
    const beyond = shift(today, 120); // 声明只到 TODAY+60

    const { exitCode, summary } = await runPredicate(beyond);
    expect(exitCode).toBe(1);
    expect(summary).toContain('判不出');
    expect(summary).toContain('覆盖区间之外');
    // 🚫 不得退化成「达标」或「非交易日不判」——那两句都等于把 unknown 说成了确定答案。
    expect(summary).not.toContain('完整性达标');
    expect(summary).not.toContain('非交易日不判');
    expect(summary).not.toMatch(/[\t\n\r]/);
  });

  it('🚨 无覆盖声明 (整行缺失) → 同样 exit 1, 而不是把「没人承诺过」读成休市', async () => {
    const holiday = await seedHolidayScene();
    await prisma.tradingDay.delete({
      where: { market_date: { market: 'us', date: day(holiday) } },
    });
    await prisma.calendarCoverage.deleteMany();

    const { exitCode, summary } = await runPredicate(holiday);
    expect(exitCode).toBe(1);
    expect(summary).toContain('判不出');
    expect(summary).toContain('缺');
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
