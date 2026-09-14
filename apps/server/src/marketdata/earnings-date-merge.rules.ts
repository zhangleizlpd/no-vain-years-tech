/**
 * 财报日期合并纯函数 (079 T004 / T005, FR-008 ~ FR-019a / FR-028, plan §D8)。
 *
 * 两个入口，均零 I/O、零时钟 (ADR-0043)：
 *
 * 1. {@link mergeEarningsDateEvent} —— 某 `(instrument, period_key)` 事件：取值 / 冲突 / 确认 /
 *    刊发覆盖 / 逾期 / 改期留痕 / 清单行提前消失。输出事件字段 + 流水 + findings 候选。
 * 2. {@link judgeNoticeUndated} —— 某标的：会前通知刊发后满 2 个交易日仍无任何日期 ⇒ 已通知日期未知。
 *    通知不带报告期 ⇒ 状态挂在占位事件 ({@link noticeUndatedPeriodKey}) 上；迁出 ⇒ `superseded`。
 *
 * ## 🚫 规则里不出现任何来源名 (FR-001)
 *
 * 判据只有两样：观测的取值口径 `basis`，与来源对该市场的能力声明 (`capabilities`)。换源 / 加源 /
 * 停源只改装配 (SC-010)。来源名只作为留痕数据原样透传。
 *
 * ## 取值 (FR-009 / FR-014)
 *
 * | 情形 | 取值 | 冲突 |
 * | --- | --- | --- |
 * | 有 `filed` | `filed` 日期 (FR-019 刊发覆盖；其余口径只留痕) | 多个 `filed` 日期不一致 |
 * | 无 `filed`、有 `explicit` | `explicit` 日期 (近似口径只留痕) | 多个 `explicit` 日期不一致 |
 * | 只有近似口径、全部相差 ≤ 1 天 | 优先级 `structured` > `meeting` | 否 |
 * | 只有近似口径、相差 ≥ 2 天、结构化日期 = 某清单会议日 | 去掉这些结构化值后 ≤ 1 天 ⇒ 取会议日推定 | 否 (可解释差异) |
 * | 其余 | —— (公布日 null) | 是 |
 *
 * 会议日推定 = 会议日 + 该类报告最近一次间隔 (无历史按 0，FR-010)。
 *
 * ## 确认 (FR-011 / FR-012)
 *
 * - 有「仅已公告」来源给出日期 ⇒ 确认；只有「确认状态未知」来源 ⇒ 🚫 永不升级 (FR-021)。
 * - 确认日期 = 同标的、刊发日 ∈ `[事件日期 − 120 天, 事件日期]` 且晚于该标的上一次刊发事实的
 *   会前通知信号中最早者 (`announced`)；无则给出日期的「仅已公告」来源首次观测当地日期 (`first_seen`)。
 * - 🚨 **只前移不回退**：既有 `announced` 而本轮无对应信号 ⇒ 保留；否则只在本轮值更早时替换。
 *   通知早于采集窗口时，一次改期就会让「重新算出的首次观测」把确认时刻静默推迟 (analyze I1)。
 * - 既有确认日期不因本轮缺来源而撤销 (FR-018) ⇒ 状态仍为确认。
 *
 * ## 状态迁移 (FR-016 / FR-017 / FR-019 / FR-019a / FR-028)
 *
 * - 取值口径为 `filed` ⇒ `published`；迁入那一轮产出各来源各口径偏差与「会议 → 刊发」间隔。
 * - 非 `published`、有公布日、公布日后满 {@link STATUS_DUE_TRADING_DAYS} 个交易日 ⇒ `overdue`；
 *   刊发或改期后按本轮输入重判即解除。
 * - 🚨 交易日数只认 `TradingCalendarPort.countTradingDays` 的结果 (🚫 按日历日：周五公布、周一
 *   已是 3 个日历日却只有 1 个交易日)；`null` ⇒ 不判、产出 `unjudged`。
 * - 🚨 **只对「具备刊发事实来源的市场」中有财年档案的标的判定** (FR-028)：市场由来源能力声明
 *   `publicationFact` 判；无档案 ⇒ 不迁入、只报「无法判定」—— 刊发事实对不上同期事件时，
 *   无档案的标的会被成批误判逾期。
 * - 🚨 **逾期只判期末日对齐键 (`P:`) 的事件** (FR-015 / FR-028)：`T:` / `D:` 键永远等不到同键的刊发事实 ⇒
 *   不迁入、不计失败、只计数 —— 后补财年档案的标的，其历史未对齐事件会被成批误判逾期 (2026-09-14 prod
 *   `hk:00939` 8 条实证)。已通知日期未知是标的级判定，🚫 受此限。
 * - 🚨 **非季报公司的第一 / 第三季不判逾期** (FR-029，spec Session（八）1b)：期末日按财年档案为第一 / 第三财季、
 *   且公布日前 {@link QUARTERLY_FILING_LOOKBACK_DAYS} 天内无季度业绩刊发事实 ⇒ 不迁入、只计数；既有逾期**解除**回原状态
 *   (稳定结论，区别于日历不可判 / 键无法对齐时的「保持不变」)。EVIDENCE: 2026-09-14 prod `hk:01299` —— 富途把
 *   「第三季新業務摘要」(`types=all`，非业绩公告) 列成 Q3 财报日，产生 2 条逾期误报 (本机 evidence
 *   `t026-investigation/report.md` A1)。
 * - 🚨 `overdue` / `notified_undated` 的 finding **只在迁入那一轮**产出 (`countsAsFailure`)：停留也产出 ⇒
 *   延期刊发的公司让日报连日标红、新故障被淹没 (spec Session（六）)。
 * - 清单行提前消失 (上一轮在、本轮页面解析成功而不在、日期晚于页首日期、同期无新日期) ⇒ 留痕 +
 *   finding，观测与确认保留；本轮来源失败 / 解析失败 ⇒ 🚫 判消失 (取不到页面 ≠ 行消失)。
 *
 * ## 🚨 日期一律按交易所当地日期字符串算
 *
 * 全部日期是 `YYYY-MM-DD` 交易所当地日期；加减天数只在 UTC 日序号上做 (与宿主时区无关，ADR-0066)。
 * 公布日落在非交易日照记，🚫 挪到最近交易日 (Edge「周末 / 假日刊发」)。
 *
 * 复杂度 O(n log n + s log s)，n = 观测条数、s = 信号条数 (各排序一次；单事件量级个位数)。
 */
