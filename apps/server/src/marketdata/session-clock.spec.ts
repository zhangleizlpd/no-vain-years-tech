import { describe, expect, it } from 'vitest';
import {
  exchangeCalendarDate,
  exchangeCalendarDateForScope,
  isSessionComplete,
  sessionWatermark,
  sessionWatermarkForScope,
  userToday,
} from './session-clock.js';

/**
 * `session-clock.ts` 纯单测 (063 Phase 1)。**无 DB、无日历** —— 本文件覆盖的是纯时钟层:
 * 「此刻在交易所当地是几号」与「哪一场已经收了」。交易日判定归 `trading-day.rules.ts`。
 *
 * 🚨 本文件存在的理由 = #103 那类偏差**永不报错**。基准差一天不会让任何断言变红, 只会让
 * 落库的 K 线少半天成交量、让 DTE 边界腿静默进出带。⇒ 每个市场 × 收盘前后 × DST 两侧
 * 逐点钉死, 是这层唯一的护栏。
 */

describe('exchangeCalendarDate — 交易所当地的日历日 (event-time 的粗粒度)', () => {
  it('cn / hk 恒等 (同为 UTC+8 且均无 DST) —— 「恰好相等」不是「可以推导」', () => {
    const now = new Date('2026-06-10T07:30:00Z'); // 北京/香港 15:30
    expect(exchangeCalendarDate('cn', now)).toBe('2026-06-10');
    expect(exchangeCalendarDate('hk', now)).toBe('2026-06-10');
  });

  it('🚨 us 在北京上午恒为**前一日** —— 全局用上海日会错位一天且每周固定丢周五', () => {
    // 北京 2026-08-19(三) 06:00 = 08-18T22:00Z = ET 08-18(二) 18:00。
    expect(exchangeCalendarDate('us', new Date('2026-08-18T22:00:00Z'))).toBe('2026-08-18');
    expect(userToday(new Date('2026-08-18T22:00:00Z'))).toBe('2026-08-19'); // 对照: 上海已翻天
  });

  it('DST 两侧均由 Intl 处理, 无需手工偏移', () => {
    // 夏令 EDT(UTC-4): 北京 06:00 = ET 前一日 18:00。
    expect(exchangeCalendarDate('us', new Date('2026-07-14T22:00:00Z'))).toBe('2026-07-14');
    // 冬令 EST(UTC-5): 北京 06:00 = ET 前一日 17:00。
    expect(exchangeCalendarDate('us', new Date('2026-01-14T22:00:00Z'))).toBe('2026-01-14');
  });

  it('未登记市场 → 兜底宿主口径 (Asia/Shanghai), 与既有行为一致', () => {
    expect(exchangeCalendarDate('xx', new Date('2026-06-10T07:30:00Z'))).toBe('2026-06-10');
  });
});

describe('exchangeCalendarDateForScope — scope 必须落在同一业务日', () => {
  it('{cn,hk} 同日 → 返该日 (现役 eod_bar 的 scope, 按时区字符串比会在生产直接抛)', () => {
    expect(exchangeCalendarDateForScope(['cn', 'hk'], new Date('2026-06-10T07:30:00Z'))).toBe(
      '2026-06-10',
    );
  });

  it('跨时区 scope → 抛 (混 scope 还会让工作集恒为全 scope)', () => {
    const now = new Date('2026-06-10T22:00:00Z');
    expect(() => exchangeCalendarDateForScope(['cn', 'us'], now)).toThrow(/跨时区/);
    expect(() => exchangeCalendarDateForScope(['us', 'hk'], now)).toThrow(/跨时区/);
  });

  it('空 scope (meta 维度如 universe/profile) → 兜底宿主口径', () => {
    const now = new Date('2026-06-10T18:00:00Z'); // 北京 06-11 02:00
    expect(exchangeCalendarDateForScope([], now)).toBe(userToday(now));
  });
});

