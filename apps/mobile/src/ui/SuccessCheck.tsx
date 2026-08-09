import { useEffect } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

// Success badge — bg-ok-soft halo + bg-ok inner circle + ✓ glyph; scale-in pop
// (≤800ms per FR-C11). Arbitrary `w-[72px]` preserves the 72px size (Tailwind's
// default scale lacks `w-18`); inner circle stays `w-12 h-12` (48px).
export function SuccessCheck() {
  const s = useSharedValue(0);

  useEffect(() => {
    s.value = withSequence(
      withTiming(1.1, { duration: 240, easing: Easing.out(Easing.cubic) }),
      withTiming(1.0, { duration: 140, easing: Easing.out(Easing.cubic) }),
    );
  }, [s]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: s.value }],
    opacity: s.value === 0 ? 0 : 1,
  }));

  // 视觉 token 下沉到内层 plain View：NativeWind className 在 reanimated Animated.View 上 web
  // 会被整串吞掉（reanimated#8329），halo 尺寸/底色全丢。Animated.View 只留 scale/opacity 动画。
  return (
    <Animated.View style={animatedStyle}>
      <View className="w-[72px] h-[72px] rounded-full bg-ok-soft items-center justify-center">
        <View className="w-12 h-12 rounded-full bg-ok items-center justify-center">
          <Text className="text-white text-2xl font-bold">✓</Text>
        </View>
      </View>
    </Animated.View>
  );
}
