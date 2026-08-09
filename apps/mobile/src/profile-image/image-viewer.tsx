// 查看大图全屏 Modal（009 US5，P2）。全屏 expo-image 原图 + 双指 pinch-zoom / 双击复位
// （react-native-reanimated + gesture-handler，零新依赖）。pinch 手势 = 设备 / 手动验证（web
// e2e 仅验开/关 + 原图展示）。Modal 渲染在独立 native 视图层 → 需自带 GestureHandlerRootView。
import { Image } from 'expo-image';
import { useEffect } from 'react';
import { Modal, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

interface ImageViewerProps {
  visible: boolean;
  uri: string | null;
  onClose: () => void;
}

export function ImageViewer({ visible, uri, onClose }: ImageViewerProps) {
  const { width, height } = useWindowDimensions();
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);

  // 每次打开 / 换图复位缩放。
  useEffect(() => {
    if (visible) {
      scale.value = 1;
      savedScale.value = 1;
    }
  }, [visible, uri, scale, savedScale]);

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.max(1, savedScale.value * e.scale);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scale.value = withTiming(1);
      savedScale.value = 1;
    });

  const gesture = Gesture.Simultaneous(pinch, doubleTap);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View className="flex-1 bg-black justify-center">
          <Pressable className="absolute inset-0" accessibilityLabel="关闭" onPress={onClose} />
          {uri ? (
            // 显式 window 尺寸（非 flex-1）—— gesture-handler web 包装层不透传 flex，flex-1 会塌成 0。
            <GestureDetector gesture={gesture}>
              <Animated.View style={[{ width, height }, animatedStyle]}>
                <Image
                  source={{ uri }}
                  style={{ width: '100%', height: '100%' }}
                  contentFit="contain"
                  accessibilityLabel="查看大图"
                />
              </Animated.View>
            </GestureDetector>
          ) : null}
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="关闭大图"
            className="absolute top-12 right-md w-10 h-10 items-center justify-center rounded-full bg-modal-overlay"
          >
            <Text className="text-white-strong text-xl">✕</Text>
          </Pressable>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}
