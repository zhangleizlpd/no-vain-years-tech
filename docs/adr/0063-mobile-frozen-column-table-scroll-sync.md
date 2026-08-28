---
adr_id: ADR-0063
status: Accepted
applies_to: [apps/mobile]
sunset_trigger: |
  - **RN 新架构（Fabric）上 `useAnimatedScrollHandler` → shared value 的投递延迟被上游修复**（reanimated [#7460](https://github.com/software-mansion/react-native-reanimated/issues/7460) 关闭且在本仓 Android 真机复验通过）→ 方案 F（单原生 ScrollView + counter-translate 冻结列）重新可用，它同时带回原生动量与原生滚动条，届时重审本 ADR 的 §决策 2
  - **出现一个封装好该范式且维护健康的库**（冻结列 + 双向滚动 + 纵向虚拟化 三者齐全，非 `.map()` 全渲染）→ 重审"自建 vs 用库"，本 ADR §候选 G/H 的否决理由届时失效
  - **表格规模突破 user 定的上界**（行 > 200 或列 > 20，且过滤器 + 截断不再是可接受的收敛手段）→ 重审是否仍靠 `FlatList` 纵向虚拟化，以及横向是否也需虚拟化（本 ADR 假设横向不虚拟化）
  - **需要 web 端等价形态**（Expo Web 上同一张表要可用）→ 本 ADR 的手势与 transform 路径未在 web 验证过，届时须重跑对照（web 侧有真 CSS `position: sticky`，结论可能相反）
  - **出现第二个消费该表格范式的 feature**（除 optionsdesk 选约表 / 聚合视图外）→ 把 PoC 沉淀的组件从 `optionsdesk/` 上提到 `~/ui/`，同 ADR-0030 的包分解判据
---

# ADR-0063: Mobile 冻结列表格的横向同步范式 — 单 Pan 手势驱动共享值，弃用多 ScrollView `scrollTo` 广播

- Status: Accepted (2026-08-10)
- Deciders: @zhangleizlpd
- Tags: mobile / table / reanimated / gesture-handler / new-architecture
- Relates: [ADR-0027](0027-frontend-data-test-layer.md)（前端数据与测试层）/ [ADR-0030](0030-package-decomposition.md)（`~/ui` 上提判据 = 本 ADR sunset #5）；实施载体 = [047-optionsdesk-chain-leg-picker](../../specs/047-optionsdesk-chain-leg-picker/spec.md)（`FR-003` 选约表，现状实现被本 ADR 取代）· `specs/048-optionsdesk-radar-aggregate-views/spec.md`（`FR-024` / V-C gate；spec 仍在未合入的 `048-optionsdesk-radar-aggregate-views` 分支上，main 无此文件，合入后改回链接）

## Context

期权台的选约表要同时满足三件事：**首列冻结**（行权价常显）、**横向滚动**看隐藏列、**纵向虚拟化**扛住行数。

047 已 ship 的实现（`leg-table-header.tsx` 的 `LegColumnScroller`）是：**表头与每一个数据行各挂一个 `Animated.ScrollView horizontal`，共享一个 `useSharedValue` offset**；任一容器滚动 → `useAnimatedScrollHandler` 写共享 offset → `useAnimatedReaction` 用 `scrollTo` 把其余容器推到同一位移。首列渲在横滑容器**之外**，因此"钉住"是布局结果而非特效。

**该实现在真机上反复出现「列左右不停震荡 / 表头自己在滚 / 行间失步」**，2026-07 起至少三次，规模从 10240 行到 200 行都复现 —— 一度被误判为**规模**问题（048 的 V-C gate 正是按"跨标的规模下范式是否仍成立"立的），实为**正确性**问题。

## Decision

### 1. 根因：跟随者把 clamp 后的位移**写回**共享值，形成自激环

```ts
// 现状（有缺陷）
const onScroll = useAnimatedScrollHandler((e) => {
  own.value = e.contentOffset.x;
  offset.value = e.contentOffset.x; // ← 任何容器都写，不分是不是用户在拖的那个
});
useAnimatedReaction(
  () => offset.value,
  (x) => {
    if (Math.abs(x - own.value) < 0.5) return;
    own.value = x; // ← 预写「期望值」
    scrollTo(ref, x, 0, false); // ← RN 会 clamp
  },
);
```

级联：① 用户拖 A → `offset = 200` ② reaction 推 B：`scrollTo(B, 200)` ③ **B 的可滚上限与 A 不同**（刚被虚拟化回收重挂 / 布局未稳 / 亚像素取整）⇒ RN clamp 到 180 ④ B 的 `onScroll` 因程序化滚动触发 → **`offset = 180`** ⑤ reaction 把所有人（含正被手指拖的 A）推回 180 ⑥ 回到 ①。

那道 `0.5px` 守卫挡不住：它比的是 `own`，而 `own` 已在第 ② 步被预写成"期望值"，第 ④ 步回来的是"实际值"，两者之差正是 clamp 量。

**只要有任何一个容器的 clamp 边界与其余不同，环就不收敛。** 与行数无关 —— 表头与数据行是两类容器，任一帧布局未稳即可起环。

### 2. 采纳方案 E：**零滚动容器**，单 `Gesture.Pan` → 单 shared value → 各行 `useAnimatedStyle(translateX)`

```ts
const tx = useSharedValue(0);
const pan = Gesture.Pan()
  .activeOffsetX([-12, 12]) // 横向超 12px 才接管
  .failOffsetY([-12, 12]) // 纵向超 12px 让给列表 ⇒ 纵滚不被吃
  .onBegin(() => {
    start.value = tx.value;
  })
  .onUpdate((e) => {
    tx.value = clamp(start.value + e.translationX, maxTx, 0);
  })
  .onEnd((e) => {
    tx.value = withDecay({ velocity: e.velocityX, clamp: [maxTx, 0] });
  });

// 表头与每一行共用：
const style = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));
```

**为什么它构造上不可能失步**：没有滚动容器 ⇒ 没有 `scrollTo` ⇒ 没有 clamp ⇒ **没有任何回写路径**。所有行读**同一个** shared value，在同一帧的 UI 线程求值。纵向仍由 `FlatList` 虚拟化，与横向方向正交、不争手势。

### 3. 明确否决方案 F（单原生 ScrollView + counter-translate 冻结列）

F 本可同时保住**原生动量**与**原生滚动条**（正是 E 的两个短板），但它依赖 `useAnimatedScrollHandler` → shared value 这条投递链，而该链在 **Android + Fabric（新架构）** 上有上游缺陷：
[#7460](https://github.com/software-mansion/react-native-reanimated/issues/7460)（sticky 元素 `translateY` 卡顿跳动，**仍 open**，RN 0.77.2 / Reanimated 3.17.5，iOS 正常）、[#6992](https://github.com/software-mansion/react-native-reanimated/issues/6992)（sticky header 闪烁且落后于滚动偏移，旧架构不复现）。

**本仓正是 Android + 新架构** ⇒ F 不可用。

📌 **这同时是 E 稳定性的机理解释**：上述缺陷的病根是「原生滚动事件 → shared value」的投递延迟；E 用手势直接在 UI 线程写共享值，**结构上不经过那条链路**。

## 实测证据（2026-08-10，Mate50 真机，200 行 × 20 列同一份数据）

对照 PoC 两臂同屏，探针走 `useAnimatedProps` → `TextInput.text`（全程 UI 线程，不扰动被测路径）：

| 判据         | A（现状 `scrollTo` 广播）                              | **E（Pan + translateX）**           |
| ------------ | ------------------------------------------------------ | ----------------------------------- |
| 方向反转次数 | **558**                                                | **3**（含手动来回甩产生的真实反向） |
| 松手后       | **净位移为零仍持续增长**（+28 写入 / +8 反转 每 3 秒） | 停增、收敛                          |
| 行间对齐     | 首行与全表错开约 35px，表头自行漂移                    | 表头 + 全部行标尺**逐像素齐**       |
| 手工复现     | 随手滑几下即出                                         | 多轮未出                            |
| 挂载耗时     | 561–732ms                                              | 670ms（同量级）                     |

🚨 **「净位移为零、写入与反转仍在涨」是自激环的判定签名** —— 该状态下**静态截图看起来是对齐的**（环在同一点抵消），肉眼与截图都会误判为正常。**验这类同步问题必须有数值探针。**

## 候选对比与否决理由

| 方案                                     | 机制               | 否决/采纳理由                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A 多 ScrollView + `scrollTo` 广播        | 047 现状           | ❌ 自激环（上有实测）；上游同类 [#1108](https://github.com/software-mansion/react-native-reanimated/issues/1108)「从 `useAnimatedScrollHandler` 调 `scrollTo` 致冻屏」；社区共识「串 `onScroll` 同步不是平滑方案」 |
| **E 单 Pan + translateX**                | 本 ADR 采纳        | ✅ 实测最优；且业界现状是「**没有专门库同时提供冻结列 + 手势动画，多数实现直接用 Reanimated / Gesture Handler 原语自建**」—— E 即该范式                                                                            |
| F 单 ScrollView + counter-translate      | 保原生动量与滚动条 | ❌ Android + Fabric 上游缺陷（见 §决策 3），正中本仓平台组合                                                                                                                                                       |
| G `react-native-sticky-table`（Simform） | Reanimated 驱动    | ⚠️ **机制未核实**（源码未取到）；文档零技术深度、无虚拟化说明、三个 peer dep。**非否决，是未查完** —— 若将来要"用库不自建"，从这里续查                                                                             |
| H `react-native-reanimated-table`        | Reanimated + RNGH  | ❌ `0.0.2`、3 年未发版；示例 `.map()` 全渲染、无虚拟化                                                                                                                                                             |
| I `react-native-frozenlist`              | 多 ScrollView 组合 | ❌ 作者自述「ScrollView 一次渲染全部子组件，不支持懒渲染」，与 200 行 × 20 列（4000 单元格）冲突                                                                                                                   |
| J WebView + web 表格库                   | 真 CSS `sticky`    | ⚠️ 保留为兜底：零新原生依赖（RN WebView 已装），但行点击走 bridge、样式脱离 NativeWind token、无原生手感与 a11y                                                                                                    |

## Consequences

### 必须接受的代价（四条，MUST NOT 在实现期被"优化"掉）

1. **动量 / 回弹自写**（`withDecay`）—— 手感与原生滚动不完全一致。
2. **没有原生横向滚动条** —— 看不出右侧还有多少列，需自绘指示条补偿。
3. **所在屏 MUST 自包裹 `GestureHandlerRootView`** —— 仓内约定根 `_layout` **不全局挂**（见 `app/(app)/(tabs)/ideation/index.tsx`）。漏了会直接 Render Error。
4. **`GestureDetector` 的子节点 MUST 是带 `collapsable={false}` 的单个原生 View** —— 两步缺一手势静默不生效：
   - 传 Fragment ⇒ 告警 `Invalid prop 'collapsable' supplied to 'React.Fragment'`，手势**根本没挂上**；
   - 传无样式副作用的 View ⇒ 被 RN view-flattening 压平，告警 `child may get view-flattened`。

   🚨 上述两条告警**正是"手势没生效"的唯一信号**，MUST NOT 用 `LogBox.ignoreLogs` 压掉（2026-08-10 实撞：压掉后根因被消音）。

### 影响面

- **047 已 ship 的 `LegColumnScroller` 被本 ADR 取代** —— 它是缺陷的载体，不是可保留的备选。替换是行为修复，不改 `FR-003` 的列集与"首列渲在横滑之外"的布局判据（那一条本就正确，且 E 沿用）。
- **048 的 V-C gate 判据随之改写** —— 原判据是"跨标的规模下范式是否仍成立"，据本 ADR 应改为"E 范式在目标规模下的手势归属与对齐"，规模不再是该 gate 的风险源。
- **纵向仍由 `FlatList` 虚拟化**，本 ADR 不改纵向；横向不虚拟化（列数 ≤ 20 的前提由产品侧约束保证）。

## 验证方式的教训（写进本 ADR，因为它决定了结论可不可信）

1. **合成手势不足以复现** —— `adb shell input swipe` 是单指、单向、无交错的干净手势，A 臂在它下面**完全测不出问题**；真机手工滑几下即出。⇒ 这类手势 / 容器约束**必须真机手验**，与 `mobile-impl-playbook` § RN 布局陷阱同族。
2. **探针本身会骗人**，本轮三次：① 模块级可变对象在 Fast Refresh 后 worklet 与 React 各持一份 ⇒ 计数恒 0；② JS 线程读 `sharedValue.value` 读不到 UI 线程写入 ⇒ 仍恒 0；③ 视觉标记在表头与数据行**形状不一致**（`C14` 3 字符 vs `44·14` 5 字符）⇒ 同一偏移下裁切不同，**把正常看成了错位**。
   ⇒ 下结论前先问「**如果反例存在，我的管道能看到吗**」：对照臂复现不出失步时，任何关于新方案的结论都不成立。
