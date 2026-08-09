import { MarketsRouteGuard } from '~/core/markets-gate';
import { WatchlistMainScreen } from '~/portfolio';

// 投资 tab 落地页 = 自选主列表（013 屏1，D6）。屏体在 ~/portfolio（per fe-directory-structure
// app/ 仅薄 route）。点底部「投资」tab 直接进；末尾 ☰ → 分组管理 push screen。
// markets off（公开版）→ 守卫重定向，堵 deep-link 直达 /portfolio（tab 按钮已在 _layout 隐藏）。
export default function PortfolioTab() {
  return (
    <MarketsRouteGuard redirect="/(app)/(tabs)/profile">
      <WatchlistMainScreen />
    </MarketsRouteGuard>
  );
}
