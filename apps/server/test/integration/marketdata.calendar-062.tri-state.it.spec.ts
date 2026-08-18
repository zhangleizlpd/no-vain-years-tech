import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';
import { DbTradingCalendarAdapter } from '../../src/marketdata/db-trading-calendar.adapter';
import { OptionSnapshotCoverageCheck } from '../../src/marketdata/option-snapshot-coverage.check';
import { OptionSnapshotRemediation } from '../../src/marketdata/option-snapshot-remediation';
import type { SyncOptionSnapshotUseCase } from '../../src/marketdata/sync-option-snapshot.usecase';
import { isTradingDayGateOpen } from '../../src/marketdata/trading-day-gate';

/**
 * 062 T006 —— 读端口三态 IT（Testcontainers PG，真 `DbTradingCalendarAdapter`）。
 *
 * **为什么必须真 PG**：被测面是「两张表的实际内容 → 三态」这条合成判据，而两张表都是 `@db.Date`
 * 列（`trading_day.date` / `calendar_coverage.covered_from|to`）。判据靠**日期边界**分档，落库
 * 口径若差一天（时区截断 / UTC 零点），`non-trading` 与 `unknown` 就会在边界日互换 —— 而这
 * 恰恰是本 feature 要消灭的那类静默失真。mock prisma 只能证明「代码调了某个方法」，证不了这个。
 *
 * 装配 = 直接 `new DbTradingCalendarAdapter(真 PrismaService)`（体例同
 * `optionsdesk-045.anchor.it.spec.ts`：贫血 adapter、无 lifecycle 语义、验证面是落库口径，
 * 不必起 Nest 容器）。
 *
 * 覆盖：`state_branches` 1 / 2 / 3 / 4 · FR-010 · FR-019 · SC-002。
 *
 * ## 🚨🚨 本文件第二个、也是更要紧的职责：把 Impl Guardrail 1 钉死
 *
 * T006 是**零行为变更**的机械改签名。旧 `DbTradingCalendarAdapter` 在「近 30 日整窗零行」时
 * **fail-open 返 `true`**；换三态后那条路径给的是 `unknown`。全部既有调用点因此必须机械映射为
 * `!== 'non-trading'` —— 写成 `=== 'trading'` 会把它翻成 `false`，于是**上线首刻**
 * （`calendar_coverage` 刚建、尚未灌值 ⇒ 全部判定都是 `unknown`）全体消费方判「今天不是交易
 * 日」，正好在最不能停摆的时刻整体停摆。而生产里「近窗零行」从不发生 ⇒ **没有任何测试会红**。
 *
 * 故下面那组用例的形状是：**`calendar_coverage` 空表 → 全 `unknown` → 各调用点的行为与改动前
 * 逐一相同**（gate 仍开 / 二级兜底仍往下走），并各配一条 `non-trading` 对照组证明「真非交易日」
 * 那一侧也没被削弱。
 */

/** `OptionSnapshotCoverageCheck` 只用到阈值一项 → IT 传最小占位。 */
const CFG = { optionCoverageThreshold: 1 } as unknown as MarketdataSyncConfig;

