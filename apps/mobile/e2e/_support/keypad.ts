import { type Locator, type Page } from '@playwright/test';

// 自绘数字键盘（`~/ui/numeric-keypad.tsx`）的 e2e 驱动 helper。026 起 alert 参数 sheet 的
// 值类/RSI/组合类阈值不再用系统 textbox；053 T015 起 optionsdesk 检索条件抽屉也走同一块键盘
// ——故文件名锚**键盘本身**而不是某一个 sheet。键名锚 numeric-keypad.tsx 的 accessibilityLabel
// （数字读自身 / '.'→「小数点」/ ⌫→「退格」/ 确定键读 confirmLabel）。
//
// 🚨 `scope` 传抽屉那个 Locator 可把键位定位收窄到抽屉内 —— 检索条件抽屉背后是整张选约表，
//    屏内同名按钮会双命中（Expo web e2e 三坑之一）。整屏只有一块键盘时传 `page` 即可。

/** 键位查找的范围：整页，或某个容器（sheet / 抽屉）。 */
export type KeypadScope = Page | Locator;

/** 自绘键盘逐字录入（数字 + 小数点）；调用前 sheet 须已开到键盘态。 */
export async function keypadType(scope: KeypadScope, value: string): Promise<void> {
  for (const ch of value) {
    await scope.getByRole('button', { name: ch === '.' ? '小数点' : ch, exact: true }).tap();
  }
}

/** 退格 count 次（清当前显示值再改写）。 */
export async function keypadBackspace(scope: KeypadScope, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await scope.getByRole('button', { name: '退格', exact: true }).tap();
  }
}

/** 键盘「确定」提交（值类 / 组合类 daysPct/pctile；纯周期 ma/window 走 sheet「选好了」）。 */
export async function keypadConfirm(scope: KeypadScope): Promise<void> {
  await scope.getByRole('button', { name: '确定' }).tap();
}
