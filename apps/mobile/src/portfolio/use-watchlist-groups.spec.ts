import { describe, expect, it, vi } from 'vitest';
import type { AxiosResponse } from 'axios';
import type { GroupItem, GroupListResponse } from '@nvy/api-client';

// 纯函数单测：mock @nvy/api-client（dist entry 在 vitest 不可解析；orval runtime hook 仅编排
// 用，被测纯函数不触达）。镜像 use-market-preferences.spec —— 仅 stub 本 impl 引入的 hook/getter。
vi.mock('@nvy/api-client', () => ({
  getWatchlistGroupsControllerListQueryKey: vi.fn(() => ['k']),
  useWatchlistGroupsControllerList: vi.fn(),
  useWatchlistGroupsControllerCreate: vi.fn(),
  useWatchlistGroupsControllerUpdate: vi.fn(),
  useWatchlistGroupsControllerDelete: vi.fn(),
  useWatchlistGroupsControllerReorder: vi.fn(),
}));

import { applyGroupReorderOptimistic, watchlistGroupErrorToast } from './use-watchlist-groups';
import { WATCHLIST_COPY } from './watchlist-copy';

const group = (over: Partial<GroupItem>): GroupItem => ({
  id: '1',
  name: '自选',
  type: 'system',
  systemKind: 'watchlist',
  visible: true,
  order: 0,
  itemCount: 0,
  ...over,
});

const resp = (groups: GroupItem[]): AxiosResponse<GroupListResponse> =>
  ({
    data: { groups },
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {},
  }) as AxiosResponse<GroupListResponse>;

const axErr = (status: number, code?: string) => ({
  isAxiosError: true,
  response: { status, data: code ? { status, title: 'x', code } : undefined },
});

describe('watchlistGroupErrorToast (错误分流)', () => {
  it('422 SYSTEM_GROUP_PROTECTED → 系统组保护文案', () => {
    expect(watchlistGroupErrorToast(axErr(422, 'SYSTEM_GROUP_PROTECTED'))).toBe(
      WATCHLIST_COPY.errorToast.systemProtected,
    );
  });
  it('404 GROUP_NOT_FOUND → 组不存在文案', () => {
    expect(watchlistGroupErrorToast(axErr(404, 'GROUP_NOT_FOUND'))).toBe(
      WATCHLIST_COPY.errorToast.groupNotFound,
    );
  });
  it('429 → 限流文案', () => {
    expect(watchlistGroupErrorToast(axErr(429))).toBe(WATCHLIST_COPY.errorToast.rateLimit);
  });
  it('5xx / 无 code → 网络文案', () => {
    expect(watchlistGroupErrorToast(axErr(503))).toBe(WATCHLIST_COPY.errorToast.network);
  });
  it('非 axios → 网络文案兜底', () => {
    expect(watchlistGroupErrorToast('nope')).toBe(WATCHLIST_COPY.errorToast.network);
  });
});

describe('applyGroupReorderOptimistic (乐观对账, 不可变)', () => {
  it('按 ordered 覆盖 order + visible 并重排升序', () => {
    const prev = resp([
      group({ id: 'watchlist', order: 0, visible: true }),
      group({ id: '10', name: '科技', type: 'custom', systemKind: null, order: 1, visible: true }),
    ]);
    const next = applyGroupReorderOptimistic(prev, [
      { groupId: '10', order: 0, visible: true },
      { groupId: 'watchlist', order: 1, visible: false },
    ]);
    expect(next.data.groups.map((g) => g.id)).toEqual(['10', 'watchlist']);
    expect(next.data.groups.find((g) => g.id === 'watchlist')?.visible).toBe(false);
  });
  it('未在 ordered 中的组保持原 order + 不 mutate 原对象', () => {
    const prev = resp([group({ id: 'watchlist', order: 0 })]);
    const next = applyGroupReorderOptimistic(prev, []);
    expect(next.data.groups[0]?.order).toBe(0);
    expect(next).not.toBe(prev);
  });
});
