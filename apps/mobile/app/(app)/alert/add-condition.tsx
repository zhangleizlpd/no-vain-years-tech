import { Redirect } from 'expo-router';

import { AddConditionScreen, useAlertDraft } from '~/alert';

// 添加条件路由（021 屏 3）。无 params——标的/已加条件取共享草稿（屏 2 已 init）。
// 草稿未 init（深链硬刷新直达）→ 无上下文可编辑，回投资 tab。
export default function AddConditionRoute() {
  const inited = useAlertDraft((s) => s.initKey != null);

  if (!inited) {
    return <Redirect href="/(app)/(tabs)/portfolio" />;
  }

  return <AddConditionScreen />;
}
