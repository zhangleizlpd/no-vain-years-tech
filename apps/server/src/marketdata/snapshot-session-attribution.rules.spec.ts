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

    it('② 仍在目标 session 收盘当日的盘后（23:30）→ eod，oiAsOf = 上一交易日', () => {
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
        oiAsOf: '2026-08-21',
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

    it('④ 跨进的是**非**交易日（周六）→ OI 未翻新，走 eod 而非 premarket_backfill', () => {
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
        oiAsOf: '2026-08-20',
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

    it('tradingDayBeforeTarget 缺行 → oiAsOf 落 null，采集照常（兜底只该有一处）', () => {
      const r = resolveSnapshotAttribution({
        ...base,
        now: hkt('2026-08-24T23:30:00'),
        lastClosedTradingDay: '2026-08-24',
        todayIsTradingDay: true,
        tradingDayBeforeTarget: null,
      });
      expect(r).toMatchObject({ decision: 'collect', oiAsOf: null });
    });
  });
});
