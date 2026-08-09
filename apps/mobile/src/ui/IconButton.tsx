import type { ReactNode } from 'react';
import { Pressable } from 'react-native';

export interface IconButtonProps {
  /** SVG icon node (caller renders the glyph; this primitive only owns the 36×36 round frame). */
  children: ReactNode;
  onPress?: () => void;
  /** disabled → no press response + caller-provided fg/icon dims it. */
  disabled?: boolean;
  /** background Tailwind class (e.g. `bg-brand-500`); default transparent. */
  bg?: string;
  /** foreground Tailwind class for tint (e.g. `text-ink-muted`); optional, icon may self-color. */
  fg?: string;
  accessibilityLabel: string;
  testID?: string;
}

/**
 * 36×36 圆形图标按钮原语（033 多模态输入栏 + / mic / send / stop 共用）。
 * 视觉值走 caller 传入的 bg/fg class（≤4 atom），本原语只持圆框 + 交互 + a11y。
 * `rounded-full`（非 `rounded-[50%]`，RN-Web 兼容，per nativewind-mapping §3）。
 */
export function IconButton({
  children,
  onPress,
  disabled,
  bg,
  fg,
  accessibilityLabel,
  testID,
}: IconButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
      className={`w-9 h-9 rounded-full items-center justify-center ${bg ?? ''} ${fg ?? ''}`}
    >
      {children}
    </Pressable>
  );
}
