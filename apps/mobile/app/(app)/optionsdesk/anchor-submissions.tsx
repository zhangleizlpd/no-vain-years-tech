import { AnchorSubmissionListScreen } from '~/optionsdesk';

// 072 T018 待审估值列表路由（薄 route，屏体在 ~/optionsdesk per fe-directory-structure）。
// 合规门控继承本栈 _layout 的 MarketsRouteGuard —— 屏内**不另写**判定。
export default function AnchorSubmissionsRoute() {
  return <AnchorSubmissionListScreen />;
}
