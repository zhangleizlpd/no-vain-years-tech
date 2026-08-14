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

import { LEG_STICKY_COL_WIDTH } from './leg-row.rules';

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

/** 指示条高度 —— sticky 栈高预算里就是这 2px（plan D-TAB-4），**别做厚**。 */
const SCROLLBAR_HEIGHT = 2;
/** thumb 宽下限 —— 列再多也不能细到看不见（12 列 / 302px 可视宽下算出来是 145px，用不到这道下限）。 */
const SCROLLBAR_MIN_THUMB = 24;

export interface LegColumnScrollbarProps {
  /** 与表格**同一个** `tx`（FR-006）。 */
  tx: SharedValue<number>;
  /** 横滑可视宽 = 轨道宽（见下方「左端对齐首列右缘」）。 */
  viewportW: SharedValue<number>;
  /** 右侧列区内容总宽。 */
  contentWidth: number;
  /**
   * 左端留白 = 冻结列宽。默认选约表的 88px；055 链分析报表的行标列是 56px。
   * 055 T011 加 —— **参数化而不是复制第二份**（`FR-004`：横滑复用 ADR-0063 那一套，
   * 🚫 MUST NOT 另立第二套；本文件头「宽度走 prop、不写死成模块常量」同一条）。
   */
  stickyWidth?: number;
  /** 轨道 testID（thumb 自动派生 `-thumb`）。 */
  testID?: string;
}

/**
 * 横向位置指示条（FR-005/006, plan D-SCROLL-4）—— **自绘**，因为 E 范式下没有滚动容器，
 * 系统不再给横向滚动条。渲在 12 列表头**正下方**（不是表格底部）：它描述的是列的位置，
 * 紧贴列头才读得懂；且落在 sticky 栈内才保证滚到哪都在。
 *
 * **左端与首列右缘对齐**（首列 88px 留空）⇒ 轨道宽 = 横滑可视宽 ⇒ 长度比即列宽比，
 * 无需二次换算。几何全部由 `tx` + `viewportW` 派生，复杂度 O(1)。
 *
 * 🚨 **本组件不新建任何共享值、零 JS state** —— 位置只从驱动表格的那个 `tx` 读（FR-006）。
 *    另立第二个来源是 ADR-0063 判死的「回写路径」的近亲，还会引入「表与指示条不同步」
 *    这一**新的**失步面。**只读、不可拖**（本片不做拖拽）。
 *    🚫 tasks.md T004 的 verify 用一条 `grep` 逐字列了那个建共享值的 hook 名并要求整片只命中
 *    屏级那一个 `tx`（外加手势起点书签），故这里蓄意不复写它。
 *
 * 📌 两个 `useAnimatedStyle` 是**节点数决定的**，不是第二个数据源：整条的可见性挂在外层、
 *    thumb 的宽与位移挂在 thumb 自身，一个 style 对象没法同时喂两个节点。两者读的是同一对值。
 */
export function LegColumnScrollbar({
  tx,
  viewportW,
  contentWidth,
  stickyWidth = LEG_STICKY_COL_WIDTH,
  testID = 'optionsdesk-detail-leg-scrollbar',
}: LegColumnScrollbarProps) {
  // 无横向溢出（`travel ≤ 0`）⇒ 高度收成 0：整条既不占位也不可见（spec Edge Case ①）。
  const barStyle = useAnimatedStyle(() => ({
    height: contentWidth - viewportW.value > 0 ? SCROLLBAR_HEIGHT : 0,
  }));

  const thumbStyle = useAnimatedStyle(() => {
    const trackW = viewportW.value;
    const travel = contentWidth - trackW;
    // 🚨 两支的 style 键集必须一致（Reanimated 要求），故这里也给全三个键。
    if (travel <= 0) {
      return { width: 0, height: 0, transform: [{ translateX: 0 }] };
    }
    // 下限之外再夹一道轨道宽：可视宽极窄时 24px 会比轨道还长，任其溢出会让 thumb 探出左端。
    const thumbW = Math.min(
      trackW,
      Math.max((trackW * trackW) / contentWidth, SCROLLBAR_MIN_THUMB),
    );
    // `tx ∈ [−travel, 0]` ⇒ `−tx / travel ∈ [0, 1]`；取 1 时 thumb 右缘贴轨道右缘。
    const range = Math.max(0, trackW - thumbW);
    return {
      width: thumbW,
      height: SCROLLBAR_HEIGHT,
      transform: [{ translateX: (-tx.value / travel) * range }],
    };
  });

  return (
    <Animated.View style={barStyle}>
      {/* ⚠️ 坑①：token 下沉到 plain 子 View（`className` 挂 `Animated.*` 会被整串吞掉）。
          首列宽的留白用兄弟节点占位 —— RN 没有 CSS 那套 `left` 定位的等价物。 */}
      <View className="h-full flex-row bg-surface-alt">
        <View style={{ width: stickyWidth }} />
        <View className="h-full flex-1 bg-line" testID={testID}>
          <Animated.View style={thumbStyle}>
            <View className="h-full w-full bg-ink-muted" testID={`${testID}-thumb`} />
          </Animated.View>
        </View>
      </View>
    </Animated.View>
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
