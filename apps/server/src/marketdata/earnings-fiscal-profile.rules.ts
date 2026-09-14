/**
 * 财年档案反推纯函数 (079 T027, FR-026 / plan §D13)。
 *
 * 标题不带期末日的刊发事实与富途 `period_text` 都要靠「公司财年结束月」才换算得出期末日
 * (`earnings-period.rules.ts`)。财年结束月由本文件从该标的已采集的数据反推一次、落
 * `earnings_fiscal_profile`，之后换算一律读档案 —— 🚫 换算时现推、🚫 未知时代入 12：
 * 非 12 月结年的公司会被静默换算到另一期且不报错。
 *
 * ## 四路来源，各路一致才出值
 *
 * | 路 | 输入 | 取值 |
 * | --- | --- | --- |
 * | `annual_title` | 业绩刊发事实 (`isResultsPublication`) 标题显式期末日、类型 = 年度 | 最近一期的期末月 |
 * | `dividend_title` | `types` 含 `dividend`、标题显式期末日、类型 = 年度、🚫 含「更新」 | 最近一期的期末月 |
 * | `board_list` | 清单「年度DD/MM/YY」行 | 最近一期的期末月 |
 * | `futu_pairing` | 富途观测 ↔ 显式期末日刊发事实，公布日相差 ≤ 1 天 | 全部配对一致的月份 |
 *
 * 各路取到的月份互相矛盾 (或富途配对内部矛盾) ⇒ `conflict`；全无 ⇒ `none`。两者都不写档案，
 * 进日报「财年待补」由维护者人工补录 (`manual`)。
 *
 * EVIDENCE: 「中期股息（更新）」与年度业绩同日刊发但属上一期 (`hk:02628`)；锚 29 只按前三路反推
 * 25 只、各路互不矛盾、与港交所公开报价页财年字段逐只一致 (spec.md 取证「刊发事实与事件对齐」，
 * 2026-09-13 本机回放)。
 *
 * 全部函数零 I/O、零时钟；复杂度 O(a·f)，a = 公告条数、f = 富途观测条数 (配对为两两比较，
 * 单标的近 2 年量级各为数十条)。
 */
import { isResultsPublication } from './earnings-notice.rules.js';
import {
  fiscalYearEndMonthFromFutuPair,
  parseAnnouncementTitlePeriod,
} from './earnings-period.rules.js';

export type FiscalProfileSource =
  | 'annual_title'
  | 'dividend_title'
  | 'board_list'
  | 'futu_pairing'
  | 'manual';

/** `marketdata.announcement` 的一行 (近 2 年)。 */
export interface FiscalProfileAnnouncement {
  /** 刊发日 `YYYY-MM-DD` (交易所当地日期)。 */
  readonly date: string;
  readonly title: string;
  readonly types: readonly string[];
  readonly link: string | null;
}

/** 清单观测的一行 (来源 `hkex_board_meeting_list`)。 */
export interface FiscalProfileBoardListRow {
  /** 期間原文，如「年度31/03/25」。 */
  readonly periodText: string | null;
  /** 换算出的期末日 `YYYY-MM-DD`；换算不出为 null。 */
  readonly periodEnd: string | null;
  /** 凭据指针 (清单页首日期等)。 */
  readonly evidence: string | null;
}

/** 富途财报日历观测的一行 (来源 `futu_calendar`)。 */
export interface FiscalProfileFutuObservation {
  readonly periodText: string | null;
  /** 富途给出的财报日 `YYYY-MM-DD`。 */
  readonly earningsDate: string;
}

export interface FiscalProfileInput {
  readonly announcements: readonly FiscalProfileAnnouncement[];
  readonly boardListRows: readonly FiscalProfileBoardListRow[];
  readonly futuObservations: readonly FiscalProfileFutuObservation[];
}

export interface FiscalProfileResolved {
  readonly month: number;
  /** 取值的路 (多路一致时取 {@link SOURCE_PRIORITY} 最靠前者)。 */
  readonly source: FiscalProfileSource;
  /** 各一致路的凭据 (`<路>: …`，`; ` 连接)。 */
  readonly evidence: string;
}

export interface FiscalProfilePending {
  readonly pending: 'none' | 'conflict';
  readonly detail: string;
}

export type FiscalProfileResolution = FiscalProfileResolved | FiscalProfilePending;

export function isFiscalProfilePending(r: FiscalProfileResolution): r is FiscalProfilePending {
  return 'pending' in r;
}

const DIVIDEND_TYPE = 'dividend';
/** 「中期股息（更新）」类属上一期，不作来源 (`hk:02628`，见文件头 EVIDENCE)。 */
const DIVIDEND_UPDATE = '更新';
const BOARD_LIST_ANNUAL = /^年度/;

const SOURCE_PRIORITY: readonly FiscalProfileSource[] = [
  'annual_title',
  'dividend_title',
  'board_list',
  'futu_pairing',
];

interface PathValue {
  readonly source: FiscalProfileSource;
  /** 该路内部矛盾时为 null (只富途配对会出现)。 */
  readonly month: number | null;
  readonly evidence: string;
}

interface Dated {
  readonly periodEnd: string;
  readonly evidence: string;
}

function monthOf(isoDate: string): number {
  return Number(isoDate.slice(5, 7));
}

function latest(items: readonly Dated[]): Dated | undefined {
  return [...items].sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1)).at(-1);
}

