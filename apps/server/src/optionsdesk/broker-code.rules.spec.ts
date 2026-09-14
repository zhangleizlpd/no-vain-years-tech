import { describe, expect, it } from 'vitest';
import { parseBrokerCode, parseComboLegs } from './broker-code.rules';

/**
 * `broker-code.rules.ts` 纯单测 (082 T005, plan D5; FR-006 / FR-007)。
 *
 * 🚨 本文件盯的解析错误都**不报错**, 只让归属悄悄错:
 *   · 调整合约词根被截掉尾数字 (`CMCS1` → `CMCS`) ⇒ 映射查到另一只正股, 或查不到被判未解析
 *   · 合成组合码被当成一张合约 ⇒ 组合单归到一个不存在的合约 (FR-007 要求按腿归属)
 *   · 解析失败的期权码被误读成正股 ⇒ `anchored` 范围下「不在锚集」被静默滤掉 (FR-006 要求保留)
 *
 * 定向变异 (out-of-test sabotage, testing.md §7.1):
 *   改坏: 词根解析后去掉尾部数字 (`root.replace(/\d+$/, '')`)
 *   结果 (2026-09-14 实跑): 1 failed | 22 passed —— 只有 ③ 红 (`CMCS1` → `CMCS`);
 *         还原后 `cmp` 与备份逐字节相同, 23/23 绿
 *   复跑: pnpm nx test server src/optionsdesk/broker-code.rules.spec.ts --skip-nx-cache
 */

describe('parseBrokerCode — 期权码', () => {
  it('① 美股 `US.ZQX260918P70000` ⇒ 词根 ZQX / 2026-09-18 / P / 行权价 70.000', () => {
    const parsed = parseBrokerCode('US.ZQX260918P70000');
    expect(parsed).toMatchObject({
      kind: 'option',
      market: 'us',
      root: 'ZQX',
      expiry: '2026-09-18',
      right: 'P',
    });
    expect(parsed?.kind === 'option' && parsed.strike.toFixed(3)).toBe('70.000');
  });

  it('② 港股 `HK.TCH260929C420000` ⇒ 词根 TCH / C / 行权价 420.000', () => {
    const parsed = parseBrokerCode('HK.TCH260929C420000');
    expect(parsed).toMatchObject({
      kind: 'option',
      market: 'hk',
      root: 'TCH',
      expiry: '2026-09-29',
      right: 'C',
    });
    expect(parsed?.kind === 'option' && parsed.strike.toFixed(3)).toBe('420.000');
  });

  it('🚨 ③ 调整合约 `US.CMCS1260918C40000` ⇒ 词根原样 CMCS1 (MUST NOT 去尾数字)', () => {
    const parsed = parseBrokerCode('US.CMCS1260918C40000');
    expect(parsed).toMatchObject({ kind: 'option', root: 'CMCS1', expiry: '2026-09-18' });
    expect(parsed?.kind === 'option' && parsed.strike.toFixed(3)).toBe('40.000');
  });

  it('行权价 ÷1000 用十进制精确算 (12500 ⇒ 12.5, 不经二进制浮点)', () => {
    const parsed = parseBrokerCode('US.SOXL260918C12500');
    expect(parsed?.kind === 'option' && parsed.strike.toString()).toBe('12.5');
  });
});

describe('parseBrokerCode — 正股码', () => {
  it('④ 带点美股 `US.BRK.B` ⇒ `us:BRK.B` (点原样, 不是 `us:BRK:B`)', () => {
    expect(parseBrokerCode('US.BRK.B')).toEqual({
      kind: 'stock',
      market: 'us',
      ticker: 'us:BRK.B',
    });
  });

  it('⑤ 港股 `HK.00700` ⇒ `hk:00700` (前导零保留)', () => {
    expect(parseBrokerCode('HK.00700')).toEqual({
      kind: 'stock',
      market: 'hk',
      ticker: 'hk:00700',
    });
  });

  it('普通美股 `US.ZQY` ⇒ `us:ZQY`', () => {
    expect(parseBrokerCode('US.ZQY')).toEqual({ kind: 'stock', market: 'us', ticker: 'us:ZQY' });
  });
});

describe('parseBrokerCode — 判不出一律 null (调用方按未解析保留, FR-006)', () => {
  it('🚨 ⑥ 合成组合码 `US.ZQY260918P120/261120P120` ⇒ null (不按合成码归属, FR-007)', () => {
    expect(parseBrokerCode('US.ZQY260918P120/261120P120')).toBeNull();
  });

  it.each([
    ['空串', ''],
    ['无前缀', 'ZQX260918P70000'],
    ['无前缀正股', 'ZQY'],
    ['未承担的市场前缀', 'SH.600519'],
    ['前缀小写', 'us.ZQY'],
    ['只有前缀', 'US.'],
    ['港股位数不对', 'HK.700'],
  ])('⑧ %s (%s) ⇒ null', (_label, code) => {
    expect(parseBrokerCode(code)).toBeNull();
  });

  it('🚨 形似期权但右侧不是 C/P ⇒ null, MUST NOT 退化成正股 `us:ZQX260918X70000`', () => {
    expect(parseBrokerCode('US.ZQX260918X70000')).toBeNull();
  });
});

describe('parseComboLegs — 从组合单腿串里提取腿码 (FR-007)', () => {
  /** 形态照 082 POC-1 原始输出 (2026-09-13) 的 `combo_legs` 字段: 字符串数组, 每腿一条。 */
  const LEGS = [
    'ComboLeg(code=US.ZQY260918P120000, trd_side=BUY, qty_ratio=1.0, position_id=N/A)',
    'ComboLeg(code=US.ZQY261120P120000, trd_side=SELL_SHORT, qty_ratio=1.0, position_id=N/A)',
  ];

  it('⑦ 两腿数组 ⇒ 两个腿码, 保持顺序', () => {
    expect(parseComboLegs(LEGS)).toEqual(['US.ZQY260918P120000', 'US.ZQY261120P120000']);
  });

  it('⑦ 两腿拼成单串 ⇒ 同样两个腿码', () => {
    expect(parseComboLegs(LEGS.join(', '))).toEqual(['US.ZQY260918P120000', 'US.ZQY261120P120000']);
  });

  it.each([
    ['空数组', []],
    ['空串', ''],
    ['N/A', 'N/A'],
    ['null', null],
    ['undefined', undefined],
  ])('非组合单 (%s) ⇒ []', (_label, raw) => {
    expect(parseComboLegs(raw)).toEqual([]);
  });
});
