import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { ListWatchlistGroupsUseCase } from './list-watchlist-groups.usecase';
import { CreateWatchlistGroupUseCase } from './create-watchlist-group.usecase';
import { ListWatchlistItemsUseCase } from './list-watchlist-items.usecase';
import { AddWatchlistItemUseCase } from './add-watchlist-item.usecase';
import { UpdateWatchlistItemUseCase } from './update-watchlist-item.usecase';
import { DeleteWatchlistItemUseCase } from './delete-watchlist-item.usecase';
import { HoldingsGroupReadonlyException } from './holdings-group-readonly.exception';
import { WatchlistItemNotFoundException } from './watchlist-item-not-found.exception';

// 013 T008 US2: 标的改/删 (固顶排序优先级 / 移到最前在固顶下方 / 改组 / 颜色笔记 / 持仓只读拒)。
// Testcontainers PG。run via `nx test server <file>` (cwd=apps/server) per memory。
describe('Watchlist items mutate use cases (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let createGroupUC: CreateWatchlistGroupUseCase;
  let listUC: ListWatchlistItemsUseCase;
  let addUC: AddWatchlistItemUseCase;
  let updateUC: UpdateWatchlistItemUseCase;
  let deleteUC: DeleteWatchlistItemUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    const groupLister = new ListWatchlistGroupsUseCase(prisma);
    createGroupUC = new CreateWatchlistGroupUseCase(prisma, groupLister);
    listUC = new ListWatchlistItemsUseCase(prisma);
    addUC = new AddWatchlistItemUseCase(prisma, listUC);
    updateUC = new UpdateWatchlistItemUseCase(prisma);
    deleteUC = new DeleteWatchlistItemUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextAccountId = (): bigint => BigInt(980_000 + ++seq);

  /** 在「自选」组顺序加入 codes, 返回 code → itemId 映射。 */
  async function seedWatchlist(accountId: bigint, codes: string[]): Promise<Map<string, string>> {
    for (const code of codes) await addUC.execute(accountId, 'watchlist', 'cn', code);
    const { items } = await listUC.execute(accountId, 'watchlist');
    return new Map(items.map((i) => [i.code, i.id]));
  }

  it('固顶 → 常驻组顶部 (pinned DESC)', async () => {
    const accountId = nextAccountId();
    const ids = await seedWatchlist(accountId, ['000001', '600519']);

    await updateUC.execute(accountId, ids.get('600519')!, { pinned: true });
    const { items } = await listUC.execute(accountId, 'watchlist');
    expect(items.map((i) => i.code)).toEqual(['600519', '000001']);
    expect(items[0]).toMatchObject({ pinned: true });
  });

  it('移到最前 → 落非固顶区头部 (在固顶项下方, FR-S05)', async () => {
    const accountId = nextAccountId();
    const ids = await seedWatchlist(accountId, ['A0001', 'B0002', 'C0003']);
    // 固顶 C → 顶部; 非固顶区 A, B。
    await updateUC.execute(accountId, ids.get('C0003')!, { pinned: true });
    // B 移到最前 → 非固顶头部 = C(固顶) 下方。
    await updateUC.execute(accountId, ids.get('B0002')!, { move: 'front' });

    const { items } = await listUC.execute(accountId, 'watchlist');
    expect(items.map((i) => i.code)).toEqual(['C0003', 'B0002', 'A0001']);
    expect(items[0].pinned).toBe(true);
    expect(items[1]).toMatchObject({ code: 'B0002', pinned: false });
  });

  it('改归属组 → item 移到目标组, 源组移出', async () => {
    const accountId = nextAccountId();
    const ids = await seedWatchlist(accountId, ['600519']);
    const { groups } = await createGroupUC.execute(accountId, '科技股');
    const customId = groups.find((g) => g.type === 'custom')!.id;

    const { items } = await updateUC.execute(accountId, ids.get('600519')!, {
      targetGroupId: customId,
    });
    // 受影响两组: 源自选(空) + 目标自定义(1)。
    expect(items.filter((i) => i.groupId === customId).map((i) => i.code)).toEqual(['600519']);
    expect((await listUC.execute(accountId, 'watchlist')).items).toHaveLength(0);
    expect((await listUC.execute(accountId, customId)).items).toHaveLength(1);
  });

  it('颜色 + 笔记 → 持久化', async () => {
    const accountId = nextAccountId();
    const ids = await seedWatchlist(accountId, ['600519']);
    await updateUC.execute(accountId, ids.get('600519')!, { color: '#E5484D', noteRef: 'note_x' });
    const { items } = await listUC.execute(accountId, 'watchlist');
    expect(items[0]).toMatchObject({ color: '#E5484D', noteRef: 'note_x' });
  });

  it('删标的 → 移除 + 剩余稠密化', async () => {
    const accountId = nextAccountId();
    const ids = await seedWatchlist(accountId, ['000001', '600519', '000002']);
    const { items } = await deleteUC.execute(accountId, ids.get('600519')!);
    expect(items.map((i) => i.code)).toEqual(['000001', '000002']);
    expect(items.map((i) => i.order)).toEqual([0, 1]); // 稠密 0-based
  });

  it('改不存在标的 → 404 WATCHLIST_ITEM_NOT_FOUND', async () => {
    const accountId = nextAccountId();
    await expect(updateUC.execute(accountId, '99999999', { pinned: true })).rejects.toBeInstanceOf(
      WatchlistItemNotFoundException,
    );
    await expect(deleteUC.execute(accountId, '99999999')).rejects.toBeInstanceOf(
      WatchlistItemNotFoundException,
    );
  });

  it('改归属到持仓组 (keyword) → 422 HOLDINGS_GROUP_READONLY', async () => {
    const accountId = nextAccountId();
    const ids = await seedWatchlist(accountId, ['600519']);
    await expect(
      updateUC.execute(accountId, ids.get('600519')!, { targetGroupId: 'holdings' }),
    ).rejects.toBeInstanceOf(HoldingsGroupReadonlyException);
  });

  it('改/删持仓组派生项 → 422 (防御; 直插持仓组项模拟未来持仓源)', async () => {
    const accountId = nextAccountId();
    await createGroupUC.execute(accountId, '科技股'); // materialize 系统组
    const holdings = await prisma.group.findFirst({
      where: { accountId, systemKind: 'holdings' },
    });
    const derived = await prisma.watchlistItem.create({
      data: { groupId: holdings!.id, market: 'cn', code: '600519', order: 0 },
    });

    await expect(
      updateUC.execute(accountId, derived.id.toString(), { color: '#fff' }),
    ).rejects.toBeInstanceOf(HoldingsGroupReadonlyException);
    await expect(deleteUC.execute(accountId, derived.id.toString())).rejects.toBeInstanceOf(
      HoldingsGroupReadonlyException,
    );
  });
});
