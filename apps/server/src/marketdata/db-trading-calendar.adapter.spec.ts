import { describe, it, expect } from 'vitest';
import { PrismaService } from '../security/prisma.service.js';
import { DbTradingCalendarAdapter } from './db-trading-calendar.adapter.js';

/**
 * 表驱动交易日历 adapter 单测 (sync-1 S1-T3)。验判定三态: 有行=true / 近窗有行但当日无行=
 * false (真非交易日) / 近窗零行=fail-open true (表未 populate)。真 count 语义由 T2 IT
 * (marketdata.trading-calendar-sync.it, 真 prisma 落库) 已覆盖; 此处以内存 stub 验判定分支。
 */

/** 内存 prisma stub: 按 (market, date) 行集回答 count (支持 exact date 与 {gte,lte} 窗口)。 */
function prismaWith(rows: { market: string; date: string }[]): PrismaService {
  const idx = rows.map((r) => ({ market: r.market, t: Date.parse(`${r.date}T00:00:00Z`) }));
  return {
    tradingDay: {
      count: async ({
        where,
      }: {
        where: { market: string; date: Date | { gte: Date; lte: Date } };
      }) => {
        const d = where.date;
        if (d instanceof Date) {
          return idx.filter((r) => r.market === where.market && r.t === d.getTime()).length;
        }
        return idx.filter(
          (r) => r.market === where.market && r.t >= d.gte.getTime() && r.t <= d.lte.getTime(),
        ).length;
      },
    },
  } as unknown as PrismaService;
}

describe('DbTradingCalendarAdapter', () => {
  it('态①: 该 (market,date) 有行 → 交易日 true', async () => {
    const adapter = new DbTradingCalendarAdapter(
      prismaWith([{ market: 'cn', date: '2026-07-13' }]),
    );
    expect(await adapter.isTradingDay('cn', '2026-07-13')).toBe(true);
  });

  it('态②: 当日无行但近窗有其它交易日 (表已 populate) → 真非交易日 false', async () => {
    // 表有 07-10(Fri)/07-13(Mon) 行, 查 07-11(Sat) → 当日无行 + 近窗有行 → false。
    const adapter = new DbTradingCalendarAdapter(
      prismaWith([
        { market: 'cn', date: '2026-07-10' },
        { market: 'cn', date: '2026-07-13' },
      ]),
    );
    expect(await adapter.isTradingDay('cn', '2026-07-11')).toBe(false);
  });

  it('态③: 该 market 近窗零行 (表未 populate) → fail-open true (不静默恒关 gate)', async () => {
    const adapter = new DbTradingCalendarAdapter(prismaWith([]));
    expect(await adapter.isTradingDay('cn', '2026-07-13')).toBe(true);
  });

  it('态③ per-market 隔离: 另一 market 已 populate 不影响本 market 的 fail-open', async () => {
    // cn 已 populate, hk 零行 → 查 hk 走 fail-open true (不被 cn 的行"污染"判定)。
    const adapter = new DbTradingCalendarAdapter(
      prismaWith([
        { market: 'cn', date: '2026-07-10' },
        { market: 'cn', date: '2026-07-13' },
      ]),
    );
    expect(await adapter.isTradingDay('hk', '2026-07-13')).toBe(true); // hk 未填 → fail-open
    expect(await adapter.isTradingDay('cn', '2026-07-11')).toBe(false); // cn 已填 → 真非交易日
  });
});
