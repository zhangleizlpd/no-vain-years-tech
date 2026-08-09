import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { parseHoldingsWorkbook, type ParsedSheet } from './holdings-xlsx.parser';
import {
  CLOSED_COLUMNS,
  HOLDING_COLUMNS,
  SHEET_CLOSED,
  SHEET_HOLDINGS,
  SHEET_TRADES,
  TRADE_COLUMNS,
  normalizeClosedPositionRow,
  normalizeHoldingRow,
  normalizeTradeRow,
  resolveColumns,
  type CellValue,
  type ColumnIndex,
  type RowOutcome,
} from './holdings-import.rules';
import { HoldingsFileInvalidException } from './holdings-file-invalid.exception';
import type {
  ImportSectionSummary,
  ImportSummaryResponse,
  SkippedRowItem,
} from './import-summary.response';

/**
 * pg_advisory_xact_lock 二元 (classid, objid) 命名空间 — classid 固定 25 (本 feature),
 * objid = accountId mod 2^31 (int4 域; bigserial 量级下无碰撞, 即便碰撞也只是两账户
 * 误串行化, 不影响正确性)。
 */
const ADVISORY_LOCK_CLASS = 25;

/** sheet 内规范化收集结果 (rows 顺序 = 入库顺序)。 */
interface CollectedSheet<T> {
  rows: T[];
  skipped: SkippedRowItem[];
  warnings: string[];
}

function collectRows<T>(
  sheet: ParsedSheet,
  normalize: (headers: CellValue[], cells: CellValue[]) => RowOutcome<T>,
): CollectedSheet<T> {
  const rows: T[] = [];
  const skipped: SkippedRowItem[] = [];
  const warnings: string[] = [];
  sheet.rows.forEach((cells, i) => {
    const outcome = normalize(sheet.headers, cells);
    if (outcome.kind === 'skip') {
      skipped.push({ row: i + 1, reason: outcome.reason });
      return;
    }
    rows.push(outcome.row);
    outcome.warnings.forEach((w) => warnings.push(`第 ${i + 1} 行: ${w}`));
  });
  return { rows, skipped, warnings };
}

function resolveOrThrow<K extends string>(
  sheetName: string,
  sheet: ParsedSheet,
  semantics: Record<K, string>,
): ColumnIndex<K> {
  const resolved = resolveColumns(sheet.headers, semantics);
  if (!resolved.ok) {
    throw HoldingsFileInvalidException.missingColumns(sheetName, resolved.missing);
  }
  return resolved.index;
}

/** 'YYYY-MM-DD' → UTC 零点 Date (Prisma `@db.Date` 列入参)。 */
const toDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

const toSection = (c: CollectedSheet<unknown>): ImportSectionSummary => ({
  imported: c.rows.length,
  skipped: c.skipped,
  warnings: c.warnings,
});

/**
 * 025 US1 EP1 — 汇总持仓 xlsx 导入 (FR-001..006; intra command, ADR-0043 直注
 * PrismaService 无 repository)。
 *
 * parse (唯一 exceljs 触点) → rules 规范化 (行级容错, skip/warning 进摘要) →
 * 批查 instrument 可识别性落 `quotable` (plan D2, Q7-B 唯一跨 ctx 读) →
 * 单事务**整体替换**: 首行 pg_advisory_xact_lock 账户级串行化 (analyze I2,
 * closed_position/trade_record 无唯一约束, 并发重导靠锁消除重复窗口) →
 * 三表 deleteMany(accountId) + createMany → 摘要。
 *
 * 解析/结构失败 (非法 xlsx / 缺 sheet / 缺列) 抛 422 于事务前 → 库不变
 * (state_branch #4); 幂等 = 全量替换天然成立 (FR-006)。禁增量 upsert。
 */
@Injectable()
export class ImportHoldingsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, buffer: Buffer, asOf: string): Promise<ImportSummaryResponse> {
    const parsed = await parseHoldingsWorkbook(buffer);
    if (!parsed.ok) {
      throw parsed.reason === 'missing_sheets'
        ? HoldingsFileInvalidException.missingSheets(parsed.missing)
        : HoldingsFileInvalidException.invalidXlsx();
    }
    const { holdings, closed, trades } = parsed.workbook;

