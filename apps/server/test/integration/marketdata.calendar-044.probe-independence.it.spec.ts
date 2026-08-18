import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { spawnSync } from 'node:child_process';
import { runMigrateDeploy } from '../_support/run-migrate';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../../src/security/prisma.service';

const SERVER_DIR = process.cwd();

/**
 * 044 T016 — **探针独立性**: `app 进程不可用 → 独立探针仍能告警` (FR-010 / spec state_branch)。
 *
 * 🚨 为什么这条不能只靠 T013 的谓词 IT: T013 用 prisma `$queryRawUnsafe` 跑谓词, 证的是
 * **「谓词判得对」**; 本文件跑**真的 `marketdata-calendar-health.sh`**(bash → docker exec psql), 证的是
 * **「谓词之外的那层胶水也通, 且这条通路上没有 app」**。两者是不同的命题, 后者塌了前者也白搭
 * (谓词判得再对, 探针连不上 / 退出码传不出去 = 照样静默)。
 *
 * ⇒ 顺带把 plan §Testing Invariants 里那条**自认残余**(「bash 的接线是否正确仍靠人工验证」)
 *   从 runbook 手册步骤收成了自动断言。**未测的三行胶水** → 已测。
 *
 * **结构性证明** (本文件 = 该论证的可核验载体, 非散文):
 *   ① 全程**零 app 进程** —— 本文件不 new 任何 Nest module / 不起 HTTP server / 不 import 任何
 *      marketdata service。整个 describe 里存在的进程只有: PG 容器 + bash + psql。
 *      ⇒ marketdata-calendar-health.sh 在此绿 = 它在 app 整个挂掉时同样绿。这就是 `app 不可用 → 仍能告警` 的证明。
 *      (PrismaService 仅用于**埋种子数据**, 是测试自己的 DB 客户端, 不是被测通路的一环 ——
 *       被测通路 = `bash marketdata-calendar-health.sh` → `docker exec psql` → PG, 全程不经 node。)
 *   ② ③ 的源码断言把「无 app 耦合」钉死, 防后人往 marketdata-calendar-health.sh 里加一行 `curl app/health` 就
 *      把独立性偷偷弄丢 (那会让探针与被监控对象同生共死 = 事故时一起哑)。
 */

const CHECK_SH = resolve(SERVER_DIR, '../../ops/jobs/marketdata-calendar-health.sh');

const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;