import type {
  EarningsDateBasis,
  EarningsDateSourceCapabilities,
  EarningsDateSourceObservation,
  EarningsNoticeSignal,
} from './earnings-date-source.port.js';
import { datePeriodKey, fiscalQuarterOf, isAlignedPeriodKey } from './earnings-period.rules.js';

/**
 * `superseded` (已并入) = 「已通知、日期未知」占位事件被给出日期的事件接手后的终态 (FR-017，spec
 * Session（七）第 2 问)：🚫 删除占位事件 —— 流水随事件级联删除 (FR-013)。
 */
export type EarningsDateEventStatus =
  | 'confirmed'
  | 'unconfirmed'
  | 'conflict'
  | 'notified_undated'
  | 'overdue'
  | 'published'
  | 'superseded';

/**
 * 占位事件键前缀：会前通知不带报告期 ⇒ 键 = `D:notice_undated:<通知刊发日>` (plan §D8)。
 * 🚫 用 `D:hkex_announcement:<日期>` —— 与公告来源无期末日刊发的兜底键同形，通知与刊发同日即撞键。
 * `notice_undated` 不是任何来源名 ⇒ 观测永远不会落这个键。
 */
export const NOTICE_UNDATED_PERIOD_KEY_PREFIX = 'D:notice_undated:';

export function noticeUndatedPeriodKey(noticeDate: string): string {
  return datePeriodKey('notice_undated', noticeDate);
}

export function isNoticeUndatedPlaceholder(periodKey: string): boolean {
  return periodKey.startsWith(NOTICE_UNDATED_PERIOD_KEY_PREFIX);
}

/** 确认日期口径：`announced` = 会前通知刊发日；`first_seen` = 来源首次观测当地日期。 */
export type EarningsConfirmedBasis = 'announced' | 'first_seen';

/**
 * 会前通知信号匹配窗口 (天)：刊发日 ∈ `[事件日期 − 120, 事件日期]`。
 * 🚨 T011 取信号的窗口 MUST 用同一常量 —— 取数窗口比匹配窗口窄时，窗口外的通知在事件重算时
 * 找不到，确认日期退回首次观测 (plan §D6 / analyze I1)。
 */
export const NOTICE_MATCH_WINDOW_DAYS = 120;

/** 逾期未刊发 (FR-019a) 与已通知日期未知 (FR-017) 的判定门槛：满 2 个**交易日**。 */
export const STATUS_DUE_TRADING_DAYS = 2;

/** 非季报公司判定的回看天数 (FR-029)：事件公布日之前这么多天内无季度业绩刊发事实 ⇒ 非季报公司。 */
export const QUARTERLY_FILING_LOOKBACK_DAYS = 730;

/**
 * 原文带季度写法 ⇒ 季度业绩刊发 (FR-029 第三路)：兜住报告类型为空、期末日换算不出的 `D:` 键季报。
 * 宁宽勿窄 —— 误认成季报公司只会照常判逾期 (响亮)；「第二季度及上半年」这类写法只有季报公司才会用。
 */
const QUARTERLY_FILING_TITLE =
  /季度|第[一三]季|首季|首三季|前三季|三個月|九個月|三个月|九个月|quarter|\bQ[1-4]\b/i;

/** 既有逾期因非季报公司判定解除时，`status_changed` 流水 `detail.releasedBy` 的值。 */
export const NON_QUARTERLY_RELEASE = 'non_quarterly_reporter';

/** 该标的的一条刊发事实 (`filed` 口径观测)，供 FR-029 判「公布日前 730 天内有无季度业绩刊发」。 */
export interface EarningsFilingFact {
  /** 刊发日 `YYYY-MM-DD` (交易所当地日期)。 */
  readonly filedDate: string;
  readonly periodEnd: string | null;
  readonly reportKind: string | null;
  /** 来源原文报告期 (公告来源为标题)。 */
  readonly periodText: string | null;
}

/** 某来源本轮的日期变更 (用例 upsert 时判定)；非本轮变更 ⇒ null。 */
export interface ObservationDateChange {
  /** 该来源上一个日期 (`meeting` 口径为会议日)。 */
  readonly previousDate: string;
  readonly changedAt: Date;
}

/**
 * 列表型来源 (清单) 的出现情况；不跟踪出现情况的来源 ⇒ null。
 * `unavailable` = 本轮来源失败或页面解析失败 —— 🚫 据此判消失。
 */
export type ListingPresence =
  | { readonly listedLastRound: boolean; readonly thisRound: 'unavailable' }
  | {
      readonly listedLastRound: boolean;
      readonly thisRound: 'listed' | 'absent';
      /** 本轮页首日期 (交易所当地日期)。 */
      readonly pageDate: string;
    };

/** 合并用的一条观测 = 来源侧观测 + 用例落库时维护的留痕字段。 */
export interface EarningsDateMergeObservation extends Pick<
  EarningsDateSourceObservation,
  'basis' | 'announceDate' | 'meetingDate' | 'publicationTime' | 'filedDate'
> {
  readonly source: string;
  /** 该来源首次观测到本行的交易所当地日期 `YYYY-MM-DD` (用例从 `first_seen_at` 按市场换算)。 */
  readonly firstSeenDate: string;
  readonly dateChange: ObservationDateChange | null;
  readonly presence: ListingPresence | null;
}

