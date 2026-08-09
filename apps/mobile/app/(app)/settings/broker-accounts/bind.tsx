import { MarketsRouteGuard } from '~/core/markets-gate';
import { BrokerBindScreen } from '~/portfolio';

// 薄 route — 绑定券商表单页（012 页 B）。导航标题「绑定券商」+ headerLeft 在
// settings/_layout 注册（route 名 broker-accounts/bind）。
// markets off（公开版）→ 守卫重定向回设置（deep-link 兜底）。
export default function BrokerBindRoute() {
  return (
    <MarketsRouteGuard redirect="/(app)/settings">
      <BrokerBindScreen />
    </MarketsRouteGuard>
  );
}
