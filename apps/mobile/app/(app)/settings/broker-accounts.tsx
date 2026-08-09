import { MarketsRouteGuard } from '~/core/markets-gate';
import { BrokerAccountListScreen } from '~/portfolio';

// 薄 route — 券商账户列表页（012 页 A）。导航标题 + headerLeft 在 settings/_layout 注册；
// 右上「新建」headerRight 由 screen 内 <Stack.Screen options> 动态提供。
// markets off（公开版）→ 守卫重定向回设置（入口 Card 已隐，此为 deep-link 兜底）。
export default function BrokerAccountsRoute() {
  return (
    <MarketsRouteGuard redirect="/(app)/settings">
      <BrokerAccountListScreen />
    </MarketsRouteGuard>
  );
}
