import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import type { TradingCalendarPort } from './trading-calendar.port.js';

/**
 * 表驱动交易日历 adapter (sync-1 S1-T3, TRADING_CALENDAR_PORT live 实现)。**去理杏仁化**:
 * 不再每次 gate 现打理杏仁付费指数 candlestick (403 打挂), 改读 `trading_day` 表 (由
 * TradingCalendarSyncService 每日 populate + seed CLI 历史填充; 与 alert 盘中 gate 读法
 * `intraday-eval.processor.ts` 同构)。
 *
 * **判定三态**:
 *  1. 该 (market, date) 有行 → 交易日 `true`。
 *  2. 无行, 但该 market 在近窗 [date−N, date] 有其它行 (表已 populate) → 该日真非交易日 `false`。
 *  3. 无行, 且该 market 近窗**零行** (表未 populate / 该 market 从未填) → **fail-open `true`**。
 *
 * 兜底 (3) 是承重设计: 空表若 fail-closed 会「恒关 gate、整管线永不跑」——比理杏仁 403 更隐蔽
 * (403 至少报错; 空表静默 skip)。宁可空表期多跑 (vendor 侧各维度自有节假日容错) 也不静默停摆。
 * 近窗取 30 日: 任何活跃市场 30 日内必有交易日, 故 fail-open 只在真未 populate 时触发, 不误判
 * 长假 (最长 A 股春节 ~9 日 << 30)。
 */

/** fail-open 判定的近窗天数 (见类注释: 30 日 > 任何市场最长连续休市)。 */
const FAIL_OPEN_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

@Injectable()
export class DbTradingCalendarAdapter implements TradingCalendarPort {
  constructor(private readonly prisma: PrismaService) {}

  async isTradingDay(market: string, date: string): Promise<boolean> {
    const target = new Date(`${date}T00:00:00Z`);
    // (1) 该日有行 = 交易日。
    const exact = await this.prisma.tradingDay.count({ where: { market, date: target } });
    if (exact > 0) return true;
    // (2)/(3) 无行 → 看近窗是否被 populate 过。
    const windowStart = new Date(target.getTime() - FAIL_OPEN_WINDOW_DAYS * DAY_MS);
    const nearby = await this.prisma.tradingDay.count({
      where: { market, date: { gte: windowStart, lte: target } },
    });
    // 近窗零行 → 表未 populate → fail-open true; 近窗有行 → 该日真非交易日 → false。
    return nearby === 0;
  }
}
