import { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';

export type SpinnerTone = 'white' | 'muted' | 'brand';

export interface SpinnerProps {
  size?: number;
  tone?: SpinnerTone;
}

export function Spinner({ size = 16, tone = 'white' }: SpinnerProps) {
  const rotation = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 700,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    anim.start();
    return () => anim.stop();
  }, [rotation]);

  const spin = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const ring =
    tone === 'white'
      ? 'border-white/30 border-t-white'
      : tone === 'brand'
        ? 'border-brand-200 border-t-brand-500'
        : 'border-line border-t-ink-subtle';

  // 视觉 token（border/rounded）下沉到内层 plain View：NativeWind className 在 Animated.View
  // 上 web 会被整串吞掉（reanimated#8329 / RN 内建 Animated 同样失效），导致 web 上 spinner
  // 无边框 → 不可见。Animated.View 只留尺寸 + 旋转 transform；子 View 随父一起转，三端一致。
  return (
    <Animated.View style={[{ width: size, height: size }, { transform: [{ rotate: spin }] }]}>
      <View className={`flex-1 rounded-full border-2 ${ring}`} />
    </Animated.View>
  );
}
