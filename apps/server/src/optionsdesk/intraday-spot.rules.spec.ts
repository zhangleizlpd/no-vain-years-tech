import { describe, it, expect } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  FRESHNESS_TICK_MULTIPLIER,
  INTRADAY_CIRCUIT_THRESHOLD,
  INTRADAY_FRESHNESS_SECONDS,
  INTRADAY_TICK_INTERVAL_SECONDS,
  intradayFreshnessCutoff,
  isIntradayFresh,
  resolveAnchorSpot,
  type AnchorSpotInput,
} from './intraday-spot.rules';

const NOW = new Date('2026-08-17T18:30:00.000Z');

/** `now` 之前 n 秒的一个采集时刻。 */
function secondsAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 1000);
}

const INTRADAY = new Prisma.Decimal('177.7700');
const LAST_CLOSE = new Prisma.Decimal('165.4100');
const LAST_CLOSE_DATE = new Date('2026-08-14T00:00:00.000Z');

function inputOf(overrides: Partial<AnchorSpotInput> = {}): AnchorSpotInput {
  return {
    intradayPrice: INTRADAY,
    intradayAt: secondsAgo(1),
    lastClose: LAST_CLOSE,
    lastCloseDate: LAST_CLOSE_DATE,
    ...overrides,
  };
}

describe('新鲜度闸的取值 (FR-007) —— 派生, 不是第二处手写数', () => {
  it('闸 = 倍数 × tick 间隔 (硬编码 90 时本条红)', () => {
    expect(INTRADAY_FRESHNESS_SECONDS).toBe(
      INTRADAY_TICK_INTERVAL_SECONDS * FRESHNESS_TICK_MULTIPLIER,
    );
  });

  it('🚨 熔断窗口与新鲜度闸**同刻**到期 (CIRCUIT_THRESHOLD × T === 闸)', () => {
    // 取 3 而非 4 的**全部**理由就是这一条: 熔断打开的那一刻, 数据也刚好被判陈旧。
    // 两者脱钩 ⇒ 出现「熔断已开、雷达仍标实时档」的窗口 —— 本 feature 最想消灭的静默骗人形态。
    expect(INTRADAY_CIRCUIT_THRESHOLD * INTRADAY_TICK_INTERVAL_SECONDS).toBe(
      INTRADAY_FRESHNESS_SECONDS,
    );
  });

  it('倍数是定死的单值, 不是区间 —— 留成区间等于第二个没人拍的自由变量', () => {
    expect(typeof FRESHNESS_TICK_MULTIPLIER).toBe('number');
    expect(Number.isInteger(FRESHNESS_TICK_MULTIPLIER)).toBe(true);
  });

  it('cutoff = now − 闸 (SQL 参数绑定的唯一来源, 读端与 SQL 同源)', () => {
    expect(intradayFreshnessCutoff(NOW).getTime()).toBe(
      NOW.getTime() - INTRADAY_FRESHNESS_SECONDS * 1000,
    );
  });
});

describe('isIntradayFresh —— 闭区间闸 (state_branch 11 / 12)', () => {
  it('闸内 → 新鲜', () => {
    expect(isIntradayFresh(secondsAgo(INTRADAY_FRESHNESS_SECONDS - 1), NOW)).toBe(true);
  });

  it('恰好落在闸上 → 仍新鲜 (闭区间)', () => {
    expect(isIntradayFresh(secondsAgo(INTRADAY_FRESHNESS_SECONDS), NOW)).toBe(true);
  });

  it('越闸一秒 → 陈旧', () => {
    expect(isIntradayFresh(secondsAgo(INTRADAY_FRESHNESS_SECONDS + 1), NOW)).toBe(false);
  });

  it('采集时刻缺失 → 陈旧 (MUST NOT 猜成新鲜)', () => {
    expect(isIntradayFresh(null, NOW)).toBe(false);
  });

  it('采集时刻不可解析 → 陈旧, 不抛', () => {
    expect(isIntradayFresh(new Date('not-a-date'), NOW)).toBe(false);
  });
});

