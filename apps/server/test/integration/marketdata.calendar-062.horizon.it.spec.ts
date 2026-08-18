import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';
import type { TradingCalendarSource } from '../../src/marketdata/trading-calendar-source.port';
import { MarketRoutedCalendarSource } from '../../src/marketdata/market-routed-calendar-source.adapter';
import { TradingCalendarSyncService } from '../../src/marketdata/trading-calendar-sync.service';

/**
 * 062 T004 —— `populate` 两段填充 + 覆盖声明推进 IT（Testcontainers PG）。
 *
 * **为什么必须真 PG**：本 task 的断言面是「`calendar_coverage` 这一行**有没有动、动到哪一天**」
 * ——「不推进」是本 feature 最关键的一类**否定断言**，而 mock prisma 只能证明「代码调了/没调
 * 某个方法」，证明不了 `@db.Date` 列的落库口径（UTC 零点 / 时区截断）与 upsert 的实际结果。
 * 声明一旦错一天，三态判定就把「还没填到」读成「填过了，确实不是交易日」，全线静默失真。
 *
 * 装配 = 直接 `new TradingCalendarSyncService(历史源, prisma, cfg, 前瞻源)` + 真
 * `PrismaService`（体例同 `optionsdesk-045.anchor.it.spec.ts`：贫血 service、无 lifecycle
 * 语义、验证面是落库口径，不必起 Nest 容器）；两个源均由 stub 供（确定性、零外呼），stub 复刻
 * 真 adapter 的 `from > to` 闸。
 *
 * 覆盖：`state_branches` 10 / 11 / 12 / 13 / 16 · FR-002 · FR-004 · FR-005 · FR-007 · FR-008 ·
 * FR-015 · SC-003 · SC-009。
 */

/** syncRange/populate 不读 cfg（仅 @Cron handleCron 读 tickEnabled）→ IT 传最小占位。 */
const CFG = { tickEnabled: true } as unknown as MarketdataSyncConfig;

interface SourceCall {
  market: string;
  from: string;
  to: string;
}

/**
 * 可编程 stub 源：记录每次调用的 `(market, from, to)`（**窗口口径就是本文件的主要断言面**），
 * 按 handler 返回交易日或抛错。
 *
 * ⚠️ `from > to` 主动抛 —— 复刻 `static-calendar.adapter.ts` / `futu-calendar.adapter.ts` 各自
 * 的区间闸。年末那一天前瞻窗会退化成 `[次年 01-01, 当年 12-31]`（反向），真 adapter 在那里抛，
 * stub 不复刻就会让本文件对年末的断言比生产宽松。
 */
function stubSource(
  handler: (market: string, from: string, to: string) => string[] | Error,
  servedBy = 'stub',
): { source: TradingCalendarSource; calls: SourceCall[] } {
  const calls: SourceCall[] = [];
  const source: TradingCalendarSource = {
    async fetchTradingDates(market, from, to) {
      calls.push({ market, from, to });
      if (from > to) throw new Error(`[stub] 区间非法 (from > to): ${from}..${to}`);
      const result = handler(market, from, to);
      if (result instanceof Error) throw result;
      return { dates: result, servedBy };
    },
  };
  return { source, calls };
}

/** 全市场都健康的 stub（返回区间端点两天即可，本文件不断言 `trading_day` 行数细节）。 */
const healthy = (servedBy: string) => stubSource((_market, from, to) => [from, to], servedBy);

