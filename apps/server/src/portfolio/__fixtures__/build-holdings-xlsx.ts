/**
 * 025 测试 fixture 程序化 builder (plan §测试 fixture 双轨之 ①)。
 *
 * exceljs 写测试 xlsx —— 默认 useSharedStrings:true 走 sharedStrings 编码路径;
 * `useSharedStrings:false` 走同花顺真实导出的 `t="str"` 编码 (合成样本
 * `synthetic-holdings.ts` 用), 两条解析路径都踩 (plan Cross-cutting)。
 * 默认数据集镜像真实样本形态 (表头 27/13/11 列 + 汇总聚合行 + 资金行/XD 行),
 * 金额纯合成。变体 (缺 sheet / `--` / 未知类别) 通过 options 组合。
 *
 * 仅测试消费 (vitest / IT / contract-smoke fixture), 不进 runtime bundle。
 */
import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import {
  SHEET_CLOSED,
  SHEET_HOLDINGS,
  SHEET_TRADES,
  type CellValue,
} from '../holdings-import.rules';

/** 真实样本表头全量 (2026-06-07 实测形态, 列序一致)。 */
export const FIXTURE_HOLDING_HEADERS: string[] = [
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

export const FIXTURE_CLOSED_HEADERS: string[] = [
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

export const FIXTURE_TRADE_HEADERS: string[] = [
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

/** 默认持仓 2 行 (合成金额; 一行含 `--` 与空列, 镜像真实脏度)。 */
export const FIXTURE_HOLDING_ROWS: CellValue[][] = [
  // prettier-ignore
  ['603915', '国茂股份', '32000', '900', '0.028', '', '', '', '', '1000', '0.03',
    '17000.55', '0.1022', '1000', '1000', '2000', '0.16', '2000', '5', '0.028',
    '16', '15.883', '', '0.06', '-0.01', '-0.02', '0.15'],
  // prettier-ignore
  ['601177', '杭齿前进', '131000', '4500', '0.035', '', '', '', '', '-1700', '-0.013',
    '--', '--', '-1700', '-1700', '-1700', '0.66', '8900', '3', '0.022',
    '14.8', '15.025', '0.013', '-0.09', '-0.05', '-0.12', '-0.12'],
];

/** 持仓 sheet 末行「汇总」聚合行 (真实导出恒有, 导入须跳过)。 */
export const FIXTURE_SUMMARY_ROW: CellValue[] = [
  // prettier-ignore
  '汇总',
  '',
  '163000',
  '5400',
  '0.028',
  '',
  '',
  '',
  '',
  '-700',
  '-0.004',
  '',
  '',
  '-700',
  '-700',
  '380',
  '0.82',
];

export const FIXTURE_CLOSED_ROWS: CellValue[][] = [
  // prettier-ignore
  ['2026-05-11', '603915', '国茂股份', '15900.35', '0.096', '0.0922', '0.0038',
    '15.76', '17.26', '-0.048', '166', '133.25', '2025-08-27'],
];

/** 默认流水 4 行：资金转入 (其他) / 买入 / 除权除息 (XD 前缀) / 卖出。 */
export const FIXTURE_TRADE_ROWS: CellValue[][] = [
  ['2025-08-25', '', '', '', '其他', '0', '0', '100000'],
  // prettier-ignore
  ['2025-08-27', '14:53:27', '603915', '国茂股份', '买入', '6200', '16.12',
    '-99900.99', '99900', '10.99', ''],
  // prettier-ignore
  ['2025-10-23', '16:00:00', '603915', 'XD国茂股份', '除权除息', '0', '15.6',
    '744', '744', '0', ''],
  // prettier-ignore
  ['2026-05-11', '10:30:00', '603915', '国茂股份', '卖出', '6200', '17.26',
    '106900.55', '107000', '111.45', ''],
];

/**
 * 真实导出的数值列 numFmt (sheet → [格式, 表头[]])，按 2026-09-14 旧样本结构探测照录。
 * 只套在 number / null 单元格上：null + 样式 = 带样式空格 `<c s=".."/>`（真实导出形态，
 * exceljs 读回为 Null 而非 Merge）；文本单元格不带样式。默认数据集全为字符串 ⇒ 对既有调用方无影响。
 */
const EXPORT_NUM_FMTS: Record<string, [fmt: string, headers: string[]][]> = {
  [SHEET_HOLDINGS]: [
    [
      '0.00;-0.00;0',
      [
        '持有金额',
        '当日盈亏',
        '组合盈亏',
        '持有盈亏',
        '累计盈亏',
        '本周盈亏',
        '本月盈亏',
        '今年盈亏',
        '最新价',
      ],
    ],
    [
      '0.00%;-0.00%;0%',
      [
        '当日盈亏率',
        '板块涨幅',
        '组合涨幅',
        '持有盈亏率',
        '累计盈亏率',
        '仓位占比',
        '最新涨幅',
        '回本涨幅',
        '近1月涨幅',
        '近3月涨幅',
        '近6月涨幅',
        '近1年涨幅',
      ],
    ],
    ['0;-0;0%', ['持有数量']],
    ['0;-0;0', ['持仓天数']],
    ['0.000;-0.000;0', ['单位成本']],
  ],
  [SHEET_CLOSED]: [
    ['0.00', ['总盈亏', '交易费用']],
    ['0.00%', ['盈亏比', '同期大盘', '跑赢大盘', '清仓距今']],
  ],
  [SHEET_TRADES]: [['0.00', ['成交金额', '费用']]],
};

function writeSheet(
  workbook: ExcelJS.Workbook,
  sheet: string,
  headers: string[],
  rows: CellValue[][],
): void {
  const ws = workbook.addWorksheet(sheet);
  ws.addRow(headers);
  const fmtByCol = new Map(
    (EXPORT_NUM_FMTS[sheet] ?? []).flatMap(([fmt, names]) =>
      names.map((name) => [headers.indexOf(name), fmt] as const),
    ),
  );
  rows.forEach((cells) => {
    const row = ws.addRow(cells);
    // forEach 跳过稀疏空位 (undefined = 缺失 cell, 真实导出资金行尾部形态)
    cells.forEach((v, i) => {
      const fmt = fmtByCol.get(i);
      if (fmt !== undefined && (v === null || typeof v === 'number')) {
        row.getCell(i + 1).numFmt = fmt;
      }
    });
  });
}

export interface BuildHoldingsXlsxOptions {
  /** 缺 sheet 变体：列出的 sheet 名不写入 (整体 422 路径)。 */
  omitSheets?: string[];
  /** 覆盖默认数据行 (表头不变)。 */
  holdingRows?: CellValue[][];
  closedRows?: CellValue[][];
  tradeRows?: CellValue[][];
  /** 持仓 sheet 是否带「汇总」聚合行 (默认 true, 镜像真实导出)。 */
  includeSummaryRow?: boolean;
  /** 默认 true (exceljs 自产 sharedStrings 路径)；false = 真实导出的 `t="str"` 文本编码。 */
  useSharedStrings?: boolean;
}

export async function buildHoldingsXlsx(opts: BuildHoldingsXlsxOptions = {}): Promise<Buffer> {
  const {
    omitSheets = [],
    holdingRows = FIXTURE_HOLDING_ROWS,
    closedRows = FIXTURE_CLOSED_ROWS,
    tradeRows = FIXTURE_TRADE_ROWS,
    includeSummaryRow = true,
    useSharedStrings = true,
  } = opts;

  const fill = (workbook: ExcelJS.Workbook): void => {
    if (!omitSheets.includes(SHEET_HOLDINGS)) {
      const rows = includeSummaryRow ? [...holdingRows, FIXTURE_SUMMARY_ROW] : holdingRows;
      writeSheet(workbook, SHEET_HOLDINGS, FIXTURE_HOLDING_HEADERS, rows);
    }
    if (!omitSheets.includes(SHEET_CLOSED)) {
      writeSheet(workbook, SHEET_CLOSED, FIXTURE_CLOSED_HEADERS, closedRows);
    }
    if (!omitSheets.includes(SHEET_TRADES)) {
      writeSheet(workbook, SHEET_TRADES, FIXTURE_TRADE_HEADERS, tradeRows);
    }
  };

  if (useSharedStrings) {
    const workbook = new ExcelJS.Workbook();
    fill(workbook);
    const out = await workbook.xlsx.writeBuffer({ useSharedStrings: true });
    return Buffer.from(out as ArrayBuffer);
  }

  // 非流式 Workbook#writeBuffer 不认 useSharedStrings:false，只有流式 WorkbookWriter 写 `t="str"`。
  // EVIDENCE: exceljs@4.4.0 lib/xlsx/xlsx.js prepareModel 恒传 worksheetOptions.sharedStrings;
  // 2026-09-14 实测 writeBuffer({ useSharedStrings: false }) 产物仍含 xl/sharedStrings.xml。
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk)); // 必须消费, 否则背压卡死 commit
  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: sink,
    useStyles: true,
    useSharedStrings: false,
  });
  fill(writer);
  await writer.commit();
  return Buffer.concat(chunks);
}
