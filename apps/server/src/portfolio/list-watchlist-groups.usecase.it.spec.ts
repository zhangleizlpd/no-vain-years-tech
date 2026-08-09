import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { ListWatchlistGroupsUseCase } from './list-watchlist-groups.usecase';

// 013 T004 US1 EP1: 列出账号分组 (虚拟系统组投影 + itemCount + 跨账号隔离)。
// run via `nx test server <file>` (cwd=apps/server) per memory testcontainers_spec_run_via_nx_cwd。
describe('ListWatchlistGroupsUseCase (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let usecase: ListWatchlistGroupsUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    usecase = new ListWatchlistGroupsUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextAccountId = (): bigint => BigInt(940_000 + ++seq);

  it('新账号 (零写库) → 投影恰 2 虚拟系统组 (自选 order 0 / 持仓 order 1, id=systemKind, itemCount 0)', async () => {
    const accountId = nextAccountId();
    const { groups } = await usecase.execute(accountId);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      id: 'watchlist',
      name: '自选',
      type: 'system',
      systemKind: 'watchlist',
      visible: true,
      order: 0,
      itemCount: 0,
    });
    expect(groups[1]).toEqual({
      id: 'holdings',
      name: '我的持仓',
      type: 'system',
      systemKind: 'holdings',
      visible: true,
      order: 1,
      itemCount: 0,
    });
  });

  it('已 materialize 系统组 + 自定义组 + items → 读回真实数字 id, itemCount 准, 按 order 升序', async () => {
    const accountId = nextAccountId();
    // materialize 2 系统组 + 1 自定义组 (order 2)。
    const watchlist = await prisma.group.create({
      data: { accountId, name: '自选', type: 'system', systemKind: 'watchlist', order: 0 },
    });
    await prisma.group.create({
      data: { accountId, name: '持仓', type: 'system', systemKind: 'holdings', order: 1 },
    });
    const custom = await prisma.group.create({
      data: { accountId, name: '科技股', type: 'custom', systemKind: null, order: 2 },
    });
    // 自选 2 项 / 自定义 1 项 / 持仓 0 项。
    await prisma.watchlistItem.create({
      data: { groupId: watchlist.id, market: 'cn', code: '600519', order: 0 },
    });
    await prisma.watchlistItem.create({
      data: { groupId: watchlist.id, market: 'hk', code: '00700', order: 1 },
    });
    await prisma.watchlistItem.create({
      data: { groupId: custom.id, market: 'us', code: 'AAPL', order: 0 },
    });

    const { groups } = await usecase.execute(accountId);

    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.systemKind)).toEqual(['watchlist', 'holdings', null]);
    // 系统组名恒取常量: 已 materialize 行 row.name='持仓'(旧名) 不显示, 读回常量「我的持仓」。
    expect(groups[0].name).toBe('自选');
    expect(groups[1].name).toBe('我的持仓');
    // 真实组 id = 数字串 (非 keyword)。
    expect(groups[0].id).toBe(watchlist.id.toString());
    expect(groups[0].itemCount).toBe(2);
    expect(groups[1].itemCount).toBe(0); // 持仓 V1 派生空
    expect(groups[2]).toMatchObject({
      id: custom.id.toString(),
      name: '科技股',
      type: 'custom',
      systemKind: null,
      itemCount: 1,
    });
  });

  it('跨账号隔离 → 仅返回本账号分组', async () => {
    const accountId = nextAccountId();
    const otherId = nextAccountId();
    await prisma.group.create({
      data: { accountId, name: '自选', type: 'system', systemKind: 'watchlist', order: 0 },
    });
    await prisma.group.create({
      data: { accountId: otherId, name: '别人组', type: 'custom', systemKind: null, order: 0 },
    });

    const { groups } = await usecase.execute(accountId);

    expect(groups).toHaveLength(1);
    expect(groups.some((g) => g.name === '别人组')).toBe(false);
  });
});
