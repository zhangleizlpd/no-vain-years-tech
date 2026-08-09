/**
 * 025 自有持仓导入纯函数规则 (ADR-0043 §4: rules 文件持无副作用业务规则)。
 *
 * 职责：同花顺汇总持仓 xlsx 三 sheet 的**行级规范化** —— 列语义映射 (表头前缀
 * 匹配容忍日期后缀如「当日盈亏05-06」) / `--`·空串 → null / 金额·数量·日期 parse /
 * 汇总聚合行判定 / 交易类别词表映射 / 三形态行校验 (持仓·已清仓·流水各自必填面)。
 * 零 DB 零框架依赖 (vitest 红绿主战场)；exceljs 触点在 holdings-xlsx.parser.ts，
 * 事务落库在 import-holdings.usecase.ts。
 *
 * 数值出口形态 = **规范化字符串** (Prisma Decimal 直收, 避免 float 精度损耗)；
 * 字段保留清单 per docs/private/plans/2026-06/06-07-holdings-import-decisions.md
 * (持仓 27→8 / 已清仓 13→9+2 大盘 / 交易 11 全存)；typed 之外原值进 raw。
 */

export type CellValue = string | number | Date | null | undefined;

/** 必要 sheet 名 (缺任一 → 整体 422, FR-001)。 */
export const SHEET_HOLDINGS = '持仓数据';
export const SHEET_CLOSED = '已清仓';
export const SHEET_TRADES = '交易记录';

/** V1 单市场：汇总持仓导出无市场列，全部按 A 股落库。 */
export const HOLDINGS_MARKET_V1 = 'cn';

/** 交易类别 normalized enum (7 实测值 + unknown 兜底；原始中文保留 raw)。 */
export const TRADE_CATEGORIES = [
  'buy',
  'sell',
  'xd',
  'dividend_tax',
  'repo_out',
  'repo_back',
  'cash',
  'unknown',
] as const;
export type TradeCategory = (typeof TRADE_CATEGORIES)[number];

/** 中文类别词表 → normalized enum (「其他」实测语义 = 资金转入转出 → cash)。 */
const CATEGORY_LEXICON: Record<string, TradeCategory> = {
  买入: 'buy',
  卖出: 'sell',
  除权除息: 'xd',
  股息个税征收: 'dividend_tax',
  质押回购拆出: 'repo_out',
  拆出质押购回: 'repo_back',
  其他: 'cash',
};

/** 列语义映射表：semantic key → 表头 (前缀, 容忍日期后缀)。 */
export const HOLDING_COLUMNS = {
  code: '代码',
  name: '名称',
  qty: '持有数量',
  unitCost: '单位成本',
  weightPct: '仓位占比',
  holdDays: '持仓天数',
  cumPnl: '累计盈亏',
  cumPnlPct: '累计盈亏率',
} as const;

export const CLOSED_COLUMNS = {
  code: '代码',
  name: '名称',
  openDate: '建仓日期',
  closeDate: '清仓日期',
  buyAvg: '买入均价',
  sellAvg: '卖出均价',
  totalPnl: '总盈亏',
  totalPnlPct: '盈亏比',
  fee: '交易费用',
  indexPct: '同期大盘',
  vsIndexPct: '跑赢大盘',
} as const;

export const TRADE_COLUMNS = {
  tradeDate: '成交日期',
  tradeTime: '成交时间',
  code: '代码',
  name: '名称',
  category: '交易类别',
  qty: '成交数量',
  price: '成交价格',
  amount: '发生金额',
  turnover: '成交金额',
  fee: '费用',
  note: '备注',
} as const;

export type ColumnIndex<K extends string> = Record<K, number>;

export type ResolveColumnsResult<K extends string> =
  | { ok: true; index: ColumnIndex<K> }
  | { ok: false; missing: string[] };

/**
 * 表头匹配：全等 OR 「语义前缀 + MM-DD 日期后缀」(实测同花顺导出形如
 * 「当日盈亏05-06」)。纯前缀 startsWith 不可用 —— 「累计盈亏」会误吞
 * 「累计盈亏率」，日期后缀正则收口互斥。
 */
function headerMatches(header: string, semantic: string): boolean {
  if (header === semantic) return true;
  if (!header.startsWith(semantic)) return false;
  return /^\d{2}-\d{2}$/.test(header.slice(semantic.length));
}