/** 一个候选公布日 (冲突候选 / 留痕)。 */
export interface EarningsDateCandidate {
  readonly source: string;
  readonly basis: EarningsDateBasis;
  readonly date: string;
}

/** 事件表既有值 (无行 ⇒ 输入 null)。 */
export interface ExistingEarningsDateEvent {
  readonly status: EarningsDateEventStatus;
  readonly announceDate: string | null;
  readonly announceBasis: EarningsDateBasis | null;
  readonly conflictCandidates: readonly EarningsDateCandidate[] | null;
  readonly confirmedDate: string | null;
  readonly confirmedBasis: EarningsConfirmedBasis | null;
  readonly overdueSince: Date | null;
}

/**
 * 「某日之后已过交易日数」= `TradingCalendarPort.countTradingDays(market, from, to)`。
 * 🚨 `from` MUST 是本规则将判定的那个日期 (公布日先调 {@link selectAnnounceDate}；通知刊发日先调
 * {@link selectPendingNotice})，不一致 ⇒ 抛错：拿旧日期数出来的交易日数会让逾期静默提前或推迟。
 */
export interface ElapsedTradingDays {
  readonly from: string;
  /** 本轮业务日 (交易所当地日期)。 */
  readonly to: string;
  /** `null` = 日历不可判 (区间含 unknown)，🚫 当 0。 */
  readonly count: number | null;
}

export interface EarningsDateMergeInput {
  readonly periodKey: string;
  readonly observations: readonly EarningsDateMergeObservation[];
  /** 来源名 → 该来源对本事件市场的能力 (`EarningsDateSource.capabilities(market)`)；查不到 = 无能力。 */
  readonly capabilities: ReadonlyMap<string, EarningsDateSourceCapabilities | null>;
  /** 本事件报告类型最近一次「会议 → 刊发」间隔天数；无历史 null (按 0 天)。 */
  readonly meetingLagDays: number | null;
  /** 该标的会前通知信号 (T011 按 {@link NOTICE_MATCH_WINDOW_DAYS} 取)。 */
  readonly noticeSignals: readonly EarningsNoticeSignal[];
  /** 该标的**本事件之外**、最近一次刊发事实的刊发日 (早于本事件)；无则 null。 */
  readonly previousFilingDate: string | null;
  readonly existing: ExistingEarningsDateEvent | null;
  /** 本轮运行时刻 —— 迁入 `overdue` 时写 `overdueSince`。 */
  readonly runAt: Date;
  /** 该标的财年档案的财年结束月；无档案 null (FR-028)。FR-029 按它换算事件期末日的财季。 */
  readonly fiscalYearEndMonth: number | null;
  /** 该标的刊发事实 (含本事件之外)；FR-029 只取公布日前 {@link QUARTERLY_FILING_LOOKBACK_DAYS} 天内的。 */
  readonly filings: readonly EarningsFilingFact[];
  /** 自公布日起算；公布日为 null 或市场无刊发事实来源时可为 null。 */
  readonly elapsedTradingDays: ElapsedTradingDays | null;
}

/** 与 `earnings_date_event` 列逐列对应 (日期为 `YYYY-MM-DD` 交易所当地日期)。 */
export interface EarningsDateEventFields {
  readonly status: EarningsDateEventStatus;
  readonly announceDate: string | null;
  readonly announceBasis: EarningsDateBasis | null;
  readonly conflictCandidates: readonly EarningsDateCandidate[] | null;
  readonly publicationTime: Date | null;
  readonly confirmedDate: string | null;
  readonly confirmedBasis: EarningsConfirmedBasis | null;
  /** 参与合并的来源名 (去重、升序)。 */
  readonly sources: readonly string[];
  readonly overdueSince: Date | null;
}

export type EarningsDateEventLogKind =
  | 'status_changed'
  | 'value_changed'
  | 'confirmation_changed'
  | 'date_rescheduled'
  | 'listing_dropped';

/** `earnings_date_event_log` 一行 (append-only；只在对应事实本轮发生时产出)。 */
export interface EarningsDateEventLogEntry {
  readonly kind: EarningsDateEventLogKind;
  readonly fromStatus: EarningsDateEventStatus | null;
  readonly toStatus: EarningsDateEventStatus | null;
  readonly detail: Record<string, unknown>;
}

export type EarningsDateFindingStep =
  | 'earnings_date_conflict'
  | 'earnings_date_overdue'
  | 'earnings_notice_undated'
  | 'earnings_board_list_dropped'
  | 'earnings_date_calendar_unknown';

/**
 * findings 候选 (plan §D10)；`countsAsFailure` = 写入点是否 `stats.failed += 1`。
 * `detail` 只放 JSON 可序列化值 (🚫 bigint)，标的由用例补。
 */
export interface EarningsDateFinding {
  readonly kind: 'notice' | 'unjudged';
  readonly step: EarningsDateFindingStep;
  readonly countsAsFailure: boolean;
  readonly detail: Record<string, unknown>;
}

/** 刊发前某来源某口径取值与刊发日的偏差 (FR-019)：`deviationDays` = 取值 − 刊发日。 */
export interface EarningsDateDeviation {
  readonly source: string;
  readonly basis: EarningsDateBasis;
  readonly date: string;
  readonly deviationDays: number;
}

/** 「会议 → 刊发」间隔更新 (FR-010 / FR-019)，写 `earnings_meeting_lag`。 */
export interface MeetingLagUpdate {
  readonly meetingDate: string;
  readonly filedDate: string;
  readonly lagDays: number;
}

