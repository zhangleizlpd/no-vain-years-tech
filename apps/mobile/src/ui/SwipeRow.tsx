import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

// 左滑露出右侧 84px err 红底白字「删除」块的列表行（012 US6）。手势用
// react-native-gesture-handler Pan + reanimated translateX；横向超 12px 才接管、纵向
// 让位列表滚动（activeOffsetX / failOffsetY），点击删除块先弹回再回调（通常开二次确认）。
// 上层屏须套一层 <GestureHandlerRootView>（镜像 ~/profile-image/image-viewer 自包裹范式，
// 根 _layout 不全局挂）。presentational 无单测 —— 渲染 / 手势走 Playwright（per mono 测试分层）。

const ACTION_WIDTH = 84;

export interface SwipeRowProps {
  /** 行内容（不含删除块）。 */
  children: ReactNode;
  /** 删除块文案（如「删除」）。 */
  actionLabel: string;
  /** 点击删除块回调（先弹回行再触发，通常打开二次确认）。 */
  onAction: () => void;
}

export function SwipeRow({ children, actionLabel, onAction }: SwipeRowProps) {
  const translateX = useSharedValue(0);
  const startX = useSharedValue(0);

  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-12, 12])
    .onStart(() => {
      startX.value = translateX.value;
    })
    .onUpdate((e) => {
      // 夹在 [-ACTION_WIDTH, 0]：只允许左滑揭示，不允许右滑越界。
      translateX.value = Math.min(0, Math.max(-ACTION_WIDTH, startX.value + e.translationX));
    })
    .onEnd(() => {
      // 过半吸附到全开，否则弹回关闭。
      translateX.value = withTiming(translateX.value < -ACTION_WIDTH / 2 ? -ACTION_WIDTH : 0, {
        duration: 200,
      });
    });

  const contentStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));

  const handleAction = () => {
    translateX.value = withTiming(0, { duration: 160 });
    onAction();
  };

  return (
    <View className="relative overflow-hidden bg-surface">
      <Pressable
        onPress={handleAction}
        accessibilityRole="button"
        accessibilityLabel={actionLabel}
        className="absolute right-0 top-0 bottom-0 items-center justify-center bg-err"
        style={{ width: ACTION_WIDTH }}
      >
        <Text className="text-sm font-medium text-surface">{actionLabel}</Text>
      </Pressable>
      <GestureDetector gesture={pan}>
        <Animated.View style={contentStyle}>
          {/* 白底覆盖层 —— translateX=0 时盖住底层红色删除块。 */}
          <View className="bg-surface">{children}</View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
