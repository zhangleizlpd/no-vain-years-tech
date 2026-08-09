import { Stack } from 'expo-router';

import { ALERT_COPY } from '~/alert';
import { MarketsRouteGuard } from '~/core/markets-gate';
import { makeHeaderBackOrParent } from '~/ui';

// 预警 push-screen 栈（021，不在底部 tab）。镜像 portfolio/_layout：详情铃铛 / 工具栏入口
// push 进来。[symbol]/edit 的 headerLeft/headerRight 由屏内 Stack.Screen 动态设（symbol
// 相关 + 多选/提交态切换）；index/select-target 父级静态 → headerLeft 在此设硬刷新兜底。
// 预警 = 行情阈值功能（消费行情数据）→ markets off（公开版）整栈守卫重定向，堵 deep-link 直达 /alert/*。
export default function AlertLayout() {
  return (
    <MarketsRouteGuard redirect="/(app)/(tabs)/profile">
      <Stack screenOptions={{ headerShown: true }}>
        <Stack.Screen
          name="index"
          options={{
            title: ALERT_COPY.allAlerts.title,
            headerLeft: makeHeaderBackOrParent('/(app)/(tabs)/portfolio'),
          }}
        />
        <Stack.Screen name="[symbol]" options={{ title: ALERT_COPY.listScreen.title }} />
        <Stack.Screen name="edit" options={{ title: ALERT_COPY.editScreen.titleNew }} />
        <Stack.Screen name="add-condition" options={{ title: ALERT_COPY.addCondition.title }} />
        <Stack.Screen
          name="select-target"
          options={{
            title: ALERT_COPY.targetSelect.title,
            headerLeft: makeHeaderBackOrParent('/(app)/alert'),
          }}
        />
        <Stack.Screen
          name="messages"
          options={{
            title: ALERT_COPY.messages.title,
            // 工具栏信封直进（不经 alert index）→ 硬刷新兜底回 portfolio tab。
            headerLeft: makeHeaderBackOrParent('/(app)/(tabs)/portfolio'),
          }}
        />
      </Stack>
    </MarketsRouteGuard>
  );
}
