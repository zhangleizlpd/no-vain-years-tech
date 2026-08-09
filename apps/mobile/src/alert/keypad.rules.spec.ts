import { describe, expect, it } from 'vitest';

import { applyKey, BACKSPACE } from './keypad.rules';

// 自定义数字键盘输入规范化纯函数（026 US1 / FR-003）：单小数点 + 前导零规范
// + 整数位 ≤7 / 小数位 ≤2 + 退格。逻辑层 vitest 全分支（交互/渲染走 Playwright）。

describe('applyKey — 数字录入（顺次构造合法值）', () => {
  it('依次点 1 2 9 . 5 → "129.5"', () => {
    let raw = '';
    for (const k of ['1', '2', '9', '.', '5']) raw = applyKey(raw, k);
    expect(raw).toBe('129.5');
  });

  it('空串点数字 → 该数字', () => {
    expect(applyKey('', '7')).toBe('7');
  });
});

describe('applyKey — 单小数点约束', () => {
  it('已含「.」再点「.」→ 不变', () => {
    expect(applyKey('129.5', '.')).toBe('129.5');
    expect(applyKey('0.', '.')).toBe('0.');
  });

  it('空串点「.」→ "0."', () => {
    expect(applyKey('', '.')).toBe('0.');
  });

  it('整数串点「.」→ 追加小数点', () => {
    expect(applyKey('12', '.')).toBe('12.');
  });
});

describe('applyKey — 前导零规范', () => {
  it('"0" 后输数字 → 替换整数位（"0"→"5"）', () => {
    expect(applyKey('0', '5')).toBe('5');
  });

  it('"0" 后再点 "0" → 仍单个前导零', () => {
    expect(applyKey('0', '0')).toBe('0');
  });

  it('"0." 后输数字 → 保留前导零小数（"0."→"0.5"）', () => {
    expect(applyKey('0.', '5')).toBe('0.5');
  });

  it('空串先点 "0" → "0"', () => {
    expect(applyKey('', '0')).toBe('0');
  });
});

describe('applyKey — 长度上限（整数位 ≤7 / 小数位 ≤2，超出忽略）', () => {
  it('整数位满 7 → 新数字被忽略', () => {
    expect(applyKey('1234567', '8')).toBe('1234567');
  });

  it('整数位 6 → 第 7 位接受', () => {
    expect(applyKey('123456', '7')).toBe('1234567');
  });

  it('小数位满 2 → 新数字被忽略', () => {
    expect(applyKey('12.34', '5')).toBe('12.34');
  });

  it('小数位 1 → 第 2 位接受', () => {
    expect(applyKey('12.3', '4')).toBe('12.34');
  });

  it('整数位满 7 仍可点小数点继续录小数', () => {
    expect(applyKey('1234567', '.')).toBe('1234567.');
    expect(applyKey('1234567.', '8')).toBe('1234567.8');
  });
});

describe('applyKey — 退格', () => {
  it('退格 = slice(0,-1)', () => {
    expect(applyKey('129.5', BACKSPACE)).toBe('129.');
    expect(applyKey('129.', BACKSPACE)).toBe('129');
  });

  it('"0." 退格 → "0" → 退格 → ""', () => {
    expect(applyKey('0.', BACKSPACE)).toBe('0');
    expect(applyKey('0', BACKSPACE)).toBe('');
  });

  it('空串退格 → 仍空串（不炸）', () => {
    expect(applyKey('', BACKSPACE)).toBe('');
  });
});

describe('applyKey — 防御（非键盘键忽略）', () => {
  it('未知键 → 原样返回', () => {
    expect(applyKey('12', 'x')).toBe('12');
    expect(applyKey('12', '')).toBe('12');
  });
});
