import { describe, expect, it } from 'vitest';
import { Project, type SourceFile } from 'ts-morph';
import { scanTradingDayReads } from './check-trading-day-read';

/**
 * 🚨 **两条 Check 各自双向反例**（062 Impl Guardrail 12）。
 *
 * 只测「违规被拒」的门禁，在正则/AST 判据写错时会**静默放行一切且 CI 全绿** —— 门禁看起来
 * 还在岗，实际上已经死了，而它死掉的那天恰好没人会知道。故每条 Check 都必须同时有：
 * ① 违规样例被拒（判据有牙）② 合规样例放行（判据没把好人也咬了）。
 */

/** 把 {path: content} 喂进 in-memory ts-morph，返回 SourceFile[]。 */
function mk(files: Record<string, string>): SourceFile[] {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [path, content] of Object.entries(files)) project.createSourceFile(path, content);
  return project.getSourceFiles();
}

const rules = (sf: SourceFile[]): string[] => scanTradingDayReads(sf).map((v) => v.rule);

describe('check-trading-day-read — Check A 跨 ctx 读日历必须用共享三态判据', () => {
  it('✅ 合规: 叶子 ctx 直查某日 + import marketdata/trading-day.rules → 放行', () => {
    // = alert/intraday-eval.processor.ts 的现状形状 (062 T007)。
    const sf = mk({
      '/apps/server/src/alert/intraday-eval.processor.ts': `
        import { classifyTradingDay } from '../marketdata/trading-day.rules.js';
        class P { constructor(private prisma: any) {}
          async run(market: string, target: Date) {
            // CROSS-CONTEXT-READ: 盘中闸读交易日历 (只读, Q7-B)
            const n = await this.prisma.tradingDay.count({ where: { market, date: target } });
            return classifyTradingDay({ hasExactRow: n > 0, coverage: null, date: '2026-08-18' });
          } }`,
    });
    expect(scanTradingDayReads(sf)).toHaveLength(0);
  });

  it('🚨 违规: 直查某日却不 import 共享判据 → trading-day-read-without-rules', () => {
    const sf = mk({
      '/apps/server/src/alert/some-new.processor.ts': `
        class P { constructor(private prisma: any) {}
          async run(market: string, target: Date) {
            const n = await this.prisma.tradingDay.count({ where: { market, date: target } });
            return n > 0; // ← 「没记录 = 不是交易日」, 本 feature 要根治的那句话
          } }`,
    });
    expect(rules(sf)).toEqual(['trading-day-read-without-rules']);
  });

  it('🚨 违规: import 的是别的 rules 文件 (adjusted-bars) → 仍然拒', () => {
    // 防「import 了个 marketdata 的什么东西就算数」—— 判据认的是**那一个**文件。
    const sf = mk({
      '/apps/server/src/alert/some-new.processor.ts': `
        import { deriveAdjustedBars } from '../marketdata/adjusted-bars.rules.js';
        class P { constructor(private prisma: any) {}
          async run(market: string, target: Date) {
            return this.prisma.tradingDay.findFirst({ where: { market, date: target } });
          } }`,
    });
    expect(rules(sf)).toEqual(['trading-day-read-without-rules']);
  });

  it('🚨 违规: 整表读 (无 where.date) 不 import 判据 → 拒 (只有被显式识别的区间形状才豁免)', () => {
    // 极性刻意 fail-closed: 「捞一堆行回来自己 includes(today)」是同一个病换个写法,
    // 若默认放行未识别的形状, 这个洞会静默存在。
    const sf = mk({
      '/apps/server/src/optionsdesk/some-new.usecase.ts': `
        class P { constructor(private prisma: any) {}
          async run(market: string) {
            const rows = await this.prisma.tradingDay.findMany({ where: { market } });
            return rows.length > 0;
          } }`,
    });
    expect(rules(sf)).toEqual(['trading-day-read-without-rules']);
  });

  it('✅ 合规: 属主 ctx (marketdata) 自己读自己的表 → 放行 (US5 AS3)', () => {
    const sf = mk({
      '/apps/server/src/marketdata/db-trading-calendar.adapter.ts': `
        class A { constructor(private prisma: any) {}
          run(market: string, target: Date) {
            return this.prisma.tradingDay.count({ where: { market, date: target } });
          } }`,
    });
    expect(scanTradingDayReads(sf)).toHaveLength(0);
  });

  it('✅ 合规: 区间聚合 (date: { gt, lte }) 问的是「这段里有几个交易日」→ 放行', () => {
    // = alert/evaluate-alerts.usecase.ts 的 staleness 计数: 它不问「今天是不是交易日」,
    // 三态判据对它无意义。⚠️ 这不是白名单 —— 判据认的是**问法的形状**, 不是文件名。
    const sf = mk({
      '/apps/server/src/alert/evaluate-alerts.usecase.ts': `
        class P { constructor(private prisma: any) {}
          run(from: Date, to: Date) {
            // CROSS-CONTEXT-READ: 算估值 staleness (只读)
            return this.prisma.tradingDay.count({ where: { market: 'cn', date: { gt: from, lte: to } } });
          } }`,
    });
    expect(scanTradingDayReads(sf)).toHaveLength(0);
  });

  it('✅ 合规: 测试文件里的 seeding / 清理 (写操作) → 放行 (写侧归 check-server-moat)', () => {
    const sf = mk({
      '/apps/server/src/alert/evaluate-alerts.usecase.it.spec.ts': `
        async function seed(prisma: any) {
          await prisma.tradingDay.deleteMany();
          await prisma.tradingDay.createMany({ data: [{ market: 'cn', date: new Date() }] });
        }`,
    });
    expect(scanTradingDayReads(sf)).toHaveLength(0);
  });
});

