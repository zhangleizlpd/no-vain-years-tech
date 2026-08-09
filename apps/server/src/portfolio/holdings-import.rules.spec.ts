import { describe, expect, it } from 'vitest';
import {
  CLOSED_COLUMNS,
  HOLDING_COLUMNS,
  TRADE_COLUMNS,
  isSummaryRow,
  mapCategory,
  normalizeCell,
  normalizeClosedPositionRow,
  normalizeHoldingRow,
  normalizeTradeRow,
  parseDateStr,
  parseDecimal,
  parseIntStrict,
  parseTimeStr,
  resolveColumns,
} from './holdings-import.rules';

// 真实样本表头 (2026-06-07 实测 ~/Downloads/汇总持仓.xlsx)
const HOLDING_HEADERS = [
  '代码',
  '名称',
  '持有金额',
  '当日盈亏',
  '当日盈亏率',
  '关联板块',
  '板块涨幅',
  '组合盈亏',
  '组合涨幅',
  '持有盈亏',
  '持有盈亏率',
  '累计盈亏',
  '累计盈亏率',
  '本周盈亏',
  '本月盈亏',
  '今年盈亏',
  '仓位占比',
  '持有数量',
  '持仓天数',
  '最新涨幅',
  '最新价',
  '单位成本',
  '回本涨幅',
  '近1月涨幅',
  '近3月涨幅',
  '近6月涨幅',
  '近1年涨幅',
];
const CLOSED_HEADERS = [
  '清仓日期',
  '代码',
  '名称',
  '总盈亏',
  '盈亏比',
  '同期大盘',
  '跑赢大盘',
  '买入均价',
  '卖出均价',
  '清仓距今',
  '持仓天数',
  '交易费用',
  '建仓日期',
];
const TRADE_HEADERS = [
  '成交日期',
  '成交时间',
  '代码',
  '名称',
  '交易类别',
  '成交数量',
  '成交价格',
  '发生金额',
  '成交金额',
  '费用',
  '备注',
];

function resolveOrThrow<K extends string>(
  headers: (string | null)[],
  semantics: Record<K, string>,
) {
  const r = resolveColumns(headers, semantics);
  if (!r.ok) throw new Error(`unresolved: ${r.missing.join(',')}`);
  return r.index;
}

