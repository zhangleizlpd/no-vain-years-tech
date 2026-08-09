import type { AccountProfileResponseGender } from '@nvy/api-client';

// 性别枚举值 — 与 server account.rules.ts Gender + api-client 生成枚举一一对应（008 FR-C07
// 单一真相源）。type-only import：仅约束类型，不在运行时拉 api-client 入口（保持本模块
// logic-only、vitest 可解析）。存储 / 传输恒英文 enum；中文标签仅展示层映射。
export type Gender = NonNullable<AccountProfileResponseGender>;

// 设置性别屏 4 行的渲染顺序（男 / 女 / 非二元 / 保密，FR-C06）。字面量受 Gender 类型约束，
// 与 api-client 枚举漂移时 GENDER_LABELS 的 Record<Gender> 会在 typecheck 报缺。
export const GENDER_OPTIONS: readonly Gender[] = ['MALE', 'FEMALE', 'NON_BINARY', 'PRIVATE'];

// 英文 enum → 中文展示标签（资料卡「性别」行 + 设置性别屏共用，FR-C07）。
export const GENDER_LABELS: Record<Gender, string> = {
  MALE: '男',
  FEMALE: '女',
  NON_BINARY: '非二元',
  PRIVATE: '保密',
};

// 任意 gender 值 → 中文标签；未设（null / undefined / 未知）→ 空串（资料卡右值占位）。
export function genderLabel(g: string | null | undefined): string {
  if (g == null) return '';
  return GENDER_LABELS[g as Gender] ?? '';
}
