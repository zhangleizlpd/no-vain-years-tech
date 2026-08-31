import { useLocalSearchParams } from 'expo-router';

import { AnchorSubmissionDetailScreen } from '~/optionsdesk';

// 072 T019 审批详情路由（薄 route，屏体在 ~/optionsdesk per fe-directory-structure）。
// 合规门控继承本栈 _layout 的 MarketsRouteGuard —— 屏内**不另写**判定。
export default function AnchorSubmissionDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AnchorSubmissionDetailScreen id={id} />;
}
