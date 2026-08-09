import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { GetWatchlistStatusUseCase } from './get-watchlist-status.usecase';

// 014 T001 US6: watchlist-status query UC (Testcontainers PG)。
// run via `nx test server <file>` (cwd=apps/server) per memory testcontainers_spec_run_via_nx_cwd。
//
// 覆盖 4 态 + D2 null 安全:
//  ① 在「自选」组 → inWatchlist=true + memberships 含自选组
//  ② 仅自定义组 (systemKind=null) → inWatchlist=false 但 memberships 非空 (验 null 纳入, D2)
//  ③ 仅持仓组 → false + 空 (持仓派生排除)
//  ④ 未加 → false + 空
//  + 跨账号隔离 (别人的自选不串)
describe('GetWatchlistStatusUseCase (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let uc: GetWatchlistStatusUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    uc = new GetWatchlistStatusUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextAccountId = (): bigint => BigInt(960_000 + ++seq);

  // 直接 prisma seed (持仓组 API 只读, 仅能经直插构造「仅持仓组」态)。
  const makeGroup = (
    accountId: bigint,
    systemKind: 'watchlist' | 'holdings' | null,
    name: string,
    order: number,
  ) =>
    prisma.group.create({
      data: {
        accountId,
        name,
        type: systemKind ? 'system' : 'custom',
        systemKind,
        order,
      },
    });
  const addItem = (groupId: bigint, market: string, code: string) =>
    prisma.watchlistItem.create({ data: { groupId, market, code, order: 0 } });

  it('① 在「自选」组 → inWatchlist=true + memberships 含自选组', async () => {
    const accountId = nextAccountId();
    const wl = await makeGroup(accountId, 'watchlist', '自选', 0);
    const item = await addItem(wl.id, 'cn', '600519');

    const res = await uc.execute(accountId, 'cn', '600519');

    expect(res.inWatchlist).toBe(true);
    expect(res.memberships).toEqual([{ groupId: wl.id.toString(), itemId: item.id.toString() }]);
  });

  it('② 仅自定义组 (systemKind=null) → inWatchlist=false 但 memberships 非空 (D2 null 纳入)', async () => {
    const accountId = nextAccountId();
    const custom = await makeGroup(accountId, null, '科技股', 2);
    const item = await addItem(custom.id, 'cn', '000001');

    const res = await uc.execute(accountId, 'cn', '000001');

    expect(res.inWatchlist).toBe(false);
    expect(res.memberships).toEqual([
      { groupId: custom.id.toString(), itemId: item.id.toString() },
    ]);
  });

  it('① + ② 同时在自选 + 自定义组 → true + memberships 含两条', async () => {
    const accountId = nextAccountId();
    const wl = await makeGroup(accountId, 'watchlist', '自选', 0);
    const custom = await makeGroup(accountId, null, '白马', 2);
    await addItem(wl.id, 'cn', '600036');
    await addItem(custom.id, 'cn', '600036');

    const res = await uc.execute(accountId, 'cn', '600036');

    expect(res.inWatchlist).toBe(true);
    expect(res.memberships).toHaveLength(2);
    expect(res.memberships.map((m) => m.groupId).sort()).toEqual(
      [wl.id.toString(), custom.id.toString()].sort(),
    );
  });

  it('③ 仅持仓组 → false + 空 (持仓派生排除)', async () => {
    const accountId = nextAccountId();
    const hold = await makeGroup(accountId, 'holdings', '持仓', 1);
    await addItem(hold.id, 'cn', '601318');

    const res = await uc.execute(accountId, 'cn', '601318');

    expect(res.inWatchlist).toBe(false);
    expect(res.memberships).toEqual([]);
  });

  it('④ 未加 (未知 symbol) → false + 空', async () => {
    const accountId = nextAccountId();
    await makeGroup(accountId, 'watchlist', '自选', 0);

    const res = await uc.execute(accountId, 'cn', '999999');

    expect(res.inWatchlist).toBe(false);
    expect(res.memberships).toEqual([]);
  });

  it('跨账号隔离 → 别人的自选不串', async () => {
    const me = nextAccountId();
    const other = nextAccountId();
    const otherWl = await makeGroup(other, 'watchlist', '自选', 0);
    await addItem(otherWl.id, 'cn', '600519');
    await makeGroup(me, 'watchlist', '自选', 0); // 我有自选组但没加该标的

    const res = await uc.execute(me, 'cn', '600519');

    expect(res.inWatchlist).toBe(false);
    expect(res.memberships).toEqual([]);
  });
});