describe('044 T016 探针独立性 (真跑 marketdata-calendar-health.sh, 全程零 app 进程)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('test_mbw')
      .withUsername('test')
      .withPassword('test')
      .start();
    const url = container.getConnectionUri();
    runMigrateDeploy(url);
    prisma = new PrismaService(url);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  /**
   * 📌 **062 T011 增补**: 同一条谓词自 062 起在心跳档之外多了**视野档** (三档, 见 .sql 头部)。
   * 本文件测的是**探针接线**(bash → docker exec psql → PG 这条无 app 通路), 故在每个用例开跑前
   * 把视野埋成恒健康 —— 让这里每一个退出码都只反映心跳判据与胶水本身, 不被视野档串味。
   * 手法与 `marketdata.calendar-044.health.it.spec.ts` 的 `seedHealthyHorizon` 完全一致 (同一份
   * 基线两处用, 别在此另发明第二套)。
   *
   * ⚠️ 相对 `current_date` 埋 (不写死年份): 视野判据全部是「相对今天」的, 写死日期明年必假红。
   * ⚠️ 余量 10 个交易日 (> 阈值 5) ⇒ **不靠年末豁免**兜底 —— 靠豁免的话, 同一条断言在 12 月与
   *   1 月会给出不同结果, 且哪天有人动豁免表达式, 本文件会跟着一起红而它根本不测那件事。
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

  /**
   * 真跑探针: `bash marketdata-calendar-health.sh`, 只喂 T014 约定的三个接线 env → 指向本测试的 PG 容器。
   * 🚨 不传任何阈值 / 市场 / 主源名 —— 传得进去就说明判断还在 bash 里 (T014 的铁律)。
   */
  function runCheckSh(): { exitCode: number; stdout: string } {
    const r = spawnSync('bash', [CHECK_SH], {
      env: {
        ...process.env,
        SYNC_REPORT_PG_CONTAINER: container.getId(),
        SYNC_REPORT_PG_USER: 'test',
        SYNC_REPORT_PG_DB: 'test_mbw',
      },
      encoding: 'utf8',
    });
    return { exitCode: r.status ?? -1, stdout: (r.stdout ?? '').trim() };
  }

  async function seedHealth(market: string, ageHours: number, servedBy: string): Promise<void> {
    await prisma.calendarSyncHealth.upsert({
      where: { market },
      create: {
        market,
        lastSuccessAt: new Date(Date.now() - ageHours * HOUR_MS),
        lastAttemptAt: new Date(),
        servedBy,
      },
      update: { lastSuccessAt: new Date(Date.now() - ageHours * HOUR_MS), servedBy },
    });
  }

  /**
   * 三市场各由**自己的**主源服务的基线。🚨 主源 per-market: cn/hk = tencent、us = futu
   * (sellput-viz Phase 1 #5 换源后, us 已纳入探针监控面)。
   */
  async function seedAllHealthy(): Promise<void> {
    await seedHealth('cn', 1, 'tencent');
    await seedHealth('hk', 1, 'tencent');
    await seedHealth('us', 1, 'futu');
  }

  // ── ① 健康路径: 退出码 0 真的传得出来 ──────────────────────────────────────────────────────
  it('心跳新鲜 + 主源 → marketdata-calendar-health.sh exit 0 (无 app 进程参与)', async () => {
    await seedAllHealthy();

    const { exitCode, stdout } = runCheckSh();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('✅ 交易日历健康');
  });

  // ── ② 告警路径: 这条绿 = `app 不可用 → 探针仍能告警` 成立 ─────────────────────────────────
  it('🚨 心跳陈旧 (27h) → marketdata-calendar-health.sh exit 1 + 打印人读摘要 (app 全程不存在, 探针照样告警)', async () => {
    await seedAllHealthy();
    await seedHealth('cn', 27, 'tencent');

    const { exitCode, stdout } = runCheckSh();

    expect(exitCode).toBe(1); // → nvy-run-reported 据此推飞书。
    expect(stdout).toContain('🔴 交易日历不健康');
    expect(stdout).toContain('cn=27h前⚠陈旧');
  });

  it('🚨 降级运行 (servedBy=static) → marketdata-calendar-health.sh exit 1 (心跳新鲜也告警: 降级 ≠ 健康, FR-014)', async () => {
    await seedAllHealthy();
    await seedHealth('hk', 1, 'static');

    const { exitCode, stdout } = runCheckSh();

    expect(exitCode).toBe(1);
    expect(stdout).toContain('⚠降级');
  });

  it('🚨 us 由腾讯 (L2) 服务 → marketdata-calendar-health.sh exit 1 (换源后 us 在监控面内, 主源是 futu)', async () => {
    await seedAllHealthy();
    await seedHealth('us', 1, 'tencent');

    const { exitCode, stdout } = runCheckSh();

    expect(exitCode).toBe(1);
    expect(stdout).toContain('us=1h前/tencent⚠降级');
  });

  it('🚨 心跳表空 (app 从未跑成功过 / 刚被清库) → marketdata-calendar-health.sh exit 1 (空集不得被读成健康)', () => {
    const { exitCode, stdout } = runCheckSh();

    expect(exitCode).toBe(1);
    expect(stdout).toContain('从未成功');
  });

  // ── ③ 源码断言: 把「探针不依赖 app」钉死, 防后人无声加回耦合 ───────────────────────────────
  it('🚨 探针源码零 app 耦合: 唯一数据通路 = docker exec psql + 共享谓词文件', () => {
    // 只看可执行体 (剥掉注释行): 注释里出现 "app" 是在**论证**不依赖 app, 不是耦合。
    const body = readFileSync(CHECK_SH, 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');

    // 任何一条命中 = 探针被接回 app / 网络 → 事故时与被监控对象同生共死。
    for (const coupling of [/curl/, /wget/, /https?:\/\//, /\bnode\b/, /\bnpx\b/, /\bpnpm\b/]) {
      expect(body).not.toMatch(coupling);
    }

    // 正向: 通路就是 marketdata-sync-report.sh 那套只读取证 + 读**共享**谓词文件 (不内联 SQL)。
    // 🚨 谓词文件名与探针同名 (`<unit>.sh` ↔ `<unit>.sql`, 同目录兄弟) —— 这条断言同时钉住
    //    「读的是那个共享文件」和「命名对应关系没被破坏」, 别改成宽松的 /\.sql/。
    expect(body).toMatch(/docker exec -i "\$PG_CONTAINER" psql/);
    expect(body).toMatch(/marketdata-calendar-health\.sql/);
    expect(body).not.toMatch(/SELECT/i); // 内联复制谓词 = drift = §II 论证作废。
  });
});
