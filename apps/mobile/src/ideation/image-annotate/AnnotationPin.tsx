// 036 T010 — 标注 pin overlay（SVG 编号圆点，绝对定位在画布顶层）。
//
// pin 锚图片内容归一化坐标（pin-reducer）。本组件在 **UI 线程 worklet** 内逐帧投影：读手势
// 共享值（scale/translateX/translateY）算出锚点屏幕坐标，**仅 translate 不 scale** → 徽标保持
// 恒定屏幕大小（地图大头针范式），锚点随缩放/平移帧帧贴图（FR-003，业内标准做法）。
// 投影式与 pin-reducer.imageToScreen 同一仿射（`screen = base×scale + translate`，round-trip 单测守约）。
//
// 🚨 web 坑（per memory）：NativeWind className 挂 Animated.View 在 web 被整串吞 → Animated.View
// 只挂 transform style（无 className），徽标的 className 下沉到普通子 View。
import { Pressable, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import type { ImageLayout } from './pin-reducer';

const PIN_SIZE = 26;

export interface AnnotationPinProps {
  /** 展示编号（pin-reducer 递增，不复用）。 */
  n: number;
  /** 归一化图坐标（pin.nx/ny；锚图片内容矩形）。 */
  nx: number;
  ny: number;
  /** 图片 content-fit 后内容矩形（computeContainLayout 结果；投影基准）。 */
  layout: ImageLayout;
  /** 手势共享值（与图片 Animated.View 同源 → 锚点帧帧跟随缩放/平移）。 */
  scale: SharedValue<number>;
  translateX: SharedValue<number>;
  translateY: SharedValue<number>;
  /** 是否选中（选中态高亮，T011 注记联动）。 */
  selected?: boolean;
  /** 点 pin（选中 → 编辑注记 / 长按移除由父层处理）。 */
  onPress?: () => void;
}

export function AnnotationPin({
  n,
  nx,
  ny,
  layout,
  scale,
  translateX,
  translateY,
  selected = false,
  onPress,
}: AnnotationPinProps) {
  // UI 线程逐帧投影（内联 imageToScreen 同式）：锚点 = 归一化 → 内容矩形 → 叠手势仿射；
  // translate 半径居中锚点；**不乘 scale** → 徽标恒定大小（缩放时不糊住所标的细节）。
  const animatedStyle = useAnimatedStyle(() => {
    const baseX = layout.offsetX + nx * layout.width;
    const baseY = layout.offsetY + ny * layout.height;
    const screenX = baseX * scale.value + translateX.value;
    const screenY = baseY * scale.value + translateY.value;
    return {
      transform: [{ translateX: screenX - PIN_SIZE / 2 }, { translateY: screenY - PIN_SIZE / 2 }],
    };
  });

  return (
    // Animated.View 只挂 transform（无 className，web 安全）；定位框尺寸 = 恒定 PIN_SIZE。
    <Animated.View
      style={[
        { position: 'absolute', left: 0, top: 0, width: PIN_SIZE, height: PIN_SIZE },
        animatedStyle,
      ]}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`标注 ${n}`}
        testID={`ideation-annotation-pin-${n}`}
        className="flex-1"
      >
        <View
          className={`flex-1 rounded-full items-center justify-center border-2 border-white ${
            selected ? 'bg-brand-600' : 'bg-brand-500'
          }`}
        >
          <Text className="text-xs font-bold text-white">{n}</Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

// 移除标记气泡定宽（RN translate 无百分比 → 定宽 + 自身偏半宽以水平居中锚点）+ 距 pin 下沿间距。
const REMOVE_BUBBLE_WIDTH = 104;
const REMOVE_BUBBLE_GAP = 10;

export interface PinRemoveBubbleProps {
  /** 选中 pin 的归一化锚点 + 内容矩形 + 手势共享值（与 AnnotationPin 同源，气泡随 pin 帧帧跟随）。 */
  nx: number;
  ny: number;
  layout: ImageLayout;
  scale: SharedValue<number>;
  translateX: SharedValue<number>;
  translateY: SharedValue<number>;
  /** 点击移除该 pin。 */
  onPress: () => void;
}

/**
 * 选中 pin 时浮出的「移除标记」气泡（绝对定位在 pin 正下方，UI 线程逐帧投影，承 AnnotationPin
 * 同款锚定）。点击 → 删除该 pin（父屏 dispatch remove + 清选中）。
 */
export function PinRemoveBubble({
  nx,
  ny,
  layout,
  scale,
  translateX,
  translateY,
  onPress,
}: PinRemoveBubbleProps) {
  const animatedStyle = useAnimatedStyle(() => {
    const baseX = layout.offsetX + nx * layout.width;
    const baseY = layout.offsetY + ny * layout.height;
    const screenX = baseX * scale.value + translateX.value;
    const screenY = baseY * scale.value + translateY.value;
    return {
      transform: [
        { translateX: screenX - REMOVE_BUBBLE_WIDTH / 2 }, // 水平居中锚点
        { translateY: screenY + PIN_SIZE / 2 + REMOVE_BUBBLE_GAP }, // pin 正下方
      ],
    };
  });

  return (
    <Animated.View
      style={[
        { position: 'absolute', left: 0, top: 0, width: REMOVE_BUBBLE_WIDTH, alignItems: 'center' },
        animatedStyle,
      ]}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="移除标记"
        testID="ideation-annotation-remove"
        className="bg-ink rounded-full px-4 py-2.5 shadow-md"
      >
        <Text className="text-xs font-medium text-white">移除标记</Text>
      </Pressable>
    </Animated.View>
  );
}
