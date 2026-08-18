import { describe, it, expect, vi } from 'vitest';
import type { TradingCalendarPort } from './trading-calendar.port.js';
import type { TradingDayStatus } from './trading-day.rules.js';
import {
  daysToExpiry,
  isTradingDayGateOpen,
  isSessionClosed,
  lastClosedSessionCutoff,
  marketDateFor,
  shanghaiToday,
} from './trading-day-gate.js';

/**
 * 交易日 gate 纯单测 (016 T004, 无 DB)。验委托 TRADING_CALENDAR_PORT + 市场/日期透传
 * + Shanghai 今日格式。SyncRun 落库 (status=skipped) 由 recorder Testcontainers 测覆盖。
 */
describe('isTradingDayGateOpen', () => {
  function calendar(result: TradingDayStatus): {
    port: TradingCalendarPort;
    spy: ReturnType<typeof vi.fn>;
  } {
    const spy = vi.fn(async () => result);
    return { port: { classify: spy, lastClosedSession: async () => null }, spy };
  }

  it('交易日 → gate open true, 透传 market/date 给 calendar', async () => {
    const { port, spy } = calendar('trading');
    expect(await isTradingDayGateOpen(port, 'cn', '2026-06-03')).toBe(true);
    expect(spy).toHaveBeenCalledWith('cn', '2026-06-03');
  });

  it('非交易日 → gate closed false (调用方据此整管线 skip)', async () => {
    const { port } = calendar('non-trading');
    expect(await isTradingDayGateOpen(port, 'cn', '2026-06-06')).toBe(false);
  });

  it('🚨 062 T006 Guardrail 1: `unknown` → gate **仍开** (映射是 `!== non-trading`)', async () => {
    // 「日历还没填到这儿」MUST NOT 被读成「今天不是交易日」—— 那会让上线首刻 (覆盖声明表刚建
    // ⇒ 全 unknown) 整条夜间管线恒 skip, 与 062 之前 fail-open 的方向正好相反, 且不会有任何
    // 既有断言变红。这一条就是那颗钉子。
    const { port } = calendar('unknown');
    expect(await isTradingDayGateOpen(port, 'cn', '2026-06-03')).toBe(true);
  });
});

describe('shanghaiToday', () => {
  it('返 Asia/Shanghai 的 YYYY-MM-DD', () => {
    // 2026-06-03 18:00 UTC = 2026-06-04 02:00 北京 → 北京日期已跨到 6-04。
    expect(shanghaiToday(new Date('2026-06-03T18:00:00Z'))).toBe('2026-06-04');
    // 2026-06-03 10:00 UTC = 2026-06-03 18:00 北京 → 同日。
    expect(shanghaiToday(new Date('2026-06-03T10:00:00Z'))).toBe('2026-06-03');
  });
});

