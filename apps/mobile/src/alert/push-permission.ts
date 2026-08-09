// 系统通知权限检测 — web stub。web 无推送（D7），恒报 enabled → 设置页
// 引导行永不显示（T013 e2e 断言）。

export async function isNotificationEnabled(): Promise<boolean> {
  return true;
}

export function openSystemNotificationSettings(): void {
  // no-op on web
}
