import { AllAlertsScreen } from '~/alert';

// 全部预警路由（021 屏 5）。入口：013 工具栏铃铛（T021）/ 屏 1 右上「全部预警」。
// 屏体在 ~/alert（per fe-directory-structure：app/ 仅薄 route）。
export default function AllAlertsRoute() {
  return <AllAlertsScreen />;
}
