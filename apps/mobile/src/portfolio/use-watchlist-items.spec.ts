import { describe, expect, it, vi } from 'vitest';
import type { AxiosResponse } from 'axios';
import type { ItemListResponse, WatchlistItemView } from '@nvy/api-client';

// 纯函数单测：mock @nvy/api-client（dist entry 在 vitest 不可解析；orval runtime hook 仅编排
// 用，被测纯函数不触达）。镜像 use-market-preferences.spec —— 仅 stub 本 impl 引入的 hook/getter。
vi.mock('@nvy/api-client', () => ({
  getWatchlistGroupsControllerListItemsQueryKey: vi.fn((g: string) => ['items', g]),
  getWatchlistGroupsControllerListQueryKey: vi.fn(() => ['groups']),
  useWatchlistGroupsControllerListItems: vi.fn(),
  useWatchlistGroupsControllerAddItem: vi.fn(),
  useWatchlistItemsControllerUpdate: vi.fn(),
  useWatchlistItemsControllerDelete: vi.fn(),
}));

import {
  applyItemPatchOptimistic,
  sortItemsPinFirst,
  watchlistItemErrorToast,
} from './use-watchlist-items';
import { WATCHLIST_COPY } from './watchlist-copy';

const item = (over: Partial<WatchlistItemView>): WatchlistItemView => ({
  id: '1',
  groupId: 'watchlist',
  market: 'cn',
  code: '600519',
  pinned: false,
  order: 0,
  color: null,
  noteRef: null,
  ...over,
});

const resp = (items: WatchlistItemView[]): AxiosResponse<ItemListResponse> =>
  ({
    data: { items },
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {},
  }) as AxiosResponse<ItemListResponse>;

const axErr = (status: number, code?: string) => ({
  isAxiosError: true,
  response: { status, data: code ? { status, title: 'x', code } : undefined },
});

describe('watchlistItemErrorToast (错误分流)', () => {
  it('422 HOLDINGS_GROUP_READONLY → 持仓只读文案', () => {
    expect(watchlistItemErrorToast(axErr(422, 'HOLDINGS_GROUP_READONLY'))).toBe(
      WATCHLIST_COPY.errorToast.holdingsReadonly,
    );
  });
  it('404 WATCHLIST_ITEM_NOT_FOUND → 项不存在文案', () => {
    expect(watchlistItemErrorToast(axErr(404, 'WATCHLIST_ITEM_NOT_FOUND'))).toBe(
      WATCHLIST_COPY.errorToast.itemNotFound,
    );
  });
  it('429 → 限流文案', () => {
    expect(watchlistItemErrorToast(axErr(429))).toBe(WATCHLIST_COPY.errorToast.rateLimit);
  });
  it('5xx / 无 code → 网络文案', () => {
    expect(watchlistItemErrorToast(axErr(500))).toBe(WATCHLIST_COPY.errorToast.network);
  });
  it('非 axios → 网络文案兜底', () => {
    expect(watchlistItemErrorToast(new Error('boom'))).toBe(WATCHLIST_COPY.errorToast.network);
  });
});

describe('sortItemsPinFirst (固顶区在前 + 各区 order 升序, FR-S05)', () => {
  it('固顶项排到非固顶项之前, 区内按 order', () => {
    const sorted = sortItemsPinFirst([
      item({ id: 'a', pinned: false, order: 0 }),
      item({ id: 'b', pinned: true, order: 1 }),
      item({ id: 'c', pinned: true, order: 0 }),
      item({ id: 'd', pinned: false, order: 1 }),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(['c', 'b', 'a', 'd']);
  });
  it('不 mutate 原数组', () => {
    const input = [item({ id: 'a', order: 1 }), item({ id: 'b', order: 0 })];
    sortItemsPinFirst(input);
    expect(input.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('applyItemPatchOptimistic (乐观对账, 不可变)', () => {
  it('固顶某项 → 该项移到顶部 + 原对象不被 mutate', () => {
    const prev = resp([
      item({ id: 'a', pinned: false, order: 0 }),
      item({ id: 'b', pinned: false, order: 1 }),
    ]);
    const next = applyItemPatchOptimistic(prev, 'b', { pinned: true });
    expect(next.data.items[0]?.id).toBe('b');
    expect(next.data.items[0]?.pinned).toBe(true);
    // 原对象未被 mutate
    expect(prev.data.items.find((i) => i.id === 'b')?.pinned).toBe(false);
    expect(next).not.toBe(prev);
  });
  it('改颜色 → 仅目标行 color 变, 其余不动', () => {
    const prev = resp([item({ id: 'a', color: null }), item({ id: 'b', color: null })]);
    const next = applyItemPatchOptimistic(prev, 'a', { color: 'blue' });
    expect(next.data.items.find((i) => i.id === 'a')?.color).toBe('blue');
    expect(next.data.items.find((i) => i.id === 'b')?.color).toBeNull();
  });
  it('清笔记 (noteRef=null) 可表达', () => {
    const prev = resp([item({ id: 'a', noteRef: 'note-1' })]);
    const next = applyItemPatchOptimistic(prev, 'a', { noteRef: null });
    expect(next.data.items[0]?.noteRef).toBeNull();
  });
});
