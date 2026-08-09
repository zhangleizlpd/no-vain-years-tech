import { MarketsRouteGuard } from '~/core/markets-gate';
import { RadarScreen } from '~/optionsdesk';

// 期权台 tab 落地页 = 击球区雷达（045 US2/US3）。屏体在 ~/optionsdesk（per fe-directory-structure
// app/ 仅薄 route）。点底部「期权台」tab 直接进；题头 ⚙ → 锚管理 push screen。
// markets off（公开版）→ 守卫重定向，堵 deep-link 直达 /optionsdesk（tab 按钮已在 _layout 隐藏）。
export default function OptionsdeskTab() {
  return (
    <MarketsRouteGuard redirect="/(app)/(tabs)/profile">
      <RadarScreen />
    </MarketsRouteGuard>
  );
}
