// RegID 绑定生命周期 (022 T012, FR-002/FR-003)。平台中立：RegID 只在 android
// init 后 materialize（push-init 平台分流），web / iOS 路径所有触发点天然 no-op。
//
// 上报时机（双入口，谁后到谁触发）：
//   1. RegID 就绪（push-init 的 listener seam）&& 已登录 → PUT
//   2. 登录成功 transition（auth store 订阅）&& RegID 已在手 → 补 PUT
// 失败静默吞不记账 → 下次登录 transition / 下次启动（重新 init = 新模块状态 +
// listener 重触发）自动重试（FR-002「至迟下次启动」）。`reportedRegId` 防同
// RegID 重复 PUT（EP9 幂等，但省无谓请求）。
//
// 登出解绑（plan D9 best-effort）：经 auth/logout-all 的 pre-logout seam 注册，
// 在 server logout-all 调用**之前**执行 —— logout-all 会撤销 token，撤销后
// DELETE 必 401。失败（离线）不阻断登出：残留绑定靠转绑（EP9 全局唯一）/
// 推送命中 invalid 剔除双兜底。

import { pushBindingControllerDelete, pushBindingControllerUpsert } from '@nvy/api-client';

import { setPreLogoutHook } from '~/auth/logout-all';
import { useAuthStore } from '~/auth/store';

import { getRegistrationId, setRegistrationIdListener } from './push-init';

// 本次启动内已成功上报的 RegID（防重；失败不记账 → 天然重试）
let reportedRegId: string | null = null;

export interface BindingReportInput {
  regId: string | null;
  isAuthenticated: boolean;
  reportedRegId: string | null;
}

export function shouldReportBinding(input: BindingReportInput): boolean {
  return input.regId !== null && input.isAuthenticated && input.regId !== input.reportedRegId;
}

async function reportBinding(): Promise<void> {
  const regId = getRegistrationId();
  const { isAuthenticated } = useAuthStore.getState();
  if (!shouldReportBinding({ regId, isAuthenticated, reportedRegId })) return;
  try {
    await pushBindingControllerUpsert({ registrationId: regId as string, platform: 'android' });
    reportedRegId = regId;
  } catch {
    // FR-002: 失败静默吞，下次登录 transition / 下次启动重试
  }
}

export async function unbindPushBinding(): Promise<void> {
  const regId = getRegistrationId();
  // 无论 DELETE 成败都清记账：下次登录（含切账号转绑）必须重新上报
  reportedRegId = null;
  if (regId === null) return;
  try {
    await pushBindingControllerDelete(regId);
  } catch {
    // plan D9: best-effort，离线残留靠转绑 / invalid 清理双兜底
  }
}

export function initAlertPushBinding(): void {
  setRegistrationIdListener(() => {
    void reportBinding();
  });
  useAuthStore.subscribe((state, prev) => {
    if (state.isAuthenticated && !prev.isAuthenticated) void reportBinding();
  });
  setPreLogoutHook(unbindPushBinding);
}
