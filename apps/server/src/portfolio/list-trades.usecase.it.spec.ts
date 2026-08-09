import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../security/prisma.service';
import { ImportHoldingsUseCase } from './import-holdings.usecase';
import { ListTradesUseCase } from './list-trades.usecase';
import { buildHoldingsXlsx } from './__fixtures__/build-holdings-xlsx';

const ASOF = '2026-06-06';

// 025 T006 US3: EP3 标的流水 UC (国茂全量 9 条时序/未交易空 items/资金行不命中)。
// Testcontainers PG。run via `nx test server <file>` (cwd=apps/server) per memory。
describe('ListTradesUseCase (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let importUC: ImportHoldingsUseCase;
  let listUC: ListTradesUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    importUC = new ImportHoldingsUseCase(prisma);
    listUC = new ListTradesUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextAccountId = (): bigint => BigInt(990_000 + ++seq);

  it('真实脱敏样本: 国茂股份全量 9 条, tradeDate desc + tradeTime desc 时序正确 (FR-008)', async () => {
    const accountId = nextAccountId();
    const buf = await readFile(join(__dirname, '__fixtures__', 'sample-holdings.xlsx'));
    await importUC.execute(accountId, buf, ASOF);

    const { items } = await listUC.execute(accountId, 'cn', '603915');
    expect(items).toHaveLength(9);
    items.forEach((t) => {
      expect(t.market).toBe('cn');
      expect(t.code).toBe('603915');
    });
    // 倒序校验: (tradeDate, tradeTime ?? '') 字典序非增 (nulls last 同日殿后)。
    const keys = items.map((t) => `${t.tradeDate} ${t.tradeTime ?? ''}`);
    const sorted = [...keys].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    expect(keys).toEqual(sorted);
  });

  it('builder fixture: 3 笔 603915 倒序 + XD 原始名保留', async () => {
    const accountId = nextAccountId();
    await importUC.execute(accountId, await buildHoldingsXlsx(), ASOF);

    const { items } = await listUC.execute(accountId, 'cn', '603915');
    expect(items.map((t) => t.category)).toEqual(['sell', 'xd', 'buy']);
    expect(items.map((t) => t.tradeDate)).toEqual(['2026-05-11', '2025-10-23', '2025-08-27']);
    expect(items[1]!.name).toBe('XD国茂股份'); // XD 前缀保留不清洗
    expect(items[2]).toMatchObject({
      qty: '6200',
      price: '16.12',
      amount: '-99900.99',
      turnover: '99900',
      fee: '10.99',
      note: null,
    });
  });

  it('未交易标的 → 空 items (200 非 404)', async () => {
    const accountId = nextAccountId();
    await importUC.execute(accountId, await buildHoldingsXlsx(), ASOF);
    expect(await listUC.execute(accountId, 'cn', '600519')).toEqual({ items: [] });
  });

  it('资金行 (code null) 天然不命中等值查询', async () => {
    const accountId = nextAccountId();
    await importUC.execute(accountId, await buildHoldingsXlsx(), ASOF);
    // 资金行确实入库 (cash, market/code null) …
    const cashRows = await prisma.tradeRecord.findMany({ where: { accountId, code: null } });
    expect(cashRows).toHaveLength(1);
    expect(cashRows[0]!.category).toBe('cash');
    // … 但任何标的等值查询都不返回它 (全量扫一遍 603915 结果无 null code 行)。
    const { items } = await listUC.execute(accountId, 'cn', '603915');
    expect(items.every((t) => t.code === '603915')).toBe(true);
  });
});
