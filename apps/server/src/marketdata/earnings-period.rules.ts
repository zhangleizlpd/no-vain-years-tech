/**
 * 报告期统一纯函数 (079 T001, FR-015 / plan §D4)。
 *
 * 三个来源对「同一次财报」的写法各不相同，跨来源对齐前 MUST 先换算成同一口径：
 *
 * | 来源 | 原文 | 换算 |
 * | --- | --- | --- |
 * | 港交所董事會會議通知清单 | 期間列「截至30/06/26止6個月」「年度31/03/25」… + 目的列 | {@link resolveBoardListPeriod} |
 * | 交易所业绩公告 | 标题「截至二零二六年六月三十日止六個月…」「2025年六月底止季度…」「二零二五年中期業績公告」 | {@link parseAnnouncementTitlePeriod} / {@link resolveAnnouncementPeriod} |
 * | 富途财报日历 | `period_text`「2027Q1」(按公司财年) | {@link resolveFutuPeriod} |
 *
 * 财年结束月一律由调用方传入财年档案值 (`earnings-fiscal-profile.rules.ts`，FR-026)，🚫 换算时现推。
 *
 * ## `period_key` 三形态 (plan §D3，列非空)
 *
 * - `P:<期末日>` —— 可跨来源对齐；**只有它参与跨来源合并**。
 * - `T:<来源>:<原文报告期>` —— 换算不出期末日，来源内稳定；独立事件并计数，🚫 猜测性合并 (FR-015)。
 * - `D:<来源>:<日期>` —— 连原文报告期都没有时的兜底。
 *
 * ## 🚨 日期一律自己拆，🚫 交给 `new Date('10/09/2026')` 之类的字符串解析
 *
 * 清单日期是 `日/月/年`、期間里的年份是两位：按「月/日」解析会把 10/09 读成 10 月 9 日，
 * 两位年份交给宿主库可能落成 19YY —— 两者都**不报错**，只让数字差几个月或一个世纪。
 * EVIDENCE: 页首「日期 : 10/09/2026」与 `Last-Modified` 2026-09-10 12:30 (香港时间) 同日 ——
 * spec.md 取证「港交所董事會會議通知清单」段 (2026-09-13 plan 期抓取)。
 *
 * ## 🚫 富途不默认 12 月结年
 *
 * EVIDENCE: `period_text` 按公司财年、以财年结束所在年命名 —— 阿里 (3 月结) `2027Q1` = 截至
 * 2026-06-30 (spec.md 取证)；本机 evidence `earnings_poc_hk_hist.jsonl` 里 `HK.09988` 2025-05-15
 * 记 `2025Q4`、`HK.00315` 2024-09-03 记 `2024Q4` (T001 impl 期统计)。默认 12 月会把阿里每一期
 * 错配到另一个季度且不报错，故财年未知 ⇒ `T:` 键。
 *
 * 全部函数零 I/O、零时钟 (ADR-0043 判据落 `*.rules.ts`)；复杂度 O(n)，n = 原文长度 / 配对条数。
 */

export type EarningsReportKind = 'quarterly' | 'interim' | 'annual';

export interface PeriodResolution {
  readonly periodKey: string;
  /** 统一期末日 `YYYY-MM-DD`；换算不出为 null (此时 `periodKey` 必非 `P:`)。 */
  readonly periodEnd: string | null;
  readonly reportKind: EarningsReportKind | null;
}

export interface BoardListPeriodResolution extends PeriodResolution {
  /** 「截至…止N個月」且 N ∉ {3, 6, 9, 12} (停牌补批 15 / 18 個月等) ⇒ 按年度处理并计数。 */
  readonly nonStandardMonths: boolean;
}

export interface AnnouncementTitlePeriod {
  readonly periodEnd: string;
  readonly reportKind: EarningsReportKind | null;
}

/** 同一公司的一次富途观测与一次交易所刊发事实 (供反推财年结束月)。 */
export interface FutuFilingPair {
  readonly futuPeriodText: string | null;
  readonly futuDate: string;
  readonly filingDate: string;
  /** 刊发事实标题换算出的期末日 (来自 {@link parseAnnouncementTitlePeriod})。 */
  readonly filingPeriodEnd: string;
}