describe('062 T004 交易日历前瞻视野 — populate 两段 + coverage 推进 (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  /** 北京 2026-08-18 12:00 = ET 2026-08-18 00:00 ⇒ cn/hk/us 三市场同为 2026-08-18。 */
  const NOW = new Date('2026-08-18T04:00:00Z');
  /** populate 历史段窗口（`shanghaiToday` 与今天-30，062 一字不改）。 */
  const HIST_FROM = '2026-07-19';
  const HIST_TO = '2026-08-18';
  /** populate 前瞻段窗口（`[明天, 当年 12-31]`）。 */
  const FWD_FROM = '2026-08-19';
  const FWD_TO = '2026-12-31';

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.tradingDay.deleteMany();
    await prisma.calendarSyncHealth.deleteMany();
    await prisma.calendarCoverage.deleteMany();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const coverageOf = async (market: string) => {
    const row = await prisma.calendarCoverage.findUnique({ where: { market } });
    return row
      ? { from: iso(row.coveredFrom), to: iso(row.coveredTo), servedBy: row.servedBy }
      : null;
  };

  const seedCoverage = (market: string, from: string, to: string) =>
    prisma.calendarCoverage.create({
      data: {
        market,
        coveredFrom: new Date(`${from}T00:00:00Z`),
        coveredTo: new Date(`${to}T00:00:00Z`),
        servedBy: 'seed',
      },
    });

  const healthOf = (market: string) => prisma.calendarSyncHealth.findUnique({ where: { market } });

  const serviceWith = (hist: TradingCalendarSource, fwd: TradingCalendarSource) =>
    new TradingCalendarSyncService(hist, prisma, CFG, fwd);

  it('两段整段成功 → 声明从历史段起点一路推到当年末, servedBy 记胜出层 (state_branch 10)', async () => {
    const hist = healthy('tencent');
    const fwd = healthy('static');

    await serviceWith(hist.source, fwd.source).populate(NOW);

    // ① 两段各自按自己的窗口调源 —— 历史段一次三市场, 前瞻段逐市场 (窗口按市场时区算)。
    expect(hist.calls).toEqual([
      { market: 'cn', from: HIST_FROM, to: HIST_TO },
      { market: 'hk', from: HIST_FROM, to: HIST_TO },
      { market: 'us', from: HIST_FROM, to: HIST_TO },
    ]);
    expect(fwd.calls).toEqual([
      { market: 'cn', from: FWD_FROM, to: FWD_TO },
      { market: 'hk', from: FWD_FROM, to: FWD_TO },
      { market: 'us', from: FWD_FROM, to: FWD_TO },
    ]);

    // ② 两段相邻 ⇒ 合并成一条连续声明; servedBy = 最后写入的那段的胜出层 (前瞻段)。
    for (const market of ['cn', 'hk', 'us']) {
      expect(await coverageOf(market)).toEqual({
        from: HIST_FROM,
        to: FWD_TO,
        servedBy: 'static',
      });
    }
  });

  it('🚨 源抛错 → covered_to 一天都不动 (state_branch 11 · Impl Guardrail 2 的机器化)', async () => {
    // 这条是本 feature 唯一的**否定断言**要害: 声明若在填充失败时照样前进, 三态判定全线失真,
    // 而「成功时推进」那条正向断言照样绿 ⇒ 没有任何测试会红。
    await seedCoverage('cn', '2026-01-01', '2026-08-17');

    const boom = () => new Error('vendor down');
    const hist = stubSource(
      (market, from, to) => (market === 'cn' ? boom() : [from, to]),
      'tencent',
    );
    const fwd = stubSource((market, from, to) => (market === 'cn' ? boom() : [from, to]), 'static');

    await serviceWith(hist.source, fwd.source).populate(NOW);

    // cn 两段全失败 → 声明纹丝不动 (连 covered_from 也不动)。
    expect(await coverageOf('cn')).toEqual({
      from: '2026-01-01',
      to: '2026-08-17',
      servedBy: 'seed',
    });
    // 但失败必留痕 (044 心跳), 且逐市场隔离: hk/us 照常推到年末 (FR-008)。
    expect((await healthOf('cn'))?.lastError).toContain('vendor down');
    expect((await coverageOf('hk'))?.to).toBe(FWD_TO);
    expect((await coverageOf('us'))?.to).toBe(FWD_TO);
  });

  it('填充区间与既有声明之间有缺口 → 不推进 + ERROR 留痕 (state_branch 11)', async () => {
    // 「源返回的区间没有把既有声明接上」= 中间那几年从没填过。合并 ⇒ 造出一段假的「已覆盖」,
    // 那几年每一天都会从 unknown 翻成 non-trading —— 本 feature 要消灭的病原样重演在声明层。
    await seedCoverage('cn', '2020-01-01', '2020-12-31');
    const errors = vi.spyOn(Logger.prototype, 'error');

    const hist = healthy('tencent');
    const fwd = healthy('static');
    await serviceWith(hist.source, fwd.source).populate(NOW);

    expect(await coverageOf('cn')).toEqual({
      from: '2020-01-01',
      to: '2020-12-31',
      servedBy: 'seed',
    });
    const messages = errors.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('覆盖声明未推进') && m.includes('cn'))).toBe(true);
    // 无声明的 hk/us 不受连累。
    expect((await coverageOf('hk'))?.to).toBe(FWD_TO);
  });

  it('前瞻源未登记该市场路由 → 显式失败留痕, 其余市场照常推进 (state_branch 12 · FR-008)', async () => {
    const hist = healthy('tencent');
    // 只登记 us 的前瞻路由 → cn/hk 命中 MarketRoutedCalendarSource 的 fail-closed throw。
    const usOnly = healthy('futu');
    const fwd = new MarketRoutedCalendarSource({ us: usOnly.source });

    await serviceWith(hist.source, fwd).populate(NOW);

    // us: 两段都成功 → 视野到年末。
    expect((await coverageOf('us'))?.to).toBe(FWD_TO);
    // cn/hk: 历史段成功 (声明推到今天), 前瞻段显式失败 → 视野停在今天, **不是**被静默落到某条链上。
    expect((await coverageOf('cn'))?.to).toBe(HIST_TO);
    expect((await coverageOf('hk'))?.to).toBe(HIST_TO);
    expect((await healthOf('cn'))?.lastError).toContain('未登记日历源路由');
    expect((await healthOf('hk'))?.lastError).toContain('未登记日历源路由');
  });

  it('历史段失败 / 前瞻段成功 (首次上线) → 声明只认前瞻那截, 今天仍不在覆盖内 (state_branch 16)', async () => {
    // 关键: 前瞻段的成功 MUST NOT 顺带把历史段没填的「今天」也声明为已覆盖 —— 那正是
    // 「声明失真」的形状。今天落在覆盖之外 ⇒ 读侧判 unknown (安全侧), 而不是 non-trading。
    //
    // ⚠️ 心跳是 **per-market 一行**、两段共用, 后跑的前瞻段成功会清掉历史段刚写的 lastError。
    // 故「两段各自留痕」的**耐久**载体是**覆盖声明本身** (下面第一条断言: covered_from 停在
    // 明天 = 今天没被填过, 一眼可查) + 各自带 from/to 的 WARN (下面第二条)。别拿心跳当分段留痕。
    const warns = vi.spyOn(Logger.prototype, 'warn');
    const hist = stubSource(() => new Error('历史段 vendor down'), 'tencent');
    const fwd = healthy('static');

    await serviceWith(hist.source, fwd.source).populate(NOW);

    expect(await coverageOf('cn')).toEqual({ from: FWD_FROM, to: FWD_TO, servedBy: 'static' });
    const histWarn = warns.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('历史段 vendor down') && m.includes(`"from":"${HIST_FROM}"`));
    expect(histWarn).toBeDefined(); // 失败痕带着**自己那段**的窗口 → 分得清是哪段坏了
  });

  it('历史段失败 + 已有声明 (稳态) → 前瞻段与声明之间出现缺口 ⇒ 视野原地不动 (state_branch 16)', async () => {
    // 稳态下声明已到昨天, 历史段一坏「今天」就没人填 ⇒ 前瞻段的 [明天, 年末] 与声明之间正好
    // 空出今天一天 → advanceCoverage 判缺口 → **不推进**。于是「历史段坏了」这件事即使被心跳
    // 的后写覆盖掉, 也必然表现为**视野停止前进**, 由视野探针独立报出来。
    await seedCoverage('cn', '2026-01-01', '2026-08-17'); // 声明到昨天
    const errors = vi.spyOn(Logger.prototype, 'error');
    const hist = stubSource(
      (market, from, to) => (market === 'cn' ? new Error('历史段 down') : [from, to]),
      'tencent',
    );
    const fwd = healthy('static');

    await serviceWith(hist.source, fwd.source).populate(NOW);

    expect(await coverageOf('cn')).toEqual({
      from: '2026-01-01',
      to: '2026-08-17',
      servedBy: 'seed',
    });
    const messages = errors.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('覆盖声明未推进') && m.includes('cn'))).toBe(true);
  });

  it('历史段成功 / 前瞻段失败 → 声明停在今天, 不伪造前瞻那截 (state_branch 16)', async () => {
    const hist = healthy('tencent');
    const fwd = stubSource(() => new Error('年历未发布'), 'static');

    await serviceWith(hist.source, fwd.source).populate(NOW);

    expect(await coverageOf('cn')).toEqual({ from: HIST_FROM, to: HIST_TO, servedBy: 'tencent' });
    expect((await healthOf('cn'))?.lastError).toContain('年历未发布');
  });

  it('跨年: 次年年历未入库 → 前瞻源整段抛错, 视野停在历史段终点而**不伪造次年日期** (state_branch 13)', async () => {
    // 静态年历的 Guardrail 7 (「区间未被覆盖范围完全包含即 throw, 禁返已覆盖的那部分」) 是
    // **设计不是 bug**: 返部分 ⇒ 缺失日被当成非交易日 ⇒ 病在静态层原样重演。年末视野停住由
    // 视野探针的年末豁免接住, 这条链是完整的。
    const NEW_YEAR = new Date('2027-01-05T12:00:00Z'); // 北京 20:00 / ET 07:00, 三市场同为 2027-01-05
    await seedCoverage('cn', '2026-01-01', '2026-12-31');

    const hist = healthy('tencent');
    const fwd = stubSource(
      () => new Error('[static] 请求区间未被静态表覆盖区间完全包含'),
      'static',
    );

    await serviceWith(hist.source, fwd.source).populate(NEW_YEAR);

    expect(fwd.calls).toContainEqual({ market: 'cn', from: '2027-01-06', to: '2027-12-31' });
    const cn = await coverageOf('cn');
    expect(cn?.to).toBe('2027-01-05'); // 只到历史段的今天
    expect(cn?.to).not.toBe('2027-12-31'); // 🚨 绝不伪造次年末
  });

  it('seed CLI 的推进路径 = populate 的同一条 → 宽区间灌完声明即覆盖该区间 (T005 · FR-009)', async () => {
    // `marketdata-trading-day-seed.cli.ts` 唯一的写库动作就是 `syncRange(markets, from, to)`,
    // 而 `syncRange` 委托 `syncRangeWith` —— 与 populate 两段共用同一条声明推进路径。
    // 🚫 **MUST NOT 在 CLI 里另写一份 coverage 写入逻辑** (FR-004: 两处维护必漂移)。上线灌视野
    // 靠它, 所以「跑完之后声明真的覆盖到指定区间」必须有机器化断言。
    const hist = healthy('tencent');
    const fwd = healthy('static');

    await serviceWith(hist.source, fwd.source).syncRange(['cn'], '2015-01-01', '2026-08-18');

    expect(await coverageOf('cn')).toEqual({
      from: '2015-01-01',
      to: '2026-08-18',
      servedBy: 'tencent',
    });
    expect(fwd.calls).toHaveLength(0); // seed 只走历史源
  });

  it('前瞻段写过的日期与历史段活源答案相反 → WARN + 计数留痕, 且**两边数据都不动** (T005 · state_branch 17)', async () => {
    // plan §D8: 前瞻段先写、历史段后到 —— 说的是**同一个日期**被两条路径先后写到 (某日在成为
    // 「今天」之前先由前瞻段落库, 日后再被历史段的活源覆盖到), 与 populate 内两段的执行顺序无关。
    //
    // 🚫 **MUST NOT 自动订正**: 谁对谁错要人判 —— 交易所临时休市 (前瞻年历错) 与年历解析错
    // (活源对) 两者处置**完全相反**。这条留痕的价值是「两条独立路径互为校验」, 单源时代根本
    // 发现不了这类错。
    const CONFLICT_DAY = '2026-08-05'; // 落在历史窗 [2026-07-19, 2026-08-18] 内
    await prisma.tradingDay.create({
      data: { market: 'cn', date: new Date(`${CONFLICT_DAY}T00:00:00Z`) },
    });
    const warns = vi.spyOn(Logger.prototype, 'warn');

    // 活源只给两天, 不含冲突日 ⇒ 「前瞻说是交易日、历史段活源没给」。
    const hist = stubSource(() => ['2026-07-20', '2026-08-06'], 'tencent');
    const fwd = healthy('static');
    await serviceWith(hist.source, fwd.source).populate(NOW);

    const warned = warns.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('交叉校验') && m.includes('cn'));
    expect(warned).toBeDefined();
    expect(warned).toContain(CONFLICT_DAY); // 痕里指得出是哪一天
    expect(warned).toContain('"count":1'); // 计数

    // 🚫 零订正: 冲突日那一行**还在**, 活源给的两天也照常落库 —— 两边数据都没被改动。
    const cn = await prisma.tradingDay.findMany({
      where: { market: 'cn' },
      orderBy: { date: 'asc' },
    });
    expect(cn.map((r) => iso(r.date))).toEqual([
      '2026-07-20',
      CONFLICT_DAY,
      '2026-08-06',
      FWD_FROM,
      FWD_TO,
    ]);
  });

  it('🚨 前瞻窗年份按**市场时区**算, 不是宿主 getFullYear() (Impl Guardrail 3 的机器化)', async () => {
    // 北京 2027-01-01 08:00 = ET 2026-12-31 19:00 —— 此刻 cn 在 2027 年、us 还在 2026 年。
    // 宿主年份 (测试机 = Asia/Shanghai) 会给 us 一个 2027-12-31 的窗: 源对次年多半返空,
    // 于是声明被推到一个**从没填过**的次年末 ⇒ 次年每一天都从 unknown 翻成 non-trading。
    const CROSS_YEAR = new Date('2027-01-01T00:00:00Z');
    const hist = healthy('tencent');
    const fwd = healthy('static');

    await serviceWith(hist.source, fwd.source).populate(CROSS_YEAR);

    const us = fwd.calls.find((c) => c.market === 'us');
    expect(us?.to).toBe('2026-12-31'); // ET 当年
    expect(us?.from).toBe('2027-01-01'); // ET 的「明天」
    const cn = fwd.calls.find((c) => c.market === 'cn');
    expect(cn?.to).toBe('2027-12-31'); // cn 当年 —— 与 us 不同年, 证明年份确实逐市场算

    // us 的前瞻窗在这一天退化成反向区间 → 真 adapter 的区间闸抛 → 声明不被推到 2026-12-31 之外。
    expect((await coverageOf('us'))?.to).not.toBe('2027-12-31');
  });
});
