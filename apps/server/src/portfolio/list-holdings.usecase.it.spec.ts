import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { ImportHoldingsUseCase } from './import-holdings.usecase';
import { ListHoldingsUseCase } from './list-holdings.usecase';
import { buildHoldingsXlsx } from './__fixtures__/build-holdings-xlsx';

const ASOF = '2026-06-06';

// 025 T005 US2: EP2 持仓列表 UC (回显字段映射全/空态 null asOf/账号隔离)。
// Testcontainers PG。run via `nx test server <file>` (cwd=apps/server) per memory。
describe('ListHoldingsUseCase (Testcontainers PG)', () => {
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let prisma: PrismaService;
  let importUC: ImportHoldingsUseCase;
  let listUC: ListHoldingsUseCase;
  let seq = 0;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    importUC = new ImportHoldingsUseCase(prisma);
    listUC = new ListHoldingsUseCase(prisma);

    // ZQX 注册 (quotable true), ZQY 故意不注册 (quotable false 降级行)。
    await prisma.instrument.create({
      data: {
        market: 'cn',
        code: 'ZQX',
        name: '合成甲股份',
        type: 'stock',
        currency: 'CNY',
        status: 'active',
      },
    });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextAccountId = (): bigint => BigInt(985_000 + ++seq);

  it('有数据回显: 字段映射全 + 双数组排序 + asOf (FR-007)', async () => {
    const accountId = nextAccountId();
    await importUC.execute(accountId, await buildHoldingsXlsx(), ASOF);

    const res = await listUC.execute(accountId);
    expect(res.asOf).toBe(ASOF);

    // current 按 weightPct desc: ZQY (0.7) > ZQX (0.3)。
    expect(res.current.map((h) => h.code)).toEqual(['ZQY', 'ZQX']);
    const main = res.current[1]!;
    expect(main).toMatchObject({
      market: 'cn',
      code: 'ZQX',
      name: '合成甲股份',
      qty: '1400',
      unitCost: '13.45',
      weightPct: '0.3',
      holdDays: 8,
      cumPnl: '2345.6',
      cumPnlPct: '0.1319',
      quotable: true,
    });
    expect(main.id).toMatch(/^\d+$/);
    // ZQY 未注册 → quotable false; `--` 列 → null 穿透。
    const second = res.current[0]!;
    expect(second.quotable).toBe(false);
    expect(second.cumPnl).toBeNull();
    expect(second.cumPnlPct).toBeNull();

    expect(res.closed).toHaveLength(1);
    expect(res.closed[0]).toMatchObject({
      market: 'cn',
      code: 'ZQX',
      name: '合成甲股份',
      openDate: '2025-09-16',
      closeDate: '2025-12-18',
      buyAvg: '10.4',
      sellAvg: '11.35',
      totalPnl: '2018.12',
      totalPnlPct: '0.0941',
      fee: '16.88',
      indexPct: '0.0353',
      vsIndexPct: '0.0588',
    });
  });

  it('空态: 未导入 → asOf null + 双空数组', async () => {
    const accountId = nextAccountId();
    expect(await listUC.execute(accountId)).toEqual({ asOf: null, current: [], closed: [] });
  });

  it('账号隔离: A 导入不泄漏给 B (FR-010)', async () => {
    const a = nextAccountId();
    const b = nextAccountId();
    await importUC.execute(a, await buildHoldingsXlsx(), ASOF);
    expect(await listUC.execute(b)).toEqual({ asOf: null, current: [], closed: [] });
  });
});
