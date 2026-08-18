import { describe, expect, it, vi } from 'vitest';
import { resolveLastClosedSessions } from './last-closed-session';
import type { TradingCalendarPort } from '../marketdata/trading-calendar.port';
import type { TradingDayStatus } from '../marketdata/trading-day.rules';

/**
 * 062 T010: 被测面由「直查 `trading_day` + 自己算收盘上界」收窄成「按市场分发端口调用 + 去重」
 * —— 收盘上界与覆盖声明可信度都搬进了 `DbTradingCalendarAdapter`（唯一实现），故本文件不再
 * 断言 cutoff（那会变成第二份判据）。cutoff 的时区语义归 `trading-day-gate.spec.ts`，
 * 覆盖声明那一维归 `optionsdesk-062.calendar.it.spec.ts`（真 PG）。
 */
function stubCalendar(sessions: Record<string, string | null>) {
  const lastClosedSession = vi.fn(async (market: string) => sessions[market] ?? null);
  const calendar: TradingCalendarPort = {
    async classify(): Promise<TradingDayStatus> {
      return 'trading';
    },
    lastClosedSession,
  };
  return { calendar, lastClosedSession };
}

describe('resolveLastClosedSessions', () => {
  /** 北京 2026-08-04(二) 10:00 = ET 08-03(一) 22:00 —— 周一早已收盘。 */
  const beijingTueMorning = new Date('2026-08-04T02:00:00Z');

  it('逐市场问端口, 原样交回 YYYY-MM-DD; 请求时刻透传 (上界按交易所时区在端口内求)', async () => {
    const { calendar, lastClosedSession } = stubCalendar({ us: '2026-08-03' });
    const got = await resolveLastClosedSessions(calendar, ['us'], beijingTueMorning);
    expect(got.get('us')).toBe('2026-08-03');
    // 🚨 传的是**绝对时刻**而不是算好的日期串: 后者等于把「跟谁的今天」这个判断留在本 ctx,
    //    而它正是 046 那次「境内早晨恒显已过时」的成因。
    expect(lastClosedSession).toHaveBeenCalledWith('us', beijingTueMorning);
  });

  it('端口判不可判定 (日历缺行 / 上界落在覆盖声明之外) ⇒ null (交由 freshnessTier fail-open)', async () => {
    const { calendar } = stubCalendar({ us: null });
    expect(
      (await resolveLastClosedSessions(calendar, ['us'], beijingTueMorning)).get('us'),
    ).toBeNull();
  });

  it('多市场各问各的; 重复市场只问一次 (Set 去重)', async () => {
    const { calendar, lastClosedSession } = stubCalendar({ us: '2026-08-03', cn: '2026-08-04' });
    const got = await resolveLastClosedSessions(calendar, ['us', 'cn', 'us'], beijingTueMorning);
    expect(got.get('us')).toBe('2026-08-03');
    expect(got.get('cn')).toBe('2026-08-04');
    expect(lastClosedSession).toHaveBeenCalledTimes(2);
  });

  it('空市场列表 ⇒ 空 Map, 零调用', async () => {
    const { calendar, lastClosedSession } = stubCalendar({});
    expect((await resolveLastClosedSessions(calendar, [], beijingTueMorning)).size).toBe(0);
    expect(lastClosedSession).not.toHaveBeenCalled();
  });
});