function announcementEvidence(a: FiscalProfileAnnouncement): string {
  return `${a.date}「${a.title}」${a.link === null ? '' : ` ${a.link}`}`;
}

function annualTitles(
  announcements: readonly FiscalProfileAnnouncement[],
  accept: (a: FiscalProfileAnnouncement) => boolean,
): Dated[] {
  return announcements.filter(accept).flatMap((a) => {
    const p = parseAnnouncementTitlePeriod(a.title);
    return p !== null && p.reportKind === 'annual'
      ? [{ periodEnd: p.periodEnd, evidence: announcementEvidence(a) }]
      : [];
  });
}

const isAnnualResultsSource = (a: FiscalProfileAnnouncement) =>
  isResultsPublication(a.title, a.types);
const isAnnualDividendSource = (a: FiscalProfileAnnouncement) =>
  a.types.includes(DIVIDEND_TYPE) && !a.title.includes(DIVIDEND_UPDATE);

function fromLatest(source: FiscalProfileSource, items: readonly Dated[]): PathValue | null {
  const top = latest(items);
  return top === undefined
    ? null
    : { source, month: monthOf(top.periodEnd), evidence: `${source}: ${top.evidence}` };
}

function futuPairingPath(input: FiscalProfileInput): PathValue | null {
  const filings = input.announcements.flatMap((a) => {
    if (!isResultsPublication(a.title, a.types)) return [];
    const p = parseAnnouncementTitlePeriod(a.title);
    return p === null ? [] : [{ a, periodEnd: p.periodEnd }];
  });
  const byMonth = new Map<number, string>();
  for (const obs of input.futuObservations) {
    for (const f of filings) {
      const month = fiscalYearEndMonthFromFutuPair({
        futuPeriodText: obs.periodText,
        futuDate: obs.earningsDate,
        filingDate: f.a.date,
        filingPeriodEnd: f.periodEnd,
      });
      if (month !== null && !byMonth.has(month)) {
        byMonth.set(month, `${obs.periodText}@${obs.earningsDate} ↔ ${announcementEvidence(f.a)}`);
      }
    }
  }
  if (byMonth.size === 0) return null;
  const entries = [...byMonth.entries()];
  if (entries.length > 1) {
    return {
      source: 'futu_pairing',
      month: null,
      evidence: `futu_pairing: 配对结论矛盾 ${entries.map(([m, e]) => `${m} 月 (${e})`).join(' / ')}`,
    };
  }
  return {
    source: 'futu_pairing',
    month: entries[0][0],
    evidence: `futu_pairing: ${entries[0][1]}`,
  };
}

/**
 * 某标的的财年结束月反推。各路一致 ⇒ `{ month, source, evidence }`；矛盾 ⇒ `{ pending: 'conflict' }`；
 * 全无 ⇒ `{ pending: 'none' }`。🚫 任何分支代入 12。
 */
export function resolveFiscalProfile(input: FiscalProfileInput): FiscalProfileResolution {
  const boardRows: Dated[] = input.boardListRows.flatMap((r) =>
    r.periodEnd !== null && BOARD_LIST_ANNUAL.test(r.periodText?.trim() ?? '')
      ? [{ periodEnd: r.periodEnd, evidence: `「${r.periodText}」${r.evidence ?? ''}` }]
      : [],
  );
  const paths = [
    fromLatest('annual_title', annualTitles(input.announcements, isAnnualResultsSource)),
    fromLatest('dividend_title', annualTitles(input.announcements, isAnnualDividendSource)),
    fromLatest('board_list', boardRows),
    futuPairingPath(input),
  ].filter((p): p is PathValue => p !== null);

  if (paths.length === 0) {
    return {
      pending: 'none',
      detail: '无年度业绩标题 / 年度股息标题 / 清单年度行 / 富途配对可反推财年结束月',
    };
  }
  const [first] = paths;
  const months = new Set(paths.map((p) => p.month));
  if (first.month === null || months.size > 1) {
    return {
      pending: 'conflict',
      detail: paths
        .map((p) => (p.month === null ? p.evidence : `${p.month} 月 ← ${p.evidence}`))
        .join('; '),
    };
  }
  const primary = SOURCE_PRIORITY.find((s) => paths.some((p) => p.source === s)) ?? first.source;
  return {
    month: first.month,
    source: primary,
    evidence: paths.map((p) => p.evidence).join('; '),
  };
}

export interface FiscalProfileTitleConflict {
  /** 最近一期年度业绩标题显式期末日的月份。 */
  readonly titleMonth: number;
  readonly detail: string;
}

/**
 * 已有档案的标的：最近一期年度业绩标题的显式期末月与档案月不同 ⇒ 矛盾 (公司可能改财年)，
 * 由调用方告警、🚫 覆盖档案 (FR-026)。无年度业绩标题或一致 ⇒ null。
 */
export function findFiscalProfileTitleConflict(
  profileMonth: number,
  announcements: readonly FiscalProfileAnnouncement[],
): FiscalProfileTitleConflict | null {
  const top = latest(annualTitles(announcements, isAnnualResultsSource));
  if (top === undefined || monthOf(top.periodEnd) === profileMonth) return null;
  return {
    titleMonth: monthOf(top.periodEnd),
    detail: `档案 ${profileMonth} 月 ≠ 年度业绩标题 ${monthOf(top.periodEnd)} 月: ${top.evidence}`,
  };
}
