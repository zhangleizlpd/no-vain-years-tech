import { describe, expect, it } from 'vitest';
import type { TradingDayStatus } from '../marketdata/trading-calendar.port';
import {
  STALE_GRACE_MINUTES,
  isStale,
  resolveJudgementSlot,
  type JudgementSlot,
} from './broker-freshness.rules';
import { RECONCILE_SLOT_MINUTES, type ExchangeClockReading } from './broker-sync-slot.rules';

/**
 * 083 陈旧判定纯函数单测 (plan D7; FR-009)。日期全为合成的交易所当地日期。
 *
 * `judge` 照 T006 use case 的组合方式串起两个函数: 先定判定时点, 为上一交易日时才取
 * 调用方给的 `previousTradingDate` (日历 port 的结果, null = 不可判定)。
 */

const US_SLOT = RECONCILE_SLOT_MINUTES.us;
const TODAY = '2026-09-10';
const PREV = '2026-09-09';
const DAY_BEFORE_PREV = '2026-09-08';

const at = (date: string, minutesOfDay: number): ExchangeClockReading => ({ date, minutesOfDay });

function judge({
  nowLocal,
  todayStatus = 'trading',
  previousTradingDate = PREV,
  lastSyncLocal,
}: {
  nowLocal: ExchangeClockReading;
  todayStatus?: TradingDayStatus;
  previousTradingDate?: string | null;
  lastSyncLocal: ExchangeClockReading | null;
}): { slot: JudgementSlot; stale: boolean; undeterminable: boolean } {
  const slot = resolveJudgementSlot({ market: 'us', nowLocal, todayStatus });
  const judgementDate = slot === 'today' ? nowLocal.date : previousTradingDate;
  return { slot, ...isStale({ market: 'us', judgementDate, lastSyncLocal }) };
}

describe('STALE_GRACE_MINUTES', () => {
  it('宽限 = 60 分钟 (覆盖 082 同日 3 次 × 15 分钟重试)', () => {
    expect(STALE_GRACE_MINUTES).toBe(60);
  });
});

describe('resolveJudgementSlot + isStale — 判定时点 = 最近一个已过宽限的对账时点', () => {
  it('① 时点 + 59 分钟、昨天已成功 ⇒ 取上一交易日时点 ⇒ 不陈旧; + 60 分钟、今天未成功 ⇒ 取今天 ⇒ 陈旧 (branch 6, 7)', () => {
    const syncedYesterday = at(PREV, US_SLOT + 5);
    expect(judge({ nowLocal: at(TODAY, US_SLOT + 59), lastSyncLocal: syncedYesterday })).toEqual({
      slot: 'previous-trading-day',
      stale: false,
      undeterminable: false,
    });
    expect(judge({ nowLocal: at(TODAY, US_SLOT + 60), lastSyncLocal: syncedYesterday })).toEqual({
      slot: 'today',
      stale: true,
      undeterminable: false,
    });
  });

  it('② 今天时点后已成功同步 ⇒ 不陈旧 (branch 7); 恰在时点那一分钟也算已同步', () => {
    expect(
      judge({ nowLocal: at(TODAY, US_SLOT + 90), lastSyncLocal: at(TODAY, US_SLOT + 3) }).stale,
    ).toBe(false);
    expect(
      judge({ nowLocal: at(TODAY, US_SLOT + 90), lastSyncLocal: at(TODAY, US_SLOT) }).stale,
    ).toBe(false);
    // 对照: 早于时点一分钟 ⇒ 陈旧。
    expect(
      judge({ nowLocal: at(TODAY, US_SLOT + 90), lastSyncLocal: at(TODAY, US_SLOT - 1) }).stale,
    ).toBe(true);
  });

  it('③ 今天非交易日 ⇒ 取上一交易日时点, 与当地时刻无关 (Edge「陈旧判定跨非交易日」)', () => {
    expect(
      resolveJudgementSlot({
        market: 'us',
        nowLocal: at(TODAY, US_SLOT + 300),
        todayStatus: 'non-trading',
      }),
    ).toBe('previous-trading-day');
  });

  it('④ 🚨 最近成功在前天、今天刚过时点 10 分钟 (宽限内) ⇒ 取上一交易日时点 ⇒ 陈旧 (analyze H5)', () => {
    expect(
      judge({ nowLocal: at(TODAY, US_SLOT + 10), lastSyncLocal: at(DAY_BEFORE_PREV, US_SLOT + 5) }),
    ).toEqual({ slot: 'previous-trading-day', stale: true, undeterminable: false });
  });

  it('⑤ 今天交易日、未到时点、昨天已同步 ⇒ 不陈旧', () => {
    expect(
      judge({ nowLocal: at(TODAY, US_SLOT - 30), lastSyncLocal: at(PREV, US_SLOT + 5) }),
    ).toEqual({ slot: 'previous-trading-day', stale: false, undeterminable: false });
  });

  it('⑥ 🚨 judgementDate = null (日历拿不到上一交易日) ⇒ 不可判定、不标陈旧, 不回落日历日 (branch 44)', () => {
    expect(
      isStale({ market: 'us', judgementDate: null, lastSyncLocal: at(DAY_BEFORE_PREV, US_SLOT) }),
    ).toEqual({ stale: false, undeterminable: true });
    expect(
      judge({
        nowLocal: at(TODAY, US_SLOT + 10),
        previousTradingDate: null,
        lastSyncLocal: at(DAY_BEFORE_PREV, US_SLOT + 5),
      }),
    ).toEqual({ slot: 'previous-trading-day', stale: false, undeterminable: true });
  });

  it('⑦ lastSyncLocal = null (从未成功同步) ⇒ 不陈旧、可判定', () => {
    expect(isStale({ market: 'us', judgementDate: TODAY, lastSyncLocal: null })).toEqual({
      stale: false,
      undeterminable: false,
    });
  });

  it('⑧ 日历 unknown 按交易日: 过宽限 ⇒ today; 未过 ⇒ previous-trading-day', () => {
    expect(
      resolveJudgementSlot({
        market: 'us',
        nowLocal: at(TODAY, US_SLOT + 60),
        todayStatus: 'unknown',
      }),
    ).toBe('today');
    expect(
      resolveJudgementSlot({
        market: 'us',
        nowLocal: at(TODAY, US_SLOT + 59),
        todayStatus: 'unknown',
      }),
    ).toBe('previous-trading-day');
  });

  it('港股按港股自己的时点判 (时点只从 RECONCILE_SLOT_MINUTES 取)', () => {
    const hkSlot = RECONCILE_SLOT_MINUTES.hk;
    expect(
      resolveJudgementSlot({
        market: 'hk',
        nowLocal: at(TODAY, hkSlot + 60),
        todayStatus: 'trading',
      }),
    ).toBe('today');
    expect(
      isStale({ market: 'hk', judgementDate: TODAY, lastSyncLocal: at(TODAY, hkSlot - 1) }).stale,
    ).toBe(true);
    expect(
      isStale({ market: 'hk', judgementDate: TODAY, lastSyncLocal: at(TODAY, hkSlot) }).stale,
    ).toBe(false);
  });
});
