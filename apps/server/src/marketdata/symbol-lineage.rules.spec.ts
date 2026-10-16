// 086 T002 —— 连续身份规则 (plan D2) 的 Small 单测: 纯函数、零 I/O。
// 日期一律 'YYYY-MM-DD' (交易所当地日历日, 与 daily_bar.trade_date 同轴)。代码为合成值。
import { describe, it, expect } from 'vitest';
import {
  SYMBOL_CHANGE_EVENT_TYPE,
  resolveLineage,
  validateRegistration,
  type SymbolChangeRegistration,
} from './symbol-lineage.rules';

const reg = (
  oldCode: string,
  newCode: string,
  effectiveDate: string,
  market = 'us',
): SymbolChangeRegistration => ({
  market,
  oldCode,
  newCode,
  effectiveDate,
  eventType: SYMBOL_CHANGE_EVENT_TYPE.RENAME,
});

describe('resolveLineage (plan D2)', () => {
  it('① 单次改名 AAA → BBB @ D ⇒ 查 BBB 得两段, 边界 = 生效日 (branch 1、2)', () => {
    expect(resolveLineage([reg('AAA', 'BBB', '2026-07-01')], 'us', 'BBB')).toEqual([
      { code: 'AAA', from: null, toExclusive: '2026-07-01' },
      { code: 'BBB', from: '2026-07-01', toExclusive: null },
    ]);
  });

  it('② 链式 AAA → BBB → CCC ⇒ 查 CCC 回溯到 AAA 三段 (branch 6)', () => {
    const regs = [reg('BBB', 'CCC', '2026-08-01'), reg('AAA', 'BBB', '2026-03-01')];
    expect(resolveLineage(regs, 'us', 'CCC')).toEqual([
      { code: 'AAA', from: null, toExclusive: '2026-03-01' },
      { code: 'BBB', from: '2026-03-01', toExclusive: '2026-08-01' },
      { code: 'CCC', from: '2026-08-01', toExclusive: null },
    ]);
  });

  it('③ 改回原码 AAA → BBB → AAA (日期递增) ⇒ 合法, 三段归属正确', () => {
    const regs = [reg('AAA', 'BBB', '2026-03-01'), reg('BBB', 'AAA', '2026-08-01')];
    expect(validateRegistration([regs[0]], regs[1], '2026-10-16')).toEqual({ ok: true });
    expect(resolveLineage(regs, 'us', 'AAA')).toEqual([
      { code: 'AAA', from: null, toExclusive: '2026-03-01' },
      { code: 'BBB', from: '2026-03-01', toExclusive: '2026-08-01' },
      { code: 'AAA', from: '2026-08-01', toExclusive: null },
    ]);
  });

  it('④ 回收: AAA → BBB @ D 后查 AAA ⇒ 只有 [D, ∞) 一段 (branch 4、5)', () => {
    expect(resolveLineage([reg('AAA', 'BBB', '2026-07-01')], 'us', 'AAA')).toEqual([
      { code: 'AAA', from: '2026-07-01', toExclusive: null },
    ]);
  });

  it('④b 回收后被回收码再次改名 AAA → CCC ⇒ 查 CCC 只回溯到回收后的 AAA 段', () => {
    const regs = [reg('AAA', 'BBB', '2026-03-01'), reg('AAA', 'CCC', '2026-08-01')];
    expect(resolveLineage(regs, 'us', 'CCC')).toEqual([
      { code: 'AAA', from: '2026-03-01', toExclusive: '2026-08-01' },
      { code: 'CCC', from: '2026-08-01', toExclusive: null },
    ]);
  });

  it('⑤ 新码在生效日前已有自有数据 ⇒ 新码段起点仍为生效日 (branch 7)', () => {
    const segs = resolveLineage([reg('AAA', 'BBB', '2026-07-01')], 'us', 'BBB');
    expect(segs.at(-1)).toEqual({ code: 'BBB', from: '2026-07-01', toExclusive: null });
  });

  it('⑥ 无登记 ⇒ 单段无下界 (branch 3)', () => {
    expect(resolveLineage([], 'us', 'AAA')).toEqual([
      { code: 'AAA', from: null, toExclusive: null },
    ]);
  });

  it('他市场的登记不参与 (同码不同市场互不影响)', () => {
    expect(resolveLineage([reg('AAA', 'BBB', '2026-07-01', 'hk')], 'us', 'BBB')).toEqual([
      { code: 'BBB', from: null, toExclusive: null },
    ]);
  });
});

