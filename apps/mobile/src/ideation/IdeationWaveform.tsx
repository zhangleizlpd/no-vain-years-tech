// 035 T006 — 录音波形（design 帧2：brand eq 条，metering 驱动起伏）。单消费，先放 ideation/。
//
// 由 use-ideation-recording 的 `levels` shared value（normalizeMeter 归一化的滚动窗口，[0,1]）
// 驱动：每条 bar 经 reanimated `useAnimatedStyle` 读 `levels.value[i]` 算高度 —— shared value 更新
// **不触发 React re-render**（10 帧/秒 metering 不抖动整屏），动画在 UI 线程。
//
// 🚨 deviation from plan「react-native-svg bars」：改用 plain `Animated.View` 竖条。理由：(1) SVG
//    Rect 的 fill 需颜色字面量，违 nativewind「禁 hex 字面量、颜色走 token」；(2) reanimated
//    `Animated.View` 上挂 NativeWind className 在 web 被整串吞（reanimated#8329，见 memory +
//    Spinner/chat-drawer 先例）→ 颜色 token 下沉到 plain 子 View，Animated 父只承载 inline 动画
//    高度。竖条 + token 配色 = 同 RecordingStrip 既有 idiom，零新 token。
import { View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

/** 静止 / 静音基线条高（px）：active=false 或电平 0 时的平基线。 */
const MIN_BAR_H = 3;
/** 满电平条高（px）。 */
const MAX_BAR_H = 24;

export interface IdeationWaveformProps {
  /** 归一化电平滚动窗口（[0,1]，长度 = bar 数）；use-ideation-recording 的 shared value。 */
  levels: SharedValue<number[]>;
  /** 录音活跃（true 随电平起伏；false 收为平基线）。 */
  active: boolean;
}

/** 单条 bar：reanimated 读 `levels.value[index]` 算动画高度（UI 线程，不 re-render）。 */
function WaveBar({
  levels,
  index,
  active,
}: {
  levels: SharedValue<number[]>;
  index: number;
  active: boolean;
}) {
  // 竖条动态高度走 inline 动画 style（className 表达不出 + Animated.View web 吞 class）；
  // 颜色/宽/圆角 token 下沉到 plain 子 View。
  const style = useAnimatedStyle(() => {
    const level = active ? (levels.value[index] ?? 0) : 0;
    return { height: MIN_BAR_H + level * (MAX_BAR_H - MIN_BAR_H) };
  });
  return (
    <Animated.View style={style}>
      <View className="w-0.5 flex-1 rounded-full bg-brand-500" />
    </Animated.View>
  );
}

/**
 * 录音波形条。固定 bar 数 = `levels` 长度（use-ideation-recording WAVEFORM_BAR_COUNT）。
 * items-end 底对齐，从平基线向上长。
 */
export function IdeationWaveform({ levels, active }: IdeationWaveformProps) {
  // bar 数固定（shared value 初始即定长），首帧读长度安全；用作稳定 key 序列。
  const bars = levels.value.length;
  return (
    <View
      className="flex-row items-end gap-0.5"
      accessibilityRole="image"
      accessibilityLabel="录音波形"
      testID="ideation-waveform"
    >
      {Array.from({ length: bars }, (_, i) => (
        <WaveBar key={i} levels={levels} index={i} active={active} />
      ))}
    </View>
  );
}
