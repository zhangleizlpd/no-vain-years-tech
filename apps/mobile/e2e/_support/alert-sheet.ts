import { type Page } from '@playwright/test';

// 026 alert 参数 sheet 自绘键盘 e2e 驱动 helper（值类/RSI/组合类阈值不再用系统 textbox，
// 改自绘数字键盘只读显示；纯周期 ma/window 仍走底部「选好了」）。各 alert spec 共享，
// 避免每文件重复键盘点按序列。键名锚 numeric-keypad.tsx 的 accessibilityLabel
// （数字读自身 / '.'→「小数点」/ ⌫→「退格」/「确定」）。

/** 自绘键盘逐字录入（数字 + 小数点）；调用前 sheet 须已开到键盘态（值/RSI/组合类）。 */
export async function keypadType(page: Page, value: string): Promise<void> {
  for (const ch of value) {
    await page.getByRole('button', { name: ch === '.' ? '小数点' : ch, exact: true }).tap();
  }
}

/** 退格 count 次（清当前显示值再改写）。 */
export async function keypadBackspace(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await page.getByRole('button', { name: '退格', exact: true }).tap();
  }
}

/** 键盘「确定」提交（值类 / 组合类 daysPct/pctile；纯周期 ma/window 走 sheet「选好了」）。 */
export async function keypadConfirm(page: Page): Promise<void> {
  await page.getByRole('button', { name: '确定' }).tap();
}
