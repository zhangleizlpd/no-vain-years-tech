import { Stack } from 'expo-router';

import { MarketsRouteGuard } from '~/core/markets-gate';
import { makeHeaderBackOrParent } from '~/ui';

// 期权台 push-screen 栈（锚管理等，不在底部 tab）。镜像 portfolio/_layout：tab 内 push
// 进来；web 硬刷新栈底空 → headerLeft 回落期权台 tab（makeHeaderBackOrParent）。
// 二级页题头左上是**返回箭头**而非汉堡（FR-024）—— navigator header 自带，无需屏内自绘。
// markets off（公开版）→ 整栈守卫重定向，堵 deep-link 直达 /optionsdesk/anchors。
export default function OptionsdeskLayout() {
  return (
    <MarketsRouteGuard redirect="/(app)/(tabs)/profile">
      <Stack screenOptions={{ headerShown: true }}>
        <Stack.Screen
          name="anchors"
          options={{
            title: '锚管理',
            headerLeft: makeHeaderBackOrParent('/(app)/(tabs)/optionsdesk'),
          }}
        />
        {/* 锚表单两态（建 / 编辑）。title + headerRight「保存」由屏内 Stack.Screen 设，
            这里只兜住 web 硬刷新时栈底为空的 headerLeft 回落（→ 锚管理列表）。 */}
        <Stack.Screen
          name="anchor-new"
          options={{ headerLeft: makeHeaderBackOrParent('/(app)/optionsdesk/anchors') }}
        />
        <Stack.Screen
          name="anchor/[id]"
          options={{ headerLeft: makeHeaderBackOrParent('/(app)/optionsdesk/anchors') }}
        />
        {/* 046 T023 两个新屏：title 由屏内 Stack.Screen 设（详情页题头 = 标的名，045 plan D13；
            锚卡到手前先呈代号）；
            这里只兜住 web 硬刷新时栈底为空的 headerLeft 回落（→ 雷达 tab 落地屏）。 */}
        <Stack.Screen
          name="thermometer"
          options={{ headerLeft: makeHeaderBackOrParent('/(app)/(tabs)/optionsdesk') }}
        />
        <Stack.Screen
          name="underlying/[symbol]"
          options={{ headerLeft: makeHeaderBackOrParent('/(app)/(tabs)/optionsdesk') }}
        />
      </Stack>
    </MarketsRouteGuard>
  );
}
