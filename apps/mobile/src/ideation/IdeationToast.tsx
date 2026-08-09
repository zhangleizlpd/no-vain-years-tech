// 033 多模态输入壳 — ideation 内联 toast（~/ui 无通用 Toast，per nativewind-mapping §5，
// 本 feature scope 内联，不抽通用原语）。占位 / 权限提示用，非错误条。
//
// absolute pill：白底 + card 阴影 + ink 文字。auto-hide 由父屏 fireToast 的 setTimeout 驱动
// （本组件纯渲染，message=null 即不挂）。⚠️ 刻意不用 Animated.View 包裹：NativeWind
// className 挂 Animated.View 在 web 端被整串吞（reanimated + RN 内建都中招，见 memory），
// 故视觉 token 全落在 plain View 上，淡入淡出交由父屏 mount/unmount。
import { Text, View } from 'react-native';

export interface IdeationToastProps {
  /** 当前 toast 文案；null = 不显示。 */
  message: string | null;
}

export function IdeationToast({ message }: IdeationToastProps) {
  if (message === null) return null;
  return (
    <View
      className="absolute left-0 right-0 bottom-28 items-center"
      pointerEvents="none"
      testID="ideation-toast"
    >
      <View className="bg-surface rounded-full px-lg py-2.5 shadow-card">
        <Text className="text-sm text-ink">{message}</Text>
      </View>
    </View>
  );
}
