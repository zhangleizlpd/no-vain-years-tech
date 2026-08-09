import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { ImportHoldingsUseCase } from './import-holdings.usecase';
import { ListWatchlistItemsUseCase } from './list-watchlist-items.usecase';
import { ListWatchlistGroupsUseCase } from './list-watchlist-groups.usecase';
import { AddWatchlistItemUseCase } from './add-watchlist-item.usecase';
import { HoldingsGroupReadonlyException } from './holdings-group-readonly.exception';
import { buildHoldingsXlsx, FIXTURE_HOLDING_ROWS } from './__fixtures__/build-holdings-xlsx';
import type { CellValue } from './holdings-import.rules';

const ASOF = '2026-06-06';

/** 27 列持仓行 (code/name/仓位占比/持有数量/单位成本), 其余空。 */
function holdingRow(code: string, name: string, weight: string, qty: string): CellValue[] {
  const row: CellValue[] = Array.from({ length: 27 }, () => '');
  row[0] = code;
  row[1] = name;
  row[16] = weight;
  row[17] = qty;
  row[21] = '10';
  return row;
}

// 025 T007 US4: 持仓组派生改读路径 (D1) — 导入→组员/GC001 不进组/重导清空/未导入恒空/
// 写保护零回归。Testcontainers PG。run via `nx test server <file>` (cwd=apps/server)。
describe('Watchlist holdings-group derivation (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let importUC: ImportHoldingsUseCase;
  let itemsUC: ListWatchlistItemsUseCase;
  let groupsUC: ListWatchlistGroupsUseCase;
  let addUC: AddWatchlistItemUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    importUC = new ImportHoldingsUseCase(prisma);
    itemsUC = new ListWatchlistItemsUseCase(prisma);
    groupsUC = new ListWatchlistGroupsUseCase(prisma);
    addUC = new AddWatchlistItemUseCase(prisma, itemsUC);

    // fixture 两只注册 (quotable true); GC001 / 600519 故意不注册。
    await prisma.instrument.createMany({
      data: (
        [
          ['603915', '国茂股份'],
          ['601177', '杭齿前进'],
        ] as const
      ).map(([code, name]) => ({
        market: 'cn',
        code,
        name,
        type: 'stock',
        currency: 'CNY',
        status: 'active',
      })),
    });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextAccountId = (): bigint => BigInt(995_000 + ++seq);

  /** 默认 2 行 + GC001 (未注册) — 组员应只剩 quotable 两只, weightPct desc。 */
  const importWithGc001 = async (accountId: bigint) =>
    importUC.execute(
      accountId,
      await buildHoldingsXlsx({
        holdingRows: [...FIXTURE_HOLDING_ROWS, holdingRow('GC001', '国债逆回购', '0.05', '10000')],
      }),
      ASOF,
    );

  it('导入后持仓组成员 = quotable 持仓集合 (weightPct desc), GC001 不进组 (SC-003)', async () => {
    const accountId = nextAccountId();
    await importWithGc001(accountId);

    const { items } = await itemsUC.execute(accountId, 'holdings');
    expect(items.map((i) => i.code)).toEqual(['601177', '603915']); // 0.66 > 0.16
    expect(items.map((i) => i.order)).toEqual([0, 1]);
    items.forEach((i) => {
      expect(i.groupId).toBe('holdings');
      expect(i.market).toBe('cn');
      expect(i.pinned).toBe(false);
      expect(i.color).toBeNull();
      expect(i.id).toMatch(/^\d+$/);
    });

    // groups itemCount 同源派生 (虚拟投影路径, 未 materialize)。
    const { groups } = await groupsUC.execute(accountId);
    const holdingsGroup = groups.find((g) => g.systemKind === 'holdings');
    expect(holdingsGroup?.itemCount).toBe(2);
  });

  it('materialized 真实组行: 数字 groupId 同样派生 + itemCount 同源', async () => {
    const accountId = nextAccountId();
    await importWithGc001(accountId);
    // 触发 materialize-on-first-write (建系统组真实行)。
    await addUC.execute(accountId, 'watchlist', 'cn', '603915');

    const row = await prisma.group.findFirst({ where: { accountId, systemKind: 'holdings' } });
    expect(row).not.toBeNull();
    const { items } = await itemsUC.execute(accountId, row!.id.toString());
    expect(items.map((i) => i.code)).toEqual(['601177', '603915']);
    expect(items[0]!.groupId).toBe(row!.id.toString());

    const { groups } = await groupsUC.execute(accountId);
    expect(groups.find((g) => g.systemKind === 'holdings')?.itemCount).toBe(2);
    // 自选组 itemCount 仍走 WatchlistItem 口径 (零回归)。
    expect(groups.find((g) => g.systemKind === 'watchlist')?.itemCount).toBe(1);
  });

  it('重导清空: 持仓 sheet 空 → 组员清空 + itemCount 0 (SC-003)', async () => {
    const accountId = nextAccountId();
    await importWithGc001(accountId);
    expect((await itemsUC.execute(accountId, 'holdings')).items).toHaveLength(2);

    await importUC.execute(accountId, await buildHoldingsXlsx({ holdingRows: [] }), ASOF);
    expect((await itemsUC.execute(accountId, 'holdings')).items).toEqual([]);
    const { groups } = await groupsUC.execute(accountId);
    expect(groups.find((g) => g.systemKind === 'holdings')?.itemCount).toBe(0);
  });

  it('qty=0 行不进组 (qty>0 派生谓词)', async () => {
    const accountId = nextAccountId();
    // 唯一持仓行 = 已注册标的 601177 但 qty=0 (quotable true) → 派生组仍空。
    await importUC.execute(
      accountId,
      await buildHoldingsXlsx({
        holdingRows: [holdingRow('601177', '杭齿前进', '0', '0')],
      }),
      ASOF,
    );
    expect((await itemsUC.execute(accountId, 'holdings')).items).toEqual([]);
  });

  it('未导入恒空 (013 既有行为零回归)', async () => {
    const accountId = nextAccountId();
    expect(await itemsUC.execute(accountId, 'holdings')).toEqual({ items: [] });
    const { groups } = await groupsUC.execute(accountId);
    expect(groups.find((g) => g.systemKind === 'holdings')?.itemCount).toBe(0);
  });

  it('写保护不动: add 持仓组仍 422 HOLDINGS_GROUP_READONLY (FR-009, 013 套件另覆盖 update/delete)', async () => {
    const accountId = nextAccountId();
    await importWithGc001(accountId);
    await expect(addUC.execute(accountId, 'holdings', 'cn', '600519')).rejects.toBeInstanceOf(
      HoldingsGroupReadonlyException,
    );
  });
});
