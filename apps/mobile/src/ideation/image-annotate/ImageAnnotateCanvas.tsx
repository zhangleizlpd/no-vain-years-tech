// 036 T010 — 标注画布（双指捏合缩放/平移 + 单击落 pin，reanimated + gesture-handler 零新依赖）。
//
// 设计（薄壳，态在父屏 image-annotate.tsx 的 pin-reducer）：本组件做手势 → transform 共享值 +
// 单击 → screenToImage → onAddPin（FR-002/003）。pin 锚图片内容归一化坐标，渲染时在 UI 线程
// worklet 内逐帧投影（AnnotationPin），随手势缩放/平移帧帧贴图。
//
// 坐标系两个关键约束（曾因偷工导致真机 Bug）：
//   ① layout = content-fit `contain` 后**真实内容矩形**（computeContainLayout），非满画布 ——
//      contain 有 letterbox 黑边，归一化必须相对内容矩形，否则周边裁切预览错位（Bug 2）。
//   ② 画布尺寸用 onLayout 量到的**真实**尺寸（非 useWindowDimensions）—— 画布是 flex-1，底部
//      注记面板出现后变矮，满窗尺寸会让图与 pin 投影都偏。
//   ③ pin overlay 与图片**共享同一手势共享值**（scale/translateX/translateY）→ 锚点帧帧跟随
//      （Bug 1：旧版用 identity 投影 + SharedValue 不触发重渲 → 完全不跟随）。
//
// 缩放绕**双指中心**（focal point）：最终变换保持简单仿射 `screen = base×scale + translate`，
// focal 只在 onUpdate 增量调整 translate 使焦点下内容点不动（避免 9 段矩阵，保 screenToImage/
// overlay 投影简单一致）。
//
// 🚨 web flex 坑（golden: profile-image/image-viewer.tsx）：gesture-handler web 包装层不透传
// flex → Animated.View 用显式量到的尺寸（非 flex-1，否则塌成 0）。pin overlay 用 box-none 顶层
// 兄弟容器：空白点击穿透到下层 GestureDetector 落新 pin，pin 自身 Pressable 捕获选中点击。
import { useCallback, useState } from 'react';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { AnnotationPin, PinRemoveBubble } from './AnnotationPin';
import {
  computeContainLayout,
  screenToImage,
  type AnnotationPin as Pin,
  type CanvasTransform,
  type ImageLayout,
} from './pin-reducer';

// RNGH 落点已是本地坐标（见 dropPin 注释）→ 归一化用恒等变换，不再二次去 transform。
const IDENTITY_TRANSFORM: CanvasTransform = { scale: 1, translateX: 0, translateY: 0 };

export interface ImageAnnotateCanvasProps {
  uri: string;
  pins: Pin[];
  /** 单击落 pin（传归一化图坐标，父屏 dispatch add）。达软上限的提示由父屏据 reducer 不变判定。 */
  onAddPin: (nx: number, ny: number) => void;
  /** 点已有 pin（选中 → 编辑注记，T011）。 */
  onSelectPin?: (id: string) => void;
  /** 移除 pin（选中态浮出「移除标记」气泡点击触发）。 */
  onRemovePin?: (id: string) => void;
  /** 当前选中 pin id（高亮 + 浮出移除气泡）。 */
  selectedPinId?: string | null;
  /** 图片自然像素尺寸就绪（T011 注记行裁切周边小图块用）。 */
  onImageLoad?: (size: { width: number; height: number }) => void;
}

