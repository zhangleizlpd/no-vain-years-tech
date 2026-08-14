import { expect, type Page } from '@playwright/test';

import { keypadBackspace, keypadType } from './keypad';

// 检索条件抽屉的改值原语（053 T015）。
//
// 🚨 抽屉自 T015 起是**只读显示 + 自绘键盘**，框里没有 `TextInput` —— `.fill()` 点不着、
//    `toHaveValue()` 读不出（真机上系统键盘会把整个抽屉顶出屏外，且 `TextInput` 的
//    className 颜色未如期生效，两条 FAIL 同一个修法，见 spec `FR-045` 2026-08-14 裁定）。
//    ⇒ 改值 = 选中框 → 退格清空 → 逐键录入。两个 optionsdesk spec 共用一份。

const SHEET = 'optionsdesk-detail-criteria-sheet';

/** 「不限」占位符（`optionsdesk-copy.ts` 逐字）—— 空值时框里显示的就是它，不是空串。 */
export const CRITERIA_UNBOUNDED = '不限';

const inputTestId = (field: string) => `optionsdesk-detail-criteria-input-${field}`;

/**
 * 把某个条件框改成 `value`（抽屉须已打开）。
 *
 * 🚨 键位定位**收窄到抽屉内** —— 抽屉背后是整张选约表，屏内同名按钮会双命中。
 * 📌 清空走退格而不是「选中即清」：后者会让「点开看看又没改」变成一次覆盖。
 */
export async function setCriteria(page: Page, field: string, value: string): Promise<void> {
  const sheet = page.getByTestId(SHEET);
  const box = page.getByTestId(inputTestId(field));
  await box.tap();
  const current = (await box.textContent()) ?? '';
  await keypadBackspace(sheet, current === CRITERIA_UNBOUNDED ? 0 : current.length);
  await keypadType(sheet, value);
  await expect(box).toHaveText(value);
}
