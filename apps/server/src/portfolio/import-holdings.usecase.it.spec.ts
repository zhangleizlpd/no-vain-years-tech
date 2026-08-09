import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../security/prisma.service';
import { ImportHoldingsUseCase } from './import-holdings.usecase';
import { HoldingsFileInvalidException } from './holdings-file-invalid.exception';
import { SHEET_TRADES, type CellValue } from './holdings-import.rules';
import {
  buildHoldingsXlsx,
  FIXTURE_HOLDING_ROWS,
  FIXTURE_TRADE_ROWS,
} from './__fixtures__/build-holdings-xlsx';

const ASOF = '2026-06-06';

// 025 T004 US1: 导入 UC (整体替换/幂等/缺 sheet 422 库不变/行级容错/quotable 批查)。
// Testcontainers PG。run via `nx test server <file>` (cwd=apps/server) per memory。
describe('ImportHoldingsUseCase (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let uc: ImportHoldingsUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    uc = new ImportHoldingsUseCase(prisma);

    // 注册 builder fixture 的两只持仓标的 (quotable 批查正例); GC001 故意不注册。
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

  const nextAccountId = (): bigint => BigInt(980_000 + ++seq);

  /** 三表内容投影 (剔除 id/createdAt 非确定列) — 幂等比对用。 */
  const snapshotTables = async (accountId: bigint) => {
    const holdings = await prisma.holding.findMany({
      where: { accountId },
      orderBy: { code: 'asc' },
    });
    const closed = await prisma.closedPosition.findMany({
      where: { accountId },
      orderBy: [{ code: 'asc' }, { closeDate: 'asc' }],
    });
    const trades = await prisma.tradeRecord.findMany({
      where: { accountId },
      orderBy: [{ tradeDate: 'asc' }, { tradeTime: 'asc' }],
    });
    const strip = ({ id: _id, createdAt: _c, ...rest }: { id: bigint; createdAt: Date }) => rest;
    return {
      holdings: holdings.map((r) => strip(r)),
      closed: closed.map((r) => strip(r)),
      trades: trades.map((r) => strip(r)),
    };
  };

  it('真实脱敏样本: 2 持仓 + 1 已清仓 + 23 流水入库, 汇总行 skip 留痕 (SC-001 数据面)', async () => {
    const accountId = nextAccountId();
    const buf = await readFile(join(__dirname, '__fixtures__', 'sample-holdings.xlsx'));
    const summary = await uc.execute(accountId, buf, ASOF);

    expect(summary.asOf).toBe(ASOF);
    expect(summary.holdings.imported).toBe(2);
    expect(summary.holdings.skipped).toHaveLength(1);
    expect(summary.holdings.skipped[0]!.reason).toContain('汇总');
    expect(summary.closed.imported).toBe(1);
    expect(summary.trades.imported).toBe(23);
    expect(summary.trades.skipped).toHaveLength(0);

    expect(await prisma.holding.count({ where: { accountId } })).toBe(2);
    expect(await prisma.closedPosition.count({ where: { accountId } })).toBe(1);
    expect(await prisma.tradeRecord.count({ where: { accountId } })).toBe(23);

    // asOf 行级冗余 (plan D6): 全部持仓行同批一致。
    const rows = await prisma.holding.findMany({ where: { accountId } });
    rows.forEach((r) => expect(r.asOf.toISOString().slice(0, 10)).toBe(ASOF));
  });

  it('重导幂等: 两次导入后逐行一致 (SC-002, FR-006 整体替换)', async () => {
    const accountId = nextAccountId();
    const buf = await buildHoldingsXlsx();

    const s1 = await uc.execute(accountId, buf, ASOF);
    const snap1 = await snapshotTables(accountId);
    const s2 = await uc.execute(accountId, buf, ASOF);
    const snap2 = await snapshotTables(accountId);

    expect(s2).toEqual(s1);
    expect(snap2).toEqual(snap1);
    expect(snap2.holdings).toHaveLength(2);
  });

  it('缺 sheet → HOLDINGS_FILE_INVALID 422, 库不变 (state_branch #4)', async () => {
    const accountId = nextAccountId();
    await uc.execute(accountId, await buildHoldingsXlsx(), ASOF);
    const before = await snapshotTables(accountId);

    const bad = await buildHoldingsXlsx({ omitSheets: [SHEET_TRADES] });
    await expect(uc.execute(accountId, bad, ASOF)).rejects.toBeInstanceOf(
      HoldingsFileInvalidException,
    );
    expect(await snapshotTables(accountId)).toEqual(before);
  });

  it('非法 xlsx buffer → HOLDINGS_FILE_INVALID 422', async () => {
    const accountId = nextAccountId();
    await expect(
      uc.execute(accountId, Buffer.from('definitely not a zip'), ASOF),
    ).rejects.toBeInstanceOf(HoldingsFileInvalidException);
    expect(await prisma.holding.count({ where: { accountId } })).toBe(0);
  });

  it('脏数据行级容错: `--`→null 入库 + 未知类别按 unknown 入库带警示 (FR-004/005)', async () => {
    const accountId = nextAccountId();
    // prettier-ignore
    const unknownTrade: CellValue[] = [
      '2026-01-05', '09:31:00', '603915', '国茂股份', '红利入账', '0', '0', '88', '88', '0', '',
    ];
    const buf = await buildHoldingsXlsx({ tradeRows: [...FIXTURE_TRADE_ROWS, unknownTrade] });
    const summary = await uc.execute(accountId, buf, ASOF);

    // 601177 行 累计盈亏/累计盈亏率 为 `--` → null 落库 (行不丢)。
    const degraded = await prisma.holding.findFirst({ where: { accountId, code: '601177' } });
    expect(degraded).not.toBeNull();
    expect(degraded!.cumPnl).toBeNull();
    expect(degraded!.cumPnlPct).toBeNull();

    // 未知类别 → unknown 入库 + 摘要警示可追溯 (raw 保留原始中文)。
    expect(summary.trades.imported).toBe(FIXTURE_TRADE_ROWS.length + 1);
    expect(summary.trades.warnings).toHaveLength(1);
    expect(summary.trades.warnings[0]).toContain('红利入账');
    const unknownRow = await prisma.tradeRecord.findFirst({
      where: { accountId, category: 'unknown' },
    });
    expect(unknownRow).not.toBeNull();
    expect((unknownRow!.raw as Record<string, string>)['交易类别']).toBe('红利入账');
  });

  it('quotable 批查: 已注册标的 true / 未注册 GC001 false (plan D2 Q7-B)', async () => {
    const accountId = nextAccountId();
    const gc001: CellValue[] = Array.from({ length: 27 }, () => '');
    gc001[0] = 'GC001';
    gc001[1] = '国债逆回购';
    gc001[16] = '0.05'; // 仓位占比
    gc001[17] = '10000'; // 持有数量
    gc001[21] = '100'; // 单位成本
    const buf = await buildHoldingsXlsx({
      holdingRows: [...FIXTURE_HOLDING_ROWS, gc001],
    });
    const summary = await uc.execute(accountId, buf, ASOF);
    expect(summary.holdings.imported).toBe(3);

    const byCode = new Map(
      (await prisma.holding.findMany({ where: { accountId } })).map((r) => [r.code, r.quotable]),
    );
    expect(byCode.get('603915')).toBe(true);
    expect(byCode.get('601177')).toBe(true);
    expect(byCode.get('GC001')).toBe(false);
  });
});