/** 富途观测与刊发事实公布日相差不超过这么多天才算同一次财报 (plan §D4 ②)。 */
export const FUTU_FILING_PAIR_MAX_GAP_DAYS = 1;

export function alignedPeriodKey(periodEnd: string): string {
  return `P:${periodEnd}`;
}

export function textPeriodKey(source: string, periodText: string): string {
  return `T:${source}:${periodText}`;
}

export function datePeriodKey(source: string, date: string): string {
  return `D:${source}:${date}`;
}

export function isAlignedPeriodKey(periodKey: string): boolean {
  return periodKey.startsWith('P:');
}

// ─── 日历算术 (只接受数值分量，不解析日期字符串) ─────────────────────────────

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (![year, month, day].every(Number.isInteger)) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthEndIso(year: number, month: number): string | null {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return toIsoDate(year, month, daysInMonth(year, month));
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoDate(text: string): CalendarDate | null {
  const m = ISO_DATE.exec(text);
  if (m === null) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return toIsoDate(year, month, day) === null ? null : { year, month, day };
}

function dayNumber(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day) / 86_400_000;
}

const DAY_MONTH_YEAR = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/;

/**
 * 港交所清单日期 `DD/MM/YY` / `DD/MM/YYYY` → `YYYY-MM-DD`；🚨 `日/月/年` 顺序、两位年份 = `20YY`。
 * 不合形态或日历上不存在 ⇒ null (交调用方决定抛错还是计数)。
 */
export function parseDayMonthYear(text: string): string | null {
  const m = DAY_MONTH_YEAR.exec(text.trim());
  if (m === null) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return toIsoDate(year, Number(m[2]), Number(m[1]));
}

function kindFromMonths(months: number): EarningsReportKind | null {
  if (months === 3 || months === 9) return 'quarterly';
  if (months === 6) return 'interim';
  if (months === 12) return 'annual';
  return null;
}

// ─── ① 清单 ────────────────────────────────────────────────────────────────

const RESULTS_PURPOSE = /業績|收益資料/;

/** 清单目的列是否为业绩行 (含「業績」或「收益資料」；否则是纯股息行) —— plan §D7 ④。 */
export function isBoardListResultsPurpose(purpose: string): boolean {
  return RESULTS_PURPOSE.test(purpose);
}

/**
 * 目的列 → 报告类型。只看**业绩段**：「末期業績/中期息」的「中期」、「業績/季度股息」的「季」
 * 说的是股息，不是报告期。无季度 / 中期 / 末期字样 ⇒ null (由期間换算)。
 */
function kindFromPurpose(purpose: string): EarningsReportKind | null {
  const resultSegments = purpose.split('/').filter((s) => RESULTS_PURPOSE.test(s));
  const text = resultSegments.length > 0 ? resultSegments.join('/') : purpose;
  if (text.includes('季')) return 'quarterly';
  if (text.includes('中期')) return 'interim';
  if (text.includes('末期')) return 'annual';
  return null;
}

const SHORT_DMY = '(\\d{2}/\\d{2}/\\d{2})';
const BOARD_N_MONTHS = new RegExp(`^截至${SHORT_DMY}止(\\d+)個月$`);
const BOARD_ANNUAL = new RegExp(`^年度${SHORT_DMY}$`);
const BOARD_QUARTER = new RegExp(`^截至${SHORT_DMY}止季度$`);
const BOARD_UNTIL = new RegExp(`^截至${SHORT_DMY}期間$`);
const BOARD_RANGE = new RegExp(`^由${SHORT_DMY}至${SHORT_DMY}$`);
const BOARD_CALENDAR_QUARTER = /^\d{4}年第[一二三四]季$/;

/**
 * 清单一行的「期間」+「目的」→ 报告期。类型：目的有季度 / 中期 / 末期字样取目的，否则取期間。
 *
 * - 「截至DD/MM/YY止N個月」N = 3 / 9 季度、6 中期、12 年度，其他 N ⇒ 年度 + `nonStandardMonths`
 * - 「年度DD/MM/YY」年度；「截至DD/MM/YY止季度」季度
 * - 「截至DD/MM/YY期間」期末 = 该日、类型只能取目的；「由DD/MM/YY至DD/MM/YY」期末 = 截止日、
 *   目的无字样时按跨越月数换算
 * - 「YYYY年第N季」(公司财年未知)、空白、其他写法 ⇒ `T:` 键
 */