export interface EarningsDateMergeResult {
  readonly event: EarningsDateEventFields;
  readonly logs: readonly EarningsDateEventLogEntry[];
  readonly findings: readonly EarningsDateFinding[];
  /** 本该判逾期、因无财年档案未判 ⇒ 计入每轮一条 `earnings_date_fiscal_unknown` (🚫 逐事件 finding)。 */
  readonly fiscalProfileMissing: boolean;
  /**
   * 公布日已过满门槛、因报告期无法对齐 (`T:` / `D:` 键) 未判逾期 ⇒ 计入每轮一条 `earnings_date_unaligned`
   * 的 `overdueUnjudged` (🚫 计失败、🚫 逐事件 finding)。
   */
  readonly overdueUnaligned: boolean;
  /**
   * 公布日已过满门槛、因非季报公司的第一 / 第三季未判逾期 (FR-029) ⇒ 计入每轮一条 `earnings_date_non_quarterly`
   * (🚫 计失败、🚫 逐事件 finding)；`released` = 既有 `overdue` 本轮据此解除。非此情形 null。
   */
  readonly nonQuarterlyReporter: { readonly released: boolean } | null;
  /** 仅迁入 `published` 那一轮非空。 */
  readonly deviations: readonly EarningsDateDeviation[];
  /** 仅迁入 `published` 且有不晚于刊发日的会议日时非 null。 */
  readonly meetingLagUpdate: MeetingLagUpdate | null;
}

// ─── 日期算术 (交易所当地日期字符串 ↔ UTC 日序号) ─────────────────────────

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(date: string): number {
  const m = ISO_DATE.exec(date);
  const day = m === null ? Number.NaN : Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // 回写比对挡住 2026-02-30 这类被 Date.UTC 静默进位的日期。
  if (Number.isNaN(day) || new Date(day).toISOString().slice(0, 10) !== date) {
    throw new Error(
      `[earnings-date-merge] 非法日期 ${JSON.stringify(date)} —— 期望 YYYY-MM-DD 交易所当地日期`,
    );
  }
  return day / DAY_MS;
}

function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

function spreadDays(candidates: readonly EarningsDateCandidate[]): number {
  const days = candidates.map((c) => dayNumber(c.date));
  return Math.max(...days) - Math.min(...days);
}

// ─── 取值 ─────────────────────────────────────────────────────────────────

const BASIS_RANK: Readonly<Record<EarningsDateBasis, number>> = {
  filed: 0,
  explicit: 1,
  structured: 2,
  meeting: 3,
};

export type EarningsDateSelectionReason =
  | 'none'
  | 'agreed'
  | 'exact_priority'
  | 'approx_within_1_day'
  | 'explainable_meeting_lag'
  | 'conflict';

export interface EarningsDateSelection {
  readonly date: string | null;
  readonly basis: EarningsDateBasis | null;
  readonly reason: EarningsDateSelectionReason;
  /** 全部候选 (口径优先级、日期升序)。 */
  readonly candidates: readonly EarningsDateCandidate[];
}

/** 一条观测在其口径下给出的公布日；给不出为 null。 */
function candidateDate(
  o: EarningsDateMergeObservation,
  meetingLagDays: number | null,
): string | null {
  switch (o.basis) {
    case 'filed':
      return o.filedDate ?? o.announceDate;
    case 'meeting':
      return o.meetingDate === null ? o.announceDate : addDays(o.meetingDate, meetingLagDays ?? 0);
    default:
      return o.announceDate;
  }
}

/** 该来源自己给出的日期 (`meeting` 口径为会议日本身)，用于改期 / 消失留痕。 */
function sourceDate(o: EarningsDateMergeObservation): string | null {
  if (o.basis === 'meeting') return o.meetingDate ?? o.announceDate;
  if (o.basis === 'filed') return o.filedDate ?? o.announceDate;
  return o.announceDate;
}

function byRankThenDate(a: EarningsDateCandidate, b: EarningsDateCandidate): number {
  return BASIS_RANK[a.basis] - BASIS_RANK[b.basis] || a.date.localeCompare(b.date);
}

/**
 * 公布日取值 (见文件头「取值」表)。导出给用例：先用它得出公布日，再按该日数交易日喂回
 * {@link mergeEarningsDateEvent} (同一输入 ⇒ 同一结果)。
 */
export function selectAnnounceDate(
  observations: readonly EarningsDateMergeObservation[],
  meetingLagDays: number | null,
): EarningsDateSelection {
  const candidates = observations
    .flatMap((o) => {
      const date = candidateDate(o, meetingLagDays);
      return date === null ? [] : [{ source: o.source, basis: o.basis, date }];
    })
    .sort(byRankThenDate);
  if (candidates.length === 0) return { date: null, basis: null, reason: 'none', candidates };

  const pick = (
    chosen: EarningsDateCandidate,
    reason: EarningsDateSelectionReason,
  ): EarningsDateSelection => ({
    date: chosen.date,
    basis: chosen.basis,
    reason: candidates.every((c) => c.date === chosen.date) ? 'agreed' : reason,
    candidates,
  });
  const conflict: EarningsDateSelection = {
    date: null,
    basis: null,
    reason: 'conflict',
    candidates,
  };

  // 精确口径：只在最高一档之内判冲突 —— 有 `filed` 时 `explicit` 与刊发日的差是偏差 (FR-019)，不是冲突。
  const topRank = BASIS_RANK[candidates[0].basis];
  if (topRank <= BASIS_RANK.explicit) {
    const tier = candidates.filter((c) => BASIS_RANK[c.basis] === topRank);
    return spreadDays(tier) === 0 ? pick(tier[0], 'exact_priority') : conflict;
  }

  if (spreadDays(candidates) <= 1) return pick(candidates[0], 'approx_within_1_day');

  // 可解释差异 (FR-014)：结构化日期恰为某会议日 ⇒ 结构化来源记的是会议日，推定值 (会议日 + 间隔) 更准。
  // EVIDENCE: `hk:00857` 三次刊发均为周日，富途记为前一个周五 = 通知中的会议日 (spec.md 取证「来源 A」)。
  const meetingDates = new Set(
    observations.flatMap((o) =>
      o.basis === 'meeting' && o.meetingDate !== null ? [o.meetingDate] : [],
    ),
  );
  const unexplained = candidates.filter(
    (c) => !(c.basis === 'structured' && meetingDates.has(c.date)),
  );
  if (unexplained.length < candidates.length && spreadDays(unexplained) <= 1) {
    return pick(unexplained[0], 'explainable_meeting_lag');
  }
  return conflict;
}

