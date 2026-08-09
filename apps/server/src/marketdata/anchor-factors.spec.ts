import { describe, it, expect } from 'vitest';
import { parseCurrencyEquivalent, pickPerExDate } from './anchor-factors.js';

// 全部取自 prod 真实 content（2026-08-01 直查）。外币宣派的港股占 needs_review 的 87%，
// 结构化 dividend 只给原币、港币等值埋在 content 括号里 —— 不解析 = 这些标的整段不复权。
describe('parseCurrencyEquivalent — 从 content 提交易币种等值', () => {
  const cases: Array<[string, string, string | null]> = [
    ['末期息CNY 0.11(HKD 0.119708)', 'HKD', '0.119708'],
    ['末期息CNY 0.0354(相当于CNY 0.04)', 'HKD', null], // 括号里是 CNY 不是 HKD → 不猜
    ['特别股息CNY 2.1366(相当于HKD 2.553)(可选择CNY或HKD)', 'HKD', '2.553'],
    ['中期(半年期)息AUD 0.5271(HKD 2.9087)(记录日期: 2022/09/06)', 'HKD', '2.9087'],
    ['末期息SGD 0.00075(HKD 0.0041505)', 'HKD', '0.0041505'],
    ['末期息HKD 0.01', 'HKD', null], // 无括号等值（本就是本币, 走结构化字段）
    ['', 'HKD', null],
  ];
  for (const [content, ccy, want] of cases) {
    it(`${content.slice(0, 34) || '(空)'} → ${want ?? 'null'}`, () => {
      const got = parseCurrencyEquivalent(content, ccy);
      if (want === null) expect(got).toBeNull();
      else expect(got!.toString()).toBe(want);
    });
  }

  it('🚨 「每N股」必须归一 —— 结构化 dividend 已是每股, 括号里仍是每 N 股口径', () => {
    // vendor: 末期息每10股CNY 2.2 → dividend 字段 0.22（已归一）; 括号 每10股HKD 2.503
    expect(parseCurrencyEquivalent('末期息每10股CNY 2.2(每10股HKD 2.503)', 'HKD')!.toString()).toBe(
      '0.2503',
    );
    expect(
      parseCurrencyEquivalent('末期息每10股CNY 7.00(每10股HKD 7.633)', 'HKD')!.toString(),
    ).toBe('0.7633');
  });

  it('不归一会放大 10 倍 —— 比不换算更危险, 故本条是硬钉子', () => {
    const v = parseCurrencyEquivalent('末期息每10股CNY 2.2(每10股HKD 2.503)', 'HKD')!;
    expect(v.lessThan(1)).toBe(true);
    expect(v.toString()).not.toBe('2.503');
  });

  it('全角括号同样识别', () => {
    expect(parseCurrencyEquivalent('末期息CNY 0.11（HKD 0.119708）', 'HKD')!.toString()).toBe(
      '0.119708',
    );
  });
});

// ── 同 exDate 多行的确定性选择 ────────────────────────────────────────────────
//
// adapter 已按 exDate 聚合, 正常每日一行。但聚合后 type 可能翻转 (某日同时有派息与送股 →
// 整个事件判 split), 而自然键含 type ⇒ upsert 打到新键、旧 type 行成孤儿留在库里。
// prod 实测 1 例 (cn 600188 2023-07-17: 陈旧 dividend 1.23 与新 split 4.30 并存)。
// 不做确定性选择时 Map 是「后写覆盖」, 取哪行取决于 findMany 返回顺序 —— 同一份数据可能
// 算出两个不同因子。
describe('pickPerExDate — 同 exDate 多行取权威那行', () => {
  const D = (s: string) => new Date(`${s}T00:00:00Z`);
  const stale = { id: 1n, exDate: D('2023-07-17'), payload: { dividend: 1.23 } };
  const fresh = { id: 2n, exDate: D('2023-07-17'), payload: { dividend: 4.3, rows: [{}, {}] } };

  it('🚨 优先带 rows 的聚合行 —— 与输入顺序无关', () => {
    expect(pickPerExDate([stale, fresh])).toEqual([fresh]);
    expect(pickPerExDate([fresh, stale])).toEqual([fresh]); // 顺序反过来结果必须相同
  });

  it('判据是「是否聚合」而非「金额谁大」—— vendor 下调金额时按金额会选错', () => {
    const freshSmaller = {
      id: 2n,
      exDate: D('2023-07-17'),
      payload: { dividend: 0.5, rows: [{}] },
    };
    expect(pickPerExDate([stale, freshSmaller])).toEqual([freshSmaller]);
  });

  it('都带 / 都不带 → 按 id 取大（后写那行），仍确定', () => {
    const a = { id: 1n, exDate: D('2024-01-02'), payload: { dividend: 1 } };
    const b = { id: 9n, exDate: D('2024-01-02'), payload: { dividend: 2 } };
    expect(pickPerExDate([a, b])).toEqual([b]);
    expect(pickPerExDate([b, a])).toEqual([b]);
  });

  it('不同 exDate 各自保留', () => {
    const a = { id: 1n, exDate: D('2024-01-02'), payload: {} };
    const b = { id: 2n, exDate: D('2024-06-03'), payload: {} };
    expect(pickPerExDate([a, b])).toHaveLength(2);
  });
});