export function resolveColumns<K extends string>(
  headers: CellValue[],
  semantics: Record<K, string>,
): ResolveColumnsResult<K> {
  const normalized = headers.map((h) => normalizeCell(h) ?? '');
  const index = {} as ColumnIndex<K>;
  const missing: string[] = [];
  for (const key of Object.keys(semantics) as K[]) {
    const semantic = semantics[key];
    const at = normalized.findIndex((h) => headerMatches(h, semantic));
    if (at === -1) {
      missing.push(semantic);
    } else {
      index[key] = at;
    }
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, index };
}

/** `--` / 空串 / 空白 → null；文本 trim；number/Date 转字符串原值。 */
export function normalizeCell(v: CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (s === '' || s === '--') return null;
  return s;
}

/** 金额/数量/比率 → 规范化十进制字符串 (Prisma Decimal 直收)；千分位容忍。 */
export function parseDecimal(v: CellValue): string | null {
  const s = normalizeCell(v);
  if (s === null) return null;
  const cleaned = s.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return cleaned;
}

export function parseIntStrict(v: CellValue): number | null {
  const s = normalizeCell(v);
  if (s === null || !/^-?\d+$/.test(s)) return null;
  return Number.parseInt(s, 10);
}

/** 日期 → 'YYYY-MM-DD'；斜杠归一；Date 对象 (builder fixture 路径) 按 UTC 取日。 */
export function parseDateStr(v: CellValue): string | null {
  const s = normalizeCell(v);
  if (s === null) return null;
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

export function parseTimeStr(v: CellValue): string | null {
  const s = normalizeCell(v);
  if (s === null) return null;
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3]) > 59) return null;
  return s;
}

/** 持仓 sheet 末行「汇总」聚合行 (代码列='汇总') —— 跳过不入库, 摘要留痕。 */
export function isSummaryRow(codeCell: CellValue): boolean {
  return normalizeCell(codeCell) === '汇总';
}

export function mapCategory(raw: CellValue): { category: TradeCategory; known: boolean } {
  const s = normalizeCell(raw);
  const hit = s === null ? undefined : CATEGORY_LEXICON[s];
  return hit ? { category: hit, known: true } : { category: 'unknown', known: false };
}

/** 行级结果：ok (含警示) / skip (带原因, 摘要留痕 FR-004)。 */
export type RowOutcome<T> =
  | { kind: 'ok'; row: T; warnings: string[] }
  | { kind: 'skip'; reason: string };

export interface NormalizedHolding {
  market: string;
  code: string;
  name: string;
  qty: string;
  unitCost: string;
  weightPct: string | null;
  holdDays: number | null;
  cumPnl: string | null;
  cumPnlPct: string | null;
  raw: Record<string, string>;
}

export interface NormalizedClosedPosition {
  market: string;
  code: string;
  name: string;
  openDate: string;
  closeDate: string;
  buyAvg: string;
  sellAvg: string;
  totalPnl: string;
  totalPnlPct: string | null;
  fee: string | null;
  indexPct: string | null;
  vsIndexPct: string | null;
  raw: Record<string, string>;
}

export interface NormalizedTradeRecord {
  market: string | null;
  code: string | null;
  name: string | null;
  category: TradeCategory;
  tradeDate: string;
  tradeTime: string | null;
  qty: string | null;
  price: string | null;
  amount: string;
  turnover: string | null;
  fee: string | null;
  note: string | null;
  raw: Record<string, string>;
}

/** raw JSONB 载荷：原始行 {表头: 原值文本}，typed 之外列不丢 (FR-003)。 */
function buildRaw(headers: CellValue[], cells: CellValue[]): Record<string, string> {
  const raw: Record<string, string> = {};
  headers.forEach((h, i) => {
    const header = normalizeCell(h);
    if (header === null) return;
    const cell = cells[i];
    if (cell === null || cell === undefined) return;
    const text = cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell).trim();
    if (text === '') return;
    raw[header] = text;
  });
  return raw;
}

function isEmptyRow(cells: CellValue[]): boolean {
  return cells.every((c) => normalizeCell(c) === null);
}

const at = (cells: CellValue[], i: number): CellValue => cells[i];

