/**
 * 港交所「董事會會議通知」清单解析纯函数 (079 T003, FR-006 / FR-025 / SC-002 / plan §D7)。
 *
 * 输入 `https://www3.hkexnews.hk/reports/bmn/ebmn_c.htm` 的 HTML 文本 (获取在
 * `hkex-board-meeting-list.source.ts`)，输出 `{ pageDate, rows, counts }`，或整页抛
 * {@link BoardListParseError}。🚫 捕获后返回空结果：空 rows 会被读成「今天没有会议」，
 * 而实际是页面改版 —— 失败 MUST 上抛，由来源隔离计入运行失败、飞书日报标红 (FR-025)。
 *
 * ## 页面结构
 *
 * EVIDENCE: `__fixtures__/hkex-board-meeting-list/` 两份页面 (2026-09-13 当日页、Wayback 2024-04-24
 * 快照) 与本机 evidence 另 6 份可解析快照同形 (8 份合计 1776 个数据行，均为 6 格，T003 impl 期统计)：页首文本「日期 : DD/MM/YYYY」；表头行含「會議日期 / 證券簡稱 / 代號 /
 * 目的 / 期間」(表头行 `<td>` 嵌套不闭合，只按整行文本判)；表头后一行全是 `-` 的分隔行；每个数据行
 * 6 个 `<td>` = 会议日期 / 空列 / 證券簡稱 / 代號 (`&nbsp;` 左补齐，不补零) / 目的 / 期間 (可空)。
 * 页面自述「若董事會會議召開日期多於一天，下表只會顯示董事會會議的開始日期」⇒ 会议日期原样取所列日期。
 *
 * ## 为什么正则 + 结构不变量，不引 HTML 解析库
 *
 * 一张固定结构的小表 (plan § Dependencies 定案，仓内零 HTML 解析依赖)。宽松的 DOM 解析器会把
 * 缺格的行静默修补成「看起来合法」，而这里唯一要显式控制的恰是**非法行的处置**：
 *
 * 1. 页首日期 MUST 解析成功 (`日/月/年`，交 {@link parseDayMonthYear})，否则 `page_date_missing`；
 * 2. 表头 MUST 含五列名，否则 `header_missing`；
 * 3. 表头之后每个 `<tr>` 只能是分隔行或数据行 (首格 `DD/MM/YYYY`)，否则 `row_unrecognized`
 *    —— 日期换了写法时整页的行都不再「形如数据行」，只靠下一条会得到 0 行而不报错；
 * 4. 🚨 结构不变量：数据行数 MUST 等于按列解析成功的行数，任一行列数 / 日期 / 代码不合法 ⇒
 *    `row_malformed` (带首个不合法行)。
 *
 * 目的含「業績」或「收益資料」⇒ 业绩行 (期間交 `earnings-period.rules.ts`)；否则纯股息行计数跳过。
 * 代码补零到 5 位原样输出，人民币柜台 `8xxxx` 等「主表查不到」的跳过在来源层。同日同代码多行各自成行。
 *
 * 复杂度 O(n)，n = HTML 长度 (各正则单遍扫描)。
 */
import {
  isAlignedPeriodKey,
  isBoardListResultsPurpose,
  parseDayMonthYear,
  resolveBoardListPeriod,
  type BoardListPeriodResolution,
} from './earnings-period.rules.js';

/** 来源稳定名 (落 `T:<来源>:<原文>` 键；plan §D2)。 */
export const HKEX_BOARD_MEETING_LIST_SOURCE = 'hkex_board_meeting_list';

export const BOARD_LIST_HEADER_LABELS = ['會議日期', '證券簡稱', '代號', '目的', '期間'] as const;

const DATA_ROW_CELLS = 6;

export type BoardListParseFailureReason =
  | 'page_date_missing'
  | 'header_missing'
  | 'row_unrecognized'
  | 'row_malformed';

const FAILURE_TEXT: Readonly<Record<BoardListParseFailureReason, string>> = {
  page_date_missing: '页首日期「日期 : DD/MM/YYYY」缺失或无法解析',
  header_missing: `表头缺少「${BOARD_LIST_HEADER_LABELS.join(' / ')}」`,
  row_unrecognized: '表头之后出现既非分隔行、也非数据行 (首格 DD/MM/YYYY) 的行',
  row_malformed: `数据行无法按列解析 (应为 ${DATA_ROW_CELLS} 列、日期与代码合法)，结构不变量不成立`,
};

export class BoardListParseError extends Error {
  readonly reason: BoardListParseFailureReason;
  /** 首个不合法行的各格文本 (` | ` 连接)；页首 / 表头类失败为 null。 */
  readonly offendingRow: string | null;