export function resolveBoardListPeriod(
  source: string,
  periodText: string,
  purpose: string,
): BoardListPeriodResolution {
  const text = periodText.trim();
  const purposeKind = kindFromPurpose(purpose);
  const unaligned = (periodKind: EarningsReportKind | null): BoardListPeriodResolution => ({
    periodKey: textPeriodKey(source, text),
    periodEnd: null,
    reportKind: purposeKind ?? periodKind,
    nonStandardMonths: false,
  });
  const aligned = (
    endText: string,
    periodKind: EarningsReportKind | null,
    nonStandardMonths = false,
  ): BoardListPeriodResolution => {
    const periodEnd = parseDayMonthYear(endText);
    if (periodEnd === null) return unaligned(periodKind);
    return {
      periodKey: alignedPeriodKey(periodEnd),
      periodEnd,
      reportKind: purposeKind ?? periodKind,
      nonStandardMonths,
    };
  };

  let m: RegExpExecArray | null;
  if ((m = BOARD_N_MONTHS.exec(text)) !== null) {
    const kind = kindFromMonths(Number(m[2]));
    return aligned(m[1], kind ?? 'annual', kind === null);
  }
  if ((m = BOARD_ANNUAL.exec(text)) !== null) return aligned(m[1], 'annual');
  if ((m = BOARD_QUARTER.exec(text)) !== null) return aligned(m[1], 'quarterly');
  if ((m = BOARD_UNTIL.exec(text)) !== null) return aligned(m[1], null);
  if ((m = BOARD_RANGE.exec(text)) !== null) {
    const start = parseIsoDate(parseDayMonthYear(m[1]) ?? '');
    const end = parseIsoDate(parseDayMonthYear(m[2]) ?? '');
    const spanMonths =
      start !== null && end !== null
        ? end.year * 12 + end.month - (start.year * 12 + start.month) + 1
        : 0;
    return aligned(m[2], kindFromMonths(spanMonths));
  }
  if (BOARD_CALENDAR_QUARTER.test(text)) return unaligned('quarterly');
  return unaligned(null);
}

// ─── ② 交易所业绩公告标题 ─────────────────────────────────────────────────

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  '○': 0,
  O: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const TITLE_YEAR = '([0-9]{4}|[零〇○O一二三四五六七八九]{4})';
const TITLE_NUM = '([0-9]{1,2}|[一二三四五六七八九十]{1,3})';
/** 「(截至)YYYY年M月D日止」—— `截至` 可省 (「二零二五年六月三十日止六個月之中期業績」)。 */
const TITLE_DATE_END = new RegExp(
  `${TITLE_YEAR}\\s*年\\s*${TITLE_NUM}\\s*月\\s*${TITLE_NUM}\\s*日\\s*止`,
);
const TITLE_MONTH_END_QUARTER = new RegExp(
  `${TITLE_YEAR}\\s*年\\s*${TITLE_NUM}\\s*月底\\s*止\\s*季度`,
);
/** 紧跟「止」之后的跨度：「(之/的)六個月」「三個月及九個月」「年度」。 */
const TITLE_SPAN = new RegExp(
  `^\\s*[之的]?\\s*(?:${TITLE_NUM}\\s*[個个]月(?:\\s*及\\s*${TITLE_NUM}\\s*[個个]月)?|(年度))`,
);

/** 阿拉伯数字或中文数字 (一 ~ 九十九) → 整数；无法识别 ⇒ NaN。 */
function parseTitleNumber(text: string): number {
  if (/^[0-9]+$/.test(text)) return Number(text);
  if (text.includes('十')) {
    const [tens, ones] = text.split('十');
    const t = tens === '' ? 1 : (CN_DIGITS[tens] ?? Number.NaN);
    const o = ones === '' ? 0 : (CN_DIGITS[ones] ?? Number.NaN);
    return t * 10 + o;
  }
  return text.length === 1 ? (CN_DIGITS[text] ?? Number.NaN) : Number.NaN;
}

/** 「2026」或逐位中文「二零二六 / 二〇二五 / 二O二五」→ 整数。 */
function parseTitleYear(text: string): number {
  if (/^[0-9]{4}$/.test(text)) return Number(text);
  return Number([...text].map((c) => CN_DIGITS[c] ?? Number.NaN).join(''));
}

