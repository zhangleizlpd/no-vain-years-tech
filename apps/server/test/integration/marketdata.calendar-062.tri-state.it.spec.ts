import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';
import { DbTradingCalendarAdapter } from '../../src/marketdata/db-trading-calendar.adapter';
import { OptionSnapshotCoverageCheck } from '../../src/marketdata/option-snapshot-coverage.check';
import { OptionSnapshotRemediation } from '../../src/marketdata/option-snapshot-remediation';
import { AnchorColdStartUseCase } from '../../src/marketdata/anchor-cold-start.usecase';
import { COLD_START_OUTCOME } from '../../src/marketdata/anchor-cold-start.rules';
import type { AnchorDrivenSyncGate } from '../../src/marketdata/anchor-driven-sync-gate';
import { FreshnessSlaCheck } from '../../src/marketdata/freshness-sla.check';
import type { SyncOptionContractUseCase } from '../../src/marketdata/sync-option-contract.usecase';
import type {
  OptionSnapshotBatch,
  OptionSnapshotPort,
  OptionSnapshotQuery,
  OptionSnapshotRow,
} from '../../src/marketdata/option-snapshot.port';
import {
  SNAPSHOT_SOURCE_EOD,
  SNAPSHOT_SOURCE_PREMARKET_BACKFILL,
  SyncOptionSnapshotUseCase,
} from '../../src/marketdata/sync-option-snapshot.usecase';
import { isTradingDayGateOpen } from '../../src/marketdata/trading-day-gate';
import { stubTradingCalendar } from '../_support/trading-calendar-stub';

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
      expect(await remediation.backfillPremarket('us', NOW)).toEqual({
        market: 'us',
        level: 'premarket_backfill',
        // 062 T009 起结局带上判据来源: 这一格正是「不知道所以照跑」。
        calendar: 'unknown',
        sessionDate: null,
        status: 'blocked',
        attempted: [],
        stillMissing: [],
      });

      // ② 对照组: 声明覆盖今天且今天无行 → non-trading → 日历那一格短路 (not_needed)。
      await seedCoverage('us', '2026-08-01', '2026-08-31');
      expect(await remediation.backfillPremarket('us', NOW)).toEqual({
        market: 'us',
        level: 'premarket_backfill',
        calendar: 'non-trading',
        sessionDate: null,
        status: 'not_needed',
        attempted: [],
        stillMissing: [],
      });
      expect(collect).not.toHaveBeenCalled();
    });
  });

  // ── T009：三处 marketdata 消费方对 `unknown` 的**语义分派** ──────────────────

  /**
   * 062 T009 —— T006 只把三处调用点机械映射成 `!== 'non-trading'`（零行为变更），本组验的是
   * 它们各自**按失败代价**分派 `unknown` 之后的行为（`state_branches` 6 / 7 / 8 · FR-012 ·
   * FR-013 · SC-004 · SC-005）。
   *
   * 🚨 **回归的埋法**（Impl Guardrail 14）：凡要踩「视野没填到今天」这个真 bug 的用例，日历
   * 一律埋成 **`trading_day` 只到昨天 + `calendar_coverage` 只覆盖到昨天**；埋成「含今天」的话
   * 测试会绿但什么都没验到。
   */
  describe('T009 消费方分派 (state_branches 6–8)', () => {
    /** 2026-08-19 周三 ET 03:00（= 14:00Z-7h… 实为 07:00Z，EDT=UTC-4）—— US3 的「美东凌晨」。 */
    const ET_0300 = new Date('2026-08-19T07:00:00Z');
    /** 同日 ET 16:30 —— 常规收盘之后。 */
    const ET_1630 = new Date('2026-08-19T20:30:00Z');
    const TODAY = '2026-08-19';
    /** `TODAY` 的上一交易日 = ② 级要补的那一场。 */
    const PREV = '2026-08-18';
    /** 覆盖率判定的分母来源日。 */
    const BASELINE = '2026-08-17';
    const CONTRACT = 'US.PEP260918P130000';
    const UNDERLYING_CODE = 'US.PEP';
    const EXPIRY = '2026-09-18';

    const day = (s: string): Date => new Date(`${s}T00:00:00Z`);

    /** 一行过得了四条落库前硬门的期权快照（数值照抄 `option-snapshot-remediation.it.spec.ts`）。 */
    const optionRow = (code: string): OptionSnapshotRow => ({
      code,
      isOption: true,
      underlyingCode: UNDERLYING_CODE,
      bid: '2.00',
      ask: '2.10',
      bidSize: '10',
      askSize: '12',
      last: '2.05',
      prevClose: '2.01',
      iv: '0.25000000',
      delta: '-0.45000000',
      gamma: '0.01000000',
      vega: '0.12000000',
      theta: '-0.03000000',
      rho: '-0.02000000',
      openInterest: '1234',
      netOpenInterest: '56',
      volume: '789',
      turnover: '161000.00',
      vendorUpdateTime: new Date('2026-08-18T20:00:00Z'),
      greeksComplete: true,
    });

    /** 测试内 stub 采集口（扮演 live vendor）；`calls` 供「零外呼」断言。 */
    class StubOptionSnapshotPort implements OptionSnapshotPort {
      readonly calls: OptionSnapshotQuery[] = [];
      async getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch> {
        this.calls.push(query);
        return {
          asOf: new Date('2026-08-18T20:00:00Z'),
          rows: [
            {
              ...optionRow(UNDERLYING_CODE),
              isOption: false,
              underlyingCode: null,
              last: '135.00',
              greeksComplete: null,
            },
            ...query.contractCodes.map((code) => optionRow(code)),
          ],
        };
      }
    }

    let port: StubOptionSnapshotPort;
    let snapshot: SyncOptionSnapshotUseCase;

    beforeEach(async () => {
      await prisma.optionDailySnapshot.deleteMany();
      await prisma.optionContract.deleteMany();
      await prisma.dailyBar.deleteMany();
      await prisma.instrument.deleteMany();
      await prisma.anchorColdStartRun.deleteMany();
      await prisma.syncRun.deleteMany();
      await prisma.syncDimension.deleteMany();
      port = new StubOptionSnapshotPort();
      snapshot = new SyncOptionSnapshotUseCase(port, prisma, stubTradingCalendar());
    });

    /** 一票 + 一张远月合约 + 只有 `BASELINE` 那天的快照行 ⇒ `PREV` / `TODAY` 均判 degraded。 */
    async function seedGap(): Promise<void> {
      const instrument = await prisma.instrument.create({
        data: {
          market: 'us',
          code: 'PEP',
          name: 'PepsiCo',
          type: 'stock',
          currency: 'USD',
          status: 'active',
          needSync: true,
        },
      });
      const contract = await prisma.optionContract.create({
        data: {
          market: 'us',
          code: CONTRACT,
          root: 'PEP',
          underlyingInstrumentId: instrument.id,
          expiryDate: day(EXPIRY),
          strikePrice: 130,
          optionType: 'PUT',
          isStandard: true,
        },
      });
      await prisma.optionDailySnapshot.create({
        data: {
          contractId: contract.id,
          sessionDate: day(BASELINE),
          source: SNAPSHOT_SOURCE_EOD,
          quoteAsOf: day(BASELINE),
          oiAsOf: day(BASELINE),
          greeksComplete: true,
        },
      });
    }

    const buildRemediation = () =>
      new OptionSnapshotRemediation(
        new OptionSnapshotCoverageCheck(prisma, CFG),
        snapshot,
        prisma,
        adapter,
      );

    const buildColdStart = () =>
      new AnchorColdStartUseCase(
        prisma,
        { recalcSafely: async () => null } as unknown as AnchorDrivenSyncGate,
        // issue #159: 冷启动改直调链本体, 不再入队 ⇒ 原先桩的是 MarketdataSyncQueue。
        // 本文件验的是日历三态判据, 链有没有真跑与判据无关 ⇒ no-op 桩 (返 false = 配额未耗尽)。
        { collect: async () => false } as unknown as SyncOptionContractUseCase,
        snapshot,
        adapter,
      );

    /** 跑一条路径 → 读回它在 `session` 落的行 → 清掉，好让下一条路径从同样的起点跑。 */
    async function collectAndDrain(run: () => Promise<unknown>, session: string) {
      await run();
      const rows = await prisma.optionDailySnapshot.findMany({
        where: { sessionDate: day(session) },
        select: { source: true, oiAsOf: true },
      });
      await prisma.optionDailySnapshot.deleteMany({ where: { sessionDate: day(session) } });
      return rows.map((r) => ({ source: r.source, oiAsOf: r.oiAsOf.toISOString().slice(0, 10) }));
    }

    // ── ① 二级盘前兜底：unknown 继续执行 + 可分辨的痕（state_branch 6 · SC-004） ──

    it('① 视野未覆盖今天 (unknown) → 二级兜底**仍执行复判并补采**, 且痕标 unknown (state_branch 6 · SC-004 · FR-013)', async () => {
      await seedGap();
      await seedDay('us', BASELINE);
      await seedDay('us', PREV);
      // 🚨 Guardrail 14 的埋法：日历与声明都只到昨天 —— 这正是生产上那条「二级兜底恒 not_needed」。
      await seedCoverage('us', '2026-08-01', PREV);
      expect(await adapter.classify('us', TODAY)).toBe('unknown');

      const outcome = await buildRemediation().backfillPremarket('us', ET_0300);

      expect(outcome.sessionDate).toBe(PREV);
      expect(outcome.status).toBe('recovered');
      // 🚨 FR-013：「补是因为确认了是交易日」与「补是因为还不知道」事后必须分得出。
      expect(outcome.calendar).toBe('unknown');
      expect(port.calls).toEqual([{ underlyingSymbol: 'us:PEP', contractCodes: [CONTRACT] }]);
    });

    it('① 视野充足 + 今天是交易日 → 同样补采, 但痕标 confirmed (与上一条**可分辨**)', async () => {
      await seedGap();
      await seedDay('us', BASELINE);
      await seedDay('us', PREV);
      await seedDay('us', TODAY);
      await seedCoverage('us', '2026-08-01', '2026-12-31');

      const outcome = await buildRemediation().backfillPremarket('us', ET_0300);

      expect(outcome).toMatchObject({
        sessionDate: PREV,
        status: 'recovered',
        calendar: 'confirmed',
      });
    });

    it('① `not_needed` 不再静默返回 —— 每条早退都留可诊断的痕 (二级兜底死了几个月没人发现的直接成因)', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      await seedDay('us', PREV);
      await seedCoverage('us', '2026-08-01', '2026-12-31'); // TODAY 无行且在覆盖内 ⇒ 确认非交易日

      const outcome = await buildRemediation().backfillPremarket('us', ET_0300);

      expect(outcome).toMatchObject({ status: 'not_needed', calendar: 'non-trading' });
      expect(port.calls).toEqual([]);
      const logged = log.mock.calls.flat().join(' ');
      expect(logged).toContain('premarket_backfill');
      expect(logged).toContain('non-trading');
    });

    // ── ②③ SC-005：两个时刻的来源标记与 OI 归属日与常规轮/盘前兜底逐一一致 ──────

    it('② ET 03:00（盘前）: 建锚补数与 ② 级盘前兜底落库的 source / oi_as_of **逐字相同** (SC-005 · US3 AS1)', async () => {
      await seedGap();
      await seedDay('us', BASELINE);
      await seedDay('us', PREV);
      await seedDay('us', TODAY);
      await seedCoverage('us', '2026-08-01', '2026-12-31');

      const viaColdStart = await collectAndDrain(
        () => buildColdStart().run({ anchorId: 7n, ticker: 'us:PEP', now: ET_0300 }),
        PREV,
      );
      const viaRemediation = await collectAndDrain(
        () => buildRemediation().backfillPremarket('us', ET_0300),
        PREV,
      );

      // 字面值：盘前 OI 已翻新 ⇒ 来源是兜底补采、OI 归属日 = **被补的那一场**。
      expect(viaColdStart).toEqual([{ source: SNAPSHOT_SOURCE_PREMARKET_BACKFILL, oiAsOf: PREV }]);
      // 🚨 SC-005 的真判据不是某个字面值, 是「同一时刻两条路径口径一致」。
      expect(viaRemediation).toEqual(viaColdStart);
    });

    it('③ ET 16:30（收盘后）: 建锚补数与 ① 级当日重试落库的 source / oi_as_of **逐字相同** (SC-005 · US3 AS2)', async () => {
      await seedGap();
      await seedDay('us', BASELINE);
      await seedDay('us', PREV);
      await seedDay('us', TODAY);
      await seedCoverage('us', '2026-08-01', '2026-12-31');

      const viaColdStart = await collectAndDrain(
        () => buildColdStart().run({ anchorId: 8n, ticker: 'us:PEP', now: ET_1630 }),
        TODAY,
      );
      const viaRemediation = await collectAndDrain(
        () => buildRemediation().retrySameDay('us', ET_1630),
        TODAY,
      );

      // 收盘当日盘后 ⇒ 常规收盘口径、OI 归属日退到**目标场的上一交易日**。
      expect(viaColdStart).toEqual([{ source: SNAPSHOT_SOURCE_EOD, oiAsOf: PREV }]);
      expect(viaRemediation).toEqual(viaColdStart);
    });

    // ── ④ 建锚补数遇 unknown → abandon（state_branch 7） ─────────────────────────

    it('④ 视野未覆盖今天 (unknown) → 建锚补数 abandon 落 calendar_missing, 且**零外呼零写库** (state_branch 7 · US3 AS4)', async () => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await seedGap();
      await seedDay('us', BASELINE);
      await seedDay('us', PREV);
      await seedCoverage('us', '2026-08-01', PREV);
      expect(await adapter.classify('us', TODAY)).toBe('unknown');

      const result = await buildColdStart().run({
        anchorId: 9n,
        ticker: 'us:PEP',
        now: ET_0300,
      });

      // 写敏感档 MUST NOT 猜口径：`premarket_backfill` 与 `eod` 差的是一整天的 OI 归属。
      expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.CALENDAR_MISSING });
      expect(port.calls).toEqual([]);
      expect(await prisma.optionDailySnapshot.count({ where: { sessionDate: day(PREV) } })).toBe(0);
      const run = await prisma.anchorColdStartRun.findUnique({ where: { anchorId: 9n } });
      expect(run?.outcome).toBe(COLD_START_OUTCOME.CALENDAR_MISSING);
    });

    // ── ⑤ 折龄遇 unknown → 按开市（state_branch 8） ──────────────────────────────

    describe('⑤ 陈旧度折龄 (`FreshnessSlaCheck`)', () => {
      const NOW = new Date('2026-08-19T02:00:00Z'); // 北京 10:00
      const LAST_OK = new Date('2026-08-17T02:00:00Z'); // 两个自然日之前

      beforeEach(async () => {
        await prisma.syncDimension.create({
          data: {
            dimensionKey: 'it_calendar_probe',
            cronExpr: '0 0 * * *',
            vendor: 'stub',
            marketScope: ['cn'],
            slaHours: 12,
          },
        });
        await prisma.syncRun.create({
          data: { syncType: 'sync:it_calendar_probe', status: 'success', finishedAt: LAST_OK },
        });
      });

      it('unknown → **按开市**折算 ⇒ 龄照算、超 SLA 照报, 且留痕 (state_branch 8)', async () => {
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        // 无覆盖声明 ⇒ 期间每一天都是 unknown。

        expect(await new FreshnessSlaCheck(prisma, adapter).check(NOW)).toEqual([
          'it_calendar_probe',
        ]);
        // FR-013：按未知继续时必须留痕, 否则「按开市算的」与「确认开市」事后一样分不出。
        expect(warn.mock.calls.flat().join(' ')).toContain('unknown');
      });

      it('对照组: 确认非交易日 → 不计龄 ⇒ 不报 (unknown 那一侧没有被抹平成本条)', async () => {
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        await seedCoverage('cn', '2026-08-01', '2026-08-31'); // 覆盖内且无 trading_day 行 ⇒ non-trading

        expect(await new FreshnessSlaCheck(prisma, adapter).check(NOW)).toEqual([]);
      });
    });
  });
});
