// 自定义数字键盘输入规范化纯函数（026 US1 / FR-003）。组件层（numeric-keypad.tsx）只
// 渲染键 + 转发 onKey，所有合法性收敛在此：交互/渲染走 Playwright，规范化走 vitest。
//
// 🚨 **规范化是调用屏的事，不是键盘的事** —— 本函数是 026 那一屏（alert 阈值）的判据，
//    **不是** `NumericKeypad` 的隐含契约。053 T015 起 optionsdesk 检索条件抽屉也用这块键盘，
//    但它沿用自己那份 `sanitizeNumeric`（无位数上限：服务端下发的权利金默认值有四位小数，
//    下面的 `MAX_FRACTION_DIGITS` 会让它打不回来）。⇒ 新接一屏时**先看它自己的判据**，
//    别默认 `applyKey` 通用。

/** 退格键字符（与设计基线 .key ⌫ 同字面，组件透传）。 */
export const BACKSPACE = '⌫';

/** 整数位上限（FR-003）。 */
const MAX_INT_DIGITS = 7;
/** 小数位上限（FR-003）。 */
const MAX_FRACTION_DIGITS = 2;

/**
 * 应用一次按键到当前显示串，返回规范化后的新串（O(len)）。
 * - 退格：`slice(0,-1)`（空串幂等）。
 * - 小数点：已含「.」忽略；空串 →「0.」；否则追加。
 * - 数字：前导零规范（"0" 后输数字替换整数位、"0" 后输 "0" 保留单零）；
 *   整数位 ≤7 / 小数位 ≤2，超出忽略。
 * - 非键盘键（非 0-9 / 「.」/ 退格）原样返回（防御）。
 */
export function applyKey(raw: string, key: string): string {
  if (key === BACKSPACE) return raw.slice(0, -1);

  if (key === '.') {
    if (raw.includes('.')) return raw;
    if (raw === '') return '0.';
    return raw + '.';
  }

  if (key.length !== 1 || key < '0' || key > '9') return raw; // 非数字键忽略

  // 前导零规范："0" 后输数字替换整数位（"0"+"5"→"5"），"0"+"0" 保留单个前导零。
  if (raw === '0') return key === '0' ? '0' : key;

  const dotIdx = raw.indexOf('.');
  if (dotIdx === -1) {
    return raw.length >= MAX_INT_DIGITS ? raw : raw + key; // 整数位上限
  }
  const fractionLen = raw.length - dotIdx - 1;
  return fractionLen >= MAX_FRACTION_DIGITS ? raw : raw + key; // 小数位上限
}
