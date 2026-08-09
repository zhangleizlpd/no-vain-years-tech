// 036 — SoM 烧录专用静态视图（captureRef 截**它**，非活画布）。
//
// 🚨 为什么要单独一个视图（真机 Mate50 实证）：活画布用 expo-image（Android 硬件纹理层）+
// reanimated `Animated.View`（变换层），二者在屏幕上由 GPU 合成显示正常；但 react-native-view-shot
// 的 `captureRef` 在 Android 走**软件重绘**（`view.draw(Canvas)`），读不到 GPU 层 → 整张烧录图**纯黑**。
// 本视图改用 **RN 内置 `Image`**（软件 drawable，零新依赖）+ **静态普通 `View`** 摆编号 pin（无
// reanimated 变换层）→ captureRef 能软件重绘截到，出图非黑。
//
// 另一收益：恒 **identity**（满图 contain + 全部「有注记」pin 按归一化坐标静态摆放）—— 不受活画布
// 当前缩放/平移影响，烧录图永远是完整原图 + 全部标记（旧「截活画布」会把当前缩放态也截进去）。
//
// pin 集 = **pinsWithNotes**（FR-006 严格 1:1：仅有注记 pin 入烧录 + 合成文字，编号沿用 pin.n）。
import { forwardRef, type ComponentRef } from 'react';
import { Image, Text, View } from 'react-native';

import type { ImageNaturalSize } from './pin-crop-preview';
import type { AnnotationPin } from './pin-reducer';

// 烧录视图基准宽（DP；captureRef 按 DP×pixelRatio 出图，下游 compressForUpload 再归一到 1280）。
const BURN_WIDTH = 360;
// 编号 pin 直径（DP，承 AnnotationPin 体例；相对 BURN_WIDTH ≈ 7%，与活画布观感接近）。
const PIN_SIZE = 26;

export interface SomBurnViewProps {
  /** 标注源图 uri（与活画布同源）。 */
  uri: string;
  /** 要烧录的 pin（**已过滤为 pinsWithNotes**，编号 = pin.n，与合成文字 1:1）。 */
  pins: AnnotationPin[];
  /** 图自然尺寸（定烧录视图宽高比；缺省 → 退化正方，不影响 capturability）。 */
  imageSize: ImageNaturalSize | null;
}

/**
 * 离屏静态烧录视图。父屏常驻渲染（off-screen，图提前加载好），发送时 `captureRef(ref)` 截取。
 * ref 转发到根 `View`（`collapsable={false}` 保证 Android 不折叠 → 可被 captureRef 软件重绘）。
 */
export const SomBurnView = forwardRef<ComponentRef<typeof View>, SomBurnViewProps>(
  function SomBurnView({ uri, pins, imageSize }, ref) {
    const aspect =
      imageSize && imageSize.width > 0 && imageSize.height > 0
        ? imageSize.height / imageSize.width
        : 1;
    const width = BURN_WIDTH;
    const height = Math.round(BURN_WIDTH * aspect);

    return (
      <View
        ref={ref}
        collapsable={false}
        // 离屏但已布局（不可见、不接触摸）→ 供 captureRef 软件重绘截取。
        style={{ position: 'absolute', left: -10000, top: 0, width, height }}
        pointerEvents="none"
      >
        {/* RN 内置 Image（软件 drawable，可被 view.draw 重画）；视图 = 图宽高比 → cover 即满铺无裁。 */}
        <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        {pins.map((p) => (
          // 静态绝对定位（动态像素位移 → 允许 inline，per nativewind-mapping 例外）；徽标 className 同 AnnotationPin。
          <View
            key={p.id}
            style={{
              position: 'absolute',
              left: p.nx * width - PIN_SIZE / 2,
              top: p.ny * height - PIN_SIZE / 2,
              width: PIN_SIZE,
              height: PIN_SIZE,
            }}
          >
            <View className="flex-1 rounded-full items-center justify-center border-2 border-white bg-brand-500">
              <Text className="text-xs font-bold text-white">{p.n}</Text>
            </View>
          </View>
        ))}
      </View>
    );
  },
);
