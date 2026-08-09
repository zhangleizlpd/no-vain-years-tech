import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_CLOSED_HEADERS,
  FIXTURE_HOLDING_HEADERS,
  FIXTURE_TRADE_HEADERS,
  buildHoldingsXlsx,
} from './__fixtures__/build-holdings-xlsx';
import { SHEET_CLOSED, SHEET_TRADES } from './holdings-import.rules';
import { parseHoldingsWorkbook } from './holdings-xlsx.parser';

describe('parseHoldingsWorkbook — builder 文件 (sharedStrings 路径)', () => {
  it('标准 3 sheet → 表头/行数正确 (持仓含汇总行)', async () => {
    const buf = await buildHoldingsXlsx();
    const r = await parseHoldingsWorkbook(buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.workbook.holdings.headers).toEqual(FIXTURE_HOLDING_HEADERS);
    expect(r.workbook.closed.headers).toEqual(FIXTURE_CLOSED_HEADERS);
    expect(r.workbook.trades.headers).toEqual(FIXTURE_TRADE_HEADERS);
    expect(r.workbook.holdings.rows).toHaveLength(3); // 2 持仓 + 1 汇总
    expect(r.workbook.closed.rows).toHaveLength(1);
    expect(r.workbook.trades.rows).toHaveLength(4);
    // 原值直通 (规范化留给 rules): exceljs 写数字串可能回读为 number
    expect(String(r.workbook.holdings.rows[0]?.[0])).toBe('603915');
    expect(r.workbook.holdings.rows[2]?.[0]).toBe('汇总');
  });

  it('缺 sheet → 结构化 missing_sheets (422 路径, 不 throw)', async () => {
    const buf = await buildHoldingsXlsx({ omitSheets: [SHEET_CLOSED, SHEET_TRADES] });
    const r = await parseHoldingsWorkbook(buf);
    expect(r).toEqual({
      ok: false,
      reason: 'missing_sheets',
      missing: [SHEET_CLOSED, SHEET_TRADES],
    });
  });

  it('非法 buffer → invalid_xlsx', async () => {
    const r = await parseHoldingsWorkbook(Buffer.from('not an xlsx'));
    expect(r).toEqual({ ok: false, reason: 'invalid_xlsx' });
  });
});

describe('parseHoldingsWorkbook — 脱敏真实样本 (inlineStr 回归)', () => {
  it('3 sheet 解析: 表头列数 27/13/11 + 行数 3(含汇总)/1/23', async () => {
    const buf = await readFile(join(__dirname, '__fixtures__', 'sample-holdings.xlsx'));
    const r = await parseHoldingsWorkbook(buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.workbook.holdings.headers).toHaveLength(27);
    expect(r.workbook.closed.headers).toHaveLength(13);
    expect(r.workbook.trades.headers).toHaveLength(11);
    expect(r.workbook.holdings.headers[0]).toBe('代码');
    expect(r.workbook.trades.headers[4]).toBe('交易类别');
    expect(r.workbook.holdings.rows).toHaveLength(3); // 2 持仓 + 1 汇总
    expect(r.workbook.closed.rows).toHaveLength(1);
    expect(r.workbook.trades.rows).toHaveLength(23);
    // inlineStr cell 原值直通
    expect(String(r.workbook.holdings.rows[0]?.[0])).toBe('603915');
  });
});
