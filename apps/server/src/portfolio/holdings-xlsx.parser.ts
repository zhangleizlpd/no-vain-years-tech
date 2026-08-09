/**
 * 025 汇总持仓 xlsx 解析 (仓内**唯一** exceljs 触点, plan D3/Q5 解耦单文件 ——
 * 未来换 read-excel-file 等只改本文件)。
 *
 * 职责边界：buffer → 按 sheet 名定位三 sheet → 首行表头 + 数据行**原值数组**。
 * 不做业务规范化 (列语义映射/`--`/类别词表在 holdings-import.rules.ts)；
 * 结构性噪音 (全空行) 在此过滤, 业务性跳行 (汇总行/必填缺失) 留给 rules 以便
 * 摘要留痕 (FR-004)。
 *
 * 错误形态：缺必要 sheet / 非法 xlsx → 结构化 ok:false (UC 映射 422, FR-001),
 * 不 throw —— 解析失败发生在事务前, 库天然不变 (state_branch #4)。
 */
import ExcelJS from 'exceljs';
import {
  SHEET_CLOSED,
  SHEET_HOLDINGS,
  SHEET_TRADES,
  type CellValue,
} from './holdings-import.rules';

export interface ParsedSheet {
  /** 首行表头原值 (列语义映射输入)。 */
  headers: CellValue[];
  /** 数据行原值数组 (0-based 列对齐表头; 行尾缺 cell → undefined)。 */
  rows: CellValue[][];
}

export interface ParsedHoldingsWorkbook {
  holdings: ParsedSheet;
  closed: ParsedSheet;
  trades: ParsedSheet;
}

export type ParseHoldingsResult =
  | { ok: true; workbook: ParsedHoldingsWorkbook }
  | { ok: false; reason: 'invalid_xlsx' }
  | { ok: false; reason: 'missing_sheets'; missing: string[] };

/**
 * exceljs cell.value 是多态联合 (richText/formula/hyperlink 对象)：标量直通,
 * 对象走 cell.text 兜底 —— 真实导出为 inlineStr 纯文本, 对象路径仅防御。
 */
function toCellValue(cell: ExcelJS.Cell): CellValue {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (v instanceof Date) return v;
  return cell.text;
}

function extractSheet(ws: ExcelJS.Worksheet): ParsedSheet {
  const headers: CellValue[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = toCellValue(cell);
  });

  const rows: CellValue[][] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells: CellValue[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cells[col - 1] = toCellValue(cell);
    });
    // 结构性全空行 (xlsx 尾部幽灵行) 在解析层过滤, 不进业务摘要
    if (cells.every((c) => c === null || c === undefined || String(c).trim() === '')) return;
    rows.push(cells);
  });
  return { headers, rows };
}

export async function parseHoldingsWorkbook(buffer: Buffer): Promise<ParseHoldingsResult> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs 类型基于旧 @types/node Buffer, 与 Node 22 Buffer<ArrayBufferLike>
    // 不兼容 (运行时同物) —— 经 Parameters 转回其期望形参类型
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    return { ok: false, reason: 'invalid_xlsx' };
  }

  const required = [SHEET_HOLDINGS, SHEET_CLOSED, SHEET_TRADES];
  const [holdingsWs, closedWs, tradesWs] = required.map((name) => workbook.getWorksheet(name));
  if (!holdingsWs || !closedWs || !tradesWs) {
    const present = [holdingsWs, closedWs, tradesWs];
    return {
      ok: false,
      reason: 'missing_sheets',
      missing: required.filter((_, i) => !present[i]),
    };
  }

  return {
    ok: true,
    workbook: {
      holdings: extractSheet(holdingsWs),
      closed: extractSheet(closedWs),
      trades: extractSheet(tradesWs),
    },
  };
}
