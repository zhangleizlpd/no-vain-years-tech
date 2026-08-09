// 036 T010 — 图片全屏查看器屏（B2-3 US1，mockup 帧②）。
//
// 全屏暗底 + content-fit 原图 + **仅居中一个「编辑/标注」入口**（FR-001 去保存/分享）。
// 点「编辑/标注」→ push 标注画布屏（image-annotate）。返回 = header back（暂存图保留可重进）。
// 路由屏 = app/ 树下只放路由屏（可复用组件/纯函数在 src/ideation/image-annotate/，per Expo
// Router app/ 扫描铁律 + fe-directory-structure）。
import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { ideationImageAnnotateRoute, type ImageViewerParams } from '~/ideation';

export default function IdeationImageViewerScreen() {
  const { uri, index, sessionId } = useLocalSearchParams<ImageViewerParams>();

  const onEdit = () => {
    if (!uri || index === undefined || !sessionId) return;
    router.push(ideationImageAnnotateRoute({ uri, index, sessionId }));
  };

  return (
    <View className="flex-1 bg-black" testID="ideation-image-viewer">
      <Stack.Screen
        options={{ title: '查看图片', headerTransparent: true, headerTintColor: '#fff' }}
      />

      {/* 全屏原图（content-fit contain 居中）。 */}
      <View className="flex-1 items-center justify-center">
        {uri ? (
          <Image
            source={{ uri }}
            style={{ width: '100%', height: '100%' }}
            contentFit="contain"
            accessibilityLabel="查看图片"
          />
        ) : null}
      </View>

      {/* 唯一居中入口「编辑/标注」（FR-001 无保存/分享）。 */}
      <View className="absolute bottom-12 inset-x-0 items-center">
        <Pressable
          onPress={onEdit}
          accessibilityRole="button"
          accessibilityLabel="编辑/标注"
          testID="ideation-image-edit-entry"
          className="h-12 px-xl rounded-full bg-brand-500 items-center justify-center shadow-cta active:bg-brand-600"
        >
          <Text className="text-base font-semibold text-white">编辑/标注</Text>
        </Pressable>
      </View>
    </View>
  );
}
