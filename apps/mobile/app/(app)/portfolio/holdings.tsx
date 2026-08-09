import { HoldingsScreen } from '~/portfolio';

// 持仓屏薄路由（025 US2）。屏体在 ~/portfolio（per fe-directory-structure：app/ 仅薄 route）；
// nav 标题/返回由 portfolio/_layout Stack 提供（web 硬刷新回落投资 tab）。
export default function HoldingsRoute() {
  return <HoldingsScreen />;
}
