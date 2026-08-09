// CheckCircle — 圆形 checkbox（021 多选删除模式 / 对象选择页 / 全选，mockup AlertKit 同名件）。
// checked = brand 实底白勾；未选 = 灰描边空圆。纯视觉无交互（行级 Pressable 由宿主提供，
// a11y checked 态挂宿主 accessibilityState）。presentational — Playwright 覆盖。

import { View } from 'react-native';
import { colors } from '~/theme';
import { AlertIcon } from './alert-icon';

export interface CheckCircleProps {
  checked: boolean;
  size?: number;
}

export function CheckCircle({ checked, size = 22 }: CheckCircleProps) {
  if (checked) {
    return (
      <View
        className="rounded-full bg-brand-500 items-center justify-center"
        style={{ width: size, height: size }}
      >
        <AlertIcon name="check" color={colors.surface.DEFAULT} size={size * 0.6} />
      </View>
    );
  }
  return (
    <View
      className="rounded-full border-2 border-line-strong"
      style={{ width: size, height: size }}
    />
  );
}