export function ImageAnnotateCanvas({
  uri,
  pins,
  onAddPin,
  onSelectPin,
  onRemovePin,
  selectedPinId,
  onImageLoad,
}: ImageAnnotateCanvasProps) {
  // 真实画布尺寸（onLayout 量）：手势 / 投影共用此坐标空间，避免满窗与 flex-1 实际高不一致的偏移。
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  // 图片自然像素尺寸（算 contain 内容矩形 + 上抛父屏注记行裁切用）。
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);

  // 图片 content-fit contain 后真实内容矩形（pin 锚此矩形归一化 → 裁切/投影一致正确）。
  // 尺寸未就绪 → 退化满画布（落 pin 前的兜底，不产 NaN）。
  const layout: ImageLayout = natural
    ? computeContainLayout(canvasSize.width, canvasSize.height, natural.width, natural.height)
    : { offsetX: 0, offsetY: 0, width: canvasSize.width, height: canvasSize.height };

  // 选中 pin（浮出移除气泡用）。
  const selectedPin = pins.find((p) => p.id === selectedPinId) ?? null;

  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  // 增量手势追踪（per-gesture）：上一帧累计 scale / pan 位移，取差 → 增量更新当前变换，
  // 避免 pinch + pan 同时写 translate 时争用 saved 基准（二者各自把自己的增量叠到当前值）。
  const lastScale = useSharedValue(1);
  const lastPanX = useSharedValue(0);
  const lastPanY = useSharedValue(0);

  // 单击落 pin → screenToImage → onAddPin（JS 线程）。
  // 🚨 RNGH 的 tap 坐标已是 Animated.View **本地坐标**（手势 transform 已由 RNGH 撤销，真机实证：
  // 同一物理点 s=1 报 188、s=1.198/tx=55 报 111，且 111×1.198+55=188）→ 直接对内容矩形归一化，
  // **不可再减 transform**（否则缩放/平移后双重扣除 transform，nx/ny 与周边裁切预览全错）。
  const dropPin = useCallback(
    (screenX: number, screenY: number) => {
      const { nx, ny } = screenToImage(screenX, screenY, layout, IDENTITY_TRANSFORM);
      onAddPin(nx, ny);
    },
    [layout, onAddPin],
  );

  // 绕双指中心增量缩放：deltaScale = 本帧累计 / 上帧累计；clamp 后实际增量 effDelta 同步作用到
  // translate，使 focal 下内容点保持不动（newT = focal − (focal − t) × effDelta）。
  const pinch = Gesture.Pinch()
    .onStart(() => {
      lastScale.value = 1;
    })
    .onUpdate((e) => {
      const deltaScale = e.scale / lastScale.value;
      lastScale.value = e.scale;
      const next = Math.max(1, scale.value * deltaScale);
      const effDelta = next / scale.value;
      translateX.value = e.focalX - (e.focalX - translateX.value) * effDelta;
      translateY.value = e.focalY - (e.focalY - translateY.value) * effDelta;
      scale.value = next;
    });

  const pan = Gesture.Pan()
    .minPointers(1)
    .onStart(() => {
      lastPanX.value = 0;
      lastPanY.value = 0;
    })
    .onUpdate((e) => {
      translateX.value += e.translationX - lastPanX.value;
      translateY.value += e.translationY - lastPanY.value;
      lastPanX.value = e.translationX;
      lastPanY.value = e.translationY;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scale.value = withTiming(1);
      translateX.value = withTiming(0);
      translateY.value = withTiming(0);
    });

  // 单击（区别于双击复位）→ 落 pin。e.x/e.y 已是本地坐标（RNGH 撤销 transform）→ 直传。
  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd((e) => {
      runOnJS(dropPin)(e.x, e.y);
    });

  // pinch + pan 同时；tap 互斥（单击与双击 require fail，避免双击误触发两次单击）。
  const gesture = Gesture.Race(
    Gesture.Simultaneous(pinch, pan),
    Gesture.Exclusive(doubleTap, singleTap),
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    // 满窗暗底画布（pin overlay 与图共此容器，绝对定位投影）。onLayout 量真实画布尺寸。
    // 注：SoM 烧录不截此活画布（expo-image/reanimated GPU 层 captureRef 软件重绘截不到 → 黑），
    // 改截父屏专用静态 SomBurnView（RN Image + 静态 pin）—— 见 image-annotate.tsx。
    <View
      className="flex-1 bg-black"
      testID="ideation-annotate-canvas"
      onLayout={(e) => {
        const { width: w, height: h } = e.nativeEvent.layout;
        setCanvasSize((prev) =>
          prev.width === w && prev.height === h ? prev : { width: w, height: h },
        );
      }}
    >
      <GestureDetector gesture={gesture}>
        {/* 显式量到的尺寸（非 flex-1，web gesture 包装层不透传 flex，per golden image-viewer）。
            transformOrigin 锚**原点 (0,0)**：RN transform 默认绕 view 中心缩放，会与 pin overlay
            投影（按原点算 screen = base×scale + translate）偏离「中心×(1−scale)」→ 缩放时 pin 离图。
            锚原点后图与 pin 同一仿射，缩放帧帧对齐（RN 0.81 原生支持 transformOrigin）。 */}
        <Animated.View
          style={[
            { width: canvasSize.width, height: canvasSize.height, transformOrigin: '0% 0%' },
            animatedStyle,
          ]}
        >
          <Image
            source={{ uri }}
            style={{ width: '100%', height: '100%' }}
            contentFit="contain"
            accessibilityLabel="标注图片"
            // 自然像素尺寸就绪 → 本地存（算 contain 矩形）+ 上抛父屏（注记行裁切，T011）。
            onLoad={(e) => {
              const size = { width: e.source.width, height: e.source.height };
              setNatural(size);
              onImageLoad?.(size);
            }}
          />
        </Animated.View>
      </GestureDetector>

      {/* pin overlay：box-none 顶层兄弟容器（在 GestureDetector 外 → 点 pin 选中 / 点空白穿透落新
          pin 不互相干扰）。每个 pin 在 UI 线程 worklet 内读手势共享值逐帧投影、徽标恒定大小。
          选中 pin 时在其正下方浮出「移除标记」气泡（同款 worklet 锚定，点击删除）。 */}
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {pins.map((p) => (
          <AnnotationPin
            key={p.id}
            n={p.n}
            nx={p.nx}
            ny={p.ny}
            layout={layout}
            scale={scale}
            translateX={translateX}
            translateY={translateY}
            selected={selectedPinId === p.id}
            onPress={onSelectPin ? () => onSelectPin(p.id) : undefined}
          />
        ))}
        {onRemovePin && selectedPin ? (
          <PinRemoveBubble
            nx={selectedPin.nx}
            ny={selectedPin.ny}
            layout={layout}
            scale={scale}
            translateX={translateX}
            translateY={translateY}
            onPress={() => onRemovePin(selectedPin.id)}
          />
        ) : null}
      </View>
    </View>
  );
}
