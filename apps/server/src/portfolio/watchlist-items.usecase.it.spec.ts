import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { ListWatchlistGroupsUseCase } from './list-watchlist-groups.usecase';
import { CreateWatchlistGroupUseCase } from './create-watchlist-group.usecase';
import { ListWatchlistItemsUseCase } from './list-watchlist-items.usecase';
import { AddWatchlistItemUseCase } from './add-watchlist-item.usecase';
import { GroupNotFoundException } from './group-not-found.exception';
import { HoldingsGroupReadonlyException } from './holdings-group-readonly.exception';

// 013 T007 US2: 自选项 query + add (持仓组派生空 / 默认落自选 / materialize / 幂等)。
// Testcontainers PG。run via `nx test server <file>` (cwd=apps/server) per memory。
describe('Watchlist items query + add use cases (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let groupLister: ListWatchlistGroupsUseCase;
  let createGroupUC: CreateWatchlistGroupUseCase;
  let listUC: ListWatchlistItemsUseCase;
  let addUC: AddWatchlistItemUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    groupLister = new ListWatchlistGroupsUseCase(prisma);
    createGroupUC = new CreateWatchlistGroupUseCase(prisma, groupLister);
    listUC = new ListWatchlistItemsUseCase(prisma);
    addUC = new AddWatchlistItemUseCase(prisma, listUC);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextAccountId = (): bigint => BigInt(970_000 + ++seq);

  // ── list ─────────────────────────────────────────────────────────────────
  it('新账号 list watchlist/holdings keyword → 空 + 零写库', async () => {
    const accountId = nextAccountId();
    expect(await listUC.execute(accountId, 'watchlist')).toEqual({ items: [] });
    expect(await listUC.execute(accountId, 'holdings')).toEqual({ items: [] });
    // 零写库: 未 materialize 任何 group 行。
    expect(await prisma.group.count({ where: { accountId } })).toBe(0);
  });

  it('list 不存在数字组 → 404 GROUP_NOT_FOUND', async () => {
    const accountId = nextAccountId();
    await expect(listUC.execute(accountId, '99999999')).rejects.toBeInstanceOf(
      GroupNotFoundException,
    );
  });

  it('list 固顶区常驻顶: pinned DESC, order ASC', async () => {
    const accountId = nextAccountId();
    await addUC.execute(accountId, 'watchlist', 'cn', '000001'); // 非固顶 order 0
    await addUC.execute(accountId, 'watchlist', 'cn', '600519'); // 非固顶 order 1
    const watchlist = await prisma.group.findFirst({
      where: { accountId, systemKind: 'watchlist' },
    });
    // 手工固顶 600519 (T008 才有 pin UC; 这里直接置位验 list 读序)。
    await prisma.watchlistItem.updateMany({
      where: { groupId: watchlist!.id, code: '600519' },
      data: { pinned: true, order: 0 },
    });

    const { items } = await listUC.execute(accountId, 'watchlist');
    expect(items.map((i) => i.code)).toEqual(['600519', '000001']);
    expect(items[0]).toMatchObject({ pinned: true, market: 'cn' });
  });

  // ── add ──────────────────────────────────────────────────────────────────
  it('加 item 默认落自选 (keyword) → materialize 系统组 + 返该组 items', async () => {
    const accountId = nextAccountId();
    const { items } = await addUC.execute(accountId, 'watchlist', 'cn', '600519');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ market: 'cn', code: '600519', pinned: false, order: 0 });
    expect(items[0].id).toMatch(/^\d+$/);
    // materialize: 2 系统组真实行落地。
    expect(await prisma.group.count({ where: { accountId } })).toBe(2);
  });

  it('幂等重复加同标的 → 仍 1 项 (FR-M07)', async () => {
    const accountId = nextAccountId();
    await addUC.execute(accountId, 'watchlist', 'cn', '600519');
    const { items } = await addUC.execute(accountId, 'watchlist', 'cn', '600519');
    expect(items).toHaveLength(1);
  });

  it('加到自定义组 (数字 id) → 落该组', async () => {
    const accountId = nextAccountId();
    const { groups } = await createGroupUC.execute(accountId, '科技股');
    const customId = groups[2].id;

    const { items } = await addUC.execute(accountId, customId, 'cn', '000001');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ groupId: customId, code: '000001' });
    // 自选组仍空 (落到了自定义组)。
    expect((await listUC.execute(accountId, 'watchlist')).items).toHaveLength(0);
  });

  it('加到持仓组 (keyword holdings) → 422 HOLDINGS_GROUP_READONLY', async () => {
    const accountId = nextAccountId();
    await expect(addUC.execute(accountId, 'holdings', 'cn', '600519')).rejects.toBeInstanceOf(
      HoldingsGroupReadonlyException,
    );
  });

  it('加到持仓组 (真实数字 id) → 422 HOLDINGS_GROUP_READONLY', async () => {
    const accountId = nextAccountId();
    await createGroupUC.execute(accountId, '科技股'); // materialize 系统组
    const holdings = await prisma.group.findFirst({
      where: { accountId, systemKind: 'holdings' },
    });
    await expect(
      addUC.execute(accountId, holdings!.id.toString(), 'cn', '600519'),
    ).rejects.toBeInstanceOf(HoldingsGroupReadonlyException);
  });

  it('加到不存在数字组 → 404 GROUP_NOT_FOUND', async () => {
    const accountId = nextAccountId();
    await expect(addUC.execute(accountId, '99999999', 'cn', '600519')).rejects.toBeInstanceOf(
      GroupNotFoundException,
    );
  });
});
