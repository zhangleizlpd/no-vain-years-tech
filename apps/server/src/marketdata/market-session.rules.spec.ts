import { describe, it, expect } from 'vitest';
import {
  closeSettleBufferMinutes,
  isCloseWriteBlocked,
  isSessionRegistered,
  isSessionUnderway,
  isWithinCloseSettleBuffer,
  isWithinTradingSession,
  marketNow,
  oiRefreshedAtEod,
  sessionCloseMinutes,
} from './market-session.rules.js';
import { isSessionComplete, sessionWatermark } from './session-clock.js';
import type { SessionKindStatus } from './trading-day.rules.js';

/** 当地当日分钟数字面量（与实现同口径，避免测试里再算一遍时区）。 */
const at = (hour: number, minute = 0) => hour * 60 + minute;

describe('market-session.rules — per-market 连续竞价时段表 (060 T001)', () => {
  describe('cn — 自 alert/intraday-eval.processor 原样搬来的回归断言', () => {
    it('marketNow(cn): UTC 02:00 → 上海 10:00 (date + 当日分钟)', () => {
      const { dateOnly, minutesOfDay } = marketNow('cn', new Date('2026-06-09T02:00:00Z'));
      expect(dateOnly).toBe('2026-06-09');
      expect(minutesOfDay).toBe(600);
    });

    it('marketNow(cn): UTC 16:00 → 跨日到上海次日 00:00', () => {
      const { dateOnly, minutesOfDay } = marketNow('cn', new Date('2026-06-09T16:00:00Z'));
      expect(dateOnly).toBe('2026-06-10');
      expect(minutesOfDay).toBe(0);
    });

    it('isWithinTradingSession(cn): 上午 [09:30,11:30] / 下午 [13:00,15:00] 含端点, 午休/盘后 false', () => {
      expect(isWithinTradingSession('cn', 570)).toBe(true); // 09:30 开盘
      expect(isWithinTradingSession('cn', 600)).toBe(true); // 10:00
      expect(isWithinTradingSession('cn', 690)).toBe(true); // 11:30 午收
      expect(isWithinTradingSession('cn', 720)).toBe(false); // 12:00 午休
      expect(isWithinTradingSession('cn', 780)).toBe(true); // 13:00 午开
      expect(isWithinTradingSession('cn', 900)).toBe(true); // 15:00 收盘
      expect(isWithinTradingSession('cn', 901)).toBe(false); // 15:01 盘后
      expect(isWithinTradingSession('cn', 569)).toBe(false); // 09:29 盘前
    });
  });

  describe('us — 本片新登记 (09:30–16:00 ET, 无午休)', () => {
    it('连续竞价 [09:30,16:00] 含端点, 盘前/盘后 false', () => {
      expect(isWithinTradingSession('us', at(9, 30))).toBe(true);
      expect(isWithinTradingSession('us', at(16))).toBe(true);
      expect(isWithinTradingSession('us', at(9, 29))).toBe(false);
      expect(isWithinTradingSession('us', at(16, 1))).toBe(false);
    });

    it('🚨 12:00 判 true —— 美股无午休, 别照 cn/hk 的两段式套过来', () => {
      expect(isWithinTradingSession('us', at(12))).toBe(true);
    });

    /**
     * 🚨 **走 `Intl` 而非手工偏移的唯一机器判据。** 同一个本地分钟数 (09:30 ET) 在冬令 (EST,
     * UTC-5) 与夏令 (EDT, UTC-4) 对应两个不同的 UTC 时刻; 手工 `now - 5h` 那种写法会让夏令
     * 那条算成 08:30 ⇒ **开盘那一格被判成盘前**, 而且只错在边界那一小时上, 不报错。
     */
    it('🚨 DST 前后同一本地分钟数判定一致 (EST 与 EDT 各一个时刻)', () => {
      const winter = marketNow('us', new Date('2026-01-15T14:30:00Z')); // EST: 09:30 ET
      const summer = marketNow('us', new Date('2026-07-15T13:30:00Z')); // EDT: 09:30 ET

      expect(winter).toEqual({ dateOnly: '2026-01-15', minutesOfDay: at(9, 30) });
      expect(summer).toEqual({ dateOnly: '2026-07-15', minutesOfDay: at(9, 30) });
      expect(isWithinTradingSession('us', winter.minutesOfDay)).toBe(true);
      expect(isWithinTradingSession('us', summer.minutesOfDay)).toBe(true);
    });
  });

  describe('hk — 单段 [09:30,16:00] HKT (午休蓄意不建模, 见 rules 文件 hk 登记处的注释)', () => {
    it('开收盘含端点; 午休判 true —— 「午休算场内」正是本简化的核心语义', () => {
      expect(isWithinTradingSession('hk', at(9, 29))).toBe(false); // 盘前
      expect(isWithinTradingSession('hk', at(9, 30))).toBe(true); // 开盘
      expect(isWithinTradingSession('hk', at(12))).toBe(true); // 港交所上午收
      expect(isWithinTradingSession('hk', at(12, 30))).toBe(true); // 午休正中 —— 单段下算场内
      expect(isWithinTradingSession('hk', at(13))).toBe(true); // 港交所午开
      expect(isWithinTradingSession('hk', at(16))).toBe(true); // 收盘
      expect(isWithinTradingSession('hk', at(16, 1))).toBe(false); // 盘后
    });

    it('marketNow(hk): HKT 恒 UTC+8 无 DST', () => {
      expect(marketNow('hk', new Date('2026-06-09T04:00:00Z'))).toEqual({
        dateOnly: '2026-06-09',
        minutesOfDay: at(12),
      });
    });
  });

  /**
   * 🚨 **本谓词与 {@link isWithinTradingSession} 的差别只在午休那一段, 而那正是 FR-011 的落点。**
   * 敏感档 (期权快照) 要的判据是「**该场收了没有**」而不是「此刻在不在连续竞价」—— 午休时后者
   * 返 `false`, 若拿它当闸就会放行, 把午休时刻的盘口贴上「上一场收盘」的标签写进库 (D4 表第三行
   * 的 `premarket_backfill` 分支)。那种错行不报错、按唯一键占位、当晚正确的行被挡掉。
   */
  describe('isSessionUnderway — 「该场进行中」(含午休), 敏感档的闸', () => {
    it('🚨 cn 午休: 与 isWithinTradingSession 结论相反 —— 这就是本谓词存在的理由', () => {
      expect(isWithinTradingSession('cn', at(12))).toBe(false);
      expect(isSessionUnderway('cn', at(12), 'unknown')).toBe(true);
    });

    it('📌 hk 已合并单段 ⇒ 两谓词在它身上不再分道 (分道只剩 cn 一处)', () => {
      expect(isWithinTradingSession('hk', at(12, 30))).toBe(true);
      expect(isSessionUnderway('hk', at(12, 30), 'unknown')).toBe(true);
    });

    it('盘前 / 盘后判 false —— 那两段正是 premarket_backfill 与 eod 的合法取数窗', () => {
      expect(isSessionUnderway('cn', at(9, 29), 'unknown')).toBe(false); // 盘前
      expect(isSessionUnderway('cn', at(15, 1), 'unknown')).toBe(false); // 盘后
      expect(isSessionUnderway('hk', at(16, 1), 'unknown')).toBe(false);
      expect(isSessionUnderway('us', at(16, 1), 'unknown')).toBe(false);
    });

    describe('🚨 半日市 (063 Phase 2) —— kind 决定收盘时刻', () => {
      it('hk 半日市 12:00 收: 港时 14:00 判**已收**, 而整天/未知都判进行中', () => {
        expect(isSessionUnderway('hk', at(14), 'half')).toBe(false);
        expect(isSessionUnderway('hk', at(14), 'whole')).toBe(true);
        // unknown ⇒ 回落常规时段 = 本片上线前的逐点行为 (fail-open, 少采一场下轮补上)。
        expect(isSessionUnderway('hk', at(14), 'unknown')).toBe(true);
        // 🚨 #187 后续: 收盘分钟本身**不再**算场内 (side="left") —— 它归收盘定稿缓冲管,
        //    写闸 `isCloseWriteBlocked` 在这一分钟仍拒绝, 故对采集路径行为不变。
        expect(isSessionUnderway('hk', at(12), 'half')).toBe(false);
        expect(isCloseWriteBlocked('hk', at(12), 'half')).toBe(true);
        expect(isSessionUnderway('hk', at(11, 59), 'half')).toBe(true);
      });

      it('🚨🚨 us 半日市取 **13:15 (期权收盘)** 而不是 13:00 (股票收盘)', () => {
        // 13:10 期权仍可成交 —— 若这里取了 13:00, 冷启动会在期权场内判「已收盘」去采快照,
        // 落进去的就是半根。本条是那个取值判据的钉子, 改成 13:00 立刻红。
        expect(isSessionUnderway('us', at(13, 10), 'half')).toBe(true);
        expect(isSessionUnderway('us', at(13, 14), 'half')).toBe(true);
        // 🚨 13:15 = 收盘分钟 ⇒ side="left" 下不算场内, 但**写闸仍拒**(定稿缓冲)。
        //    改成 13:00 (股票口径) 的话, 13:00–13:15 期权仍在成交却被判可写 ⇒ 本条立刻红。
        expect(isSessionUnderway('us', at(13, 15), 'half')).toBe(false);
        expect(isCloseWriteBlocked('us', at(13, 15), 'half')).toBe(true);
        expect(isCloseWriteBlocked('us', at(13, 14), 'half')).toBe(true);
        expect(isSessionUnderway('us', at(13, 16), 'half')).toBe(false);
      });

      it('cn 没登记半日市形态 ⇒ 即便日历说 half 也回落常规时段 (**不编一个出来**)', () => {
        // A 股除夕直接休市、不半开 ⇒ cn 的 `half` 只可能来自源侧错误。回落 = 安全侧。
        expect(isSessionUnderway('cn', at(14), 'half')).toBe(true);
        expect(isSessionUnderway('cn', at(15, 1), 'half')).toBe(false);
      });
    });

    it('🚨 区间为左闭右开: 开盘端点含在内, 收盘端点**不含** (side="left", #187 后续)', () => {
      // 分钟标签 `close` 代表 `[收盘, 收盘+1分钟)` —— 落在收盘**之后**, 故不算场内分钟。
      // 与 `session-clock.sessionWatermark` 的 `>= close ⇒ 已收` 同侧; 两侧的互补性由
      // 本文件「边界一致性」段逐 market × kind 钉住。
      expect(isSessionUnderway('cn', at(9, 30), 'unknown')).toBe(true);
      expect(isSessionUnderway('cn', at(15), 'unknown')).toBe(false);
      expect(isSessionUnderway('cn', at(14, 59), 'unknown')).toBe(true);
      expect(isSessionUnderway('hk', at(9, 30), 'unknown')).toBe(true);
      expect(isSessionUnderway('hk', at(16), 'unknown')).toBe(false);
      expect(isSessionUnderway('hk', at(15, 59), 'unknown')).toBe(true);
    });

    /**
     * 📌 **两谓词的分道如今只剩 `cn` 一个市场**: us 本就无午休, hk 已合并单段 ⇒ 它俩身上逐分钟
     * 等价。这条断言把这件事钉住 —— 谁把 hk 改回两段式, 这里第一个红, 逼他先回去读 FR-011。
     */
    it('📌 us / hk 均为单段 ⇒ 两个谓词除**收盘那一分钟**外全天逐分钟等价 (分道只剩 cn)', () => {
      // 🚨 #187 后续起两者刻意取不同侧: `isWithinTradingSession` 问「能不能成交」(收盘集合
      //    竞价就在收盘那一刻成交 ⇒ side="both"), `isSessionUnderway` 问「这一场收了没有」
      //    (归属口径 ⇒ side="left")。⇒ 收盘分钟必然分叉, 其余分钟仍等价。
      for (let m = 0; m < 24 * 60; m += 1) {
        if (m === sessionCloseMinutes('us', 'unknown')) {
          expect(isSessionUnderway('us', m, 'unknown')).toBe(false);
          expect(isWithinTradingSession('us', m)).toBe(true);
          expect(isSessionUnderway('hk', m, 'unknown')).toBe(false);
          expect(isWithinTradingSession('hk', m)).toBe(true);
          continue;
        }
        expect(isSessionUnderway('us', m, 'unknown')).toBe(isWithinTradingSession('us', m));
        expect(isSessionUnderway('hk', m, 'unknown')).toBe(isWithinTradingSession('hk', m));
      }
    });
  });

  describe('未登记市场 —— 禁静默套用别人的时窗', () => {
    it('🚨 marketNow 抛', () => {
      expect(() => marketNow('sg', new Date('2026-06-09T02:00:00Z'))).toThrow(/未登记盘中时段/);
    });

    it('🚨 isSessionUnderway 同样抛 (fail-closed: 返 false 会放行写快照)', () => {
      expect(() => isSessionUnderway('sg', 600, 'unknown')).toThrow(/未登记盘中时段/);
    });

    it('isWithinTradingSession 保持既有的返 false 语义 (alert 侧行为原样)', () => {
      expect(isWithinTradingSession('sg', 600)).toBe(false);
    });

    it('isSessionRegistered 是唯一「未登记也不抛」的入口 (060 T005, FR-022 的显式跳过要它)', () => {
      expect(isSessionRegistered('sg')).toBe(false);
      for (const market of ['cn', 'us', 'hk']) expect(isSessionRegistered(market)).toBe(true);
    });
  });

  describe('oiRefreshedAtEod — OI 定稿了没有 (066 T09, FR-016; 时刻化见 rules 文件注释)', () => {
    /** 2026-08-21 是周五、hk 常规交易日; 港股恒 UTC+8 无 DST ⇒ 偏移量写死安全。 */
    const HK_SESSION = '2026-08-21';
    const hkAt = (dayIso: string, hhmm: string) => new Date(`${dayIso}T${hhmm}:00+08:00`);

    it('hk: 定稿时刻 21:30 **含**端点 —— 实测窗口 16:30–21:30 取上界', () => {
      expect(oiRefreshedAtEod('hk', HK_SESSION, hkAt(HK_SESSION, '21:30'))).toBe(true);
      expect(oiRefreshedAtEod('hk', HK_SESSION, hkAt(HK_SESSION, '21:29'))).toBe(false);
    });

    it('🚨🚨 hk: 收盘后、定稿前采到的仍是**上一场**的 OI —— 本次修的就是这一格', () => {
      // 建锚冷启动由用户行为触发, 落点不受 cron 时刻约束。静态查表时这一刻答 true
      // ⇒ 把 D−1 的持仓量标成 D, 数字与标签双错; 且 skipDuplicates 会让当晚 23:30
      // 那轮正确的写入被静默跳过 —— 那一场的 OI 从此拿不回来。
      expect(oiRefreshedAtEod('hk', HK_SESSION, hkAt(HK_SESSION, '16:05'))).toBe(false);
      expect(oiRefreshedAtEod('hk', HK_SESSION, hkAt(HK_SESSION, '17:00'))).toBe(false);
      // 而夜间 cron (23:30) 恒在定稿之后 —— 那条路的取值**逐点不变**
      expect(oiRefreshedAtEod('hk', HK_SESSION, hkAt(HK_SESSION, '23:30'))).toBe(true);
    });

    it('🚨 hk: 已跨过 session 那天 ⇒ 恒 true, **不比分钟数**', () => {
      // 只比当日分钟数会把这两种情形全判成「未定稿」(01:30 / 10:00 都 < 21:30),
      // 而它们早已过了定稿时刻。#181 的长链正是被挤过午夜的。
      expect(oiRefreshedAtEod('hk', HK_SESSION, hkAt('2026-08-22', '01:30'))).toBe(true);
      // 周六补采上一场 (境内用户建锚的高发时段)
      expect(oiRefreshedAtEod('hk', HK_SESSION, hkAt('2026-08-22', '10:00'))).toBe(true);
    });

    it('🚨 us = false 恒真 —— 清算所 T+1 才发布 (分叉是增量, 美股逐点不变)', () => {
      for (const hhmm of ['16:05', '21:30', '23:30']) {
        expect(oiRefreshedAtEod('us', HK_SESSION, hkAt(HK_SESSION, hhmm))).toBe(false);
      }
      expect(oiRefreshedAtEod('us', HK_SESSION, hkAt('2026-08-22', '10:00'))).toBe(false);
    });

    it('cn = false —— 期权采集未开通, 未实测过的市场一律保守取 null', () => {
      expect(oiRefreshedAtEod('cn', HK_SESSION, hkAt('2026-08-22', '10:00'))).toBe(false);
    });

    it('🚨 未登记市场返 false 而**不抛** —— 与 marketNow/isSessionUnderway 蓄意不同', () => {
      // 那两个的返回值是判据, 静默套用别市场的时窗会写出脏行 ⇒ fail-closed 抛。
      // 本表的保守值只让标签偏早一天, 一条确定性 UPDATE 可订正 (FR-016 的不对称性)
      // ⇒ 为一个 OI 标签把整轮采集炸掉, 方向反了。
      const now = hkAt('2026-08-22', '10:00');
      expect(oiRefreshedAtEod('sg', HK_SESSION, now)).toBe(false);
      expect(() => oiRefreshedAtEod('sg', HK_SESSION, now)).not.toThrow();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🚨 边界一致性 —— 本段是「两张表在收盘那一分钟打架」的**防复发闸**（#187 后续）
//
// 病史：`session-clock.sessionWatermark` 用 `>= close ⇒ 已收`（业内的 side="left"），而本文件
// 的 `isSessionUnderway` 曾用闭区间 `[open, close]`（side="both"）⇒ 收盘那一分钟，两者对**同一
// 个时刻**给出相反答案。归属判据同时消费两者，合成出一轮无来由的 skip；而没有任何断言会红
// —— 两边各自的单测都只测自己那一侧，恰好各自都「对」。
//
// ⇒ 本段断言的不是任一侧的取值，而是**两侧的关系**。改任一张表的收盘时刻或区间符号，这里必红。
// ─────────────────────────────────────────────────────────────────────────────
describe('🚨 边界一致性: market-session 与 session-clock 在收盘分钟必须同侧', () => {
  /** 现役市场 × kind 全组合（cn 无半日市形态 ⇒ half 回落常规，同样要覆盖）。 */
  const CASES: { market: string; kind: SessionKindStatus }[] = [
    { market: 'cn', kind: 'whole' },
    { market: 'cn', kind: 'half' },
    { market: 'cn', kind: 'unknown' },
    { market: 'hk', kind: 'whole' },
    { market: 'hk', kind: 'half' },
    { market: 'hk', kind: 'unknown' },
    { market: 'us', kind: 'whole' },
    { market: 'us', kind: 'half' },
    { market: 'us', kind: 'unknown' },
  ];

  /** 该市场当地 `minutesOfDay` 那一刻的绝对时刻（取一个已知交易日，日期本身不参与断言）。 */
  function instantAt(market: string, minutesOfDay: number): Date {
    // 2026-06-10 是周三。逐分钟扫当天 UTC，找到该市场当地分钟数吻合的那一刻。
    for (let utcMin = 0; utcMin < 48 * 60; utcMin++) {
      const d = new Date(Date.UTC(2026, 5, 10, 0, utcMin));
      if (marketNow(market, d).minutesOfDay === minutesOfDay) return d;
    }
    throw new Error(`找不到 ${market} 当地 ${minutesOfDay} 分的时刻`);
  }

  it.each(CASES)(
    '$market/$kind: 收盘分钟 —— watermark 说「已收」∧ isSessionUnderway 说「不在场内」(两侧同为 left)',
    ({ market, kind }) => {
      const close = sessionCloseMinutes(market, kind);
      expect(close).toBeDefined();
      const atClose = instantAt(market, close as number);
      const today = marketNow(market, atClose).dateOnly;

      // ① 时钟层: 收盘分钟起算「今天已收」
      expect(sessionWatermark(market, atClose, kind)).toBe(today);
      expect(isSessionComplete(market, today, atClose, kind)).toBe(true);
      // ② 时段层: 同一分钟**不**算场内 —— 这就是 side="left"
      expect(isSessionUnderway(market, close as number, kind)).toBe(false);
      // ③ 互补性: 两者对同一时刻的答案必须相反。这一条才是防复发的核心。
      expect(isSessionUnderway(market, close as number, kind)).toBe(
        !isSessionComplete(market, today, atClose, kind),
      );
    },
  );

  it.each(CASES)(
    '$market/$kind: 收盘前一分钟 —— 反向同样成立 (场内 ∧ 未收)',
    ({ market, kind }) => {
      const close = sessionCloseMinutes(market, kind) as number;
      const atLast = instantAt(market, close - 1);
      const today = marketNow(market, atLast).dateOnly;

      expect(isSessionUnderway(market, close - 1, kind)).toBe(true);
      expect(isSessionComplete(market, today, atLast, kind)).toBe(false);
    },
  );

  it('收盘时刻表只有一份: sessionCloseMinutes 逐点等于 session-clock 删掉的那张表', () => {
    // 🚨 这不是重复断言 —— 它钉住 P0-1 的**搬运保真**: 两张表合并前后取值必须逐点相同,
    //    否则「单源化」会顺手改掉一个市场的收盘时刻而无人察觉。
    expect(sessionCloseMinutes('cn', 'whole')).toBe(15 * 60);
    expect(sessionCloseMinutes('hk', 'whole')).toBe(16 * 60);
    expect(sessionCloseMinutes('us', 'whole')).toBe(16 * 60);
    expect(sessionCloseMinutes('hk', 'half')).toBe(12 * 60);
    expect(sessionCloseMinutes('us', 'half')).toBe(13 * 60 + 15); // 期权口径, 非股票 13:00
    // cn 没有半日市形态 ⇒ 回落常规收盘, **不编一个出来**
    expect(sessionCloseMinutes('cn', 'half')).toBe(15 * 60);
    // 未登记市场返 undefined（由 session-clock 自己 fail-open 兜底, 极性刻意不同）
    expect(sessionCloseMinutes('xx', 'whole')).toBeUndefined();
  });
});

describe('🚨 收盘定稿缓冲 —— 从「闭区间的副作用」拆成显式参数 (#187 后续 P0-3)', () => {
  it('缓冲默认 1 分钟 = 拆出来之前的等效值 ⇒ 未分叉的市场行为逐点不变', () => {
    // 🚨 us 留在默认值上是**有理由的空缺**, 不是漏填: 美股收盘竞价的官方价何时进到本供应方
    // 的快照里没实测过。别照着 hk 编一个 (rules 文件 CLOSE_SETTLE_BUFFER_MINUTES 注释)。
    for (const market of ['cn', 'us']) {
      expect(closeSettleBufferMinutes(market)).toBe(1);
    }
  });

  it('🚨 hk = 10 分钟 —— HKEX CAS 16:08–16:10 随机收市, 官方收盘价最早 16:10 才存在', () => {
    expect(closeSettleBufferMinutes('hk')).toBe(10);

    const close = sessionCloseMinutes('hk', 'whole') as number;
    // 16:01 (旧 buffer=1 的放行点) 到 16:09 全程仍拒写 —— 这一段落库的 underlying_spot
    // 会是**竞价撮合前**的最后成交价, 而它被实值/虚值分类、快照硬门、选约表 spot 三处读。
    for (let m = close + 1; m <= close + 9; m++) {
      expect(isCloseWriteBlocked('hk', m, 'whole')).toBe(true);
    }
    expect(isCloseWriteBlocked('hk', close + 10, 'whole')).toBe(false);
  });

  it('🚨 hk 半日市同样 10 —— CAS 整体平移到 12:00–12:10, 按 market 取值即可, 不按 kind 分叉', () => {
    const halfClose = sessionCloseMinutes('hk', 'half') as number;
    expect(halfClose).toBe(at(12));
    expect(isCloseWriteBlocked('hk', halfClose + 9, 'half')).toBe(true);
    expect(isCloseWriteBlocked('hk', halfClose + 10, 'half')).toBe(false);
  });

  it.each([
    { market: 'cn', kind: 'whole' as SessionKindStatus },
    { market: 'hk', kind: 'whole' as SessionKindStatus },
    { market: 'hk', kind: 'half' as SessionKindStatus },
    { market: 'us', kind: 'whole' as SessionKindStatus },
    { market: 'us', kind: 'half' as SessionKindStatus },
  ])(
    '$market/$kind: isCloseWriteBlocked = [open, close+buffer) —— 端点取值由 buffer 派生',
    ({ market, kind }) => {
      const close = sessionCloseMinutes(market, kind) as number;
      const buffer = closeSettleBufferMinutes(market);

      // 收盘分钟: 不在场内, 但在缓冲窗内 ⇒ 仍然**不许写** (= 改造前 `[open, close]` 的取值)
      expect(isSessionUnderway(market, close, kind)).toBe(false);
      expect(isWithinCloseSettleBuffer(market, close, kind)).toBe(true);
      expect(isCloseWriteBlocked(market, close, kind)).toBe(true);

      // 缓冲窗结束后的第一分钟 ⇒ 放行
      expect(isCloseWriteBlocked(market, close + buffer, kind)).toBe(false);
      // 收盘前一分钟 ⇒ 场内, 自然也不许写
      expect(isCloseWriteBlocked(market, close - 1, kind)).toBe(true);
    },
  );

  it.each(['us', 'hk'])('🚨 %s: 缓冲与场内**严格互补且相邻**: 两段不重叠、不留缝', (market) => {
    const close = sessionCloseMinutes(market, 'whole') as number;
    // 扫到 close+13 才能覆盖 hk 的 10 分钟缓冲并越过它的右端点
    for (let m = close - 3; m <= close + 13; m++) {
      const underway = isSessionUnderway(market, m, 'whole');
      const inBuffer = isWithinCloseSettleBuffer(market, m, 'whole');
      // 同一分钟不可能既「场内」又「在缓冲窗」—— 重叠意味着两段各自的语义已经糊了
      expect(underway && inBuffer).toBe(false);
      // 并集恰好是写闸
      expect(isCloseWriteBlocked(market, m, 'whole')).toBe(underway || inBuffer);
    }
  });

  it('未登记市场一律抛 (fail-closed) —— 每个 false 都意味着「可以写」', () => {
    expect(() => isSessionUnderway('xx', 600, 'whole')).toThrow(/未登记盘中时段/);
    expect(() => isWithinCloseSettleBuffer('xx', 600, 'whole')).toThrow(/未登记盘中时段/);
    expect(() => isCloseWriteBlocked('xx', 600, 'whole')).toThrow(/未登记盘中时段/);
  });
});