describe('resolveColumns 列语义映射', () => {
  it('真实持仓表头全量解析 (前缀互斥: 累计盈亏 ≠ 累计盈亏率)', () => {
    const r = resolveColumns(HOLDING_HEADERS, HOLDING_COLUMNS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.index.code).toBe(0);
    expect(r.index.cumPnl).toBe(11);
    expect(r.index.cumPnlPct).toBe(12);
    expect(r.index.weightPct).toBe(16);
    expect(r.index.qty).toBe(17);
    expect(r.index.unitCost).toBe(21);
  });

  it('容忍日期后缀 (「累计盈亏05-06」→ cumPnl, 不串到 cumPnlPct)', () => {
    const headers = [
      '代码',
      '名称',
      '累计盈亏05-06',
      '累计盈亏率05-06',
      '仓位占比',
      '持有数量',
      '持仓天数',
      '单位成本',
    ];
    const r = resolveColumns(headers, HOLDING_COLUMNS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.index.cumPnl).toBe(2);
    expect(r.index.cumPnlPct).toBe(3);
  });

  it('缺列报 missing (中文表头便于摘要)', () => {
    const r = resolveColumns(['代码', '名称'], HOLDING_COLUMNS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toContain('持有数量');
    expect(r.missing).toContain('单位成本');
  });
});

describe('normalizeCell / parse 基础规范化', () => {
  it('`--`/空串/空白 → null; 文本 trim; 数字转字符串', () => {
    expect(normalizeCell('--')).toBeNull();
    expect(normalizeCell('')).toBeNull();
    expect(normalizeCell('  ')).toBeNull();
    expect(normalizeCell(null)).toBeNull();
    expect(normalizeCell(undefined)).toBeNull();
    expect(normalizeCell(' 国茂股份 ')).toBe('国茂股份');
    expect(normalizeCell(16.43)).toBe('16.43');
  });

  it('parseDecimal: 数字串/负数/千分位/number 入参; 不可解析 → null', () => {
    expect(parseDecimal('15.883')).toBe('15.883');
    expect(parseDecimal('-1739.34')).toBe('-1739.34');
    expect(parseDecimal('1,234.5')).toBe('1234.5');
    expect(parseDecimal(16.43)).toBe('16.43');
    expect(parseDecimal('164847')).toBe('164847');
    expect(parseDecimal('--')).toBeNull();
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
  });

  it('parseIntStrict: 整数串; 小数/不可解析 → null', () => {
    expect(parseIntStrict('5')).toBe(5);
    expect(parseIntStrict(166)).toBe(166);
    expect(parseIntStrict('5.5')).toBeNull();
    expect(parseIntStrict('--')).toBeNull();
  });

  it('parseDateStr: YYYY-MM-DD / 斜杠归一 / Date 对象 (builder fixture); 非法 → null', () => {
    expect(parseDateStr('2026-05-11')).toBe('2026-05-11');
    expect(parseDateStr('2026/05/11')).toBe('2026-05-11');
    expect(parseDateStr(new Date(Date.UTC(2025, 7, 27)))).toBe('2025-08-27');
    expect(parseDateStr('05-11')).toBeNull();
    expect(parseDateStr('--')).toBeNull();
  });

  it('parseTimeStr: HH:MM:SS; 空 → null', () => {
    expect(parseTimeStr('14:53:27')).toBe('14:53:27');
    expect(parseTimeStr('')).toBeNull();
    expect(parseTimeStr('25:00:00')).toBeNull();
  });
});

describe('isSummaryRow 汇总聚合行', () => {
  it('代码列=汇总 → true; 正常代码 → false', () => {
    expect(isSummaryRow('汇总')).toBe(true);
    expect(isSummaryRow(' 汇总 ')).toBe(true);
    expect(isSummaryRow('603915')).toBe(false);
    expect(isSummaryRow(null)).toBe(false);
  });
});

describe('mapCategory 交易类别词表', () => {
  it('7 实测值映射 + 其他→cash', () => {
    expect(mapCategory('买入')).toEqual({ category: 'buy', known: true });
    expect(mapCategory('卖出')).toEqual({ category: 'sell', known: true });
    expect(mapCategory('除权除息')).toEqual({ category: 'xd', known: true });
    expect(mapCategory('股息个税征收')).toEqual({ category: 'dividend_tax', known: true });
    expect(mapCategory('质押回购拆出')).toEqual({ category: 'repo_out', known: true });
    expect(mapCategory('拆出质押购回')).toEqual({ category: 'repo_back', known: true });
    expect(mapCategory('其他')).toEqual({ category: 'cash', known: true });
  });

  it('未知类别 → unknown 兜底 (不丢行, 摘要警示)', () => {
    expect(mapCategory('红股入账')).toEqual({ category: 'unknown', known: false });
    expect(mapCategory(null)).toEqual({ category: 'unknown', known: false });
  });
});

describe('normalizeHoldingRow 持仓行 (27→8 typed + raw 全保留)', () => {
  const index = resolveOrThrow(HOLDING_HEADERS, HOLDING_COLUMNS);
  // 真实样本 row2: 国茂股份
  const sampleCells = [
    '603915',
    '国茂股份',
    '32860',
    '920',
    '0.0288',
    '',
    '',
    '',
    '',
    '1094.68',
    '0.0345',
    '17055.03',
    '0.1022',
    '1094.68',
    '1094.68',
    '2124.02',
    '0.1648',
    '2000',
    '5',
    '0.0288',
    '16.43',
    '15.883',
    '',
    '0.0604',
    '-0.012',
    '-0.0207',
    '0.1566',
  ];

  it('真实样本行 → typed 8 字段 + market=cn', () => {
    const r = normalizeHoldingRow(index, HOLDING_HEADERS, sampleCells);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.row).toMatchObject({
      market: 'cn',
      code: '603915',
      name: '国茂股份',
      qty: '2000',
      unitCost: '15.883',
      weightPct: '0.1648',
      holdDays: 5,
      cumPnl: '17055.03',
      cumPnlPct: '0.1022',
    });
    // raw 全保留 (丢弃的 typed 外列也在)
    expect(r.row.raw['持有金额']).toBe('32860');
    expect(r.row.raw['最新价']).toBe('16.43');
  });

  it('`--` 盈亏字段 → null (行不跳)', () => {
    const cells = [...sampleCells];
    cells[11] = '--';
    cells[12] = '--';
    const r = normalizeHoldingRow(index, HOLDING_HEADERS, cells);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.row.cumPnl).toBeNull();
    expect(r.row.cumPnlPct).toBeNull();
  });

  it('汇总聚合行 → skip 带原因', () => {
    const cells = ['汇总', '', '164847', '5459.67', '0.0282'];
    const r = normalizeHoldingRow(index, HOLDING_HEADERS, cells);
    expect(r.kind).toBe('skip');
    if (r.kind !== 'skip') return;
    expect(r.reason).toContain('汇总');
  });

  it('必填面缺失 (持有数量不可解析) → skip', () => {
    const cells = [...sampleCells];
    cells[17] = '--';
    const r = normalizeHoldingRow(index, HOLDING_HEADERS, cells);
    expect(r.kind).toBe('skip');
  });

  it('空行 → skip', () => {
    const r = normalizeHoldingRow(index, HOLDING_HEADERS, []);
    expect(r.kind).toBe('skip');
  });
});

