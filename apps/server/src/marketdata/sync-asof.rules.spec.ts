import { describe, expect, it } from 'vitest';
import { DIMENSION_KEYS } from './dimension-executor.js';
import { exchangeCalendarDateForScope } from './session-clock.js';
import { AS_OF_BASIS_BY_DIMENSION, resolveAsOfForDimension } from './sync-asof.rules.js';

/**
 * 采集业务日期 (`asOf`) 的求值单点 —— 063 Phase 1。
 *
 * 🚨 本文件的红线是 **「准点行为零变化」**: 各维度在**自己 cron 时刻**上的取值必须与改动前
 * 逐点相同。改动只在**非准点时刻**(盘中建锚 / 手敲 CLI / misfire 补触发) 生效。
 */

describe('AS_OF_BASIS_BY_DIMENSION — 口径必须逐维度显式声明', () => {
  it('🚨 覆盖全部维度键 —— 新增维度不声明口径 = 编译不过 (Record 的穷尽性)', () => {
    // 这条断言是运行时的第二道: TS 的 `Record<DimensionKey, AsOfBasis>` 已在编译期拦住,
    // 但键全集来自 `as const` 数组, 有人改成 `Partial<>` 时编译期那道会静默消失。
    for (const key of DIMENSION_KEYS) {
      expect(AS_OF_BASIS_BY_DIMENSION[key], `维度 ${key} 未声明 asOf 口径`).toBeDefined();
    }
  });

  it('Phase 1 切到收盘口径的只有价格/快照族四个 (其余保持现状 = 零行为变化)', () => {
    const closedSession = DIMENSION_KEYS.filter(
      (k) => AS_OF_BASIS_BY_DIMENSION[k] === 'last-completed-session',
    );
    expect([...closedSession].sort()).toEqual([
      'eod_bar',
      'option_daily_snapshot',
      'underlying_iv_daily',
      'us_equity_bar',
    ]);
  });
});

describe('resolveAsOfForDimension — 准点行为零变化 (回归护栏)', () => {
  it('us 批 06:00 CST: 收盘口径与日历日口径**同值** ⇒ 改动前后逐点相同', () => {
    // 北京 2026-08-19 06:00 = 08-18T22:00Z = ET 08-18 18:00 (已收盘)。
    const cron0600 = new Date('2026-08-18T22:00:00Z');
    expect(
      resolveAsOfForDimension({ dimensionKey: 'us_equity_bar', marketScope: ['us'] }, cron0600),
    ).toBe('2026-08-18');
  });

  it('cn/hk 批 22:00 CST: 同值 ⇒ 逐点相同', () => {
    const cron2200 = new Date('2026-06-10T14:00:00Z'); // 北京 22:00
    expect(
      resolveAsOfForDimension({ dimensionKey: 'eod_bar', marketScope: ['cn', 'hk'] }, cron2200),
    ).toBe('2026-06-10');
  });

  it('周六 06:00 CST 的 us 批仍取 ET 周五 (每周固定丢周五那条护栏)', () => {
    // 北京 2026-06-13(六) 06:00 = 06-12T22:00Z = ET 06-12(五) 18:00。
    const sat = new Date('2026-06-12T22:00:00Z');
    expect(
      resolveAsOfForDimension({ dimensionKey: 'us_equity_bar', marketScope: ['us'] }, sat),
    ).toBe('2026-06-12');
  });
});

