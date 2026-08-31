import { describe, expect, it } from 'vitest';
import {
  ANCHOR_SUBMISSION_ASOF_FLAGS,
  asofNeedsAcknowledgement,
  classifyAsof,
  resolveDisposition,
  type AnchorSubmissionAsofFlag,
} from './anchor-submission.rules';

describe('classifyAsof — 五档 asof 可信度 (072)', () => {
  it('过去的交易日 → OK', () => {
    expect(
      classifyAsof({ asof: '2026-08-28', exchangeToday: '2026-08-31', calendarStatus: 'trading' }),
    ).toBe('OK');
  });

  it('就是交易所今天 → TODAY (warning 档, 不阻断)', () => {
    expect(
      classifyAsof({ asof: '2026-08-31', exchangeToday: '2026-08-31', calendarStatus: 'trading' }),
    ).toBe('TODAY');
  });

  it('晚于交易所今天 → FUTURE (那天的收盘价还不存在)', () => {
    expect(
      classifyAsof({ asof: '2026-09-01', exchangeToday: '2026-08-31', calendarStatus: 'trading' }),
    ).toBe('FUTURE');
  });

  it('日历说不开市 → NON_TRADING —— 周末与节假日同一档 (shell 版盖不住节假日)', () => {
    expect(
      classifyAsof({
        asof: '2026-08-29',
        exchangeToday: '2026-08-31',
        calendarStatus: 'non-trading',
      }),
    ).toBe('NON_TRADING');
  });

  // 🚨 这条是整个文件里最要紧的一发。折成 OK 就是把「日历缺行」静默判成「这天没问题」,
  //    而调用方据此放行 = 替日历做主。TradingDayStatus 三态的立意就是这个。
  it('日历不可判定 → UNKNOWN, MUST NOT 折进 OK', () => {
    const flag = classifyAsof({
      asof: '2026-08-28',
      exchangeToday: '2026-08-31',
      calendarStatus: 'unknown',
    });
    expect(flag).toBe('UNKNOWN');
    expect(flag).not.toBe('OK');
  });

  describe('优先级 (顺序即语义, 不可折叠)', () => {
    it('未来 ∧ 非交易日 → FUTURE 胜出 (收盘价不存在是更根本的理由)', () => {
      expect(
        classifyAsof({
          asof: '2026-09-05',
          exchangeToday: '2026-08-31',
          calendarStatus: 'non-trading',
        }),
      ).toBe('FUTURE');
    });

    it('今天 ∧ 非交易日 → NON_TRADING 胜出 (比 TODAY 更有信息量)', () => {
      expect(
        classifyAsof({
          asof: '2026-08-31',
          exchangeToday: '2026-08-31',
          calendarStatus: 'non-trading',
        }),
      ).toBe('NON_TRADING');
    });

    it('未来 ∧ 日历不可判定 → FUTURE 胜出', () => {
      expect(
        classifyAsof({
          asof: '2026-09-05',
          exchangeToday: '2026-08-31',
          calendarStatus: 'unknown',
        }),
      ).toBe('FUTURE');
    });
  });

  // 「今天」是**喂进来的**, 不在本文件里算 —— 这条断言钉的就是这件事:
  // 同一个 asof 在两个市场的当地今天下必须给出不同的答案 (美东尚未跨日 / 港股已跨日 那类)。
  it('同一 asof + 不同交易所今天 → 不同档 (本文件绝不自己算时区)', () => {
    const asof = '2026-08-31';
    expect(classifyAsof({ asof, exchangeToday: '2026-08-31', calendarStatus: 'trading' })).toBe(
      'TODAY',
    );
    expect(classifyAsof({ asof, exchangeToday: '2026-08-30', calendarStatus: 'trading' })).toBe(
      'FUTURE',
    );
  });
});

describe('asofNeedsAcknowledgement — fail-closed 闸的判据单点', () => {
  it('FUTURE / NON_TRADING / UNKNOWN 三档要显式确认', () => {
    expect(asofNeedsAcknowledgement('FUTURE')).toBe(true);
    expect(asofNeedsAcknowledgement('NON_TRADING')).toBe(true);
    expect(asofNeedsAcknowledgement('UNKNOWN')).toBe(true);
  });

  // TODAY 若进闸, 每天正常提交的那一批全部要人多点一次, 而服务端并没有多知道一点东西。
  it('OK / TODAY 直接放行', () => {
    expect(asofNeedsAcknowledgement('OK')).toBe(false);
    expect(asofNeedsAcknowledgement('TODAY')).toBe(false);
  });

  // 穷尽闸: 加了第六档却忘了归类 → 本条红。
  it('每一档都被显式归类 (值域穷尽)', () => {
    const classified = ANCHOR_SUBMISSION_ASOF_FLAGS.filter((f: AnchorSubmissionAsofFlag) =>
      asofNeedsAcknowledgement(f),
    );
    expect(classified).toEqual(['FUTURE', 'NON_TRADING', 'UNKNOWN']);
    expect(ANCHOR_SUBMISSION_ASOF_FLAGS).toHaveLength(5);
  });
});

describe('resolveDisposition', () => {
  it('锚表没有该 ticker → create', () => {
    expect(resolveDisposition(false)).toBe('create');
  });

  it('锚表已有该 ticker → refresh (会冲人工位, 不是更温和的 create)', () => {
    expect(resolveDisposition(true)).toBe('refresh');
  });
});
