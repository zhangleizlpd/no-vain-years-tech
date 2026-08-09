import { GroupManagementScreen } from '~/portfolio';

// 屏3 分组管理 route（push from 投资 tab 末尾 ☰）。屏体在 ~/portfolio（per fe-directory-structure
// app/ 仅薄 route，业务在 src/<feature>/）。
export default function WatchlistGroupsRoute() {
  return <GroupManagementScreen />;
}
