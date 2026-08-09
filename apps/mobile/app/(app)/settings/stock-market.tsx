import { MarketsRouteGuard } from '~/core/markets-gate';
import { StockMarketScreen } from '~/portfolio';

// 薄 route — 证券市场准入设置页（011）。导航标题 + headerLeft 在 settings/_layout 注册。
// markets off（公开版）→ 守卫重定向回设置（入口 Card 已隐，此为 deep-link 兜底）。
export default function StockMarketRoute() {
  return (
    <MarketsRouteGuard redirect="/(app)/settings">
      <StockMarketScreen />
    </MarketsRouteGuard>
  );
}