// ─── 确认 ─────────────────────────────────────────────────────────────────

interface Confirmation {
  readonly date: string | null;
  readonly basis: EarningsConfirmedBasis | null;
}

/** 本轮算出的确认日期；无「仅已公告」来源给出日期 ⇒ null (交给既有值)。 */
function computeConfirmation(
  input: EarningsDateMergeInput,
  selection: EarningsDateSelection,
): Confirmation | null {
  const confirming = input.observations.filter(
    (o) =>
      input.capabilities.get(o.source)?.forward === 'announced_only' &&
      candidateDate(o, input.meetingLagDays) !== null,
  );
  if (confirming.length === 0) return null;

  // 冲突时无单一事件日期 ⇒ 窗口取全部候选日期的包络。
  const eventDates =
    selection.date === null ? selection.candidates.map((c) => c.date) : [selection.date];
  const sortedDates = [...eventDates].sort();
  const lower = addDays(sortedDates[0], -NOTICE_MATCH_WINDOW_DAYS);
  const upper = sortedDates[sortedDates.length - 1];
  const previousFiling = input.previousFilingDate;
  const earliestNotice = input.noticeSignals
    .map((s) => s.noticeDate)
    .filter(
      (d) =>
        dayNumber(d) >= dayNumber(lower) &&
        d <= upper &&
        (previousFiling === null || dayNumber(d) > dayNumber(previousFiling)),
    )
    .sort()[0];
  if (earliestNotice !== undefined) return { date: earliestNotice, basis: 'announced' };
  const firstSeen = confirming.map((o) => addDays(o.firstSeenDate, 0)).sort()[0];
  return { date: firstSeen, basis: 'first_seen' };
}

/** 🚨 只前移不回退 (FR-012)。 */
function advanceConfirmation(existing: Confirmation, computed: Confirmation | null): Confirmation {
  if (computed === null || computed.date === null) return existing;
  if (existing.date === null) return computed;
  if (existing.basis === 'announced' && computed.basis !== 'announced') return existing;
  return computed.date < existing.date ? computed : existing;
}

// ─── 状态判定 ─────────────────────────────────────────────────────────────

type ElapsedVerdict = 'unjudged' | 'not_due' | 'fiscal_unknown' | 'due';
/**
 * 逾期专用：`unaligned` = 到期但键非期末日对齐 (FR-015)，永不迁入 `overdue`；`non_quarterly` = 到期但属非季报公司的
 * 第一 / 第三季 (FR-029)，不迁入且解除既有逾期。
 */
type OverdueVerdict = ElapsedVerdict | 'unaligned' | 'non_quarterly';

function marketHasPublicationFact(
  capabilities: ReadonlyMap<string, EarningsDateSourceCapabilities | null>,
): boolean {
  return [...capabilities.values()].some((c) => c?.publicationFact === true);
}

/** 逾期与已通知日期未知共用的门槛判定 —— 单一维护点 (交易日数、财年档案)。 */
function judgeElapsed(
  elapsed: ElapsedTradingDays | null,
  from: string,
  hasFiscalProfile: boolean,
): ElapsedVerdict {
  if (elapsed === null || elapsed.from !== from) {
    throw new Error(
      `[earnings-date-merge] 交易日数须自 ${from} 起算, 收到 ${JSON.stringify(elapsed)} —— ` +
        `先按同一输入选出日期再数交易日`,
    );
  }
  if (elapsed.count === null) return 'unjudged';
  if (elapsed.count < STATUS_DUE_TRADING_DAYS) return 'not_due';
  return hasFiscalProfile ? 'due' : 'fiscal_unknown';
}

/** 迁入判定：本轮为 `target` 且既有不是 —— finding 只在迁入时产出 (spec Session（六）)。 */
function entered(
  from: EarningsDateEventStatus | null,
  to: EarningsDateEventStatus | null,
  target: EarningsDateEventStatus,
): boolean {
  return to === target && from !== target;
}

function baseStatus(
  selection: EarningsDateSelection,
  confirmation: Confirmation,
): EarningsDateEventStatus {
  if (selection.reason === 'conflict') return 'conflict';
  if (selection.basis === 'filed') return 'published';
  return confirmation.date !== null ? 'confirmed' : 'unconfirmed';
}

function judgeOverdue(
  input: EarningsDateMergeInput,
  selection: EarningsDateSelection,
  base: EarningsDateEventStatus,
): { readonly status: EarningsDateEventStatus; readonly verdict: OverdueVerdict | null } {
  if (
    (base !== 'confirmed' && base !== 'unconfirmed') ||
    selection.date === null ||
    !marketHasPublicationFact(input.capabilities)
  ) {
    return { status: base, verdict: null };
  }
  const elapsed = judgeElapsed(
    input.elapsedTradingDays,
    selection.date,
    input.fiscalYearEndMonth !== null,
  );
  // 🚨 判定顺序 (FR-028 / FR-029)：日历不可判 → 未到期 → 键无法对齐 → 无财年档案 → 非季报公司的第一 / 第三季 → 逾期。
  // 日历不可判照报 unjudged (与键无关)；非对齐键有无档案都等不到同键刊发事实 ⇒ 记 unaligned、🚫 报财年未知
  // (补档案也不会让它可判)；非季报判定要按档案换算财季 ⇒ 排在财年档案之后。
  const verdict: OverdueVerdict =
    (elapsed === 'due' || elapsed === 'fiscal_unknown') && !isAlignedPeriodKey(input.periodKey)
      ? 'unaligned'
      : elapsed === 'due' && isNonQuarterlyReporterQuarter(input, selection.date)
        ? 'non_quarterly'
        : elapsed;
  // 日历不可判 / 非对齐键 ⇒ 本轮判不了：既有逾期不凭空解除，也不凭空迁入。
  // 非季报是判出来的稳定结论 (不是判不了) ⇒ 不迁入，既有逾期解除回原状态 (spec Session（八）1b)。
  const stays =
    (verdict === 'unjudged' || verdict === 'unaligned') && input.existing?.status === 'overdue';
  return { status: verdict === 'due' || stays ? 'overdue' : base, verdict };
}