function kindFromTitleRemainder(rest: string): EarningsReportKind | null {
  const span = TITLE_SPAN.exec(rest);
  if (span !== null) {
    if (span[3] !== undefined) return 'annual';
    const months = Math.max(
      parseTitleNumber(span[1]),
      span[2] === undefined ? 0 : parseTitleNumber(span[2]),
    );
    const kind = kindFromMonths(months);
    if (kind !== null) return kind;
  }
  // 🚨 先认「半年度 / 中期 / 上半年」再认「年度 / 全年」(FR-027)：「止半年度業績」含「年度」，
  // 反过来会判成年度，财年结束月被推成 6 月且不报错 (spec 取证：prod 近 2 年 37 条)。
  if (/半年度|中期|上半年/.test(rest)) return 'interim';
  if (/年度|全年/.test(rest)) return 'annual';
  if (rest.includes('季')) return 'quarterly';
  return null;
}

/**
 * 业绩公告标题 → 期末日与类型；取到期末日即可落 `P:` 键。只认显式期末日的两种写法：
 * 「(截至)YYYY年M月D日止…」与「YYYY年M月底止季度」(阿拉伯与中文数字)。
 * 「2025年第一季度報告」「2024年度業績公告」这类不带期末日的 ⇒ null，🚫 按自然年猜。
 *
 * EVIDENCE: 写法取自本机 evidence `lixinger_hk23.json` 23 只锚两年 159 条 `fs_main` 标题
 * (T001 impl 期统计：含「截至二零二五年六月三十日止三個月及六個月業績公佈」「2025年六月底止季度業績公告」
 * 「2024年12月31日止第四季度及財政年度…」「截至2025年 9 月 30日止三個月及九個月之業績公告」)。
 */
export function parseAnnouncementTitlePeriod(title: string): AnnouncementTitlePeriod | null {
  const dateEnd = TITLE_DATE_END.exec(title);
  if (dateEnd !== null) {
    const periodEnd = toIsoDate(
      parseTitleYear(dateEnd[1]),
      parseTitleNumber(dateEnd[2]),
      parseTitleNumber(dateEnd[3]),
    );
    if (periodEnd === null) return null;
    const rest = title.slice(dateEnd.index + dateEnd[0].length);
    return { periodEnd, reportKind: kindFromTitleRemainder(rest) };
  }
  const monthEnd = TITLE_MONTH_END_QUARTER.exec(title);
  if (monthEnd !== null) {
    const periodEnd = monthEndIso(parseTitleYear(monthEnd[1]), parseTitleNumber(monthEnd[2]));
    return periodEnd === null ? null : { periodEnd, reportKind: 'quarterly' };
  }
  return null;
}

/**
 * 刊发时限 (月)：期末日之后多少个月内刊发才认作该期。候选期末日只取「刊发日 − 期末日 ∈ (0, 时限]」者。
 * EVIDENCE: 上市规则 13.49 年度 3 个月、中期 2 个月；季度取 3 个月 —— 取 1 个月时 `hk:09961` 季报
 * (期末后第 49–50 天刊发) 4 次超窗 (spec.md 取证「刊发事实与事件对齐」，2026-09-13 本机回放)。
 */
export const PUBLICATION_DEADLINE_MONTHS: Readonly<Record<EarningsReportKind, number>> = {
  annual: 3,
  interim: 2,
  quarterly: 3,
};

/** 标题不带期末日时的报告部分；季度需区分第一 / 第三季才定得出期末月。 */
type TitleReportPart = 'annual' | 'interim' | 'q1' | 'q3';

/** 该部分期末月相对财年结束月的月数偏移。 */
const PART_MONTH_OFFSET: Readonly<Record<TitleReportPart, number>> = {
  annual: 0,
  interim: -6,
  q1: -9,
  q3: -3,
};

const PART_KIND: Readonly<Record<TitleReportPart, EarningsReportKind>> = {
  annual: 'annual',
  interim: 'interim',
  q1: 'quarterly',
  q3: 'quarterly',
};