export function normalizeHoldingRow(
  index: ColumnIndex<keyof typeof HOLDING_COLUMNS>,
  headers: CellValue[],
  cells: CellValue[],
): RowOutcome<NormalizedHolding> {
  if (isEmptyRow(cells)) return { kind: 'skip', reason: '空行' };
  if (isSummaryRow(at(cells, index.code))) return { kind: 'skip', reason: '「汇总」聚合行' };

  const code = normalizeCell(at(cells, index.code));
  const name = normalizeCell(at(cells, index.name));
  const qty = parseDecimal(at(cells, index.qty));
  const unitCost = parseDecimal(at(cells, index.unitCost));
  if (code === null || name === null || qty === null || unitCost === null) {
    return { kind: 'skip', reason: `必填字段缺失或不可解析 (代码=${code ?? '?'})` };
  }

  return {
    kind: 'ok',
    warnings: [],
    row: {
      market: HOLDINGS_MARKET_V1,
      code,
      name,
      qty,
      unitCost,
      weightPct: parseDecimal(at(cells, index.weightPct)),
      holdDays: parseIntStrict(at(cells, index.holdDays)),
      cumPnl: parseDecimal(at(cells, index.cumPnl)),
      cumPnlPct: parseDecimal(at(cells, index.cumPnlPct)),
      raw: buildRaw(headers, cells),
    },
  };
}

export function normalizeClosedPositionRow(
  index: ColumnIndex<keyof typeof CLOSED_COLUMNS>,
  headers: CellValue[],
  cells: CellValue[],
): RowOutcome<NormalizedClosedPosition> {
  if (isEmptyRow(cells)) return { kind: 'skip', reason: '空行' };

  const code = normalizeCell(at(cells, index.code));
  const name = normalizeCell(at(cells, index.name));
  const openDate = parseDateStr(at(cells, index.openDate));
  const closeDate = parseDateStr(at(cells, index.closeDate));
  const buyAvg = parseDecimal(at(cells, index.buyAvg));
  const sellAvg = parseDecimal(at(cells, index.sellAvg));
  const totalPnl = parseDecimal(at(cells, index.totalPnl));
  if (
    code === null ||
    name === null ||
    openDate === null ||
    closeDate === null ||
    buyAvg === null ||
    sellAvg === null ||
    totalPnl === null
  ) {
    return { kind: 'skip', reason: `必填字段缺失或不可解析 (代码=${code ?? '?'})` };
  }

  return {
    kind: 'ok',
    warnings: [],
    row: {
      market: HOLDINGS_MARKET_V1,
      code,
      name,
      openDate,
      closeDate,
      buyAvg,
      sellAvg,
      totalPnl,
      totalPnlPct: parseDecimal(at(cells, index.totalPnlPct)),
      fee: parseDecimal(at(cells, index.fee)),
      indexPct: parseDecimal(at(cells, index.indexPct)),
      vsIndexPct: parseDecimal(at(cells, index.vsIndexPct)),
      raw: buildRaw(headers, cells),
    },
  };
}

export function normalizeTradeRow(
  index: ColumnIndex<keyof typeof TRADE_COLUMNS>,
  headers: CellValue[],
  cells: CellValue[],
): RowOutcome<NormalizedTradeRecord> {
  if (isEmptyRow(cells)) return { kind: 'skip', reason: '空行' };

  const tradeDate = parseDateStr(at(cells, index.tradeDate));
  const amount = parseDecimal(at(cells, index.amount));
  if (tradeDate === null || amount === null) {
    return { kind: 'skip', reason: '必填字段缺失或不可解析 (成交日期/发生金额)' };
  }

  const rawCategory = normalizeCell(at(cells, index.category));
  const { category, known } = mapCategory(rawCategory);
  const warnings = known ? [] : [`未知交易类别「${rawCategory ?? ''}」按 unknown 入库`];

  // 资金转入转出行 (cash) 代码/名称/时间天然为空 → market 同置 null,
  // 不参与标的维度查询 (EP3 等值查询天然不命中)。
  const code = normalizeCell(at(cells, index.code));

  return {
    kind: 'ok',
    warnings,
    row: {
      market: code === null ? null : HOLDINGS_MARKET_V1,
      code,
      name: normalizeCell(at(cells, index.name)),
      category,
      tradeDate,
      tradeTime: parseTimeStr(at(cells, index.tradeTime)),
      qty: parseDecimal(at(cells, index.qty)),
      price: parseDecimal(at(cells, index.price)),
      amount,
      turnover: parseDecimal(at(cells, index.turnover)),
      fee: parseDecimal(at(cells, index.fee)),
      note: normalizeCell(at(cells, index.note)),
      raw: buildRaw(headers, cells),
    },
  };
}
