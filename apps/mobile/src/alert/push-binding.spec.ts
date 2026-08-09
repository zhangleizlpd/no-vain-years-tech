import { beforeEach, describe, expect, it, vi } from 'vitest';

// expo-secure-store is pulled in transitively via auth/store.ts; mock it so
// the store module initialises cleanly in a Node environment (logout-all.spec
// 同款样板).
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
  deleteItemAsync: vi.fn().mockResolvedValue(undefined),
}));

const h = vi.hoisted(() => ({
  upsert: vi.fn(),
  del: vi.fn(),
  logoutEndpoint: vi.fn(),
  // 调用次序记录（登出解绑次序断言用）
  order: [] as string[],
  regId: null as string | null,
  regIdListener: null as ((regId: string) => void) | null,
}));

vi.mock('@nvy/api-client', () => ({
  pushBindingControllerUpsert: h.upsert,
  pushBindingControllerDelete: h.del,
  accountTokenControllerLogoutAll: h.logoutEndpoint,
}));

vi.mock('./push-init', () => ({
  getRegistrationId: () => h.regId,
  setRegistrationIdListener: (cb: (regId: string) => void) => {
    h.regIdListener = cb;
  },
}));

import { shouldReportBinding } from './push-binding';

// flush queued microtasks (listener 触发的 void promise)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('shouldReportBinding — 上报条件派生（纯函数）', () => {
  it('RegID 未就绪 → false', () => {
    expect(shouldReportBinding({ regId: null, isAuthenticated: true, reportedRegId: null })).toBe(
      false,
    );
  });

  it('未登录 → false', () => {
    expect(
      shouldReportBinding({ regId: 'reg-1', isAuthenticated: false, reportedRegId: null }),
    ).toBe(false);
  });

  it('同 RegID 本次启动已上报成功 → false（幂等防重）', () => {
    expect(
      shouldReportBinding({ regId: 'reg-1', isAuthenticated: true, reportedRegId: 'reg-1' }),
    ).toBe(false);
  });

  it('RegID 就绪 + 已登录 + 未上报 → true', () => {
    expect(
      shouldReportBinding({ regId: 'reg-1', isAuthenticated: true, reportedRegId: null }),
    ).toBe(true);
  });
});

describe('push-binding 生命周期（mock api-client + push-init seam）', () => {
  // 每 case 重置模块级状态（reportedRegId / preLogoutHook / store 订阅）
  let binding: typeof import('./push-binding');
  let store: typeof import('~/auth/store');
  let logout: typeof import('~/auth/logout-all');

  beforeEach(async () => {
    vi.resetModules();
    h.upsert.mockReset().mockImplementation(() => {
      h.order.push('upsert');
      return Promise.resolve({ status: 200 });
    });
    h.del.mockReset().mockImplementation(() => {
      h.order.push('delete-binding');
      return Promise.resolve({ status: 200 });
    });
    h.logoutEndpoint.mockReset().mockImplementation(() => {
      h.order.push('logout-endpoint');
      return Promise.resolve({ status: 204 });
    });
    h.order = [];
    h.regId = null;
    h.regIdListener = null;
    binding = await import('./push-binding');
    store = await import('~/auth/store');
    logout = await import('~/auth/logout-all');
  });

  function loginAs(accountId: string) {
    store.useAuthStore.setState({
      accountId,
      accessToken: 'at',
      refreshToken: 'rt',
      isAuthenticated: true,
    });
  }

  it('RegID 就绪且已登录 → 立即 PUT 上报（platform android）', async () => {
    loginAs('acc-1');
    binding.initAlertPushBinding();
    h.regId = 'reg-1';
    h.regIdListener?.('reg-1');
    await flush();

    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.upsert).toHaveBeenCalledWith({ registrationId: 'reg-1', platform: 'android' });
  });

  it('RegID 就绪但未登录 → 不上报；登录 transition 后补上报（FR-002）', async () => {
    store.useAuthStore.setState({ isAuthenticated: false });
    binding.initAlertPushBinding();
    h.regId = 'reg-1';
    h.regIdListener?.('reg-1');
    await flush();
    expect(h.upsert).not.toHaveBeenCalled();

    loginAs('acc-1');
    await flush();
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it('上报失败静默吞（不抛）→ 下次触发重试（重试条件 = 失败不记账）', async () => {
    loginAs('acc-1');
    binding.initAlertPushBinding();
    h.upsert.mockRejectedValueOnce(new Error('network'));
    h.regId = 'reg-1';
    h.regIdListener?.('reg-1');
    await flush();
    expect(h.upsert).toHaveBeenCalledTimes(1);

    // 重试入口：下次登录 transition（下次启动 = 重新 init，等价新模块状态）
    store.useAuthStore.setState({ isAuthenticated: false });
    loginAs('acc-1');
    await flush();
    expect(h.upsert).toHaveBeenCalledTimes(2);
  });

  it('同 RegID 上报成功后重复触发 → 不再 PUT（幂等防重）', async () => {
    loginAs('acc-1');
    binding.initAlertPushBinding();
    h.regId = 'reg-1';
    h.regIdListener?.('reg-1');
    await flush();
    h.regIdListener?.('reg-1');
    await flush();

    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it('登出次序：DELETE binding → server logout-all → clearSession（token 撤销前解绑）', async () => {
    loginAs('acc-1');
    binding.initAlertPushBinding();
    h.regId = 'reg-1';
    h.regIdListener?.('reg-1');
    await flush();
    h.order = [];

    await logout.logoutAll();

    expect(h.order).toEqual(['delete-binding', 'logout-endpoint']);
    expect(store.useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('登出时 DELETE 失败（离线）→ 不阻断登出（plan D9 best-effort）', async () => {
    loginAs('acc-1');
    binding.initAlertPushBinding();
    h.regId = 'reg-1';
    h.regIdListener?.('reg-1');
    await flush();
    h.del.mockRejectedValue(new Error('offline'));

    await expect(logout.logoutAll()).resolves.toBeUndefined();

    expect(h.logoutEndpoint).toHaveBeenCalledTimes(1);
    expect(store.useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('登出解绑后再登录（账号切换）→ 同 RegID 重新上报（转绑回流）', async () => {
    loginAs('acc-1');
    binding.initAlertPushBinding();
    h.regId = 'reg-1';
    h.regIdListener?.('reg-1');
    await flush();
    expect(h.upsert).toHaveBeenCalledTimes(1);

    await logout.logoutAll();
    loginAs('acc-2');
    await flush();

    expect(h.upsert).toHaveBeenCalledTimes(2);
  });
});
