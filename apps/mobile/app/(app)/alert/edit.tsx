import { Redirect, useLocalSearchParams } from 'expo-router';

import { AlertEditScreen } from '~/alert';

// 编辑/新建预警路由（021 屏 2）。params 二选一：`alertId`（编辑）或 `instruments`
// （新建，逗号分隔 canonical symbols `cn:603305,cn:600519`——屏 1 单只 / 屏 4 批量）。
// 两者皆缺（手敲 URL）→ 回投资 tab。屏体在 ~/alert（app/ 仅薄 route）。
export default function AlertEditRoute() {
  const { alertId, instruments } = useLocalSearchParams<{
    alertId?: string;
    instruments?: string;
  }>();

  if (typeof alertId === 'string' && alertId !== '') {
    return <AlertEditScreen alertId={alertId} />;
  }

  const parsed =
    typeof instruments === 'string'
      ? instruments
          .split(',')
          .map((s) => s.split(':'))
          .filter((p): p is [string, string] => p.length === 2 && p[0] !== '' && p[1] !== '')
          .map(([market, code]) => ({ market, code }))
      : [];

  if (parsed.length === 0) {
    return <Redirect href="/(app)/(tabs)/portfolio" />;
  }

  return <AlertEditScreen instruments={parsed} />;
}
