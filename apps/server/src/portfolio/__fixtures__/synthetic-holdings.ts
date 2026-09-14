/**
 * 025 合成导出样本 `synthetic-holdings.xlsx` 的数据集与生成器 (plan D8 双轨之 ②)。
 *
 * 🚨 **纯合成**：代码 / 名称 / 数量 / 金额 / 日期全部虚构 (词根 ZQX / ZQY / ZQR)，不取自任何
 * 真实账户。入库二进制**只许**由本文件生成，禁手工编辑：
 *
 *   pnpm exec tsx apps/server/src/portfolio/__fixtures__/write-synthetic-holdings-xlsx.ts
 *
 * 形态照录 2026-09-14 对旧真实导出的结构探测 (只取结构、不取值)：
 * - 编码：无 sharedStrings 部件，文本走 `t="str"`，数值走 `n` + 列级 numFmt (builder `useSharedStrings:false`)；
 * - 持仓 2 行 + 27 列宽「汇总」行；数值空位分两种 —— `''` 文本空格 / `null` 带样式空格；
 * - 已清仓 1 行 (与持仓首标的同代码，清仓后再建仓)；
 * - 流水 23 行 = 标的甲 9 (8 个成交日, 含 XD 前缀名) + 回购 2 + 标的乙 4 (3 个成交日) + 资金行 8；
 *   资金行代码 / 名称 / 时间为空、成交金额 / 费用两格缺失 (稀疏空位)、备注恒空。
 * 逐行单元格类型网格与旧样本一致；`holdings-xlsx.parser.spec.ts` 守「入库文件 = 本生成器产物」。
 */
import { join } from 'node:path';
import type { CellValue } from '../holdings-import.rules';
import { FIXTURE_INSTRUMENTS, buildHoldingsXlsx } from './build-holdings-xlsx';

export const SYNTHETIC_HOLDINGS_XLSX_PATH = join(__dirname, 'synthetic-holdings.xlsx');

/** 流水全量 9 条、同时持仓 + 已清仓的合成标的 (EP3 等值查询锚)。标识单源于 builder `FIXTURE_INSTRUMENTS`。 */
export const SYNTHETIC_CODE_MAIN = FIXTURE_INSTRUMENTS.main.code;
export const SYNTHETIC_NAME_MAIN = FIXTURE_INSTRUMENTS.main.name;

const X = [SYNTHETIC_CODE_MAIN, SYNTHETIC_NAME_MAIN] as const;
const Y = [FIXTURE_INSTRUMENTS.second.code, FIXTURE_INSTRUMENTS.second.name] as const;
const R = [FIXTURE_INSTRUMENTS.repo.code, FIXTURE_INSTRUMENTS.repo.name] as const;

// prettier-ignore
export const SYNTHETIC_HOLDING_ROWS: CellValue[][] = [
  [...X, 11200, 100, 0.009, '', null, null, null, 700, 0.0667, 1500.5, 0.1429, 200, 300, 900,
    0.35, 1000, 13, 0.009, 11.2, 10.5, null, 0.05, -0.02, -0.03, 0.12],
  [...Y, 20700, -60, -0.0029, '', null, null, null, -1050, -0.0483, -980.25, -0.045, -150, -400, -1050,
    0.65, 3000, 12, -0.0029, 6.9, 7.25, 0.0507, -0.08, -0.06, -0.1, -0.15],
  ['汇总', '', 31900, 40, 0.0013, '', '', null, '', -350, -0.011, '', '', 50, -100, -150,
    1, '', '', '', '', '', '', '', '', '', ''],
];

// prettier-ignore
export const SYNTHETIC_CLOSED_ROWS: CellValue[][] = [
  ['2026-03-20', ...X, 1830.4, 0.087, 0.0412, 0.0458, 10.2, 11.1, -0.1123, 120, 48.6, '2025-11-20'],
];

/** 资金行：成交金额 / 费用两格缺失 (稀疏空位)，备注空串。 */
// prettier-ignore
const cash = (date: string, amount: number): CellValue[] =>
  [date, '', '', '', '其他', 0, 0, amount, undefined, undefined, ''];

// prettier-ignore
export const SYNTHETIC_TRADE_ROWS: CellValue[][] = [
  cash('2025-11-18', 50000),
  ['2025-11-20', '09:35:12', ...X, '买入', 1000, 10.2, -10205.1, 10200, 5.1, ''],
  ['2025-12-15', '16:00:00', X[0], `XD${X[1]}`, '除权除息', 0, 10.05, 150, 150, 0, ''],
  cash('2026-01-05', 20000),
  ['2026-01-08', '10:12:40', ...X, '买入', 500, 10.1, -5052.5, 5050, 2.5, ''],
  ['2026-01-22', '13:45:03', ...X, '买入', 500, 10.3, -5152.6, 5150, 2.6, ''],
  cash('2026-02-04', 10000),
  ['2026-02-05', '14:58:00', ...R, '质押回购拆出', 10, 1.85, -10000, 10000, 0.1, ''],
  ['2026-02-06', '09:00:00', ...R, '拆出质押购回', 10, 1.85, 10005.07, 10005.07, 0, ''],
  cash('2026-03-09', -8000),
  ['2026-03-10', '14:20:00', ...X, '卖出', 1000, 11, 10994.5, 11000, 5.5, ''],
  cash('2026-03-11', -2000),
  ['2026-03-12', '16:00:00', ...X, '股息个税征收', 0, 0, -15, 0, 0, ''],
  ['2026-03-20', '10:05:30', ...X, '卖出', 1000, 11.2, 11194.4, 11200, 5.6, ''],
  cash('2026-03-20', 3000),
  ['2026-03-20', '16:00:00', ...X, '股息个税征收', 0, 0, -12, 0, 0, ''],
  cash('2026-05-15', 12000),
  ['2026-05-18', '09:31:00', ...X, '买入', 1000, 10.5, -10505.25, 10500, 5.25, ''],
  ['2026-05-19', '10:00:00', ...Y, '买入', 1000, 7.3, -7303.65, 7300, 3.65, ''],
  cash('2026-05-25', 5000),
  ['2026-05-26', '11:11:11', ...Y, '买入', 1000, 7.2, -7203.6, 7200, 3.6, ''],
  ['2026-05-26', '14:02:09', ...Y, '买入', 500, 7.25, -3626.81, 3625, 1.81, ''],
  ['2026-06-02', '09:45:27', ...Y, '买入', 500, 7.25, -3626.81, 3625, 1.81, ''],
];

export function buildSyntheticHoldingsXlsx(): Promise<Buffer> {
  return buildHoldingsXlsx({
    useSharedStrings: false,
    holdingRows: SYNTHETIC_HOLDING_ROWS,
    closedRows: SYNTHETIC_CLOSED_ROWS,
    tradeRows: SYNTHETIC_TRADE_ROWS,
    includeSummaryRow: false, // 汇总行已在 SYNTHETIC_HOLDING_ROWS 末行 (27 列宽, 真实导出形态)
  });
}
