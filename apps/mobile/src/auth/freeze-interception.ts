// FR-C03 FROZEN 登录拦截 — 004 专属 UI 数学 / 路由（纯函数）。
// 403 `ACCOUNT_IN_FREEZE_PERIOD` 的**识别**复用 canonical ProblemDetail 层
// `~/core/api/errors` 的 isFreezePeriod（per ADR-0038，单一真理源）；这里只放
// 该层没有的两件 004 专属事：剩余天数计算 + 撤销分支路由构造。

const DAY_MS = 24 * 60 * 60 * 1000;

// 剩余冻结天数 = ceil((freezeUntil - now) / 天)；下限 0（已过期不显负）。
// ceil：不足一天按一天算（「剩余 N 天」语义，今天没满也算还剩）。
export function remainingFreezeDays(freezeUntil: string, now: Date = new Date()): number {
  const diff = new Date(freezeUntil).getTime() - now.getTime();
  if (diff <= 0) return 0;
  return Math.ceil(diff / DAY_MS);
}

// 撤销分支路由：跳撤销屏 + 经查询参数预填手机号。encodeURIComponent 让 `+86` 的
// `+` 编码成 %2B（否则 URL query 里 `+` 会被解析成空格）；撤销屏 useLocalSearchParams 还原。
export function cancelDeletionPath(phone: string): string {
  return `/cancel-deletion?phone=${encodeURIComponent(phone)}`;
}