describe('marketDateFor (业务日期按市场时区)', () => {
  /** 北京 06:00 = us 维度的 cron 时刻 (美股收盘后 12–13 小时)。 */
  const beijing6am = (isoDate: string) => new Date(`${isoDate}T22:00:00Z`); // 次日 06:00 北京

  describe('cn / hk 行为零变化 (回归护栏)', () => {
    it.each([
      ['2026-06-03T18:00:00Z', '2026-06-04'],
      ['2026-06-03T10:00:00Z', '2026-06-03'],
      ['2026-06-03T15:59:59Z', '2026-06-03'], // 北京 23:59:59 —— 日界前一秒
      ['2026-06-03T16:00:00Z', '2026-06-04'], // 北京 00:00:00 —— 日界
    ])('%s → cn/hk 与 shanghaiToday 同值 (%s)', (iso, expected) => {
      const now = new Date(iso);
      for (const scope of [['cn'], ['hk'], ['cn', 'hk']]) {
        expect(marketDateFor(scope, now)).toBe(expected);
        expect(marketDateFor(scope, now)).toBe(shanghaiToday(now));
      }
    });

    it('空 marketScope (meta 维度 universe/profile) → 沿用宿主口径', () => {
      const now = new Date('2026-06-03T18:00:00Z');
      expect(marketDateFor([], now)).toBe(shanghaiToday(now));
    });
  });

  describe('🚨 us: 修掉「拿墙上时钟当业务日期」', () => {
    it('北京周二 06:00 → 业务日 = 周一 (不再错位一天)', () => {
      // 2026-06-08 是周一。北京周二(06-09) 06:00 = 06-08 22:00 UTC = 06-08 18:00 EDT。
      expect(marketDateFor(['us'], beijing6am('2026-06-08'))).toBe('2026-06-08');
      // 对照: 全局 shanghaiToday 会给出周二 —— 那正是 bug。
      expect(shanghaiToday(beijing6am('2026-06-08'))).toBe('2026-06-09');
    });

    it('🚨 北京周六 06:00 → 业务日 = 周五 (周五的 bar 不再永久丢失)', () => {
      // 2026-06-12 周五。北京周六(06-13) 06:00 → NY 仍是周五 18:00。
      expect(marketDateFor(['us'], beijing6am('2026-06-12'))).toBe('2026-06-12');
      // 旧口径会给周六 → 交易日闸判非交易日 → 整批短路 → 周五永远采不到。
      expect(shanghaiToday(beijing6am('2026-06-12'))).toBe('2026-06-13');
    });

    it('北京周日/周一 06:00 → 业务日 = 周六/周日 (由交易日闸正确跳过, 不白跑)', () => {
      expect(marketDateFor(['us'], beijing6am('2026-06-13'))).toBe('2026-06-13'); // 周六
      expect(marketDateFor(['us'], beijing6am('2026-06-14'))).toBe('2026-06-14'); // 周日
    });

    it('DST 两侧都落在收盘之后, 无需特判 (夏令 18:00 EDT / 冬令 17:00 EST)', () => {
      // 夏令 (EDT, UTC-4): 北京 06:00 → 前一日 18:00。
      expect(marketDateFor(['us'], beijing6am('2026-07-15'))).toBe('2026-07-15');
      // 冬令 (EST, UTC-5): 北京 06:00 → 前一日 17:00 —— 仍晚于 16:00 收盘。
      expect(marketDateFor(['us'], beijing6am('2026-01-15'))).toBe('2026-01-15');
    });
  });

  it('🚨 跨时区 scope → throw (混 scope 无单一业务日, 且会让工作集恒为全 scope)', () => {
    const now = new Date('2026-06-03T18:00:00Z');
    expect(() => marketDateFor(['cn', 'us'], now)).toThrow(/跨时区/);
    expect(() => marketDateFor(['us', 'hk'], now)).toThrow(/跨时区/);
  });
});

describe('lastClosedSessionCutoff (已收盘 session 的日期上界)', () => {
  describe('us — 判据必须是收盘时刻, 不是日历日', () => {
    it('ET 15:59 (未收盘) → 上界 = 前一日; ET 16:00 (收盘瞬间) → 上界 = 当日', () => {
      // 2026-06-10 周三, EDT = UTC-4。
      expect(lastClosedSessionCutoff('us', new Date('2026-06-10T19:59:00Z'))).toBe('2026-06-09');
      expect(lastClosedSessionCutoff('us', new Date('2026-06-10T20:00:00Z'))).toBe('2026-06-10');
    });

    it('🚨 北京周四上午 10:00 → 上界 = ET 周三 (缺周三数据即判陈旧)', () => {
      // 北京 2026-06-11(四) 10:00 = 06-11 02:00Z = ET 06-10(三) 22:00 —— 周三早已收盘。
      // 若判据写成「严格早于市场当地今天」, 这里会得到周二 ⇒ 昨夜同步失败也判正常, 正是 FR-020 要抓的。
      expect(lastClosedSessionCutoff('us', new Date('2026-06-11T02:00:00Z'))).toBe('2026-06-10');
    });

    it('北京周四凌晨 03:00 (ET 周三 15:00, 尚未收盘) → 上界仍是周二', () => {
      expect(lastClosedSessionCutoff('us', new Date('2026-06-10T19:00:00Z'))).toBe('2026-06-09');
    });

    it('DST 两侧同一 ET 墙上时刻给同一答案 (Intl 处理, 无需特判)', () => {
      // 夏令 EDT(UTC-4) 与冬令 EST(UTC-5) 各自的 ET 16:30。
      expect(lastClosedSessionCutoff('us', new Date('2026-07-15T20:30:00Z'))).toBe('2026-07-15');
      expect(lastClosedSessionCutoff('us', new Date('2026-01-15T21:30:00Z'))).toBe('2026-01-15');
    });
  });

  describe('cn / hk — 各自的收盘时刻', () => {
    it('cn 收盘 15:00: 北京 14:59 → 前一日, 15:00 → 当日', () => {
      expect(lastClosedSessionCutoff('cn', new Date('2026-06-10T06:59:00Z'))).toBe('2026-06-09');
      expect(lastClosedSessionCutoff('cn', new Date('2026-06-10T07:00:00Z'))).toBe('2026-06-10');
    });

    it('hk 收盘 16:00: 港时 15:00 (= cn 已收盘) 仍算前一日 —— 两个市场不共用一个时刻', () => {
      const at15 = new Date('2026-06-10T07:00:00Z'); // 北京/香港 15:00
      expect(lastClosedSessionCutoff('cn', at15)).toBe('2026-06-10');
      expect(lastClosedSessionCutoff('hk', at15)).toBe('2026-06-09');
    });
  });

  it('未登记市场 → 兜底 Asia/Shanghai + 16:00 (偏保守, 少判陈旧)', () => {
    expect(lastClosedSessionCutoff('xx', new Date('2026-06-10T07:59:00Z'))).toBe('2026-06-09');
    expect(lastClosedSessionCutoff('xx', new Date('2026-06-10T08:00:00Z'))).toBe('2026-06-10');
  });

  it('跨月 / 跨年日界回退正确 (纯日历日运算)', () => {
    expect(lastClosedSessionCutoff('cn', new Date('2026-06-01T00:00:00Z'))).toBe('2026-05-31');
    expect(lastClosedSessionCutoff('cn', new Date('2026-01-01T00:00:00Z'))).toBe('2025-12-31');
  });
});

