/**
 * 财报日期合并纯函数 (079 T004, FR-008 ~ FR-014 / plan §D8)。
 *
 * 输入某 `(instrument, period_key)` 的全部来源观测 + 来源能力声明 + 会议 → 刊发间隔 + 该标的
 * 会前通知信号 + 事件既有值；输出事件字段 + 流水 + findings 候选。零 I/O、零时钟 (ADR-0043)。
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

export type EarningsDateEventStatus =
  | 'confirmed'
  | 'unconfirmed'
  | 'conflict'
  | 'notified_undated'
  | 'overdue'
  | 'published';

/** 确认日期口径：`announced` = 会前通知刊发日；`first_seen` = 来源首次观测当地日期。 */
export type EarningsConfirmedBasis = 'announced' | 'first_seen';

/**
 * 会前通知信号匹配窗口 (天)：刊发日 ∈ `[事件日期 − 120, 事件日期]`。
 * 🚨 T011 取信号的窗口 MUST 用同一常量 —— 取数窗口比匹配窗口窄时，窗口外的通知在事件重算时
 * 找不到，确认日期退回首次观测 (plan §D6 / analyze I1)。
 */
export const NOTICE_MATCH_WINDOW_DAYS = 120;

/** 合并用的一条观测 = 来源侧观测 + 来源名 + 首次观测当地日期 (后两者由用例落库时维护)。 */
export interface EarningsDateMergeObservation extends Pick<
  EarningsDateSourceObservation,
  'basis' | 'announceDate' | 'meetingDate' | 'publicationTime' | 'filedDate'
> {
  readonly source: string;
  /** 该来源首次观测到本行的交易所当地日期 `YYYY-MM-DD` (用例从 `first_seen_at` 按市场换算)。 */
  readonly firstSeenDate: string;
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
}

export type EarningsDateEventLogKind = 'status_changed' | 'value_changed' | 'confirmation_changed';

/** `earnings_date_event_log` 一行 (append-only；只在对应字段相对既有值变化时产出)。 */
export interface EarningsDateEventLogEntry {
  readonly kind: EarningsDateEventLogKind;
  readonly fromStatus: EarningsDateEventStatus | null;
  readonly toStatus: EarningsDateEventStatus | null;
  readonly detail: Record<string, unknown>;
}

/**
 * findings 候选 (plan §D10)；`countsAsFailure` = 写入点是否 `stats.failed += 1`。
 * `detail` 只放 JSON 可序列化值 (🚫 bigint)，标的由用例补。
 */
export interface EarningsDateFinding {
  readonly kind: 'notice';
  readonly step: 'earnings_date_conflict';
  readonly countsAsFailure: boolean;
  readonly detail: Record<string, unknown>;
}