  constructor(reason: BoardListParseFailureReason, offendingRow: string | null) {
    const detail = offendingRow === null ? '' : `；首个不合法行 =「${offendingRow}」`;
    super(`港交所董事會會議通知清单解析失败 (${reason})：${FAILURE_TEXT[reason]}${detail}`);
    this.name = 'BoardListParseError';
    this.reason = reason;
    this.offendingRow = offendingRow;
  }
}

export interface BoardListRow extends BoardListPeriodResolution {
  /** 会议日期 (香港当地日期 `YYYY-MM-DD`)。 */
  readonly meetingDate: string;
  readonly stockName: string;
  /** 补零到 5 位的代码。 */
  readonly code: string;
  readonly purpose: string;
  /** 期間原文 (可为空串)。 */
  readonly periodText: string;
}

export interface BoardListCounts {
  /** 首格形如 `DD/MM/YYYY` 的行数 = `resultRows + dividendOnlyRows` (0 行静默丢弃)。 */
  readonly dataRows: number;
  readonly resultRows: number;
  readonly dividendOnlyRows: number;
  /** 业绩行里换算不出期末日 (`T:` 键) 的行数。 */
  readonly textPeriodKeyRows: number;
  /** 业绩行里「截至…止N個月」N ∉ {3, 6, 9, 12} 的行数。 */
  readonly nonStandardMonthRows: number;
}

export interface BoardListPage {
  /** 页首日期 (香港当地日期 `YYYY-MM-DD`)，陈旧判定的凭据。 */
  readonly pageDate: string;
  readonly rows: readonly BoardListRow[];
  readonly counts: BoardListCounts;
}

const TABLE_ROW = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const TABLE_CELL = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
const PAGE_DATE = /日期\s*:\s*(\d{2}\/\d{2}\/\d{4})/;
const DATA_ROW_FIRST_CELL = /^\d{2}\/\d{2}\/\d{4}$/;
const SEPARATOR_CELL = /^-*$/;
const STOCK_CODE = /^\d{1,5}$/;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

/** 去标签、解实体、折叠空白。 */
function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

type ParsedCells = Pick<
  BoardListRow,
  'meetingDate' | 'stockName' | 'code' | 'purpose' | 'periodText'
>;

function parseDataRowCells(cells: readonly string[]): ParsedCells | null {
  if (cells.length !== DATA_ROW_CELLS) return null;
  const [dateText, , stockName, codeText, purpose, periodText] = cells;
  const meetingDate = parseDayMonthYear(dateText);
  if (meetingDate === null || !STOCK_CODE.test(codeText) || stockName === '' || purpose === '') {
    return null;
  }
  return { meetingDate, stockName, code: codeText.padStart(5, '0'), purpose, periodText };
}

export function parseBoardMeetingList(html: string): BoardListPage {
  const pageDateMatch = PAGE_DATE.exec(textOf(html));
  const pageDate = pageDateMatch === null ? null : parseDayMonthYear(pageDateMatch[1]);
  if (pageDate === null) throw new BoardListParseError('page_date_missing', null);

  const tableRows = [...html.matchAll(TABLE_ROW)].map((m) => m[1]);
  const headerIndex = tableRows.findIndex((row) => {
    const text = textOf(row);
    return BOARD_LIST_HEADER_LABELS.every((label) => text.includes(label));
  });
  if (headerIndex < 0) throw new BoardListParseError('header_missing', null);

  const rows: BoardListRow[] = [];
  let dataRows = 0;
  let dividendOnlyRows = 0;
  let firstMalformedRow: string | null = null;

  for (const row of tableRows.slice(headerIndex + 1)) {
    const cells = [...row.matchAll(TABLE_CELL)].map((m) => textOf(m[1]));
    if (cells.every((cell) => SEPARATOR_CELL.test(cell))) continue;
    if (!DATA_ROW_FIRST_CELL.test(cells[0])) {
      throw new BoardListParseError('row_unrecognized', cells.join(' | '));
    }
    dataRows += 1;

    const parsed = parseDataRowCells(cells);
    if (parsed === null) {
      firstMalformedRow ??= cells.join(' | ');
      continue;
    }
    if (!isBoardListResultsPurpose(parsed.purpose)) {
      dividendOnlyRows += 1;
      continue;
    }
    rows.push({
      ...parsed,
      ...resolveBoardListPeriod(HKEX_BOARD_MEETING_LIST_SOURCE, parsed.periodText, parsed.purpose),
    });
  }

  // 🚨 结构不变量：形如数据行的行必须全部按列解析成功，缺一行即整页失败 (零写入)。
  if (rows.length + dividendOnlyRows !== dataRows) {
    throw new BoardListParseError('row_malformed', firstMalformedRow);
  }

  return {
    pageDate,
    rows,
    counts: {
      dataRows,
      resultRows: rows.length,
      dividendOnlyRows,
      textPeriodKeyRows: rows.filter((r) => !isAlignedPeriodKey(r.periodKey)).length,
      nonStandardMonthRows: rows.filter((r) => r.nonStandardMonths).length,
    },
  };
}