/**
 * 047 T006a: 请求时 DTE 的**日期基准**。
 * canonical = `docs/conventions/cross-timezone-date-semantics.md` §3 (「今天」归属表) + §4 (剩余期限口径)。
 *
 * 🚨 本 describe 的第一条是**整条 task 的全部意义**: 基准差一天不会让任何东西报错 —— 它只让
 * 带判据 (建仓腿 `DTE ≤ 14` / 收租腿 `DTE ∈ [150,365]` / FR-048 豁免线 `DTE ≤ 2`) 悄悄挪一格。
 */
describe('daysToExpiry (请求时 DTE, 基准 = 交易所的今天)', () => {
  describe('🚨 基准是 ET 日期, 不是宿主 (上海) 日期', () => {
    // 北京 2026-08-05 10:00 = 02:00Z = 纽约 2026-08-04 22:00 EDT —— 北京上午恒为 ET 前一日晚。
    const beijingMorning = new Date('2026-08-05T02:00:00Z');

    it('北京上午 10:00 → 取 ET 的 08-04 而非上海的 08-05 (差一天不会红, 只让边界腿静默进出带)', () => {
      // 前置: 这一刻两地日期确实不同 (否则本条断言退化成恒真)。
      expect(marketDateFor(['us'], beijingMorning)).toBe('2026-08-04');
      expect(shanghaiToday(beijingMorning)).toBe('2026-08-05');

      // ET 基准 = 08-21 − 08-04 = 17; 宿主 (上海) 基准会给 16 —— 恰好是建仓腿 `DTE ≤ 14`
      // 与收租腿 `DTE ∈ [150,365]` 两条带判据的静默偏移源。
      expect(daysToExpiry({ expiry: '2026-08-21', now: beijingMorning })).toBe(17);
      expect(daysToExpiry({ expiry: '2026-08-21', now: beijingMorning })).not.toBe(16);
    });

    it('同一个 ET 日内任意时刻 → DTE 恒定 (禁绝对时刻差: 小数会让带判据在一天内抖)', () => {
      const sameEtDay = [
        new Date('2026-08-04T14:00:00Z'), // ET 08-04 10:00
        new Date('2026-08-04T20:00:00Z'), // ET 08-04 16:00 (收盘)
        beijingMorning, // ET 08-04 22:00
        new Date('2026-08-05T03:59:00Z'), // ET 08-04 23:59 —— 日界前一分钟
      ];
      for (const now of sameEtDay) {
        expect(daysToExpiry({ expiry: '2026-08-21', now })).toBe(17);
      }
    });
  });

  /** 纽约当地 12:00 的绝对时刻 (EDT 16:00Z / EST 17:00Z, 两侧都稳落在当天)。 */
  const etNoon = (utcIso: string) => new Date(utcIso);

  it('到期日当天 = 0 (canonical §4)', () => {
    expect(daysToExpiry({ expiry: '2026-08-21', now: etNoon('2026-08-21T16:00:00Z') })).toBe(0);
  });

  it('整数日历日, 跨周末不跳过 (周五 → 周一 = 3 不是 1)', () => {
    // 2026-08-21 周五 → 2026-08-24 周一。交易日算法会给 1, 日历日给 3 —— 口径是日历日。
    expect(daysToExpiry({ expiry: '2026-08-24', now: etNoon('2026-08-21T16:00:00Z') })).toBe(3);
  });

  it('已过期 → 负数 (不 clamp 到 0: 0 已被"当天到期"占用, clamp 会把两种状态混成一种)', () => {
    expect(daysToExpiry({ expiry: '2026-08-20', now: etNoon('2026-08-21T16:00:00Z') })).toBe(-1);
    expect(daysToExpiry({ expiry: '2026-07-21', now: etNoon('2026-08-21T16:00:00Z') })).toBe(-31);
  });

  it('🚨 DST 切换日附近不抖 (2026-11-01 美东回拨: 该窗 73 绝对小时, 时刻差会给 3.04)', () => {
    // 全部对同一个到期日 2026-11-02, 逐 ET 日递减 1 —— 中间跨 11-01 02:00 EDT→01:00 EST。
    const byEtDay: [string, number][] = [
      ['2026-10-30T16:00:00Z', 3], // ET 周五 10-30
      ['2026-10-31T16:00:00Z', 2], // ET 周六 10-31
      ['2026-11-01T17:00:00Z', 1], // ET 周日 11-01 (回拨当日, 已是 EST)
      ['2026-11-02T17:00:00Z', 0], // ET 周一 11-02
    ];
    for (const [utcIso, expected] of byEtDay) {
      const dte = daysToExpiry({ expiry: '2026-11-02', now: etNoon(utcIso) });
      expect(dte).toBe(expected);
      expect(Number.isInteger(dte)).toBe(true);
    }
  });

  it('接受 Prisma `@db.Date` 读出的 Date (UTC 午夜) 与 `YYYY-MM-DD` 字符串, 两者同值', () => {
    const now = etNoon('2026-08-21T16:00:00Z');
    const fromDbDate = daysToExpiry({ expiry: new Date('2026-08-24T00:00:00Z'), now });
    expect(fromDbDate).toBe(daysToExpiry({ expiry: '2026-08-24', now }));
  });

  it('🚨 到期日传了一个带时间的绝对时刻 → throw (canonical §3 那个"身兼两职"的陷阱)', () => {
    const now = etNoon('2026-08-21T16:00:00Z');
    expect(() => daysToExpiry({ expiry: new Date('2026-08-24T13:30:00Z'), now })).toThrow(/到期日/);
  });

  it('非 YYYY-MM-DD 字符串 → throw (不静默返 NaN)', () => {
    const now = etNoon('2026-08-21T16:00:00Z');
    expect(() => daysToExpiry({ expiry: '2026/08/24', now })).toThrow(/YYYY-MM-DD/);
    expect(() => daysToExpiry({ expiry: '2026-02-30', now })).toThrow(/YYYY-MM-DD/);
  });
});

