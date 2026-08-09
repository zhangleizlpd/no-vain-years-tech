import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

// 自建拖拽排序列表（013 屏3 分组管理；D7 不引 draggable-flatlist）。固定行高 + 绝对定位
// 布局：拖拽行随手指 translateY 抬起，其余行按目标落点 withTiming 让位；松手算 from→to 调
// onReorder。手势用 gesture-handler Pan（activeOffsetY 阈值让纯点击穿透到行内按钮），
// reanimated useAnimatedStyle 驱动位移（动态计算位移 = nativewind 字面量例外）。
// ⚠️ 上层屏须套一层 <GestureHandlerRootView>（根 _layout 不全局挂，镜像 SwipeRow）。
// presentational 无单测 —— 拖拽交互走 Playwright e2e（per mono vitest 测试分层）。

export interface DraggableListProps<T> {
  data: T[];
  keyExtractor: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** 松手后提交：from / to 为列表下标（from===to 时调用方应自行短路）。 */
  onReorder: (from: number, to: number) => void;
  /** 行高（px）；绝对定位与让位位移均以此为单位。 */
  rowHeight: number;
}

export function DraggableList<T>({
  data,
  keyExtractor,
  renderItem,
  onReorder,
  rowHeight,
}: DraggableListProps<T>) {
  // -1 = 无拖拽中行。dragY = 当前拖拽行的实时 translateY。
  const activeIndex = useSharedValue(-1);
  const dragY = useSharedValue(0);
  const count = data.length;

  return (
    <View style={{ height: count * rowHeight }}>
      {data.map((item, index) => (
        <DraggableRow
          key={keyExtractor(item)}
          index={index}
          count={count}
          rowHeight={rowHeight}
          activeIndex={activeIndex}
          dragY={dragY}
          onReorder={onReorder}
        >
          {renderItem(item, index)}
        </DraggableRow>
      ))}
    </View>
  );
}

interface DraggableRowProps {
  index: number;
  count: number;
  rowHeight: number;
  activeIndex: SharedValue<number>;
  dragY: SharedValue<number>;
  onReorder: (from: number, to: number) => void;
  children: ReactNode;
}

function DraggableRow({
  index,
  count,
  rowHeight,
  activeIndex,
  dragY,
  onReorder,
  children,
}: DraggableRowProps) {
  const commit = (from: number, to: number) => {
    if (from !== to) onReorder(from, to);
  };

  const pan = Gesture.Pan()
    // 纵向超 8px 才接管 → 纯点击（行内 👁/⋯ 按钮）穿透，不被拖拽吞掉。
    .activeOffsetY([-8, 8])
    .onStart(() => {
      activeIndex.value = index;
      dragY.value = 0;
    })
    .onUpdate((e) => {
      dragY.value = e.translationY;
    })
    .onEnd(() => {
      const to = Math.max(0, Math.min(count - 1, index + Math.round(dragY.value / rowHeight)));
      runOnJS(commit)(index, to);
      activeIndex.value = -1;
      dragY.value = 0;
    });

  const animatedStyle = useAnimatedStyle(() => {
    const ai = activeIndex.value;
    // 本行正被拖拽：跟随手指 + 抬起（放大 + 高 zIndex/elevation）。
    if (ai === index) {
      return {
        transform: [{ translateY: dragY.value }, { scale: 1.02 }],
        zIndex: 10,
        elevation: 10,
      };
    }
    // 无拖拽：归位。
    if (ai === -1) {
      return { transform: [{ translateY: withTiming(0, { duration: 120 }) }], zIndex: 0 };
    }
    // 他行让位：算拖拽行将落到的目标位 `to`，介于 [ai, to] 之间的行上/下移一格腾空。
    const to = Math.max(0, Math.min(count - 1, ai + Math.round(dragY.value / rowHeight)));
    let shift = 0;
    if (ai < index && index <= to) shift = -rowHeight;
    else if (ai > index && index >= to) shift = rowHeight;
    return { transform: [{ translateY: withTiming(shift, { duration: 120 }) }], zIndex: 0 };
  });

  return (
    <Animated.View
      style={[
        { position: 'absolute', left: 0, right: 0, top: index * rowHeight, height: rowHeight },
        animatedStyle,
      ]}
    >
      <GestureDetector gesture={pan}>
        <View style={{ flex: 1 }}>{children}</View>
      </GestureDetector>
    </Animated.View>
  );
}
