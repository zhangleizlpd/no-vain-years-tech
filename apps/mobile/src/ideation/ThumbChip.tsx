// ThumbChip — 033 多模态壳本地附件缩略图（B2-1 US2）。
//
// 58×58 rounded-lg + 本地 uri 背景图 + 右上角 × 移除按钮。client-only 本地 uri（无 OSS、
// 无网络），expo-image 直渲 file:// / content://。× 钮复用 ~/ui/IconButton（圆框原语）。
import { Image } from 'expo-image';
import { Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

export interface ThumbChipProps {
  /** 本地图片 uri（file:// / content://）。 */
  uri: string;
  /** 在缩略图排里的位置（testID 用，e2e 定位单个 chip）。 */
  index: number;
  onRemove: () => void;
  /** 036：点缩略图 → 进全屏查看器（FR-001）。缺省（033 旧调用）= 不可点。 */
  onPress?: () => void;
}

const THUMB = 58;

export function ThumbChip({ uri, index, onRemove, onPress }: ThumbChipProps) {
  return (
    <View
      className="rounded-lg overflow-hidden bg-surface-sunken"
      style={{ width: THUMB, height: THUMB }}
      testID={`ideation-thumb-${index}`}
    >
      <Pressable
        onPress={onPress}
        disabled={!onPress}
        accessibilityRole="imagebutton"
        accessibilityLabel="查看附件"
        testID={`ideation-thumb-open-${index}`}
        style={{ width: '100%', height: '100%' }}
      >
        <Image
          source={{ uri }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          accessibilityLabel="附件缩略图"
        />
      </Pressable>
      {/* 右上角 × 移除（IconButton 36×36 对 58px chip 偏大，用 20px 圆角 badge + hitSlop）。 */}
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="移除附件"
        testID={`ideation-thumb-remove-${index}`}
        className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-modal-overlay items-center justify-center"
      >
        <RemoveIcon />
      </Pressable>
    </View>
  );
}

function RemoveIcon() {
  return (
    <Svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M6 6 18 18" />
      <Path d="M18 6 6 18" />
    </Svg>
  );
}