describe('062 T006 交易日历读端口三态 (Testcontainers PG, 真 DbTradingCalendarAdapter)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let adapter: DbTradingCalendarAdapter;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
    adapter = new DbTradingCalendarAdapter(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.tradingDay.deleteMany();
    await prisma.calendarCoverage.deleteMany();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const seedDay = (market: string, date: string) =>
    prisma.tradingDay.create({ data: { market, date: new Date(`${date}T00:00:00Z`) } });

  const seedCoverage = (market: string, from: string, to: string) =>
    prisma.calendarCoverage.create({
      data: {
        market,
        coveredFrom: new Date(`${from}T00:00:00Z`),
        coveredTo: new Date(`${to}T00:00:00Z`),
        servedBy: 'seed',
      },
    });

  // ── state_branches 1–4：三态判定本体 ─────────────────────────────────────────

  it('态①: 该 (market,date) 有行 → trading (state_branch 1)', async () => {
    await seedDay('cn', '2026-07-13'); // 周一
    await seedCoverage('cn', '2026-07-01', '2026-07-31');

    expect(await adapter.classify('cn', '2026-07-13')).toBe('trading');
  });

  it('态①: 有行时**不看**覆盖声明 —— 声明够不到该日照样 trading (判据优先级)', async () => {
    // 行是**实证**, 声明只是「填到哪儿」的承诺; 实证在, 承诺再窄也翻不了案。
    await seedDay('cn', '2026-07-13');
    await seedCoverage('cn', '2026-01-01', '2026-01-31');

    expect(await adapter.classify('cn', '2026-07-13')).toBe('trading');
  });

  it('态②: 无行 + 落在覆盖区间内 → non-trading (state_branch 2)', async () => {
    await seedDay('cn', '2026-07-10'); // 周五
    await seedDay('cn', '2026-07-13'); // 周一
    await seedCoverage('cn', '2026-07-01', '2026-07-31');

    expect(await adapter.classify('cn', '2026-07-11')).toBe('non-trading'); // 周六
  });

  it('态②: 覆盖区间**闭区间**两端点各自算「在内」(边界差一天即 unknown/non-trading 互换)', async () => {
    await seedCoverage('cn', '2026-07-01', '2026-07-31');

    expect(await adapter.classify('cn', '2026-07-01')).toBe('non-trading'); // 恰等于 from
    expect(await adapter.classify('cn', '2026-07-31')).toBe('non-trading'); // 恰等于 to
    expect(await adapter.classify('cn', '2026-06-30')).toBe('unknown'); // from 前一天
    expect(await adapter.classify('cn', '2026-08-01')).toBe('unknown'); // to 后一天
  });

  it('态③: 无行 + 落在覆盖区间外 → unknown (state_branch 3)', async () => {
    await seedDay('cn', '2026-07-13');
    await seedCoverage('cn', '2026-07-01', '2026-07-31');

    // 声明只到 7 月末 ⇒ 8 月那天「根本没填到」, 不是「填过了确实没有」。
    expect(await adapter.classify('cn', '2026-08-19')).toBe('unknown');
  });

  it('态④: 该市场无覆盖声明 → unknown, 且 per-market 隔离 (state_branch 4)', async () => {
    // cn 已声明、hk 没有 —— hk 绝不能被 cn 的声明「传染」成 non-trading。
    await seedCoverage('cn', '2026-07-01', '2026-07-31');

    expect(await adapter.classify('hk', '2026-07-11')).toBe('unknown');
    expect(await adapter.classify('cn', '2026-07-11')).toBe('non-trading');
  });

  it('🚨 态④ 反例: `calendar_coverage` **空表** → 任何日期都是 unknown, 一个 non-trading 都不许有', async () => {
    // 上线首刻的真实形态 (表刚建、尚未灌值)。这里若有任何一天被判成 non-trading, 说明
    // 「库里没有的即为假」这个病只是换了个地方原样犯 —— 而它下一步就是全体停摆。
    await seedDay('cn', '2026-07-13');

    for (const date of ['2026-07-11', '2026-07-12', '2026-12-31', '2026-01-01']) {
      expect(await adapter.classify('cn', date)).toBe('unknown');
    }
    // 有行的那天仍是 trading (空声明不影响实证)。
    expect(await adapter.classify('cn', '2026-07-13')).toBe('trading');
  });

  // ⚠️ 「非法日期格式 → throw」不在本文件: 那是判据本体的语义, 由 `trading-day.rules.spec.ts`
  //    (T001) 覆盖。本 adapter 先把 `date` 转成 `Date` 再点查, 脏串在 Prisma 那一层就抛 ——
  //    与 062 之前逐点相同, 断言它等于把 Prisma 的错误文案钉进本文件。

  // ── Impl Guardrail 1：各调用点经映射后与改动前逐一相同 ───────────────────────

  describe('🚨🚨 Guardrail 1: unknown 必须走 `!== non-trading` 的放行侧 (改动前是 fail-open true)', () => {
    it('交易日 gate (`isTradingDayGateOpen`, 016 夜间管线 / sync-tick-driver 的调用点)', async () => {
      // ① 空 coverage → unknown → gate **仍开** (与改动前「近窗零行 fail-open true」逐点相同)。
      expect(await adapter.classify('cn', '2026-06-20')).toBe('unknown');
      expect(await isTradingDayGateOpen(adapter, 'cn', '2026-06-20')).toBe(true);

      // ② 对照组: 真非交易日那一侧没被削弱 —— 仍然关。
      await seedCoverage('cn', '2026-06-01', '2026-06-30');
      expect(await adapter.classify('cn', '2026-06-20')).toBe('non-trading'); // 周六
      expect(await isTradingDayGateOpen(adapter, 'cn', '2026-06-20')).toBe(false);

      // ③ 交易日 → 开。
      await seedDay('cn', '2026-06-19');
      expect(await isTradingDayGateOpen(adapter, 'cn', '2026-06-19')).toBe(true);
    });

    it('快照补救 ② 级 (`backfillPremarket`) —— unknown 不短路, non-trading 才短路', async () => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const collect = vi.fn();
      const remediation = new OptionSnapshotRemediation(
        new OptionSnapshotCoverageCheck(prisma, CFG),
        { collect } as unknown as SyncOptionSnapshotUseCase,
        prisma,
        adapter,
      );
      // ET 2026-08-18 10:00 (= 14:00Z) ⇒ us 业务日 = 2026-08-18。
      const NOW = new Date('2026-08-18T14:00:00Z');

      // ① 空 coverage → unknown → **不**在日历那一格短路, 一路走到「定位待补交易日」并因
      //    `trading_day` 无历史行而落 blocked。改动前 fail-open true 走的是同一条路。
      expect(await remediation.backfillPremarket(NOW)).toEqual({
        level: 'premarket_backfill',
        sessionDate: null,
        status: 'blocked',
        attempted: [],
        stillMissing: [],
      });

      // ② 对照组: 声明覆盖今天且今天无行 → non-trading → 日历那一格短路 (not_needed)。
      await seedCoverage('us', '2026-08-01', '2026-08-31');
      expect(await remediation.backfillPremarket(NOW)).toEqual({
        level: 'premarket_backfill',
        sessionDate: null,
        status: 'not_needed',
        attempted: [],
        stillMissing: [],
      });
      expect(collect).not.toHaveBeenCalled();
    });
  });
});