describe('resolveAsOfForDimension — 非准点时刻才是改动生效处', () => {
  it('🚨 #103: 美股盘中建锚 → 取上一场, 而不是尚未收盘的当日', () => {
    // 2026-08-19 00:13 CST = 08-18T16:13Z = ET 08-18 12:13 (盘中)。
    const intraday = new Date('2026-08-18T16:13:00Z');
    expect(
      resolveAsOfForDimension({ dimensionKey: 'us_equity_bar', marketScope: ['us'] }, intraday),
    ).toBe('2026-08-17');
  });

  it('misfire: cn 漏 22:00、次日 10:00 恢复 → 取漏掉的那天而非当日半根', () => {
    const recovery = new Date('2026-06-11T02:00:00Z'); // 北京 06-11 10:00, cn 早盘中
    expect(
      resolveAsOfForDimension({ dimensionKey: 'eod_bar', marketScope: ['cn', 'hk'] }, recovery),
    ).toBe('2026-06-10');
  });

  it('{cn,hk} 在北京 15:30 取最严 (hk 未收) → 前一日', () => {
    const at1530 = new Date('2026-06-10T07:30:00Z');
    expect(
      resolveAsOfForDimension({ dimensionKey: 'eod_bar', marketScope: ['cn', 'hk'] }, at1530),
    ).toBe('2026-06-09');
  });
});

describe('resolveAsOfForDimension — calendar-day 口径的维度不受影响', () => {
  it('universe (覆盖式快照, 空 scope) 仍取宿主日历日', () => {
    const intraday = new Date('2026-08-18T16:13:00Z'); // 北京 08-19 00:13
    expect(resolveAsOfForDimension({ dimensionKey: 'universe', marketScope: [] }, intraday)).toBe(
      '2026-08-19',
    );
  });

  it('option_contract 在盘中仍取 ET 当日 —— 它用业务日剔**已过期**到期日, 不是写行日期', () => {
    const intraday = new Date('2026-08-18T16:13:00Z'); // ET 08-18 12:13
    expect(
      resolveAsOfForDimension({ dimensionKey: 'option_contract', marketScope: ['us'] }, intraday),
    ).toBe('2026-08-18');
  });

  /**
   * 🚨 全景 IT (`marketdata.{trigger,backfill}-cli.it.spec.ts`) 抓出来的回归 —— 这条钉死它。
   *
   * `universe` / `profile` 的 scope **合法地**是 `{cn,hk,us}`, 而 us 与 cn/hk 一天里大半时间
   * 不在同一日历日 ⇒ 它们根本没有单一的「交易所今天」。在入口处抛会让一条
   * `--cascade universe` 命令在一天里大半时间**整条死掉**, 而改动前它一直能跑。
   */
  it('🚨 跨时区 scope ({cn,hk,us}) 回落宿主日, **不抛** —— 逐点恢复改动前的取值', () => {
    // 北京 06-11 06:00 = ET 06-10 18:00 ⇒ cn/hk 是 06-11 而 us 是 06-10, 三者不同日。
    const now = new Date('2026-06-10T22:00:00Z');
    const asOf = resolveAsOfForDimension(
      { dimensionKey: 'universe', marketScope: ['cn', 'hk', 'us'] },
      now,
    );
    expect(asOf).toBe('2026-06-11'); // = 旧实现的 shanghaiToday(now)
  });

  it('📌 但「别把 us 掺进 cn/hk 采集维度」的机器强制没丢 —— 它在采集本体那一侧', () => {
    // 入口宽松、采集本体严格: 后者直接调 exchangeCalendarDateForScope, 混 scope 照样抛,
    // 且错误直接指向真正出问题的采集路径。这里断言的是「入口不再是那道闸」。
    const now = new Date('2026-06-10T22:00:00Z');
    expect(() =>
      resolveAsOfForDimension({ dimensionKey: 'universe', marketScope: ['cn', 'us'] }, now),
    ).not.toThrow();
    expect(() => exchangeCalendarDateForScope(['cn', 'us'], now)).toThrow(/跨时区/);
  });

  it('未登记的维度键 → 回落 calendar-day (= 改动前行为), 不让一行陈旧配置炸掉整轮 tick', () => {
    const now = new Date('2026-06-10T14:00:00Z');
    expect(
      resolveAsOfForDimension({ dimensionKey: 'not_a_dimension', marketScope: ['cn'] }, now),
    ).toBe('2026-06-10');
  });
});
