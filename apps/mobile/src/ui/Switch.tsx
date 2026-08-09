import { Switch as RNSwitch } from 'react-native';
import { colors } from '~/theme';

export interface SwitchProps {
  value: boolean;
  onValueChange?: (next: boolean) => void;
  /** disabled track 置灰 + 不响应点击（海外市场恒 disabled，FR-M04）。 */
  disabled?: boolean;
  accessibilityLabel?: string;
}

// 项目首个 toggle 原语（011 portfolio）。基于 RN 原生 `Switch` 包装：ON 色 = brand-500
// 蓝（mockup 定稿，commit 3ece552），trackColor/thumbColor 全走 `~/theme` token，
// 0 新增 token / 0 hex 字面量（SC-M06）。a11y per FR-M09（switch role + checked/disabled）。
// presentational — 无单测（covered by Playwright e2e，per mono vitest 测试分层）。
export function Switch({ value, onValueChange, disabled, accessibilityLabel }: SwitchProps) {
  return (
    <RNSwitch
      value={value}
      onValueChange={disabled ? undefined : onValueChange}
      disabled={disabled}
      // RN 原生 Switch 已天然暴露 switch role + checked/disabled（web 端内层 input
      // 自带 role=switch；显式再加 accessibilityRole 会在外层 wrapper 重复一份，
      // 致 getByRole('switch') 双命中）。仅补 label（FR-M09 语义由原生满足）。
      accessibilityLabel={accessibilityLabel}
      trackColor={{ false: colors.line.DEFAULT, true: colors.brand[500] }}
      thumbColor={colors.surface.DEFAULT}
      ios_backgroundColor={colors.line.DEFAULT}
      style={disabled ? { opacity: 0.5 } : undefined}
    />
  );
}