/**
 * FR-029：事件期末日按财年档案为第一 / 第三财季，且该标的在 `[公布日 − 730 天, 公布日)` 内无季度业绩刊发事实。
 * 财年结束月未知 / 非 `P:` 键 ⇒ false (照常判)。复杂度 O(f)，f = 刊发事实条数。
 */
function isNonQuarterlyReporterQuarter(
  input: EarningsDateMergeInput,
  announceDate: string,
): boolean {
  const fiscalYearEndMonth = input.fiscalYearEndMonth;
  if (fiscalYearEndMonth === null || !isAlignedPeriodKey(input.periodKey)) return false;
  const quarter = fiscalQuarterOf(input.periodKey.slice('P:'.length), fiscalYearEndMonth);
  if (quarter !== 1 && quarter !== 3) return false;
  const to = dayNumber(announceDate);
  const from = to - QUARTERLY_FILING_LOOKBACK_DAYS;
  return !input.filings.some((f) => {
    const filed = dayNumber(f.filedDate);
    return filed >= from && filed < to && isQuarterlyFiling(f, fiscalYearEndMonth);
  });
}

/** 季度业绩刊发：报告类型为季度，或期末日为第一 / 第三财季，或原文带季度写法 —— 任一即算 (FR-029)。 */
function isQuarterlyFiling(f: EarningsFilingFact, fiscalYearEndMonth: number): boolean {
  if (f.reportKind === 'quarterly') return true;
  const quarter = f.periodEnd === null ? null : fiscalQuarterOf(f.periodEnd, fiscalYearEndMonth);
  if (quarter === 1 || quarter === 3) return true;
  return f.periodText !== null && QUARTERLY_FILING_TITLE.test(f.periodText);
}

interface ListingDrop {
  readonly source: string;
  readonly lastDate: string;
  readonly pageDate: string;
}

function listingDrops(observations: readonly EarningsDateMergeObservation[]): ListingDrop[] {
  // 同期出现新日期 (本轮任一来源改期) ⇒ 是改期不是消失 (FR-016)。
  if (observations.some((o) => o.dateChange !== null)) return [];
  return observations.flatMap((o) => {
    const presence = o.presence;
    const lastDate = sourceDate(o);
    // 🚨 `unavailable` (本轮来源失败 / 解析失败) 在这里被挡掉 —— 取不到页面 ≠ 行消失。
    if (presence?.thisRound !== 'absent' || !presence.listedLastRound || lastDate === null) {
      return [];
    }
    return dayNumber(lastDate) > dayNumber(presence.pageDate)
      ? [{ source: o.source, lastDate, pageDate: presence.pageDate }]
      : [];
  });
}

function publicationTimeOf(
  input: EarningsDateMergeInput,
  selection: EarningsDateSelection,
): Date | null {
  if (selection.date === null) return null;
  const matching = input.observations
    .filter(
      (o) =>
        o.publicationTime !== null && candidateDate(o, input.meetingLagDays) === selection.date,
    )
    .sort((a, b) => BASIS_RANK[a.basis] - BASIS_RANK[b.basis]);
  return matching[0]?.publicationTime ?? null;
}

function deviationsOf(input: EarningsDateMergeInput, filedDate: string): EarningsDateDeviation[] {
  return input.observations.flatMap((o) => {
    const date = o.basis === 'filed' ? null : candidateDate(o, input.meetingLagDays);
    return date === null
      ? []
      : [
          {
            source: o.source,
            basis: o.basis,
            date,
            deviationDays: dayNumber(date) - dayNumber(filedDate),
          },
        ];
  });
}

function meetingLagUpdateOf(
  observations: readonly EarningsDateMergeObservation[],
  filedDate: string,
): MeetingLagUpdate | null {
  // 晚于刊发日的会议日不是这次刊发的会议 (间隔不为负)；多个会议日取最晚者。
  const meetingDate = observations
    .flatMap((o) =>
      o.meetingDate !== null && dayNumber(o.meetingDate) <= dayNumber(filedDate)
        ? [o.meetingDate]
        : [],
    )
    .sort()
    .pop();
  return meetingDate === undefined
    ? null
    : { meetingDate, filedDate, lagDays: dayNumber(filedDate) - dayNumber(meetingDate) };
}

// ─── 流水与 findings ─────────────────────────────────────────────────────

interface PriorEvent {
  readonly status: EarningsDateEventStatus | null;
  readonly announceDate: string | null;
  readonly announceBasis: EarningsDateBasis | null;
  readonly conflictCandidates: readonly EarningsDateCandidate[] | null;
  readonly confirmedDate: string | null;
  readonly confirmedBasis: EarningsConfirmedBasis | null;
  readonly overdueSince: Date | null;
}

const NO_PRIOR_EVENT: PriorEvent = {
  status: null,
  announceDate: null,
  announceBasis: null,
  conflictCandidates: null,
  confirmedDate: null,
  confirmedBasis: null,
  overdueSince: null,
};

