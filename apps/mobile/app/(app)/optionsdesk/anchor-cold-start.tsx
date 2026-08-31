import { AnchorColdStartScreen } from '~/optionsdesk';

// 072 T021 冷启动结局路由（薄 route，屏体在 ~/optionsdesk per fe-directory-structure）。
// 合规门控继承本栈 _layout 的 MarketsRouteGuard —— 屏内**不另写**判定。
export default function AnchorColdStartRoute() {
  return <AnchorColdStartScreen />;
}