describe('check-trading-day-read — Check B 覆盖终点禁由 max(date) 派生 (FR-003)', () => {
  it('🚨 违规: 同文件内 tradingDay.aggregate({ _max: { date } }) 后写 coverage', () => {
    const sf = mk({
      '/apps/server/src/marketdata/trading-calendar-sync.service.ts': `
        class S { constructor(private prisma: any) {}
          async run(market: string) {
            const agg = await this.prisma.tradingDay.aggregate({ where: { market }, _max: { date: true } });
            await this.prisma.calendarCoverage.upsert({
              where: { market },
              create: { market, coveredFrom: new Date(), coveredTo: agg._max.date },
              update: { coveredTo: agg._max.date },
            });
          } }`,
    });
    expect(rules(sf)).toEqual(['coverage-derived-from-max-date']);
  });

  it('🚨 违规: orderBy: { date: "desc" } 取最大日期后写 coverage', () => {
    const sf = mk({
      '/apps/server/src/marketdata/trading-calendar-sync.service.ts': `
        class S { constructor(private prisma: any) {}
          async run(market: string) {
            const last = await this.prisma.tradingDay.findFirst({
              where: { market },
              orderBy: { date: 'desc' },
            });
            await this.prisma.calendarCoverage.update({
              where: { market },
              data: { coveredTo: last.date },
            });
          } }`,
    });
    expect(rules(sf)).toEqual(['coverage-derived-from-max-date']);
  });

  it('✅ 合规: 写 coverage 但终点来自「整段成功填充的区间」→ 放行', () => {
    // = trading-calendar-sync.service.ts 的现状 (advanceCoverage(current, filled))。
    const sf = mk({
      '/apps/server/src/marketdata/trading-calendar-sync.service.ts': `
        class S { constructor(private prisma: any) {}
          async run(market: string, from: string, to: string) {
            const existing = await this.prisma.tradingDay.findMany({
              where: { market, date: { gte: new Date(from), lte: new Date(to) } },
              select: { date: true },
            });
            await this.prisma.calendarCoverage.upsert({
              where: { market },
              create: { market, coveredFrom: new Date(from), coveredTo: new Date(to) },
              update: { coveredTo: new Date(to) },
            });
            return existing.length;
          } }`,
    });
    expect(scanTradingDayReads(sf)).toHaveLength(0);
  });

  it('✅ 合规: 不写 coverage 的文件里取最大交易日 → 放行 (那是合法的「最近一场已收盘交易日」)', () => {
    // = db-trading-calendar.adapter.ts 的 lastClosedSession (062 T010)。Check B 的射程
    // 刻意只覆盖**写声明**的文件 —— 否则会把这条完全合法的用法一并咬死。
    const sf = mk({
      '/apps/server/src/marketdata/db-trading-calendar.adapter.ts': `
        class A { constructor(private prisma: any) {}
          run(market: string, upper: Date) {
            return this.prisma.tradingDay.findFirst({
              where: { market, date: { lte: upper } },
              orderBy: { date: 'desc' },
            });
          } }`,
    });
    expect(scanTradingDayReads(sf)).toHaveLength(0);
  });

  it('🚨 违规: groupBy + _max 变体也算「取最大日期」形状', () => {
    const sf = mk({
      '/apps/server/src/marketdata/seed.cli.ts': `
        class S { constructor(private prisma: any) {}
          async run() {
            const rows = await this.prisma.tradingDay.groupBy({ by: ['market'], _max: { date: true } });
            for (const r of rows) {
              await this.prisma.calendarCoverage.upsert({
                where: { market: r.market },
                create: { market: r.market, coveredFrom: new Date(), coveredTo: r._max.date },
                update: { coveredTo: r._max.date },
              });
            }
          } }`,
    });
    expect(rules(sf)).toEqual(['coverage-derived-from-max-date']);
  });
});
