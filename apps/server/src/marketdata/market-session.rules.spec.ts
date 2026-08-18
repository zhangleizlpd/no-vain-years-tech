import { describe, it, expect } from 'vitest';
import {
  isSessionRegistered,
  isSessionUnderway,
  isWithinTradingSession,
  marketNow,
} from './market-session.rules.js';

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
      expect(isSessionUnderway('cn', at(12))).toBe(true);
    });

    it('📌 hk 已合并单段 ⇒ 两谓词在它身上不再分道 (分道只剩 cn 一处)', () => {
      expect(isWithinTradingSession('hk', at(12, 30))).toBe(true);
      expect(isSessionUnderway('hk', at(12, 30))).toBe(true);
    });

    it('盘前 / 盘后判 false —— 那两段正是 premarket_backfill 与 eod 的合法取数窗', () => {
      expect(isSessionUnderway('cn', at(9, 29))).toBe(false); // 盘前
      expect(isSessionUnderway('cn', at(15, 1))).toBe(false); // 盘后
      expect(isSessionUnderway('hk', at(16, 1))).toBe(false);
      expect(isSessionUnderway('us', at(16, 1))).toBe(false);
    });

    it('首段开盘 / 末段收盘两个端点含在内', () => {
      expect(isSessionUnderway('cn', at(9, 30))).toBe(true);
      expect(isSessionUnderway('cn', at(15))).toBe(true);
      expect(isSessionUnderway('hk', at(9, 30))).toBe(true);
      expect(isSessionUnderway('hk', at(16))).toBe(true);
    });

    /**
     * 📌 **两谓词的分道如今只剩 `cn` 一个市场**: us 本就无午休, hk 已合并单段 ⇒ 它俩身上逐分钟
     * 等价。这条断言把这件事钉住 —— 谁把 hk 改回两段式, 这里第一个红, 逼他先回去读 FR-011。
     */
    it('📌 us / hk 均为单段 ⇒ 两个谓词在全天逐分钟等价 (分道只剩 cn)', () => {
      for (let m = 0; m < 24 * 60; m += 1) {
        expect(isSessionUnderway('us', m)).toBe(isWithinTradingSession('us', m));
        expect(isSessionUnderway('hk', m)).toBe(isWithinTradingSession('hk', m));
      }
    });
  });

  describe('未登记市场 —— 禁静默套用别人的时窗', () => {
    it('🚨 marketNow 抛', () => {
      expect(() => marketNow('sg', new Date('2026-06-09T02:00:00Z'))).toThrow(/未登记盘中时段/);
    });

    it('🚨 isSessionUnderway 同样抛 (fail-closed: 返 false 会放行写快照)', () => {
      expect(() => isSessionUnderway('sg', 600)).toThrow(/未登记盘中时段/);
    });

    it('isWithinTradingSession 保持既有的返 false 语义 (alert 侧行为原样)', () => {
      expect(isWithinTradingSession('sg', 600)).toBe(false);
    });

    it('isSessionRegistered 是唯一「未登记也不抛」的入口 (060 T005, FR-022 的显式跳过要它)', () => {
      expect(isSessionRegistered('sg')).toBe(false);
      for (const market of ['cn', 'us', 'hk']) expect(isSessionRegistered(market)).toBe(true);
    });
  });
});