describe('resolveAnchorSpot —— 读端档位判定的唯一入口 (FR-008 / FR-014)', () => {
  it('实时价新鲜 → 实时档, 用实时价, asOf 呈**时刻** (state_branch 11)', () => {
    const at = secondsAgo(INTRADAY_FRESHNESS_SECONDS - 1);
    const spot = resolveAnchorSpot(inputOf({ intradayAt: at }), NOW);
    expect(spot.priceKind).toBe('realtime');
    expect(spot.price?.equals(INTRADAY)).toBe(true);
    expect(spot.asOf).toBe(at.toISOString());
  });

  it('恰好落在闸上 → 仍是实时档 (闭区间, 与 isIntradayFresh 同一判据)', () => {
    const spot = resolveAnchorSpot(
      inputOf({ intradayAt: secondsAgo(INTRADAY_FRESHNESS_SECONDS) }),
      NOW,
    );
    expect(spot.priceKind).toBe('realtime');
  });

  it('🚨 越闸 → 回落收盘价并标收盘档, MUST NOT 用陈旧实时价 (state_branch 12)', () => {
    const spot = resolveAnchorSpot(
      inputOf({ intradayAt: secondsAgo(INTRADAY_FRESHNESS_SECONDS + 1) }),
      NOW,
    );
    expect(spot.priceKind).toBe('eod_close');
    expect(spot.price?.equals(LAST_CLOSE)).toBe(true);
    expect(spot.asOf).toBe('2026-08-14'); // 收盘档 asOf 呈**交易日**, 不是时刻
  });

  it('半写状态 (有价无时刻) → 收盘档 —— 无时刻即无从判新鲜', () => {
    const spot = resolveAnchorSpot(inputOf({ intradayAt: null }), NOW);
    expect(spot.priceKind).toBe('eod_close');
    expect(spot.price?.equals(LAST_CLOSE)).toBe(true);
  });

  it('半写状态 (有时刻无价) → 收盘档', () => {
    const spot = resolveAnchorSpot(inputOf({ intradayPrice: null }), NOW);
    expect(spot.priceKind).toBe('eod_close');
    expect(spot.price?.equals(LAST_CLOSE)).toBe(true);
  });

  it('从未采集过 (两者皆 null) → 收盘档 (state_branch 13 的前半)', () => {
    const spot = resolveAnchorSpot(inputOf({ intradayPrice: null, intradayAt: null }), NOW);
    expect(spot.priceKind).toBe('eod_close');
    expect(spot.price?.equals(LAST_CLOSE)).toBe(true);
    expect(spot.asOf).toBe('2026-08-14');
  });

  it('🚨 全为 null → price 显式 null 且档位仍给出, **MUST NOT 回落成 0** (FR-014)', () => {
    const spot = resolveAnchorSpot(
      { intradayPrice: null, intradayAt: null, lastClose: null, lastCloseDate: null },
      NOW,
    );
    expect(spot.price).toBeNull();
    expect(spot.asOf).toBeNull();
    // 0 是一个**有意义的距离值**(「正好在带上」), 用它表达「没有数据」会被读成强信号。
    expect(spot.priceKind).toBe('eod_close');
  });

  it('收盘后两价「都是今天的」→ 闸单点裁决, 连查两次不抖 (state_branch 15)', () => {
    const input = inputOf({
      intradayAt: secondsAgo(INTRADAY_FRESHNESS_SECONDS + 1),
      lastCloseDate: new Date('2026-08-17T00:00:00.000Z'),
    });
    const first = resolveAnchorSpot(input, NOW);
    const second = resolveAnchorSpot(input, NOW);
    expect(second).toEqual(first);
    expect(first.priceKind).toBe('eod_close');
  });
});