/** 🚨 与 {@link kindFromTitleRemainder} 同序：先认中期再认年度 (FR-027)。 */
function titleReportPart(title: string): TitleReportPart | null {
  if (/半年度|中期|上半年|半年/.test(title)) return 'interim';
  if (/第一季|首季|一季度|第1季/.test(title)) return 'q1';
  if (/第三季|首三季|前三季|首3季|三季度/.test(title)) return 'q3';
  if (/全年|年度|年業績|末期/.test(title)) return 'annual';
  return null;
}

const TITLE_FISCAL_YEAR_PAIR = new RegExp(
  `${TITLE_YEAR}年?[╱/／至及-]([0-9]{2,4}|[零〇○O一二三四五六七八九]{2,4})年?`,
);
const TITLE_FIRST_YEAR = new RegExp(TITLE_YEAR);

/**
 * 标题里的财年年份。「2024/25年度」这类跨年写法 ⇒ 财年结束年确定 (只一个候选)；
 * 单个年份 ⇒ 公司可能按财年开始年或结束年命名，由调用方各出一个候选。
 */
function titleFiscalYear(title: string): { year: number; isEndYear: boolean } | null {
  const text = title.replace(/&#x2f;/gi, '/').replace(/\s+/g, '');
  const pair = TITLE_FISCAL_YEAR_PAIR.exec(text);
  if (pair !== null) {
    const start = parseTitleYear(pair[1]);
    let end = /^[0-9]+$/.test(pair[2]) ? Number(pair[2]) : parseTitleYear(pair[2]);
    if (end < 100) end += Math.floor(start / 100) * 100;
    if (end === start + 1) return { year: end, isEndYear: true };
  }
  const first = TITLE_FIRST_YEAR.exec(text);
  if (first === null) return null;
  const year = parseTitleYear(first[1]);
  return Number.isInteger(year) ? { year, isEndYear: false } : null;
}

function monthEndFromAbsolute(absMonth: number): string | null {
  return monthEndIso(Math.floor(absMonth / 12), (absMonth % 12) + 1);
}

/**
 * 刊发事实标题 → 期末日与类型 (FR-027)。标题带显式期末日 ⇒ 同 {@link parseAnnouncementTitlePeriod}；
 * 否则候选期末日 = 标题年份 + 报告类型 + 财年结束月 (单个年份在非 12 月结年时按两种命名习惯各得一个候选)，
 * 只取「刊发日 − 期末日 ∈ (0, 时限]」({@link PUBLICATION_DEADLINE_MONTHS}) 的唯一者。
 * 两个候选相隔 12 个月而时限 < 12 个月 ⇒ 至多一个落窗。
 *
 * 无唯一候选 / 认不出类型或年份 / 🚫 财年结束月未知 (null，🚫 代入 12) ⇒ null，由调用方落 `D:` 键并计数。
 * 财年结束月 MUST 来自财年档案 (`earnings-fiscal-profile.rules.ts`)，🚫 换算时现推。
 */
export function resolveAnnouncementPeriod(
  title: string,
  input: { readonly announceDate: string; readonly fiscalYearEndMonth: number | null },
): AnnouncementTitlePeriod | null {
  const explicit = parseAnnouncementTitlePeriod(title);
  if (explicit !== null) return explicit;

  const fy = input.fiscalYearEndMonth;
  if (fy === null || !Number.isInteger(fy) || fy < 1 || fy > 12) return null;
  if (parseIsoDate(input.announceDate) === null) return null;
  const part = titleReportPart(title);
  const year = titleFiscalYear(title);
  if (part === null || year === null) return null;

  const endYears = year.isEndYear || fy === 12 ? [year.year] : [year.year, year.year + 1];
  const inWindow = candidatesInWindow(part, endYears, fy, input.announceDate);
  if (inWindow.length !== 1) return null;
  return { periodEnd: inWindow[0], reportKind: PART_KIND[part] };
}

/** 各财年结束年的候选期末日中，刊发日落在 (期末日, 期末日 + 时限] 内的那些 (去重)。 */
function candidatesInWindow(
  part: TitleReportPart,
  endYears: readonly number[],
  fiscalYearEndMonth: number,
  announceDate: string,
): string[] {
  const deadline = PUBLICATION_DEADLINE_MONTHS[PART_KIND[part]];
  const inWindow = new Set<string>();
  for (const endYear of endYears) {
    const absMonth = endYear * 12 + (fiscalYearEndMonth - 1) + PART_MONTH_OFFSET[part];
    const candidate = monthEndFromAbsolute(absMonth);
    const lastDay = monthEndFromAbsolute(absMonth + deadline);
    if (
      candidate !== null &&
      lastDay !== null &&
      candidate < announceDate &&
      announceDate <= lastDay
    ) {
      inWindow.add(candidate);
    }
  }
  return [...inWindow];
}

// ─── ③ 富途 period_text ───────────────────────────────────────────────────

const FUTU_FISCAL_QUARTER = /^(\d{4})Q([1-4])$/;

/** EVIDENCE: 本机 evidence `earnings_poc_hk_hist.jsonl` 11156 行里 8 行 `period_text` = `"N/A"`，其余全为 `YYYYQn` (T001 impl 期统计)。 */
const FUTU_MISSING_PERIOD_TEXT = 'N/A';

function fiscalQuarterKind(quarter: number): EarningsReportKind {
  if (quarter === 4) return 'annual';
  return quarter === 2 ? 'interim' : 'quarterly';
}

/** 财年结束月 M 的公司，其「Y 财年第 q 季」期末所在月的绝对月序 = Y×12 + (M−1) − 3×(4−q)。 */
function fiscalQuarterEnd(
  label: number,
  quarter: number,
  fiscalYearEndMonth: number,
): string | null {
  const absMonth = label * 12 + (fiscalYearEndMonth - 1) - 3 * (4 - quarter);
  return monthEndIso(Math.floor(absMonth / 12), (absMonth % 12) + 1);
}

/**
 * 一条「富途观测 ↔ 交易所刊发事实」配对反推的财年结束月；公布日相差 > 1 天或推不出 1–12 月 ⇒ null。
 * 多条配对怎么合、与其他来源怎么对账在财年档案 (`earnings-fiscal-profile.rules.ts`)。
 */
export function fiscalYearEndMonthFromFutuPair(pair: FutuFilingPair): number | null {
  const m = FUTU_FISCAL_QUARTER.exec(pair.futuPeriodText?.trim() ?? '');
  const futuDate = parseIsoDate(pair.futuDate);
  const filingDate = parseIsoDate(pair.filingDate);
  const periodEnd = parseIsoDate(pair.filingPeriodEnd);
  if (m === null || futuDate === null || filingDate === null || periodEnd === null) return null;
  if (Math.abs(dayNumber(futuDate) - dayNumber(filingDate)) > FUTU_FILING_PAIR_MAX_GAP_DAYS) {
    return null;
  }
  const monthIndex =
    periodEnd.year * 12 + (periodEnd.month - 1) + 3 * (4 - Number(m[2])) - Number(m[1]) * 12;
  return monthIndex >= 0 && monthIndex <= 11 ? monthIndex + 1 : null;
}

/**
 * 富途 `period_text` → 报告期。财年结束月由调用方传入财年档案值。港股且财年结束月已知 ⇒ `P:`；港股财年未知、美股 (无第二来源)、
 * 非 `YYYYQn` 原文 ⇒ `T:`；原文缺失 (null / 空白 / `N/A`) ⇒ `D:<来源>:<财报日>`。
 */
export function resolveFutuPeriod(
  source: string,
  input: {
    readonly market: 'hk' | 'us';
    readonly periodText: string | null;
    readonly earningsDate: string;
    readonly fiscalYearEndMonth: number | null;
  },
): PeriodResolution {
  const text = input.periodText?.trim() ?? '';
  if (text === '' || text === FUTU_MISSING_PERIOD_TEXT) {
    return {
      periodKey: datePeriodKey(source, input.earningsDate),
      periodEnd: null,
      reportKind: null,
    };
  }
  const m = FUTU_FISCAL_QUARTER.exec(text);
  if (m === null)
    return { periodKey: textPeriodKey(source, text), periodEnd: null, reportKind: null };

  const quarter = Number(m[2]);
  const reportKind = fiscalQuarterKind(quarter);
  const fy = input.fiscalYearEndMonth;
  const periodEnd =
    input.market === 'hk' && fy !== null ? fiscalQuarterEnd(Number(m[1]), quarter, fy) : null;
  if (periodEnd === null)
    return { periodKey: textPeriodKey(source, text), periodEnd: null, reportKind };
  return { periodKey: alignedPeriodKey(periodEnd), periodEnd, reportKind };
}