describe('validateRegistration (plan D2; FR-002 / FR-008)', () => {
  const today = '2026-10-16';

  it('合法登记 ⇒ ok', () => {
    expect(validateRegistration([], reg('AAA', 'BBB', '2026-10-16'), today)).toEqual({ ok: true });
  });

  it('⑦a 旧码 = 新码 ⇒ 拒绝 same_code (branch 10)', () => {
    expect(validateRegistration([], reg('AAA', 'AAA', '2026-07-01'), today)).toMatchObject({
      ok: false,
      reason: 'same_code',
    });
  });

  it('⑦b 生效日晚于交易所当地今天 ⇒ 拒绝 future_effective_date (branch 10)', () => {
    expect(validateRegistration([], reg('AAA', 'BBB', '2026-10-17'), today)).toMatchObject({
      ok: false,
      reason: 'future_effective_date',
    });
  });

  it('⑦c 同 (market, old, effective) 重复 ⇒ 拒绝 duplicate (branch 9)', () => {
    const existing = [reg('AAA', 'BBB', '2026-07-01')];
    expect(validateRegistration(existing, reg('AAA', 'CCC', '2026-07-01'), today)).toMatchObject({
      ok: false,
      reason: 'duplicate',
    });
  });

  it('⑦d 跨市场在入参类型上即不可表达 (branch 10): 旧码 / 新码共用一个 market 字段', () => {
    const crossMarket = {
      ...reg('AAA', 'BBB', '2026-07-01'),
      // @ts-expect-error —— 登记没有第二个市场字段, 跨市场登记写不出来
      newMarket: 'hk',
    } satisfies SymbolChangeRegistration;
    expect(crossMarket.market).toBe('us');
  });

  it('⑧ 非 rename 类型 (分拆 / 退市) ⇒ 拒绝 unsupported_event_type (branch 11)', () => {
    for (const eventType of ['split', 'delist']) {
      expect(
        validateRegistration([], { ...reg('AAA', 'BBB', '2026-07-01'), eventType }, today),
      ).toMatchObject({ ok: false, reason: 'unsupported_event_type' });
    }
  });

  it('⑨a 成环: 同一生效日 AAA → BBB 与 BBB → AAA ⇒ 拒绝 cycle', () => {
    const existing = [reg('AAA', 'BBB', '2026-07-01')];
    expect(validateRegistration(existing, reg('BBB', 'AAA', '2026-07-01'), today)).toMatchObject({
      ok: false,
      reason: 'cycle',
    });
  });

  it('⑨b 成环: 同一生效日三码环 AAA → BBB → CCC → AAA ⇒ 拒绝 cycle', () => {
    const existing = [reg('AAA', 'BBB', '2026-07-01'), reg('BBB', 'CCC', '2026-07-01')];
    expect(validateRegistration(existing, reg('CCC', 'AAA', '2026-07-01'), today)).toMatchObject({
      ok: false,
      reason: 'cycle',
    });
  });

  it('⑨c 区间重叠: BBB 已被 AAA 改入且未改走, 又登记 CCC → BBB ⇒ 拒绝 overlap', () => {
    const existing = [reg('AAA', 'BBB', '2026-03-01')];
    expect(validateRegistration(existing, reg('CCC', 'BBB', '2026-08-01'), today)).toMatchObject({
      ok: false,
      reason: 'overlap',
    });
  });

  it('⑨d 区间重叠: 插到既有改入之前 (CCC → BBB 早于 AAA → BBB) 同样拒绝', () => {
    const existing = [reg('AAA', 'BBB', '2026-08-01')];
    expect(validateRegistration(existing, reg('CCC', 'BBB', '2026-03-01'), today)).toMatchObject({
      ok: false,
      reason: 'overlap',
    });
  });

  it('BBB 先改走再被改入 ⇒ 不算重叠 (段首尾相接)', () => {
    const existing = [reg('AAA', 'BBB', '2026-03-01'), reg('BBB', 'DDD', '2026-05-01')];
    expect(validateRegistration(existing, reg('CCC', 'BBB', '2026-08-01'), today)).toEqual({
      ok: true,
    });
  });

  it('他市场的同参数登记不算重复', () => {
    const existing = [reg('AAA', 'BBB', '2026-07-01', 'hk')];
    expect(validateRegistration(existing, reg('AAA', 'BBB', '2026-07-01'), today)).toEqual({
      ok: true,
    });
  });
});