/**
 * 2026-08-17 prod 实撞的那条前置条件 (开盘前跑 `option_daily_snapshot` ⇒ 盘前价盖当日日戳,
 * 且 `skipDuplicates` 把当晚真收盘那轮静默挡掉)。这里钉的是**判据本身**, 落点断言在
 * `sync-option-snapshot.usecase.spec.ts`。
 */
describe('isSessionClosed (能不能以 eod 口径写这一天)', () => {
  it('🚨 事故时刻复现: 北京 21:07 = ET 09:07 周一 (盘前) ⇒ 当日**未**收盘', () => {
    // 2026-08-17 周一, EDT = UTC-4 ⇒ 北京 21:07 = 13:07Z = ET 09:07, 距 16:00 收盘还有近 7 小时。
    const preOpen = new Date('2026-08-17T13:07:00Z');
    expect(isSessionClosed('us', '2026-08-17', preOpen)).toBe(false);
    // 而上一交易日 (周五) 早已收盘 —— 这正是那一刻**唯一**能合法落库的 session。
    expect(isSessionClosed('us', '2026-08-14', preOpen)).toBe(true);
  });

  it('收盘瞬间是闭区间: ET 15:59 判 false / 16:00 判 true', () => {
    expect(isSessionClosed('us', '2026-08-17', new Date('2026-08-17T19:59:00Z'))).toBe(false);
    expect(isSessionClosed('us', '2026-08-17', new Date('2026-08-17T20:00:00Z'))).toBe(true);
  });

  it('夜间轮时刻 (北京次日 06:30 = ET 18:30 盘后) ⇒ 当日已收盘, 正常路径不受本闸影响', () => {
    expect(isSessionClosed('us', '2026-08-17', new Date('2026-08-17T22:30:00Z'))).toBe(true);
  });

  it('🚫 它不回答「是不是交易日」: 周六 ET 18:30 判周六同样 true (那天根本没有 session)', () => {
    // 2026-08-15 周六 ET 18:30 = 22:30Z。交易日判定归 trading_day / isTradingDayGateOpen。
    expect(isSessionClosed('us', '2026-08-15', new Date('2026-08-15T22:30:00Z'))).toBe(true);
  });

  it('未来的 session 一律未收盘', () => {
    expect(isSessionClosed('us', '2026-08-18', new Date('2026-08-17T22:30:00Z'))).toBe(false);
  });
});
