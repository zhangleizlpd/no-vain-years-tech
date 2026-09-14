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
    expect(normalizeCell(' 合成甲股份 ')).toBe('合成甲股份');
    expect(normalizeCell(14.25)).toBe('14.25');
  });

  it('parseDecimal: 数字串/负数/千分位/number 入参; 不可解析 → null', () => {
    expect(parseDecimal('13.45')).toBe('13.45');
    expect(parseDecimal('-1750.25')).toBe('-1750.25');
    expect(parseDecimal('1,234.5')).toBe('1234.5');
    expect(parseDecimal(14.25)).toBe('14.25');
    expect(parseDecimal('135790')).toBe('135790');
    expect(parseDecimal('--')).toBeNull();
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
  });

  it('parseIntStrict: 整数串; 小数/不可解析 → null', () => {
    expect(parseIntStrict('5')).toBe(5);
    expect(parseIntStrict(137)).toBe(137);
    expect(parseIntStrict('5.5')).toBeNull();
    expect(parseIntStrict('--')).toBeNull();
  });

  it('parseDateStr: YYYY-MM-DD / 斜杠归一 / Date 对象 (builder fixture); 非法 → null', () => {
    expect(parseDateStr('2025-12-18')).toBe('2025-12-18');
    expect(parseDateStr('2025/12/18')).toBe('2025-12-18');
    expect(parseDateStr(new Date(Date.UTC(2025, 8, 16)))).toBe('2025-09-16');
    expect(parseDateStr('12-18')).toBeNull();
    expect(parseDateStr('--')).toBeNull();
  });

  it('parseTimeStr: HH:MM:SS; 空 → null', () => {
    expect(parseTimeStr('13:48:36')).toBe('13:48:36');
    expect(parseTimeStr('')).toBeNull();
    expect(parseTimeStr('25:00:00')).toBeNull();
  });
});

describe('isSummaryRow 汇总聚合行', () => {
  it('代码列=汇总 → true; 正常代码 → false', () => {
    expect(isSummaryRow('汇总')).toBe(true);
    expect(isSummaryRow(' 汇总 ')).toBe(true);
    expect(isSummaryRow('ZQX')).toBe(false);
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
  // 合成样本行 (纯虚构标的与数值, 列形态同真实导出)
  const sampleCells = [
    'ZQX',
    '合成甲股份',
    '19600',
    '300',
    '0.0145',
    '',
    '',
    '',
    '',
    '770',
    '0.0411',
    '2345.6',
    '0.1319',
    '300',
    '600',
    '770',
    '0.3',
    '1400',
    '8',
    '0.0145',
    '14',
    '13.45',
    '',
    '0.04',
    '-0.02',
    '0.08',
    '0.12',
  ];

  it('样本行 → typed 8 字段 + market=cn', () => {
    const r = normalizeHoldingRow(index, HOLDING_HEADERS, sampleCells);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.row).toMatchObject({
      market: 'cn',
      code: 'ZQX',
      name: '合成甲股份',
      qty: '1400',
      unitCost: '13.45',
      weightPct: '0.3',
      holdDays: 8,
      cumPnl: '2345.6',
      cumPnlPct: '0.1319',
    });
    // raw 全保留 (丢弃的 typed 外列也在)
    expect(r.row.raw['持有金额']).toBe('19600');
    expect(r.row.raw['最新价']).toBe('14');
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
    const cells = ['汇总', '', '68600', '-400', '-0.0057'];
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
  // 合成样本行: 标的甲一轮封闭清仓
  const sampleCells = [
    '2025-12-18',
    'ZQX',
    '合成甲股份',
    '2018.12',
    '0.0941',
    '0.0353',
    '0.0588',
    '10.4',
    '11.35',
    '-0.1265',
    '93',
    '16.88',
    '2025-09-16',
  ];

  it('样本行 → typed 9+2 字段 (清仓距今/持仓天数不入 typed)', () => {
    const r = normalizeClosedPositionRow(index, CLOSED_HEADERS, sampleCells);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.row).toMatchObject({
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
    expect(r.row.raw['清仓距今']).toBe('-0.1265');
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
      '2025-09-16',
      '10:21:09',
      'ZQX',
      '合成甲股份',
      '买入',
      '1700',
      '10.4',
      '-17685.3',
      '17680',
      '5.3',
      '',
    ];
    const r = normalizeTradeRow(index, TRADE_HEADERS, cells);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.row).toMatchObject({
      market: 'cn',
      code: 'ZQX',
      name: '合成甲股份',
      category: 'buy',
      tradeDate: '2025-09-16',
      tradeTime: '10:21:09',
      qty: '1700',
      price: '10.4',
      amount: '-17685.3',
      turnover: '17680',
      fee: '5.3',
      note: null,
    });
    expect(r.warnings).toEqual([]);
  });

  it('资金转入转出行 (其他, 代码/名称/时间空) → market/code null + cash', () => {
    const cells = ['2025-09-12', '', '', '', '其他', '0', '0', '60000'];
    const r = normalizeTradeRow(index, TRADE_HEADERS, cells);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.row).toMatchObject({
      market: null,
      code: null,
      name: null,
      category: 'cash',
      tradeDate: '2025-09-12',
      tradeTime: null,
      amount: '60000',
    });
  });

  it('除权除息行 XD 前缀名称保留不清洗', () => {
    const cells = [
      '2025-11-06',
      '15:30:00',
      'ZQX',
      'XD合成甲股份',
      '除权除息',
      '0',
      '10.9',
      '420',
      '420',
      '0',
      '',
    ];
    const r = normalizeTradeRow(index, TRADE_HEADERS, cells);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.row.name).toBe('XD合成甲股份');
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
    const noAmount = ['2025-09-12', '', '', '', '其他', '0', '0', ''];
    expect(normalizeTradeRow(index, TRADE_HEADERS, noAmount).kind).toBe('skip');
    expect(normalizeTradeRow(index, TRADE_HEADERS, []).kind).toBe('skip');
  });
});
