import { describe, it, expect, vi } from 'vitest';
import { WatchlistGroupsController } from './watchlist-groups.controller';
import type { ListWatchlistGroupsUseCase } from './list-watchlist-groups.usecase';
import type { CreateWatchlistGroupUseCase } from './create-watchlist-group.usecase';
import type { UpdateWatchlistGroupUseCase } from './update-watchlist-group.usecase';
import type { DeleteWatchlistGroupUseCase } from './delete-watchlist-group.usecase';
import type { ReorderWatchlistGroupsUseCase } from './reorder-watchlist-groups.usecase';
import type { ListWatchlistItemsUseCase } from './list-watchlist-items.usecase';
import type { AddWatchlistItemUseCase } from './add-watchlist-item.usecase';
import { SystemGroupProtectedException } from './system-group-protected.exception';

const GROUPS = {
  groups: [
    {
      id: 'watchlist',
      name: '自选',
      type: 'system' as const,
      systemKind: 'watchlist' as const,
      visible: true,
      order: 0,
      itemCount: 0,
    },
  ],
};

const ITEMS = {
  items: [
    {
      id: '101',
      groupId: '1',
      market: 'cn',
      code: '600519',
      pinned: false,
      order: 0,
      color: null,
      noteRef: null,
    },
  ],
};

function build() {
  const listExecute = vi.fn().mockResolvedValue(GROUPS);
  const createExecute = vi.fn().mockResolvedValue(GROUPS);
  const updateExecute = vi.fn().mockResolvedValue(GROUPS);
  const deleteExecute = vi.fn().mockResolvedValue(GROUPS);
  const reorderExecute = vi.fn().mockResolvedValue(GROUPS);
  const listItemsExecute = vi.fn().mockResolvedValue(ITEMS);
  const addItemExecute = vi.fn().mockResolvedValue(ITEMS);
  const controller = new WatchlistGroupsController(
    { execute: listExecute } as unknown as ListWatchlistGroupsUseCase,
    { execute: createExecute } as unknown as CreateWatchlistGroupUseCase,
    { execute: updateExecute } as unknown as UpdateWatchlistGroupUseCase,
    { execute: deleteExecute } as unknown as DeleteWatchlistGroupUseCase,
    { execute: reorderExecute } as unknown as ReorderWatchlistGroupsUseCase,
    { execute: listItemsExecute } as unknown as ListWatchlistItemsUseCase,
    { execute: addItemExecute } as unknown as AddWatchlistItemUseCase,
  );
  return {
    controller,
    listExecute,
    createExecute,
    updateExecute,
    deleteExecute,
    reorderExecute,
    listItemsExecute,
    addItemExecute,
  };
}

const REQ = { user: { accountId: 42n, isAdmin: false } };

describe('WatchlistGroupsController', () => {
  it('GET → delegates accountId, 返 groups', async () => {
    const { controller, listExecute } = build();
    const res = await controller.list(REQ);
    expect(listExecute).toHaveBeenCalledWith(42n);
    expect(res.groups[0].id).toBe('watchlist');
  });

  it('POST → 透传 (accountId, name)', async () => {
    const { controller, createExecute } = build();
    await controller.create(REQ, { name: '科技股' });
    expect(createExecute).toHaveBeenCalledWith(42n, '科技股');
  });

  it('PATCH (reorder) → 透传 (accountId, ordered)', async () => {
    const { controller, reorderExecute } = build();
    const ordered = [{ groupId: 'watchlist', order: 0, visible: true }];
    await controller.reorder(REQ, { ordered });
    expect(reorderExecute).toHaveBeenCalledWith(42n, ordered);
  });

  it('PATCH :groupId → 透传 (accountId, groupId 原样 string, name)', async () => {
    const { controller, updateExecute } = build();
    await controller.update(REQ, '42', { name: '价值股' });
    expect(updateExecute).toHaveBeenCalledWith(42n, '42', '价值股');
  });

  it('PATCH :groupId (keyword) → 透传 keyword 原样 (UC 拒系统组)', async () => {
    const { controller, updateExecute } = build();
    updateExecute.mockRejectedValueOnce(new SystemGroupProtectedException());
    await expect(controller.update(REQ, 'watchlist', { name: 'x' })).rejects.toBeInstanceOf(
      SystemGroupProtectedException,
    );
    expect(updateExecute).toHaveBeenCalledWith(42n, 'watchlist', 'x');
  });

  it('DELETE :groupId → 透传 (accountId, groupId 原样 string)', async () => {
    const { controller, deleteExecute } = build();
    await controller.delete(REQ, '42');
    expect(deleteExecute).toHaveBeenCalledWith(42n, '42');
  });

  it('GET :groupId/items → 透传 (accountId, groupId 原样), 返 items', async () => {
    const { controller, listItemsExecute } = build();
    const res = await controller.listItems(REQ, 'watchlist');
    expect(listItemsExecute).toHaveBeenCalledWith(42n, 'watchlist');
    expect(res.items[0].code).toBe('600519');
  });

  it('POST :groupId/items → 透传 (accountId, groupId, market, code)', async () => {
    const { controller, addItemExecute } = build();
    await controller.addItem(REQ, 'watchlist', { market: 'cn', code: '600519' });
    expect(addItemExecute).toHaveBeenCalledWith(42n, 'watchlist', 'cn', '600519');
  });
});