describe('sessionWatermark — event-time 水位「哪一场已经收了」', () => {
  describe('🚨 判据是收盘时刻, 不是日历日', () => {
    it('us: ET 15:59 → 前一日; ET 16:00 (收盘瞬间) → 当日', () => {
      expect(sessionWatermark('us', new Date('2026-06-10T19:59:00Z'))).toBe('2026-06-09');
      expect(sessionWatermark('us', new Date('2026-06-10T20:00:00Z'))).toBe('2026-06-10');
    });

    it('cn 收盘 15:00: 北京 14:59 → 前一日, 15:00 → 当日', () => {
      expect(sessionWatermark('cn', new Date('2026-06-10T06:59:00Z'))).toBe('2026-06-09');
      expect(sessionWatermark('cn', new Date('2026-06-10T07:00:00Z'))).toBe('2026-06-10');
    });

    it('hk 收盘 16:00: 港时 15:00 (cn 已收盘) 仍算前一日 —— 两市场不共用一个时刻', () => {
      const at15 = new Date('2026-06-10T07:00:00Z');
      expect(sessionWatermark('cn', at15)).toBe('2026-06-10');
      expect(sessionWatermark('hk', at15)).toBe('2026-06-09');
    });
  });

  describe('🚨 #103 的那一刻 —— 本次改动的全部意义', () => {
    /** 2026-08-19 00:13 CST = 08-18T16:13Z = ET 08-18(二) 12:13, **美股盘中**。 */
    const coldStartMoment = new Date('2026-08-18T16:13:00Z');

    it('盘中建锚: 日历日给出**尚未收盘**的当日, 水位给出上一场 —— 差的就是那半根 K', () => {
      expect(exchangeCalendarDate('us', coldStartMoment)).toBe('2026-08-18'); // 旧口径 → 半根 K
      expect(sessionWatermark('us', coldStartMoment)).toBe('2026-08-17'); // 新口径 → 完整的上一场
    });

    it('同日 06:00 CST 的常规轮不受影响 —— 准点行为零变化是本阶段的红线', () => {
      // 北京 08-19 06:00 = 08-18T22:00Z = ET 08-18 18:00 (已收盘)。
      const regularRound = new Date('2026-08-18T22:00:00Z');
      expect(exchangeCalendarDate('us', regularRound)).toBe('2026-08-18');
      expect(sessionWatermark('us', regularRound)).toBe('2026-08-18'); // 两者同值 ⇒ 行为不变
    });
  });

  describe('misfire 补触发: 漏跑后在盘中恢复', () => {
    it('cn 漏 22:00、次日 10:00 恢复 → 水位指向**漏掉的那天**而不是当日半根', () => {
      // 北京 2026-06-11(四) 10:00 = 06-11T02:00Z, cn 早盘进行中 (10:00 < 15:00)。
      const recovery = new Date('2026-06-11T02:00:00Z');
      expect(exchangeCalendarDate('cn', recovery)).toBe('2026-06-11'); // 旧: 写今天的半根
      expect(sessionWatermark('cn', recovery)).toBe('2026-06-10'); // 新: 捡回漏掉的 06-10
    });
  });

  it('DST 两侧同一 ET 墙上时刻给同一答案', () => {
    expect(sessionWatermark('us', new Date('2026-07-15T20:30:00Z'))).toBe('2026-07-15'); // EDT 16:30
    expect(sessionWatermark('us', new Date('2026-01-15T21:30:00Z'))).toBe('2026-01-15'); // EST 16:30
  });

  it('未登记市场 → 兜底 Asia/Shanghai + 16:00 (偏保守 → 少判陈旧)', () => {
    expect(sessionWatermark('xx', new Date('2026-06-10T07:59:00Z'))).toBe('2026-06-09');
    expect(sessionWatermark('xx', new Date('2026-06-10T08:00:00Z'))).toBe('2026-06-10');
  });

  it('跨月 / 跨年日界回退正确 (纯日历日运算, 与时区无关)', () => {
    expect(sessionWatermark('cn', new Date('2026-06-01T00:00:00Z'))).toBe('2026-05-31');
    expect(sessionWatermark('cn', new Date('2026-01-01T00:00:00Z'))).toBe('2025-12-31');
  });
});

describe('sessionWatermarkForScope — 多市场取**最严** (最早的那个水位)', () => {
  it('{cn,hk} 在北京 15:30: cn 已收、hk 未收 → 取 hk 的前一日', () => {
    // 15:30 CST/HKT: cn(15:00) 已过 → 06-10; hk(16:00) 未过 → 06-09。最严 = 06-09。
    const at1530 = new Date('2026-06-10T07:30:00Z');
    expect(sessionWatermark('cn', at1530)).toBe('2026-06-10');
    expect(sessionWatermark('hk', at1530)).toBe('2026-06-09');
    expect(sessionWatermarkForScope(['cn', 'hk'], at1530)).toBe('2026-06-09');
  });

  it('{cn,hk} 在 22:00 (现役 eod_bar 的 cron 时刻) → 两者同为当日 ⇒ 行为零变化', () => {
    const at2200 = new Date('2026-06-10T14:00:00Z');
    expect(sessionWatermarkForScope(['cn', 'hk'], at2200)).toBe('2026-06-10');
  });

  it('单市场 scope 与单市场函数逐点等价', () => {
    const now = new Date('2026-08-18T16:13:00Z');
    expect(sessionWatermarkForScope(['us'], now)).toBe(sessionWatermark('us', now));
  });

  it('🚨 跨时区 scope **不抛** —— 与 exchangeCalendarDateForScope 的极性刻意相反', () => {
    // 「同一业务日」是日历日口径的前提 (否则没有单一今天可言, 故抛);
    // 而水位问的是「哪一场收了」, 多市场取最严**恒有意义** ⇒ 无须抛, 取 min 即可。
    const now = new Date('2026-06-10T22:00:00Z'); // 北京 06-11 06:00 = ET 06-10 18:00
    expect(sessionWatermarkForScope(['cn', 'us'], now)).toBe('2026-06-10');
  });

  it('空 scope → 兜底宿主口径 + 16:00', () => {
    expect(sessionWatermarkForScope([], new Date('2026-06-10T07:59:00Z'))).toBe('2026-06-09');
  });
});

describe('isSessionComplete — 「此刻能不能以收盘口径往这一天落库」', () => {
  it('与 sessionWatermark 同一算式的一次比较 (字典序 = 时序)', () => {
    const at16 = new Date('2026-06-10T20:00:00Z'); // ET 16:00
    expect(isSessionComplete('us', '2026-06-10', at16)).toBe(true);
    expect(isSessionComplete('us', '2026-06-11', at16)).toBe(false);
  });

  it('🚫 MUST NOT 当「是不是交易日」用: 周六 ET 18:30 判周六同样返 true', () => {
    // 2026-06-13 是周六。本函数只回答「过没过收盘时刻」, 交易日判定归 trading_day。
    expect(isSessionComplete('us', '2026-06-13', new Date('2026-06-13T22:30:00Z'))).toBe(true);
  });
});

describe('userToday — 人工节奏跟**用户所在地**走, 与市场无关', () => {
  it('返 Asia/Shanghai 的 YYYY-MM-DD', () => {
    expect(userToday(new Date('2026-06-03T18:00:00Z'))).toBe('2026-06-04'); // 北京 02:00
    expect(userToday(new Date('2026-06-03T10:00:00Z'))).toBe('2026-06-03'); // 北京 18:00
  });
});
