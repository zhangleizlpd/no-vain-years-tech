// 032 T012 — ideation Stack 脚手架，现挂在「灵感」tab 内（app/(app)/(tabs)/ideation/）。
// 两屏：index（会话列表，US2 T018）+ [id]（会话详情：澄清对话 + brief，T015/T016）。
//
// index 是 tab 根屏 → 无 headerLeft（tab 切换即导航，不挂返回箭头）。
// [id] header back 回退兜底（web 硬刷新无栈底，per Expo Router web refresh 范式）→ 回列表。
import { Stack } from 'expo-router';

import { makeHeaderBackOrParent } from '~/ui';

export default function IdeationLayout() {
  return (
    <Stack screenOptions={{ headerShown: true }}>
      <Stack.Screen
        name="index"
        options={{
          title: '需求灵感',
        }}
      />
      <Stack.Screen
        name="[id]"
        options={{
          // title 由 [id].tsx 据 session.title（灵感名称）动态覆盖；此处仅加载前占位。
          title: '需求灵感',
          headerLeft: makeHeaderBackOrParent('/(app)/(tabs)/ideation'),
        }}
      />
      <Stack.Screen
        name="mockups"
        options={{
          // 037 T011 设计稿区（从 session 进入）；title 由屏内 Stack.Screen 覆盖。
          title: '设计稿',
          headerLeft: makeHeaderBackOrParent('/(app)/(tabs)/ideation'),
        }}
      />
    </Stack>
  );
}
