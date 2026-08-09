// 045 T018 — 左侧抽屉**通用容器**（骨架自 chat/chat-drawer.tsx 抽出，plan D11）。
//
// 归属划分（D11）：本文件只承载**骨架**，业务内容一律由调用方以 children 传入 ——
// chat 的搜索框/会话列表/新建对话留在 chat/，App 级抽屉的品牌头/菜单区/用户脚留在挂载层。
//
// 结构（自绘 Reanimated overlay，**0 新第三方依赖**，SC-009 —— Modal / Reanimated /
// gesture-handler / safe-area-context 全在库，明确**不引** @react-navigation/drawer）：
//   Modal（transparent，全屏）覆盖整屏——**含底部 Tab 栏 + 状态栏**：抽屉渲在屏内时其
//   absolute overlay 受 React Navigation tab content 容器约束、够不到同级 Tab 栏（Tab 栏外露
//   不被遮罩）。改走 RN 内建 Modal（root 层挂载，native 在 Tab 栏之上 / web 视口 overlay，
//   与本仓 ~16 处 Modal 同范式），backdrop 遂能盖住 Tab 栏 + 右半区（网易云式遮罩）：
//     ├─ backdrop（rgba(0,0,0,0.4)，tap 关 / fade 淡入淡出）
//     └─ 面板（宽 82%，translateX withTiming 滑入/滑出）→ children
//   全屏后面板自管安全区：bg 铺满全高，内容用 useSafeAreaInsets 顶/底内缩，避开状态栏 /
//   home indicator（statusBar/navigationBarTranslucent 让 Modal 画到状态栏 + 导航栏之下）。
//
// 开关 tap 驱动（调用方的 hamburger 开 / backdrop tap 关，per RNGH web 手势非确定 memory）；
// swipe-left 关为增强（gesture-handler Pan，非唯一路径）。open 态由调用方持有，传入 props。
// mounted（open=false 时 unmount 面板）避免抽屉常驻挡住底层屏交互（web pointer 穿透）；Modal
// onRequestClose 接 Android 硬件返回键 → 关抽屉。
//
// 面板宽用百分比 → 包一层 View 约束 frame（width class 不约束 ScrollView frame，per 布局铁律）。
// presentational/编排 —— 无 vitest（render/手势走 Playwright e2e，per mono 测试分层）。
import { type ReactNode, useEffect } from 'react';
import { Modal, Pressable, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

/** 面板占屏宽比例（mockup baseline）。 */
const PANEL_WIDTH_RATIO = 0.82;
/** 滑入/滑出时长（ms）。 */
const SLIDE_MS = 220;
/** swipe-left 关阈值（拖过面板宽 1/3 即关，增强路径）。 */
const SWIPE_CLOSE_RATIO = 1 / 3;

export interface AppDrawerProps {
  open: boolean;
  onClose: () => void;
  /** testID 前缀：根 = `testID`，面板 = `${testID}-panel`，遮罩 = `${testID}-backdrop`。
   *  🚨 既有 e2e 契约按此派生（如 chat 传 'chat-drawer' → 'chat-drawer-panel'）。 */
  testID: string;
  /** 抽屉根容器 a11y 名（调用方 copy）。 */
  accessibilityLabel: string;
  /** 遮罩 a11y 名（tap 关，调用方 copy）。 */
  backdropAccessibilityLabel: string;
  /** 面板内容（安全区内缩后的 flex 容器内，由调用方自行分段）。 */
  children: ReactNode;
}

export function AppDrawer({
  open,
  onClose,
  testID,
  accessibilityLabel,
  backdropAccessibilityLabel,
  children,
}: AppDrawerProps) {
  const { width } = useWindowDimensions();
  const panelWidth = width * PANEL_WIDTH_RATIO;
  // 全屏 Modal 后面板自管安全区：bg 铺满全高，内容顶/底按 inset 内缩（避状态栏 / home indicator）。
  const insets = useSafeAreaInsets();

  // 面板位移：-panelWidth = 全藏（屏外左侧），0 = 全开。backdrop 透明度同步。
  const translateX = useSharedValue(-panelWidth);
  const backdropOpacity = useSharedValue(0);
  const startX = useSharedValue(0);

  // open 切换 → 滑入/滑出（withTiming）。panelWidth 变化（旋转）时重算藏匿位移。
  useEffect(() => {
    if (open) {
      translateX.value = withTiming(0, { duration: SLIDE_MS });
      backdropOpacity.value = withTiming(1, { duration: SLIDE_MS });
    } else {
      translateX.value = withTiming(-panelWidth, { duration: SLIDE_MS });
      backdropOpacity.value = withTiming(0, { duration: SLIDE_MS });
    }
  }, [open, panelWidth, translateX, backdropOpacity]);

  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdropOpacity.value }));

  // swipe-left 关（增强路径，非唯一）：横向左拖超 12px 接管、纵向让位列表滚动。
  const closeGesture = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-12, 12])
    .onStart(() => {
      startX.value = translateX.value;
    })
    .onUpdate((e) => {
      // 夹在 [-panelWidth, 0]：只允许左滑收起。
      translateX.value = Math.min(0, Math.max(-panelWidth, startX.value + e.translationX));
    })
    .onEnd(() => {
      if (translateX.value < -panelWidth * SWIPE_CLOSE_RATIO) {
        runOnJS(onClose)();
      } else {
        translateX.value = withTiming(0, { duration: 160 });
      }
    });

  // 关态不挂载 → 不挡底层屏交互（web pointer 穿透 + 省渲染）。
  if (!open) return null;

  return (
    // 全屏 Modal → root 层挂载，盖住 Tab 栏 + 状态栏（透明背景，遮罩自绘）。statusBar/
    // navigationBarTranslucent 让 Android 画到状态栏 + 导航栏之下；onRequestClose 接硬件返回。
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View className="flex-1" accessibilityLabel={accessibilityLabel} testID={testID}>
          {/* backdrop（tap 关）。 */}
          <Animated.View style={[{ position: 'absolute', inset: 0 }, backdropStyle]}>
            <Pressable
              className="flex-1 bg-black/40"
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={backdropAccessibilityLabel}
              testID={`${testID}-backdrop`}
            />
          </Animated.View>

          {/* 面板（82%，translateX 滑入；包 View 约束 frame，per 布局铁律）。 */}
          <GestureDetector gesture={closeGesture}>
            {/* Animated.View 只承载「位移 + 定位 inline style」，视觉 token（bg-surface）下沉到
              内层 plain View —— reanimated@4.1.1+ web 上 NativeWind className 在 Animated.View 失效
              （class 整串被吞，reanimated#8329 / nativewind#1181），故 className 必须挂非动画 View，
              定位走 inline（native/web 行为一致，对齐同文件 backdrop 写法）。空态曾因 position 丢失
              塌成内容高（327px），bg 丢失则面板透出底层首页。 */}
            <Animated.View
              style={[
                { position: 'absolute', top: 0, bottom: 0, left: 0, width: panelWidth },
                panelStyle,
              ]}
              testID={`${testID}-panel`}
            >
              {/* bg 铺满全高（含安全区）；内容顶/底按 inset 内缩，避状态栏 / home indicator。 */}
              <View
                className="flex-1 bg-surface"
                style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
              >
                {children}
              </View>
            </Animated.View>
          </GestureDetector>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}
