import { TargetSelectScreen } from '~/alert';

// 预警对象选择路由（021 屏 4）。入口：屏 5 底栏「新建预警」。
// 屏体在 ~/alert（per fe-directory-structure：app/ 仅薄 route）。
export default function SelectTargetRoute() {
  return <TargetSelectScreen />;
}
