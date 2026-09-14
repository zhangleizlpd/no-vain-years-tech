import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  BoardListParseError,
  parseBoardMeetingList,
  type BoardListParseFailureReason,
} from './hkex-board-meeting-list.rules.js';

/**
 * fixture = 港交所「董事會會議通知」清单公开页面 (https://www3.hkexnews.hk/reports/bmn/ebmn_c.htm)：
 * 2026-09-13 抓取的当日页 + Wayback 2024-04-24 快照。核对值由 T003 impl 期另写的 Python 脚本
 * (按 `<tr>` / `<td>` 独立解析) 对同两份文件算出，非本函数自证。
 */
function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', 'hkex-board-meeting-list', name), 'utf8');
}

const TODAY = fixture('ebmn_c-2026-09-13.htm');
const SNAPSHOT_2024 = fixture('ebmn_c-wayback-20240424125921.htm');

function expectParseError(html: string, reason: BoardListParseFailureReason): BoardListParseError {
  let caught: unknown;
  try {
    parseBoardMeetingList(html);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(BoardListParseError);
  const error = caught as BoardListParseError;
  expect(error.reason).toBe(reason);
  return error;
}

describe('parseBoardMeetingList — 当日页 (页首 10/09/2026)', () => {
  const page = parseBoardMeetingList(TODAY);

  it('页首日期按 日/月/年 解析', () => {
    expect(page.pageDate).toBe('2026-09-10');
  });

  it('计数与手工核对值一致, 0 行静默丢弃', () => {
    expect(page.counts).toEqual({
      dataRows: 30,
      resultRows: 29,
      dividendOnlyRows: 1,
      textPeriodKeyRows: 0,
      nonStandardMonthRows: 0,
    });
    expect(page.rows).toHaveLength(page.counts.resultRows);
    expect(page.counts.resultRows + page.counts.dividendOnlyRows).toBe(page.counts.dataRows);
  });

  it('业绩行: 会议日期取所列日期、代码补零到 5 位、期间交报告期规则', () => {
    expect(page.rows.find((r) => r.code === '09961')).toEqual({
      meetingDate: '2026-09-14',
      stockName: '攜程集團－Ｓ',
      code: '09961',
      purpose: '業績',
      periodText: '截至30/06/26止6個月',
      periodKey: 'P:2026-06-30',
      periodEnd: '2026-06-30',
      reportKind: 'interim',
      nonStandardMonths: false,
    });
    expect(page.rows.find((r) => r.stockName === '卓能（集團）')?.code).toBe('00131');
  });

  it('纯股息行 (特別中期股息) 不进 rows', () => {
    expect(page.rows.some((r) => r.purpose === '特別中期股息')).toBe(false);
  });

  it('同页同日同代码多行各自成行 (清晰醫療 15/09 三期)', () => {
    const rows = page.rows.filter((r) => r.code === '01406' && r.meetingDate === '2026-09-15');
    expect(rows.map((r) => r.periodKey)).toEqual(['P:2025-03-31', 'P:2025-09-30', 'P:2026-03-31']);
  });
});

describe('parseBoardMeetingList — 2024-04-24 快照 (多期多行 / 人民币柜台 / 纯股息行)', () => {
  const page = parseBoardMeetingList(SNAPSHOT_2024);

  it('计数与手工核对值一致, 0 行静默丢弃', () => {
    expect(page.pageDate).toBe('2024-04-23');
    expect(page.counts).toEqual({
      dataRows: 226,
      resultRows: 218,
      dividendOnlyRows: 8,
      textPeriodKeyRows: 6,
      nonStandardMonthRows: 0,
    });
    expect(page.rows).toHaveLength(page.counts.resultRows);
  });

  it('「季度收益資料」计为业绩行', () => {
    expect(page.rows.find((r) => r.purpose === '季度收益資料')).toMatchObject({
      code: '01913',
      periodKey: 'P:2024-03-31',
      reportKind: 'quarterly',
    });
  });

  it('人民币柜台 8xxxx 原样成行 (查主表跳过在来源层)', () => {
    expect(page.rows.find((r) => r.code === '82388')).toMatchObject({
      meetingDate: '2024-04-29',
      periodKey: 'T:hkex_board_meeting_list:2024年第一季',
      periodEnd: null,
    });
  });

  it('同日同代码: 业绩行成行、纯股息行不成行 (匯豐 30/04)', () => {
    const rows = page.rows.filter((r) => r.code === '00005' && r.meetingDate === '2024-04-30');
    expect(rows.map((r) => r.purpose)).toEqual(['第一季業績/中期股息']);
  });

  it('同日同代码多期 (24/04 代码 1622 三行)', () => {
    const rows = page.rows.filter((r) => r.code === '01622' && r.meetingDate === '2024-04-24');
    expect(rows.map((r) => r.periodKey)).toEqual(['P:2022-12-31', 'P:2023-06-30', 'P:2023-12-31']);
  });
});

describe('结构异常 ⇒ 整页抛 BoardListParseError (FR-025, 🚫 返回空结果)', () => {
  function mutate(from: string | RegExp, to: string): string {
    const html = TODAY.replace(from, to);
    expect(html).not.toBe(TODAY);
    return html;
  }

  it('删页首日期', () => {
    const error = expectParseError(mutate('日期 : 10/09/2026', ''), 'page_date_missing');
    expect(error.message).toContain('页首日期');
  });

  it('删表头', () => {
    const error = expectParseError(
      mutate(/<tr>(?:(?!<\/tr>)[\s\S])*會議日期[\s\S]*?<\/tr>/, ''),
      'header_missing',
    );
    expect(error.message).toContain('表头');
  });

  it('🚨 破坏一行列数 (攜程那行删掉「期間」格) ⇒ 结构不变量不成立', () => {
    const error = expectParseError(
      mutate(
        "<td valign=top><font face='monospace' style='font-size: 12'>截至30/06/26止6個月</font></td>",
        '',
      ),
      'row_malformed',
    );
    expect(error.offendingRow).toContain('9961');
    expect(error.message).toContain('首个不合法行');
  });

  it('代码非数字 ⇒ 行不合法', () => {
    const error = expectParseError(mutate('&nbsp;9961', '&nbsp;99A1'), 'row_malformed');
    expect(error.offendingRow).toContain('99A1');
  });

  it('会议日期日历上不存在 (31/09) ⇒ 行不合法', () => {
    expectParseError(mutate('14/09/2026', '31/09/2026'), 'row_malformed');
  });

  it('会议日期改了写法 (不再是 DD/MM/YYYY) ⇒ 表头之后出现无法识别的行', () => {
    const error = expectParseError(mutate('14/09/2026', '2026-09-14'), 'row_unrecognized');
    expect(error.offendingRow).toContain('2026-09-14');
  });
});
