// 049 T001 — 选约表右侧列区的**位移载体** + 横滑手势工厂（FR-001/004, plan D-SCROLL-1/3）。
//
// 🚨 **范式换代（ADR-0063 方案 E）**：047 那套「表头与每个数据行各挂一个
//    `Animated.ScrollView`，谁滚了就把其余容器推到同一位移」是自激环的载体 —— 跟随者容器把
//    系统钳制后的位移**写回**共享值，环不收敛（真机实测方向反转 558 次 / 松手后仍每 3s 写入）。
//    这里**零滚动容器**：单个 `Gesture.Pan` 写一个共享位移，表头与各行各自 `translateX`
//    读它，**没有任何回写路径**。
//    🚫 MUST NOT 退回 A 范式的那三个广播 API —— tasks.md T001 的 verify 用一条 `grep` 逐字
//    列了它们的名字并要求本文件**零命中**，故这里蓄意不复写（写了那条判据就永远有命中）。
//
// 🚨 **符号翻转**：旧 `offset ∈ [0, contentWidth − viewportW]`（**正**，scroll offset），
//    新 `tx ∈ [maxTx, 0]`（**负**，translateX）。两者类型同为 `SharedValue<number>` ⇒
//    沿用旧名会**编译绿、e2e 也可能绿，而真机上方向反了或恒 clamp 到 0 滑不动**。
//    改名是把这次翻转钉在类型层之外的唯一手段（plan Guardrail 3）。
//
// 🚨 **`maxTx` 每帧在 worklet 内从 `viewportW.value` 重算**（Guardrail 4）：提到 JS 闭包里
//    只算一次，旋转屏后右侧滑不到底，**且不会红**。`withDecay` 的 `clamp` 同理。
//
// 📌 **宽度走 prop、MUST NOT 写死成模块常量**：P1/P2 改列集时列宽会变，写死等于逼下游复制
//    一份；这也是 ADR-0063 sunset #5（上提 `~/ui`）到来时能「移动文件而非重写」的前提。
//
// ⚠️ **NativeWind web 坑①**：`className` 挂在 `Animated.*` 上会被**整串吞掉** ⇒ token 一律
//    下沉到 plain 子 `View`（同 `leg-table-header.tsx` 头部那条）。**web 侧静默失效**，
//    native 不受影响 —— CI 全绿也不代表对。
import { useMemo, type ReactNode } from 'react';
import { View } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  type SharedValue,
} from 'react-native-reanimated';

/**
 * 位移下界（**负值**）。无横向溢出（`viewportW ≥ contentWidth`）⇒ `0` ⇒ 合法域退化成一个点，
 * 拖拽不产生任何位移 —— 这正是 spec Edge Case ① 要的形态，不是需要特判的意外。
 * 首帧 `viewportW = 0` 时同样落在这一支（`maxTx = 0`，一帧不可滑，无感）。复杂度 O(1)。
 */
function legColumnMaxTx(viewportW: number, contentWidth: number): number {
  'worklet';
  return Math.min(0, viewportW - contentWidth);
}

/**
 * 把横向位移夹回合法域 `[maxTx, 0]`。复杂度 O(1)。
 *
 * 📌 导出是给屏级 `onLayout` 用的（Guardrail 5：可视宽变化时 MUST 顺手把 `tx` 拉回新域，
 * 否则竖→横→竖之后卡在越界位置、只能反向滑）—— 两处夹的必须是**同一套判据**。
 */
export function clampLegColumnTx(next: number, viewportW: number, contentWidth: number): number {
  'worklet';
  return Math.min(0, Math.max(legColumnMaxTx(viewportW, contentWidth), next));
}

export interface LegColumnPaneProps {
  /** 表头与全部数据行共读的**唯一**位移（负值域，见文件头符号翻转段）。 */
  tx: SharedValue<number>;
  /** 右侧列区内容总宽（**prop 不写死**）。 */
  contentWidth: number;
  children: ReactNode;
  testID?: string;
}

/**
 * 右侧列区的位移载体：一个只读 `tx` 的 `translateX`。复杂度 O(1)（每行一个 `useAnimatedStyle`，
 * 随虚拟化窗口而非 730 行增长）。
 *
 * 🚫 **零滚动容器、零手势** —— 手势只有屏级那**一个**（见 {@link useLegColumnPan}）；
 * 每行各挂一个手势会把「谁接管」重新变成一个竞争问题。
 */
export function LegColumnPane({ tx, contentWidth, children, testID }: LegColumnPaneProps) {
  const paneStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));

  return (
    // 外层 wrapper 负责占满剩余宽并裁剪（`overflow-hidden`）—— 位移只在它内部发生。
    <View className="flex-1 overflow-hidden">
      <Animated.View style={paneStyle}>
        {/* ⚠️ 坑①：token 下沉到这一层 plain View；宽度是布局量，走 style。 */}
        <View className="flex-row" style={{ width: contentWidth }} testID={testID}>
          {children}
        </View>
      </Animated.View>
    </View>
  );
}

export interface UseLegColumnPanArgs {
  /** 被驱动的唯一位移。 */
  tx: SharedValue<number>;
  /** 横滑可视宽（= 容器宽 − 首列宽），由屏级 `onLayout` 写入 —— **不是** `useWindowDimensions()`。 */
  viewportW: SharedValue<number>;
  /** 右侧列区内容总宽。 */
  contentWidth: number;
}

/**
 * 横滑手势工厂。挂在包住整个 `SectionList` 的那一层（plan D-SCROLL-2），这样表头
 * （`renderSectionHeader`）与所有行（`renderItem`）—— `SectionList` 的两个不同槽位 ——
 * 被同一个手势覆盖。
 *
 * 🚨 依赖只有 shared value 与列宽 ⇒ **旋转屏不重建手势对象**（可视宽变化只改 `viewportW.value`）。
 */
export function useLegColumnPan({ tx, viewportW, contentWidth }: UseLegColumnPanArgs) {
  // 🚨 这是**手势起点书签，不是位移来源** —— FR-006 约束的是「被渲染消费的那个值」（`tx`）。
  //    指示条等下游 MUST 从 `tx` 派生，MUST NOT 另立第二个来源。
  const startTx = useSharedValue(0);

  return useMemo(
    () =>
      Gesture.Pan()
        // 方向正交：横向超 12px 才接管，纵向超 12px 直接 fail、触点整个交还 `SectionList`。
        // 同一组参数在 `~/ui/SwipeRow.tsx:28-29` 已长期在列表内工作。
        .activeOffsetX([-12, 12])
        .failOffsetY([-12, 12])
        .onBegin(() => {
          // 触地即停：`withDecay` 还在跑时不掐掉，起点会被它推着走 ⇒ 接管瞬间跳一段。
          cancelAnimation(tx);
          startTx.value = tx.value;
        })
        .onUpdate((e) => {
          // 🚨 clamp 每帧读 `viewportW.value`（Guardrail 4）。
          tx.value = clampLegColumnTx(
            startTx.value + e.translationX,
            viewportW.value,
            contentWidth,
          );
        })
        .onEnd((e) => {
          // 惯性同样受合法域约束：`clamp` 让它**停在边界而不回弹**（spec US1-AS4 后半）。
          tx.value = withDecay({
            velocity: e.velocityX,
            clamp: [legColumnMaxTx(viewportW.value, contentWidth), 0],
          });
        }),
    [contentWidth, startTx, tx, viewportW],
  );
}