function eventLogs(
  input: EarningsDateMergeInput,
  prior: PriorEvent,
  event: EarningsDateEventFields,
  selection: EarningsDateSelection,
  drops: readonly ListingDrop[],
  verdict: OverdueVerdict | null,
): EarningsDateEventLogEntry[] {
  const logs: EarningsDateEventLogEntry[] = [];
  const log = (kind: EarningsDateEventLogKind, detail: Record<string, unknown>) =>
    logs.push({ kind, fromStatus: prior.status, toStatus: event.status, detail });

  for (const o of input.observations) {
    if (o.dateChange === null) continue;
    log('date_rescheduled', {
      source: o.source,
      basis: o.basis,
      previousDate: o.dateChange.previousDate,
      date: sourceDate(o),
      changedAt: o.dateChange.changedAt.toISOString(),
    });
  }
  for (const drop of drops) log('listing_dropped', { ...drop });
  if (prior.status !== event.status) {
    log('status_changed', {
      announceDate: event.announceDate,
      announceBasis: event.announceBasis,
      ...(event.status === 'conflict' ? { candidates: selection.candidates } : {}),
      ...(prior.status === 'conflict'
        ? { resolvedCandidates: prior.conflictCandidates ?? [] }
        : {}),
      ...(prior.status === 'overdue' && verdict === 'non_quarterly'
        ? { releasedBy: NON_QUARTERLY_RELEASE }
        : {}),
    });
  }
  if (prior.announceDate !== event.announceDate || prior.announceBasis !== event.announceBasis) {
    log('value_changed', {
      from: { date: prior.announceDate, basis: prior.announceBasis },
      to: { date: event.announceDate, basis: event.announceBasis },
      reason: selection.reason,
      candidates: selection.candidates,
    });
  }
  if (
    prior.confirmedDate !== event.confirmedDate ||
    prior.confirmedBasis !== event.confirmedBasis
  ) {
    log('confirmation_changed', {
      from: { date: prior.confirmedDate, basis: prior.confirmedBasis },
      to: { date: event.confirmedDate, basis: event.confirmedBasis },
    });
  }
  return logs;
}

function eventFindings(
  input: EarningsDateMergeInput,
  prior: PriorEvent,
  event: EarningsDateEventFields,
  verdict: OverdueVerdict | null,
  drops: readonly ListingDrop[],
): EarningsDateFinding[] {
  const findings: EarningsDateFinding[] = [];
  const notice = (
    step: EarningsDateFindingStep,
    countsAsFailure: boolean,
    detail: Record<string, unknown>,
  ) =>
    findings.push({
      kind: 'notice',
      step,
      countsAsFailure,
      detail: { periodKey: input.periodKey, ...detail },
    });

  if (entered(prior.status, event.status, 'conflict')) {
    notice('earnings_date_conflict', false, { candidates: event.conflictCandidates });
  }
  if (entered(prior.status, event.status, 'overdue')) {
    notice('earnings_date_overdue', true, {
      announceDate: event.announceDate,
      announceBasis: event.announceBasis,
      elapsedTradingDays: input.elapsedTradingDays?.count ?? null,
    });
  }
  if (verdict === 'unjudged') {
    findings.push({
      kind: 'unjudged',
      step: 'earnings_date_calendar_unknown',
      countsAsFailure: false,
      detail: {
        periodKey: input.periodKey,
        judgement: 'overdue',
        from: input.elapsedTradingDays?.from ?? null,
        to: input.elapsedTradingDays?.to ?? null,
      },
    });
  }
  for (const drop of drops) notice('earnings_board_list_dropped', false, { ...drop });
  return findings;
}

// ─── 入口 ①：事件合并 ─────────────────────────────────────────────────────

export function mergeEarningsDateEvent(input: EarningsDateMergeInput): EarningsDateMergeResult {
  const prior = input.existing ?? NO_PRIOR_EVENT;
  const selection = selectAnnounceDate(input.observations, input.meetingLagDays);
  const confirmation = advanceConfirmation(
    { date: prior.confirmedDate, basis: prior.confirmedBasis },
    computeConfirmation(input, selection),
  );
  const { status, verdict } = judgeOverdue(input, selection, baseStatus(selection, confirmation));
  const keepsOverdueSince = status === 'overdue' && prior.status === 'overdue';

  const event: EarningsDateEventFields = {
    status,
    announceDate: selection.date,
    announceBasis: selection.basis,
    conflictCandidates: status === 'conflict' ? selection.candidates : null,
    publicationTime: publicationTimeOf(input, selection),
    confirmedDate: confirmation.date,
    confirmedBasis: confirmation.basis,
    sources: [...new Set(input.observations.map((o) => o.source))].sort(),
    overdueSince: keepsOverdueSince
      ? (prior.overdueSince ?? input.runAt)
      : status === 'overdue'
        ? input.runAt
        : null,
  };

  const drops = listingDrops(input.observations);
  const filedDate = entered(prior.status, status, 'published') ? selection.date : null;
  return {
    event,
    logs: eventLogs(input, prior, event, selection, drops, verdict),
    findings: eventFindings(input, prior, event, verdict, drops),
    fiscalProfileMissing: verdict === 'fiscal_unknown',
    overdueUnaligned: verdict === 'unaligned',
    nonQuarterlyReporter:
      verdict === 'non_quarterly' ? { released: prior.status === 'overdue' } : null,
    deviations: filedDate === null ? [] : deviationsOf(input, filedDate),
    meetingLagUpdate: filedDate === null ? null : meetingLagUpdateOf(input.observations, filedDate),
  };
}

// ─── 入口 ②：已通知日期未知 (标的级) ──────────────────────────────────────

export interface NoticeUndatedInput {
  readonly noticeSignals: readonly EarningsNoticeSignal[];
  /** 该标的最近一次刊发事实的刊发日；无则 null。不晚于它的通知已被那次刊发「用掉」。 */
  readonly latestFilingDate: string | null;
  /**
   * 该标的**未刊发**事件 (占位事件除外) 的公布日；冲突事件取候选日期中最晚者。只有不早于待判通知
   * 刊发日的才算「日期已由那个事件给出」(见 {@link hasDatedEventForNotice})。
   */
  readonly unpublishedEventDates: readonly string[];
  /** 该标的是否曾有清单观测 (清单不覆盖的板块从未出现，FR-017)。 */
  readonly everListed: boolean;
  readonly hasFiscalProfile: boolean;
  readonly capabilities: ReadonlyMap<string, EarningsDateSourceCapabilities | null>;
  /** 自 {@link selectPendingNotice} 选出的通知刊发日起算；无待判通知时可为 null。 */
  readonly elapsedTradingDays: ElapsedTradingDays | null;
  /** 该标的「已通知日期未知」占位事件的既有状态；无则 null。 */
  readonly existingStatus: EarningsDateEventStatus | null;
}

