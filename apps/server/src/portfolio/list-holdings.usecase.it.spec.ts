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

    // 603915 注册 (quotable true), 601177 故意不注册 (quotable false 降级行)。
    await prisma.instrument.create({
      data: {
        market: 'cn',
        code: '603915',
        name: '国茂股份',
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

    // current 按 weightPct desc: 601177 (0.66) > 603915 (0.16)。
    expect(res.current.map((h) => h.code)).toEqual(['601177', '603915']);
    const gm = res.current[1]!;
    expect(gm).toMatchObject({
      market: 'cn',
      code: '603915',
      name: '国茂股份',
      qty: '2000',
      unitCost: '15.883',
      weightPct: '0.16',
      holdDays: 5,
      cumPnl: '17000.55',
      cumPnlPct: '0.1022',
      quotable: true,
    });
    expect(gm.id).toMatch(/^\d+$/);
    // 601177 未注册 → quotable false; `--` 列 → null 穿透。
    const hc = res.current[0]!;
    expect(hc.quotable).toBe(false);
    expect(hc.cumPnl).toBeNull();
    expect(hc.cumPnlPct).toBeNull();

    expect(res.closed).toHaveLength(1);
    expect(res.closed[0]).toMatchObject({
      market: 'cn',
      code: '603915',
      name: '国茂股份',
      openDate: '2025-08-27',
      closeDate: '2026-05-11',
      buyAvg: '15.76',
      sellAvg: '17.26',
      totalPnl: '15900.35',
      totalPnlPct: '0.096',
      fee: '133.25',
      indexPct: '0.0922',
      vsIndexPct: '0.0038',
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
