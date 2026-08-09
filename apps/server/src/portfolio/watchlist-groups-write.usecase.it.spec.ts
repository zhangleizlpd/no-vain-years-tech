import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { FormValidationException } from '../security/form-validation.exception';
import { ListWatchlistGroupsUseCase } from './list-watchlist-groups.usecase';
import { CreateWatchlistGroupUseCase } from './create-watchlist-group.usecase';
import { UpdateWatchlistGroupUseCase } from './update-watchlist-group.usecase';
import { DeleteWatchlistGroupUseCase } from './delete-watchlist-group.usecase';
import { ReorderWatchlistGroupsUseCase } from './reorder-watchlist-groups.usecase';
import { SystemGroupProtectedException } from './system-group-protected.exception';
import { GroupNotFoundException } from './group-not-found.exception';

// 013 T005 US1: 分组写 (建/改名/删回落/reorder + 系统组保护)。Testcontainers PG。
// run via `nx test server <file>` (cwd=apps/server) per memory testcontainers_spec_run_via_nx_cwd。
describe('Watchlist groups write use cases (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let lister: ListWatchlistGroupsUseCase;
  let createUC: CreateWatchlistGroupUseCase;
  let updateUC: UpdateWatchlistGroupUseCase;
  let deleteUC: DeleteWatchlistGroupUseCase;
  let reorderUC: ReorderWatchlistGroupsUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    lister = new ListWatchlistGroupsUseCase(prisma);
    createUC = new CreateWatchlistGroupUseCase(prisma, lister);
    updateUC = new UpdateWatchlistGroupUseCase(prisma, lister);
    deleteUC = new DeleteWatchlistGroupUseCase(prisma, lister);
    reorderUC = new ReorderWatchlistGroupsUseCase(prisma, lister);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextAccountId = (): bigint => BigInt(960_000 + ++seq);

  it('建自定义组 → materialize 2 系统组 + custom(order 2), 返全量', async () => {
    const accountId = nextAccountId();
    const { groups } = await createUC.execute(accountId, '科技股');

    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.systemKind)).toEqual(['watchlist', 'holdings', null]);
    expect(groups[2]).toMatchObject({ name: '科技股', type: 'custom', order: 2, itemCount: 0 });
    // 真实数字 id (非 keyword)。
    expect(groups[0].id).toMatch(/^\d+$/);
  });

  it('建重名组 → 400 FORM_VALIDATION', async () => {
    const accountId = nextAccountId();
    await createUC.execute(accountId, '科技股');
    await expect(createUC.execute(accountId, '科技股')).rejects.toBeInstanceOf(
      FormValidationException,
    );
  });

  it('改自定义组名 → 生效', async () => {
    const accountId = nextAccountId();
    const { groups } = await createUC.execute(accountId, '科技股');
    const customId = groups[2].id;

    const after = await updateUC.execute(accountId, customId, '价值股');
    expect(after.groups.find((g) => g.id === customId)?.name).toBe('价值股');
  });

  it('改系统组名 (keyword 与 真实数字 id 两形) → 422 SYSTEM_GROUP_PROTECTED', async () => {
    const accountId = nextAccountId();
    const { groups } = await createUC.execute(accountId, '科技股'); // materialize 系统组
    const watchlistRealId = groups[0].id;

    await expect(updateUC.execute(accountId, 'watchlist', '改名')).rejects.toBeInstanceOf(
      SystemGroupProtectedException,
    );
    await expect(updateUC.execute(accountId, watchlistRealId, '改名')).rejects.toBeInstanceOf(
      SystemGroupProtectedException,
    );
  });

  it('改不存在组 → 404 GROUP_NOT_FOUND', async () => {
    const accountId = nextAccountId();
    await expect(updateUC.execute(accountId, '99999999', 'x')).rejects.toBeInstanceOf(
      GroupNotFoundException,
    );
  });

  it('删非空自定义组 → item 回落自选不丢 + 冲突项丢弃幂等, 组删除', async () => {
    const accountId = nextAccountId();
    const { groups } = await createUC.execute(accountId, '科技股');
    const watchlistId = BigInt(groups[0].id);
    const customId = BigInt(groups[2].id);

    // 自选已有 cn:600519; custom 有 cn:600519(冲突) + cn:000001(非冲突)。
    await prisma.watchlistItem.create({
      data: { groupId: watchlistId, market: 'cn', code: '600519', order: 0 },
    });
    await prisma.watchlistItem.create({
      data: { groupId: customId, market: 'cn', code: '600519', order: 0 },
    });
    await prisma.watchlistItem.create({
      data: { groupId: customId, market: 'cn', code: '000001', order: 1 },
    });

    const after = await deleteUC.execute(accountId, customId.toString());

    // custom 组消失。
    expect(after.groups.some((g) => g.id === customId.toString())).toBe(false);
    // 自选: 600519(原) + 000001(迁入) = 2 项; 冲突 600519(custom 那条) 被丢弃。
    const watchlistItems = await prisma.watchlistItem.findMany({
      where: { groupId: watchlistId },
      orderBy: { code: 'asc' },
    });
    expect(watchlistItems.map((i) => i.code)).toEqual(['000001', '600519']);
    // custom 组无残留 item。
    expect(await prisma.watchlistItem.count({ where: { groupId: customId } })).toBe(0);
  });

  it('删系统组 (keyword) → 422 SYSTEM_GROUP_PROTECTED', async () => {
    const accountId = nextAccountId();
    await createUC.execute(accountId, '科技股');
    await expect(deleteUC.execute(accountId, 'holdings')).rejects.toBeInstanceOf(
      SystemGroupProtectedException,
    );
  });

  it('reorder (新账号 keyword ids) → materialize + order/visible 持久化', async () => {
    const accountId = nextAccountId();
    // 新账号未写过, 用 keyword 形 id 拖拽: 持仓置顶可见, 自选隐藏。
    const { groups } = await reorderUC.execute(accountId, [
      { groupId: 'holdings', order: 0, visible: true },
      { groupId: 'watchlist', order: 1, visible: false },
    ]);

    const byKind = new Map(groups.map((g) => [g.systemKind, g]));
    expect(byKind.get('holdings')).toMatchObject({ order: 0, visible: true });
    expect(byKind.get('watchlist')).toMatchObject({ order: 1, visible: false });
    // 升序返回 → 持仓在前。
    expect(groups[0].systemKind).toBe('holdings');
  });
});