export interface NoticeUndatedResult {
  readonly pendingNotice: EarningsNoticeSignal | null;
  /**
   * `notified_undated` ⇒ 迁入或停留；`superseded` ⇒ 既有占位事件本轮迁出 (被接手，用例写流水指向
   * 接手事件)；null ⇒ 该标的本轮不处于、也未曾处于已通知日期未知。
   */
  readonly status: 'notified_undated' | 'superseded' | null;
  readonly logs: readonly EarningsDateEventLogEntry[];
  readonly findings: readonly EarningsDateFinding[];
  /** 从未在清单出现的标的满足条件 ⇒ 只计数 (🚫 计失败、🚫 迁入)。 */
  readonly neverListedUndated: boolean;
  /** 本该判定、因无财年档案未判 ⇒ 计入 `earnings_date_fiscal_unknown`。 */
  readonly fiscalProfileMissing: boolean;
}

/** 待判的会前通知 = 晚于该标的最近一次刊发事实的通知中最早者；无 ⇒ null。 */
export function selectPendingNotice(
  signals: readonly EarningsNoticeSignal[],
  latestFilingDate: string | null,
): EarningsNoticeSignal | null {
  const pending = signals.filter(
    (s) => latestFilingDate === null || dayNumber(s.noticeDate) > dayNumber(latestFilingDate),
  );
  return pending.sort((a, b) => a.noticeDate.localeCompare(b.noticeDate))[0] ?? null;
}

/**
 * 通知的日期已由某个未刊发事件给出 = 有公布日 ≥ 通知刊发日的未刊发事件 (FR-017「通知之后仍无任何
 * 来源给出日期」)。🚨 🚫 按「任一未刊发带日期事件」判：公布日早于通知的是更早一期 (如期间空白、
 * 永远对不上刊发事实而长期逾期的 `D:` 键事件)，计入 ⇒ 该标的之后每份通知都判不成、静默漏报。
 * 用例据同一函数决定是否数交易日 ({@link ElapsedTradingDays} 起算校验)。复杂度 O(n)。
 */
export function hasDatedEventForNotice(
  unpublishedEventDates: readonly string[],
  noticeDate: string,
): boolean {
  return unpublishedEventDates.some((d) => dayNumber(d) >= dayNumber(noticeDate));
}

function undatedLogs(
  input: NoticeUndatedInput,
  pendingNotice: EarningsNoticeSignal | null,
  status: NoticeUndatedResult['status'],
): EarningsDateEventLogEntry[] {
  if ((input.existingStatus === 'notified_undated') === (status === 'notified_undated')) return [];
  return [
    {
      kind: 'status_changed',
      fromStatus: input.existingStatus,
      toStatus: status,
      detail: { noticeDate: pendingNotice?.noticeDate ?? null, link: pendingNotice?.link ?? null },
    },
  ];
}

function undatedFindings(
  input: NoticeUndatedInput,
  pendingNotice: EarningsNoticeSignal | null,
  status: NoticeUndatedResult['status'],
  verdict: ElapsedVerdict | null,
): EarningsDateFinding[] {
  if (pendingNotice === null) return [];
  const findings: EarningsDateFinding[] = [];
  if (entered(input.existingStatus, status, 'notified_undated')) {
    findings.push({
      kind: 'notice',
      step: 'earnings_notice_undated',
      countsAsFailure: true,
      detail: {
        noticeDate: pendingNotice.noticeDate,
        title: pendingNotice.title,
        link: pendingNotice.link,
        elapsedTradingDays: input.elapsedTradingDays?.count ?? null,
      },
    });
  }
  if (verdict === 'unjudged') {
    findings.push({
      kind: 'unjudged',
      step: 'earnings_date_calendar_unknown',
      countsAsFailure: false,
      detail: {
        judgement: 'notified_undated',
        from: pendingNotice.noticeDate,
        to: input.elapsedTradingDays?.to ?? null,
      },
    });
  }
  return findings;
}

export function judgeNoticeUndated(input: NoticeUndatedInput): NoticeUndatedResult {
  const pendingNotice = selectPendingNotice(input.noticeSignals, input.latestFilingDate);
  const wasUndated = input.existingStatus === 'notified_undated';
  // 无待判通知 ⇒ 无未知日期态 (公司不为该类报告发通知，Edge 15)；已有公布日不早于通知的未刊发事件 ⇒
  // 日期已由那个事件给出，其确认日期经 120 天窗口取到该通知刊发日。
  const verdict =
    pendingNotice === null ||
    hasDatedEventForNotice(input.unpublishedEventDates, pendingNotice.noticeDate) ||
    !marketHasPublicationFact(input.capabilities)
      ? null
      : judgeElapsed(input.elapsedTradingDays, pendingNotice.noticeDate, input.hasFiscalProfile);
  // 🚨 从未在清单的标的 (清单不覆盖的板块) 只计数 (FR-017)。
  const neverListedUndated = verdict === 'due' && !input.everListed;
  const undated =
    (verdict === 'due' && !neverListedUndated) || (verdict === 'unjudged' && wasUndated);
  const status: NoticeUndatedResult['status'] = undated
    ? 'notified_undated'
    : wasUndated
      ? 'superseded'
      : null;

  return {
    pendingNotice,
    status,
    logs: undatedLogs(input, pendingNotice, status),
    findings: undatedFindings(input, pendingNotice, status, verdict),
    neverListedUndated,
    fiscalProfileMissing: verdict === 'fiscal_unknown',
  };
}
