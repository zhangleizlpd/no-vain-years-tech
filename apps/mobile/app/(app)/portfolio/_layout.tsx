import { Stack } from 'expo-router';

import { MarketsRouteGuard } from '~/core/markets-gate';
import { makeHeaderBackOrParent } from '~/ui';

// 投资 push-screen 栈（自选分组管理等，不在底部 tab）。镜像 settings/_layout：tab 内 push
// 进来；web 硬刷新栈底空 → headerLeft 回落投资 tab（makeHeaderBackOrParent）。
// markets off（公开版）→ 整栈守卫重定向，堵 deep-link 直达 /portfolio/holdings、/portfolio/<symbol> 等。
export default function PortfolioLayout() {
  return (
    <MarketsRouteGuard redirect="/(app)/(tabs)/profile">
      <Stack screenOptions={{ headerShown: true }}>
        <Stack.Screen
          name="watchlist-groups"
          options={{
            title: '全部分组',
            headerLeft: makeHeaderBackOrParent('/(app)/(tabs)/portfolio'),
          }}
        />
        <Stack.Screen
          name="holdings"
          options={{
            title: '持仓',
            headerLeft: makeHeaderBackOrParent('/(app)/(tabs)/portfolio'),
          }}
        />
        {/* 交易历史标题动态（屏内 Stack.Screen 设 name+code）；web 硬刷新回落持仓屏。 */}
        <Stack.Screen
          name="trades/[symbol]"
          options={{ headerLeft: makeHeaderBackOrParent('/(app)/portfolio/holdings') }}
        />
        {/* 详情页自带 nav（T007 DetailTopNav，含返回兜底）→ 隐 navigator header。 */}
        <Stack.Screen name="[symbol]" options={{ headerShown: false }} />
      </Stack>
    </MarketsRouteGuard>
  );
}
