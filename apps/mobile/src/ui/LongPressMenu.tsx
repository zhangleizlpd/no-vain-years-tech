import type { ReactNode } from 'react';
import { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

// 长按某行 → 底部 sheet 菜单的通用容器原语（013 屏2）。长按手势用 gesture-handler
// LongPress（`.runOnJS(true)` 让 onStart 直接在 JS 线程切 state，免 reanimated worklet
// runOnJS 包裹）；sheet = RN Modal portal + 半透明 scrim（点击关闭），镜像 ConfirmModal
// overlay 体例。菜单内容由调用方经 renderMenu 注入 —— 本原语不含 watchlist 专属 6 项
// （那是 T016 watchlist-item-menu）。受控触发区 + 内部 visible 态。
// ⚠️ 上层屏须套一层 <GestureHandlerRootView>（根 _layout 不全局挂，镜像 SwipeRow 范式）。
// presentational 无单测 —— 走 Playwright e2e（per mono vitest 测试分层）。

export interface LongPressMenuProps {
  /** 长按触发区内容（通常一行）。 */
  children: ReactNode;
  /** sheet 内容；close 回调供菜单项点击后自行关闭。 */
  renderMenu: (close: () => void) => ReactNode;
  /** 长按触发区 a11y 文案（如标的名）。 */
  accessibilityLabel?: string;
  /** 长按最短时长 ms（默认 420，对齐 mockup StockRow）。 */
  minDurationMs?: number;
  /**
   * 单击触发（与长按互斥，014 详情下钻）。给定时 = `Gesture.Exclusive(longPress, tap)`：
   * 长按优先，快速单击（未达 minDuration）→ longPress fail → tap 激活。同一 role=button
   * 触发区不新增嵌套节点 → 既有 e2e `getByRole('button',{name})` 长按定位不破。
   */
  onTap?: () => void;
}

export function LongPressMenu({
  children,
  renderMenu,
  accessibilityLabel,
  minDurationMs = 420,
  onTap,
}: LongPressMenuProps) {
  const [visible, setVisible] = useState(false);
  const close = () => setVisible(false);

  // gesture-handler 2.x `.runOnJS(true)`：回调走 JS 线程，可直接 setState（无需 reanimated
  // worklet + runOnJS）。LongPress 不涉及 shared value，无须 worklet。
  const longPress = Gesture.LongPress()
    .minDuration(minDurationMs)
    .runOnJS(true)
    .onStart(() => setVisible(true));

  // 单击手势：onEnd success=已完成单击。Exclusive 让 longPress 优先 → tap/longPress 不双触。
  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((_event, success) => {
      if (success && onTap) onTap();
    });
  const gesture = onTap ? Gesture.Exclusive(longPress, tap) : longPress;

  return (
    <>
      <GestureDetector gesture={gesture}>
        <View accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
          {children}
        </View>
      </GestureDetector>
      <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
        <View className="flex-1 justify-end bg-modal-overlay">
          <Pressable onPress={close} accessibilityLabel="关闭" className="absolute inset-0" />
          <View className="bg-surface rounded-t-lg pb-md shadow-modal">
            <View className="items-center pt-sm pb-xs">
              {/* 抓手 pill（一次性视觉，无对应 token；动态尺寸走 style，per nativewind 例外）。 */}
              <View className="rounded-full bg-line-strong" style={{ width: 38, height: 5 }} />
            </View>
            {renderMenu(close)}
          </View>
        </View>
      </Modal>
    </>
  );
}
