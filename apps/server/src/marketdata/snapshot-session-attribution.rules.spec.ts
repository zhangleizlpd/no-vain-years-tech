import { describe, it, expect } from 'vitest';
import { resolveSnapshotAttribution } from './snapshot-session-attribution.rules.js';

/**
 * 快照归属判据 单测（#181, Small —— 纯函数零 I/O）。
 *
 * 🚨 本文件盯的是「**盲写会踩、且踩了不会红**」的那一类：这套判据错了不报错，只让
 * `session_date` 差一天，而它进唯一键、`createMany(skipDuplicates)` 不可逆。
 *
 * 时刻一律用 UTC 构造再换算到港股当地（UTC+8），避免测试跟着运行机时区走。
 * 港股 session 09:30–16:00；2026-08-21 五 / 08-22 六 / 08-24 一 / 08-25 二。
 */

/** 港股当地时刻 → Date（HKT = UTC+8，无 DST）。 */
const hkt = (localIso: string) => new Date(`${localIso}+08:00`);

/** 美东当地时刻 → Date（2026-08 在 DST 内 ⇒ ET = UTC-4）。 */
const et = (localIso: string) => new Date(`${localIso}-04:00`);

const base = {
  market: 'hk',
  todayKind: 'whole' as const,
};

describe('resolveSnapshotAttribution', () => {
  describe('🚨 盘中拒绝 —— 端点此刻返的是盘中态，不是任何 session 的收盘价', () => {
    it('该场进行中 ∧ 今天是交易日 → skip(session_underway)', () => {
      // 08-24 周一 11:00 HKT，港股盘中。此刻采到的是**盘中报价**，落成任何 session 的
      // 「收盘」都是错的 —— 而错了不报错，只是数字不对。
      const r = resolveSnapshotAttribution({
        ...base,
        now: hkt('2026-08-24T11:00:00'),
        lastClosedTradingDay: '2026-08-21',
        todayIsTradingDay: true,
        tradingDayBeforeTarget: '2026-08-20',
      });
      expect(r).toEqual({ decision: 'skip', reason: 'session_underway' });
    });

    it('🚨 场内钟点但**今天不是交易日**（周六）→ MUST NOT skip', () => {
      // `isSessionUnderway` 是**纯时钟**谓词，不看星期也不看日历 ⇒ 周六 11:00 它照样返 true。
      // 少了 `todayIsTradingDay` 这一格，周末就永远采不到上一场的收盘（而那正是周末建锚
      // 唯一能拿到的东西），且**不报错**。
      const r = resolveSnapshotAttribution({
        ...base,
        now: hkt('2026-08-22T11:00:00'),
        lastClosedTradingDay: '2026-08-21',
        todayIsTradingDay: false,
        tradingDayBeforeTarget: '2026-08-20',
      });
      expect(r.decision).toBe('collect');
    });
  });

  describe('归属四行表', () => {
    it('① 日历查不到上一个已收盘交易日 → abandon，不猜', () => {
      const r = resolveSnapshotAttribution({
        ...base,
        now: hkt('2026-08-24T23:30:00'),
        lastClosedTradingDay: null,
        todayIsTradingDay: true,
        tradingDayBeforeTarget: null,
      });
      expect(r).toEqual({ decision: 'abandon', reason: 'calendar_missing' });
    });

    it('🚨 ② 仍在目标 session 收盘当日的盘后（23:30）→ eod，但 hk 的 oiAsOf = **当天**', () => {
      // 066 T09：这一格就是 U2 实测推翻的那一格。hk 的 OI 在 D 日 16:30–21:30 之间就已定稿
      // （360 行样本里跨 22:00 日终那一拍 0/30 变动），而本轮跑在 23:30 ⇒ 抓到的就是 D 的真值。
      // 🚨 `mode` 仍是 `eod` —— 分叉只动 OI 归属，不动「捕捉的是哪一场收盘」那个标签。
      const r = resolveSnapshotAttribution({
        ...base,
        now: hkt('2026-08-24T23:30:00'),
        lastClosedTradingDay: '2026-08-24',
        todayIsTradingDay: true,
        tradingDayBeforeTarget: '2026-08-21',
      });
      expect(r).toMatchObject({
        decision: 'collect',
        spec: { sessionDate: '2026-08-24', mode: 'eod', marketScope: ['hk'] },
        oiAsOf: '2026-08-24',
      });
    });

    it('🚨 ③ 已跨进下一交易日盘前（01:30）→ 仍归**上一个已收盘 session**，premarket_backfill', () => {
      // 这一格就是 #181 的病灶：`exchangeCalendarDate` 在 00:00 翻页，会把这批数据标成
      // 08-25（一个还没开盘的 session）。归属必须跟「哪一场收了」走，不跟日历日走。
      const r = resolveSnapshotAttribution({
        ...base,
        now: hkt('2026-08-25T01:30:00'),
        lastClosedTradingDay: '2026-08-24',
        todayIsTradingDay: true,
        tradingDayBeforeTarget: '2026-08-21',
      });
      expect(r).toMatchObject({
        decision: 'collect',
        spec: { sessionDate: '2026-08-24', mode: 'premarket_backfill' },
        // 已进下一交易日盘前 ⇒ 目标 session 的 OI 已翻新，此刻抓到的就是它的真值。
        oiAsOf: '2026-08-24',
      });
    });

    it('④ 跨进的是**非**交易日（周六）→ 走 eod 而非 premarket_backfill；hk 的 oiAsOf 仍是周五', () => {
      // 周末不翻新 ⇒ `mode` 保持 eod（这一格不受 066 T09 影响）。
      // 但 hk 的 OI 早在周五傍晚就定稿了 ⇒ 周六抓到的就是**周五自己的** OI，不是周四的。
      // 📌 U2 的周六基线拍正是这一格的实证：08-22 22:05 那拍的 vendor 更新时刻是 08-21 15:59。
      const r = resolveSnapshotAttribution({
        ...base,
        now: hkt('2026-08-22T09:00:00'),
        lastClosedTradingDay: '2026-08-21',
        todayIsTradingDay: false,
        tradingDayBeforeTarget: '2026-08-20',
      });
      expect(r).toMatchObject({
        decision: 'collect',
        spec: { sessionDate: '2026-08-21', mode: 'eod' },
        oiAsOf: '2026-08-21',
      });
    });
  });

  describe('spec 的其余字段', () => {
    it('now 原样带过（DTE 基准要绝对时刻，拿 sessionDate 当基准会系统性偏一天）', () => {
      const now = hkt('2026-08-25T01:30:00');
      const r = resolveSnapshotAttribution({
        ...base,
        now,
        lastClosedTradingDay: '2026-08-24',
        todayIsTradingDay: true,
        tradingDayBeforeTarget: '2026-08-21',
      });
      expect(r.decision === 'collect' && r.spec.now).toBe(now);
    });

    it('🚨 hk 的 oiAsOf 不再读 tradingDayBeforeTarget —— 缺行也照给当天，不落 null', () => {
      // 066 T09 的连带效果：hk 收盘当晚那条路径压根不查上一交易日 ⇒ 日历缺更早的行对它无影响。
      // 「缺行 → null」这条语义只对仍走隔日口径的市场成立，见下面的 us 块。
      const r = resolveSnapshotAttribution({
        ...base,
        now: hkt('2026-08-24T23:30:00'),
        lastClosedTradingDay: '2026-08-24',
        todayIsTradingDay: true,
        tradingDayBeforeTarget: null,
      });
      expect(r).toMatchObject({ decision: 'collect', oiAsOf: '2026-08-24' });
    });
  });

  /**
   * 🚨 066 T09 verify ②：**分叉是增量，不是改写**。
   *
   * 下面每一条都是分叉**之前**就成立的取值，逐点原样保留。这一块的价值全在「改坏了会红」——
   * 若哪天有人把 `oiRefreshedAtEod` 也给 us 设成 `true`（或把两条路径抹平），这里立刻红。
   */
  describe('美股逐点不变 —— 清算所 T+1 才发布，收盘当晚抓到的 OI 属于上一场', () => {
    const usBase = { market: 'us', todayKind: 'whole' as const };

    it('us 收盘当晚（18:00 ET）→ eod，oiAsOf = **上一交易日**（与 hk 分叉后的答案相反）', () => {
      const r = resolveSnapshotAttribution({
        ...usBase,
        now: et('2026-08-24T18:00:00'),
        lastClosedTradingDay: '2026-08-24',
        todayIsTradingDay: true,
        tradingDayBeforeTarget: '2026-08-21',
      });
      expect(r).toMatchObject({
        decision: 'collect',
        spec: { sessionDate: '2026-08-24', mode: 'eod', marketScope: ['us'] },
        oiAsOf: '2026-08-21',
      });
    });

    it('us 次日盘前（06:00 ET）→ premarket_backfill，oiAsOf = 被补那天', () => {
      const r = resolveSnapshotAttribution({
        ...usBase,
        now: et('2026-08-25T06:00:00'),
        lastClosedTradingDay: '2026-08-24',
        todayIsTradingDay: true,
        tradingDayBeforeTarget: '2026-08-21',
      });
      expect(r).toMatchObject({
        decision: 'collect',
        spec: { sessionDate: '2026-08-24', mode: 'premarket_backfill' },
        oiAsOf: '2026-08-24',
      });
    });

    it('🚨 us 两条路径的 oiAsOf MUST NOT 抹平 —— 同一个 target，答案必须差一天', () => {
      const args = {
        ...usBase,
        lastClosedTradingDay: '2026-08-24',
        todayIsTradingDay: true,
        tradingDayBeforeTarget: '2026-08-21',
      };
      const eod = resolveSnapshotAttribution({ ...args, now: et('2026-08-24T18:00:00') });
      const pre = resolveSnapshotAttribution({ ...args, now: et('2026-08-25T06:00:00') });
      expect(eod.decision === 'collect' && eod.oiAsOf).not.toBe(
        pre.decision === 'collect' && pre.oiAsOf,
      );
    });

    it('us 的 tradingDayBeforeTarget 缺行 → oiAsOf 落 null，采集照常（兜底只该有一处）', () => {
      const r = resolveSnapshotAttribution({
        ...usBase,
        now: et('2026-08-24T18:00:00'),
        lastClosedTradingDay: '2026-08-24',
        todayIsTradingDay: true,
        tradingDayBeforeTarget: null,
      });
      expect(r).toMatchObject({ decision: 'collect', oiAsOf: null });
    });
  });
});