describe('normalizeClosedPositionRow 已清仓行', () => {
  const index = resolveOrThrow(CLOSED_HEADERS, CLOSED_COLUMNS);
  // 真实样本 row2: 国茂股份一轮封闭清仓
  const sampleCells = [
    '2026-05-11',
    '603915',
    '国茂股份',
    '15960.35',
    '0.096',
    '0.0922',
    '0.0038',
    '15.76',
    '17.26',
    '-0.0483',
    '166',
    '133.25',
    '2025-08-27',
  ];

  it('真实样本行 → typed 9+2 字段 (清仓距今/持仓天数不入 typed)', () => {
    const r = normalizeClosedPositionRow(index, CLOSED_HEADERS, sampleCells);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.row).toMatchObject({
      market: 'cn',
      code: '603915',
      name: '国茂股份',
      openDate: '2025-08-27',
      closeDate: '2026-05-11',
      buyAvg: '15.76',
      sellAvg: '17.26',
      totalPnl: '15960.35',
      totalPnlPct: '0.096',
      fee: '133.25',
      indexPct: '0.0922',
      vsIndexPct: '0.0038',
    });
    expect(r.row.raw['清仓距今']).toBe('-0.0483');
  });

  it('必填面缺失 (清仓日期非法) → skip', () => {
    const cells = [...sampleCells];
    cells[0] = '--';
    const r = normalizeClosedPositionRow(index, CLOSED_HEADERS, cells);
    expect(r.kind).toBe('skip');
  });
});

describe('normalizeTradeRow 交易流水行 (11 全存)', () => {
  const index = resolveOrThrow(TRADE_HEADERS, TRADE_COLUMNS);

  it('买入行 → 全字段 (amount signed)', () => {
    const cells = [
      '2025-08-27',
      '14:53:27',
      '603915',
      '国茂股份',
      '买入',
      '6200',
      '16.12',
      '-99954.99',
      '99944',
      '10.99',
      '',
    ];
    const r = normalizeTradeRow(index, TRADE_HEADERS, cells);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.row).toMatchObject({
      market: 'cn',
      code: '603915',
      name: '国茂股份',
      category: 'buy',
      tradeDate: '2025-08-27',
      tradeTime: '14:53:27',
      qty: '6200',
      price: '16.12',
      amount: '-99954.99',
      turnover: '99944',
      fee: '10.99',
      note: null,
    });
    expect(r.warnings).toEqual([]);
  });

  it('资金转入转出行 (其他, 代码/名称/时间空) → market/code null + cash', () => {
    const cells = ['2025-08-25', '', '', '', '其他', '0', '0', '100000'];
    const r = normalizeTradeRow(index, TRADE_HEADERS, cells);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.row).toMatchObject({
      market: null,
      code: null,
      name: null,
      category: 'cash',
      tradeDate: '2025-08-25',
      tradeTime: null,
      amount: '100000',
    });
  });

  it('除权除息行 XD 前缀名称保留不清洗', () => {
    const cells = [
      '2025-10-23',
      '16:00:00',
      '603915',
      'XD国茂股份',
      '除权除息',
      '0',
      '15.6',
      '744',
      '744',
      '0',
      '',
    ];
    const r = normalizeTradeRow(index, TRADE_HEADERS, cells);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.row.name).toBe('XD国茂股份');
    expect(r.row.category).toBe('xd');
  });

  it('未知类别 → unknown 入库 + warning (不丢行)', () => {
    const cells = [
      '2025-09-01',
      '10:00:00',
      '600000',
      '某股',
      '红股入账',
      '100',
      '1',
      '100',
      '100',
      '0',
      '',
    ];
    const r = normalizeTradeRow(index, TRADE_HEADERS, cells);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.row.category).toBe('unknown');
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.row.raw['交易类别']).toBe('红股入账');
  });

  it('必填面缺失 (发生金额空) → skip; 全空行 → skip', () => {
    const noAmount = ['2025-08-25', '', '', '', '其他', '0', '0', ''];
    expect(normalizeTradeRow(index, TRADE_HEADERS, noAmount).kind).toBe('skip');
    expect(normalizeTradeRow(index, TRADE_HEADERS, []).kind).toBe('skip');
  });
});
