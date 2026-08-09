// 资料卡行右侧缩略图（009 FR-C04）。圆形 = 头像、圆角矩形 = 背景图；null → 空占位框
// （回落不回归，FR-C06）。外层 View overflow-hidden 裁形，内 expo-image 填满（OSS 缩略派生）。
import { Image } from 'expo-image';
import { View } from 'react-native';

import { ossThumbCacheKey, ossThumbUrl } from './oss-image';

const THUMB = { width: 80, height: 80 };

export function ProfileImageThumb({
  url,
  shape,
}: {
  url: string | null;
  shape: 'circle' | 'rounded';
}) {
  const radius = shape === 'circle' ? 'rounded-full' : 'rounded-sm';
  return (
    <View className={`w-7 h-7 ${radius} overflow-hidden bg-surface-sunken`}>
      {url ? (
        <Image
          source={{ uri: ossThumbUrl(url, THUMB), cacheKey: ossThumbCacheKey(url, THUMB) }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          accessibilityLabel="缩略图"
        />
      ) : null}
    </View>
  );
}