    const holdingIdx = resolveOrThrow(SHEET_HOLDINGS, holdings, HOLDING_COLUMNS);
    const closedIdx = resolveOrThrow(SHEET_CLOSED, closed, CLOSED_COLUMNS);
    const tradeIdx = resolveOrThrow(SHEET_TRADES, trades, TRADE_COLUMNS);

    const h = collectRows(holdings, (hd, c) => normalizeHoldingRow(holdingIdx, hd, c));
    const cp = collectRows(closed, (hd, c) => normalizeClosedPositionRow(closedIdx, hd, c));
    const t = collectRows(trades, (hd, c) => normalizeTradeRow(tradeIdx, hd, c));

    // 可识别性批查: 持仓行 (market, code) 去重一次 findMany, 命中 → quotable=true
    // (持仓组派生/quote merge 消费); GC001 类场外品种自然 false (降级展示)。
    const keys = [...new Map(h.rows.map((r) => [`${r.market} ${r.code}`, r])).values()].map(
      (r) => ({ market: r.market, code: r.code }),
    );
    let quotableKeys = new Set<string>();
    if (keys.length > 0) {
      // CROSS-CONTEXT-READ: 导入时批查 marketdata.instrument 可识别性落 holding.quotable (只读, Q7-B per plan D2)
      const instruments = await this.prisma.instrument.findMany({
        where: { OR: keys },
        select: { market: true, code: true },
      });
      quotableKeys = new Set(instruments.map((i) => `${i.market} ${i.code}`));
    }

    const asOfDate = toDate(asOf);
    await this.prisma.$transaction(async (tx) => {
      // 账户级串行化: 并发导入「后完成者整体覆盖」确定性成立 (analyze I2)。
      // ::text — pg_advisory_xact_lock 返回 void, Prisma 无法反序列化 void 列。
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_CLASS}::int, ${Number(accountId % 2_147_483_648n)}::int)::text`;
      await tx.holding.deleteMany({ where: { accountId } });
      await tx.closedPosition.deleteMany({ where: { accountId } });
      await tx.tradeRecord.deleteMany({ where: { accountId } });
      if (h.rows.length > 0) {
        await tx.holding.createMany({
          data: h.rows.map((r) => ({
            accountId,
            market: r.market,
            code: r.code,
            name: r.name,
            qty: r.qty,
            unitCost: r.unitCost,
            weightPct: r.weightPct,
            holdDays: r.holdDays,
            cumPnl: r.cumPnl,
            cumPnlPct: r.cumPnlPct,
            quotable: quotableKeys.has(`${r.market} ${r.code}`),
            asOf: asOfDate,
            raw: r.raw,
          })),
        });
      }
      if (cp.rows.length > 0) {
        await tx.closedPosition.createMany({
          data: cp.rows.map((r) => ({
            accountId,
            market: r.market,
            code: r.code,
            name: r.name,
            openDate: toDate(r.openDate),
            closeDate: toDate(r.closeDate),
            buyAvg: r.buyAvg,
            sellAvg: r.sellAvg,
            totalPnl: r.totalPnl,
            totalPnlPct: r.totalPnlPct,
            fee: r.fee,
            indexPct: r.indexPct,
            vsIndexPct: r.vsIndexPct,
            raw: r.raw,
          })),
        });
      }
      if (t.rows.length > 0) {
        await tx.tradeRecord.createMany({
          data: t.rows.map((r) => ({
            accountId,
            market: r.market,
            code: r.code,
            name: r.name,
            category: r.category,
            tradeDate: toDate(r.tradeDate),
            tradeTime: r.tradeTime,
            qty: r.qty,
            price: r.price,
            amount: r.amount,
            turnover: r.turnover,
            fee: r.fee,
            note: r.note,
            raw: r.raw,
          })),
        });
      }
    });

    return {
      asOf,
      holdings: toSection(h),
      closed: toSection(cp),
      trades: toSection(t),
    };
  }
}
