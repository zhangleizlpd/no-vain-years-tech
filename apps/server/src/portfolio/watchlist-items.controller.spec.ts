import { describe, it, expect, vi } from 'vitest';
import { WatchlistItemsController } from './watchlist-items.controller';
import type { UpdateWatchlistItemUseCase } from './update-watchlist-item.usecase';
import type { DeleteWatchlistItemUseCase } from './delete-watchlist-item.usecase';
import { HoldingsGroupReadonlyException } from './holdings-group-readonly.exception';

const ITEMS = {
  items: [
    {
      id: '101',
      groupId: '1',
      market: 'cn',
      code: '600519',
      pinned: true,
      order: 0,
      color: null,
      noteRef: null,
    },
  ],
};

function build() {
  const updateExecute = vi.fn().mockResolvedValue(ITEMS);
  const deleteExecute = vi.fn().mockResolvedValue(ITEMS);
  const controller = new WatchlistItemsController(
    { execute: updateExecute } as unknown as UpdateWatchlistItemUseCase,
    { execute: deleteExecute } as unknown as DeleteWatchlistItemUseCase,
  );
  return { controller, updateExecute, deleteExecute };
}

const REQ = { user: { accountId: 42n, isAdmin: false } };

describe('WatchlistItemsController', () => {
  it('PATCH :itemId → 透传 (accountId, itemId 原样, body)', async () => {
    const { controller, updateExecute } = build();
    const body = { pinned: true };
    const res = await controller.update(REQ, '101', body);
    expect(updateExecute).toHaveBeenCalledWith(42n, '101', body);
    expect(res.items[0].pinned).toBe(true);
  });

  it('PATCH :itemId (改归属持仓组) → UC 拒 422 透传', async () => {
    const { controller, updateExecute } = build();
    updateExecute.mockRejectedValueOnce(new HoldingsGroupReadonlyException());
    await expect(
      controller.update(REQ, '101', { targetGroupId: 'holdings' }),
    ).rejects.toBeInstanceOf(HoldingsGroupReadonlyException);
  });

  it('DELETE :itemId → 透传 (accountId, itemId 原样)', async () => {
    const { controller, deleteExecute } = build();
    await controller.delete(REQ, '101');
    expect(deleteExecute).toHaveBeenCalledWith(42n, '101');
  });
});