export interface EarningsDateMergeResult {
  readonly event: EarningsDateEventFields;
  readonly logs: readonly EarningsDateEventLogEntry[];
  readonly findings: readonly EarningsDateFinding[];
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

type SelectionReason =
  | 'none'
  | 'agreed'
  | 'exact_priority'
  | 'approx_within_1_day'
  | 'explainable_meeting_lag'
  | 'conflict';

interface Selection {
  readonly date: string | null;
  readonly basis: EarningsDateBasis | null;
  readonly reason: SelectionReason;
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

function byRankThenDate(a: EarningsDateCandidate, b: EarningsDateCandidate): number {
  return BASIS_RANK[a.basis] - BASIS_RANK[b.basis] || a.date.localeCompare(b.date);
}

function selectAnnounceDate(
  observations: readonly EarningsDateMergeObservation[],
  meetingLagDays: number | null,
): Selection {
  const candidates = observations
    .flatMap((o) => {
      const date = candidateDate(o, meetingLagDays);
      return date === null ? [] : [{ source: o.source, basis: o.basis, date }];
    })
    .sort(byRankThenDate);
  if (candidates.length === 0) return { date: null, basis: null, reason: 'none', candidates };

  const pick = (chosen: EarningsDateCandidate, reason: SelectionReason): Selection => ({
    date: chosen.date,
    basis: chosen.basis,
    reason: candidates.every((c) => c.date === chosen.date) ? 'agreed' : reason,
    candidates,
  });
  const conflict: Selection = { date: null, basis: null, reason: 'conflict', candidates };

  // 精确口径：只在最高一档之内判冲突 —— 有 `filed` 时 `explicit` 与刊发日的差是偏差 (FR-019)，不是冲突。
  const topRank = BASIS_RANK[candidates[0].basis];
  if (topRank <= BASIS_RANK.explicit) {
    const tier = candidates.filter((c) => BASIS_RANK[c.basis] === topRank);
    return spreadDays(tier) === 0 ? pick(tier[0], 'exact_priority') : conflict;
  }

  if (spreadDays(candidates) <= 1) return pick(candidates[0], 'approx_within_1_day');

  // 可解释差异 (FR-014)：结构化日期恰为某清单会议日 ⇒ 结构化来源记的是会议日，推定值 (会议日 + 间隔) 更准。
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
  selection: Selection,
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

// ─── 主函数 ───────────────────────────────────────────────────────────────

export function mergeEarningsDateEvent(input: EarningsDateMergeInput): EarningsDateMergeResult {
  const existing = input.existing;
  const selection = selectAnnounceDate(input.observations, input.meetingLagDays);
  const isConflict = selection.reason === 'conflict';

  const confirmation = advanceConfirmation(
    { date: existing?.confirmedDate ?? null, basis: existing?.confirmedBasis ?? null },
    computeConfirmation(input, selection),
  );
  const status: EarningsDateEventStatus = isConflict
    ? 'conflict'
    : confirmation.date !== null
      ? 'confirmed'
      : 'unconfirmed';

  const publicationTime =
    input.observations
      .filter(
        (o) =>
          o.publicationTime !== null &&
          selection.date !== null &&
          candidateDate(o, input.meetingLagDays) === selection.date,
      )
      .sort((a, b) => BASIS_RANK[a.basis] - BASIS_RANK[b.basis])[0]?.publicationTime ?? null;

  const event: EarningsDateEventFields = {
    status,
    announceDate: selection.date,
    announceBasis: selection.basis,
    conflictCandidates: isConflict ? selection.candidates : null,
    publicationTime,
    confirmedDate: confirmation.date,
    confirmedBasis: confirmation.basis,
    sources: [...new Set(input.observations.map((o) => o.source))].sort(),
  };

  const fromStatus = existing?.status ?? null;
  const logs: EarningsDateEventLogEntry[] = [];
  const log = (kind: EarningsDateEventLogKind, detail: Record<string, unknown>) =>
    logs.push({ kind, fromStatus, toStatus: status, detail });

  if (fromStatus !== status) {
    log('status_changed', {
      announceDate: event.announceDate,
      announceBasis: event.announceBasis,
      ...(isConflict ? { candidates: selection.candidates } : {}),
      ...(fromStatus === 'conflict'
        ? { resolvedCandidates: existing?.conflictCandidates ?? [] }
        : {}),
    });
  }
  if (
    (existing?.announceDate ?? null) !== event.announceDate ||
    (existing?.announceBasis ?? null) !== event.announceBasis
  ) {
    log('value_changed', {
      from: { date: existing?.announceDate ?? null, basis: existing?.announceBasis ?? null },
      to: { date: event.announceDate, basis: event.announceBasis },
      reason: selection.reason,
      candidates: selection.candidates,
    });
  }
  if (
    (existing?.confirmedDate ?? null) !== confirmation.date ||
    (existing?.confirmedBasis ?? null) !== confirmation.basis
  ) {
    log('confirmation_changed', {
      from: { date: existing?.confirmedDate ?? null, basis: existing?.confirmedBasis ?? null },
      to: { date: confirmation.date, basis: confirmation.basis },
    });
  }

  const findings: EarningsDateFinding[] =
    isConflict && fromStatus !== 'conflict'
      ? [
          {
            kind: 'notice',
            step: 'earnings_date_conflict',
            countsAsFailure: false,
            detail: { periodKey: input.periodKey, candidates: selection.candidates },
          },
        ]
      : [];

  return { event, logs, findings };
}
