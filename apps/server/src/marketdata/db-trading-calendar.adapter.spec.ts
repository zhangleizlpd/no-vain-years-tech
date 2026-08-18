import { describe, it, expect } from 'vitest';
import { PrismaService } from '../security/prisma.service.js';
import { DbTradingCalendarAdapter } from './db-trading-calendar.adapter.js';

/**
 * 表驱动交易日历 adapter 单测 (sync-1 S1-T3, 062 T006 换三态)。本文件的被测面是 adapter
 * 自己那一层职责: **取两个事实 (该日有没有行 / 该市场声明覆盖到哪儿) → 喂纯函数**, 含
 * `@db.Date` 列到 `YYYY-MM-DD` 的转换口径。
 *
 * 判据本体 (四态 + 边界) 归 `trading-day.rules.spec.ts`; 真 PG 上的合成行为归
 * `test/integration/marketdata.calendar-062.tri-state.it.spec.ts` —— 此处不复制那两份。
 */

interface Row {
  market: string;
  date: string;
}

/** 内存 prisma stub: `trading_day` 按 (market,date) 精确计数 + `calendar_coverage` 单行点查。 */
function prismaWith(rows: Row[], coverage: Record<string, [string, string]> = {}): PrismaService {
  const idx = rows.map((r) => ({ market: r.market, t: Date.parse(`${r.date}T00:00:00Z`) }));
  return {
    tradingDay: {
      count: async ({ where }: { where: { market: string; date: Date } }) =>
        idx.filter((r) => r.market === where.market && r.t === where.date.getTime()).length,
    },
    calendarCoverage: {
      findUnique: async ({ where }: { where: { market: string } }) => {
        const range = coverage[where.market];
        return range === undefined
          ? null
          : {
              market: where.market,
              coveredFrom: new Date(`${range[0]}T00:00:00Z`),
              coveredTo: new Date(`${range[1]}T00:00:00Z`),
              servedBy: 'stub',
              updatedAt: new Date(),
            };
      },
    },
  } as unknown as PrismaService;
}

describe('DbTradingCalendarAdapter', () => {
  it('态①: 该 (market,date) 有行 → trading', async () => {
    const adapter = new DbTradingCalendarAdapter(
      prismaWith([{ market: 'cn', date: '2026-07-13' }], { cn: ['2026-07-01', '2026-07-31'] }),
    );
    expect(await adapter.classify('cn', '2026-07-13')).toBe('trading');
  });

  it('态②: 当日无行 + 落在覆盖声明内 → non-trading (填过了, 确实不是交易日)', async () => {
    const adapter = new DbTradingCalendarAdapter(
      prismaWith(
        [
          { market: 'cn', date: '2026-07-10' },
          { market: 'cn', date: '2026-07-13' },
        ],
        { cn: ['2026-07-01', '2026-07-31'] },
      ),
    );
    expect(await adapter.classify('cn', '2026-07-11')).toBe('non-trading'); // 周六
  });

  it('态③: 当日无行 + 落在覆盖声明外 → unknown (根本没填到这儿)', async () => {
    const adapter = new DbTradingCalendarAdapter(
      prismaWith([{ market: 'cn', date: '2026-07-13' }], { cn: ['2026-07-01', '2026-07-31'] }),
    );
    expect(await adapter.classify('cn', '2026-08-19')).toBe('unknown');
  });

  it('🚨 态④: 该 market 无覆盖声明 → unknown (**不是** non-trading), 且 per-market 隔离', async () => {
    // 062 病根的换汤不换药版本正是把「无声明」读成 non-trading —— 那会在上线首刻 (声明表刚建)
    // 让全体消费方判「今天不是交易日」。cn 有声明、hk 没有: hk 绝不能被 cn 的声明传染。
    const adapter = new DbTradingCalendarAdapter(
      prismaWith(
        [
          { market: 'cn', date: '2026-07-10' },
          { market: 'cn', date: '2026-07-13' },
        ],
        { cn: ['2026-07-01', '2026-07-31'] },
      ),
    );
    expect(await adapter.classify('hk', '2026-07-13')).toBe('unknown'); // hk 未声明
    expect(await adapter.classify('cn', '2026-07-11')).toBe('non-trading'); // cn 已声明
  });

  it('声明表整体为空 (上线首刻) → 无行的日期一律 unknown, 有行的仍 trading', async () => {
    const adapter = new DbTradingCalendarAdapter(
      prismaWith([{ market: 'cn', date: '2026-07-13' }]),
    );
    expect(await adapter.classify('cn', '2026-07-13')).toBe('trading');
    expect(await adapter.classify('cn', '2026-07-11')).toBe('unknown');
  });
});
