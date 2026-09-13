import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../security/prisma.service.js';
import { EarningsCalendarBudgetExhaustedError } from './earnings-calendar.port.js';
import {
  isNoticeUndatedPlaceholder,
  judgeNoticeUndated,
  mergeEarningsDateEvent,
  NOTICE_UNDATED_PERIOD_KEY_PREFIX,
  noticeUndatedPeriodKey,
  selectAnnounceDate,
  selectPendingNotice,
  type EarningsConfirmedBasis,
  type EarningsDateCandidate,
  type EarningsDateEventFields,
  type EarningsDateEventLogEntry,
  type EarningsDateEventStatus,
  type EarningsDateFinding,
  type EarningsDateMergeObservation,
  type EarningsDateMergeResult,
  type EarningsDateSelection,
  type ExistingEarningsDateEvent,
  type ListingPresence,
  type NoticeUndatedResult,
} from './earnings-date-merge.rules.js';
import {
  EARNINGS_DATE_SOURCES,
  type AssembledEarningsDateSource,
  type EarningsDateBasis,
  type EarningsDateCollectMode,
  type EarningsDateCollectResult,
  type EarningsDateSourceCapabilities,
  type EarningsDateSourceName,
  type EarningsDateSourceObservation,
  type EarningsNoticeSignal,
} from './earnings-date-source.port.js';
import { exchangeCalendarDate } from './session-clock.js';
import {
  SyncEarningsFiscalProfileUseCase,
  type FiscalProfileBatchResult,
} from './sync-earnings-fiscal-profile.usecase.js';
import { addWritten, type SyncRunStats } from './sync-run.recorder.js';
import { TRADING_CALENDAR_PORT, type TradingCalendarPort } from './trading-calendar.port.js';

/**
 * 港股财报日期合并用例 (079 T013 / T014, FR-013 / FR-018 / FR-020a / FR-023 / FR-025, plan §D8 / §D10)。
 * ADR-0043 扁平贫血：直注 `PrismaService`，判据全在 `earnings-date-merge.rules.ts`。
 *
 * ## 采集段 (T013)：先全部 collect 完，再写库 (🚫 事务内 HTTP)
 *
 * 按来源 try/catch 隔离 (FR-018)，🚫 出现任何来源名分支 (FR-001)，只认 port 契约：
 *
 * | 本轮结局 | finding | `stats` | 该来源观测 |
 * | --- | --- | --- | --- |
 * | `collect` 抛错 | `failure` `earnings_date_source` (`symbol = source:<装配名>`) | `failed += 1` | 🚨 零写入 |
 * | 抛 {@link EarningsCalendarBudgetExhaustedError} (429) | —— (只 warn) | 不计 | 零写入，`budgetExhausted = true` 顺延 |
 * | 成功、`stale: true` | `failure` `earnings_board_list_stale` | `ok += 1`、`failed += 1` | 照写 |
 * | 成功、`stale: 'unknown'` | `unjudged` `earnings_date_calendar_unknown` | `ok += 1` (🚫 计失败) | 照写 |
 * | 成功 | —— | `ok += 1` | 照写 |
 *
 * 🚨 **失败三件套同处落** (tasks 排序铁律 3)：`failure` kind 本身不蕴含计数 (`sync-run.recorder.ts`
 * `SyncRunFinding` 注释)，只写 finding 不加 `failed` ⇒ 运行状态仍 `success` ⇒ 日报绿、飞书不标红。
 *
 * 📌 计数口径：`scanned` = 本轮尝试的来源数 (对本市场有能力者)，`ok` = 成功完成 `collect` 的来源数
 * (陈旧页也算完成)，`failed` = 失败来源数 + 陈旧页数 (+ T015 状态迁入数)。⇒ 全部来源失败时
 * `deriveStatus` 得 `failed`，部分失败 / 陈旧得 `partial`。
 *
 * 📌 429 处置照现役 `sync-earnings-event.usecase.ts` `fetchHorizon` (`err instanceof
 * EarningsCalendarBudgetExhaustedError` ⇒ 只 warn、不计 `failed`、返回 `budgetExhausted: true`)：
 * 端口契约 `earnings-calendar.port.ts` 限频耗尽 = 「顺延重入队, 不耗 attempts (deferral ≠ failure)」。
 * 与现役的差别只在「已取到的窗」：来源的 `collect` 整体抛出，半份结果拿不到 ⇒ 该来源本轮零写入，
 * 重入队那一轮整段重拉 (观测 upsert 幂等)。
 *
 * ## 合并段 (T014)：起手补财年档案 → 采集 → 观测落库 → 逐事件合并 → 已通知日期未知扫描
 *
 * 1. 🚨 起手 {@link SyncEarningsFiscalProfileUseCase.syncHkAnchors} (tasks 排序铁律 9)：来源换算期末日与
 *    逾期判定都读档案，先采后补 ⇒ 存量锚第一轮成批落 `D:` / `T:` 键并误判逾期。
 * 2. 重算集合 = 本轮观测的键 ∪ 清单上一轮在、本轮不在的键 (提前消失候选) ∪ 本市场全部未刊发事件
 *    (逾期扫描；仅当有来源声明 `publicationFact`，FR-028)。🚨 占位事件单点排除 ({@link isNoticeUndatedPlaceholder})：
 *    零观测、带 `confirmedDate` 的占位事件进合并会被静默算成 `confirmed`。
 * 3. 每事件：读观测 + 事件 → 纯函数 → 一个事务 (事件 `updateMany where { id, revision }` / create →
 *    流水 → 偏差写回观测 → 间隔 upsert)；命中 0 行或唯一键冲突 ⇒ 重读重算，至多 {@link MAX_REVISION_RETRIES} 次。
 *    🚫 `FOR UPDATE`；🚫 事务内 HTTP (HTTP 全在采集段)。内容全无变化 ⇒ 不写 (不空涨 `revision`)。
 * 4. 已通知日期未知 (标的级)：迁入 ⇒ 建占位事件 `D:notice_undated:<通知刊发日>`；迁出 ⇒ 占位事件
 *    `superseded`，流水 `detail.supersededBy` 指向接手事件 id。🚫 删除 (流水级联删除，FR-013 / FR-017)。
 *    提供会前通知信号的来源本轮失败 ⇒ 整段不判 (取不到信号 ≠ 通知已被用掉)。
 *
 * findings 不在本段写进 `stats`：本段只把规则产出带上标的代码汇总进 {@link EarningsDatesMergeSummary}。
 */

/** 事件条件更新命中 0 行 / 新事件唯一键冲突后的重读重算次数上限 (plan §D8)。 */
export const MAX_REVISION_RETRIES = 3;

/** 港股日常入口的市场 (plan §D9 `hk_earnings_date` 维度 scope `{hk}`)。 */
export const HK_EARNINGS_DATE_MARKET = 'hk';

/** 单次 `createMany` 的行数配额 (同 `sync-earnings-event.usecase.ts` 的 `EARNINGS_ROW_CHUNK`)。 */
const OBSERVATION_ROW_CHUNK = 500;

const toDateOnly = (s: string | null): Date | null =>
  s === null ? null : new Date(`${s}T00:00:00Z`);
const isoDate = (d: Date | null): string | null =>
  d === null ? null : d.toISOString().slice(0, 10);

export interface EarningsDatesRunRequest {
  /** 本轮运行时刻 (UTC instant)；业务日 = 该市场交易所当地日期，观测时刻一律取它。 */
  readonly now: Date;
  readonly mode: EarningsDateCollectMode;
}

/** 成功完成 `collect` 的一个来源。 */
export interface CollectedEarningsDateSource {
  readonly name: EarningsDateSourceName;
  readonly result: EarningsDateCollectResult;
}

/** 采集段结局 (T014 合并段的输入)。 */
export interface EarningsDatesCollectOutcome {
  readonly market: string;
  readonly businessDate: string;
  readonly collected: readonly CollectedEarningsDateSource[];
  /** 本轮 `collect` 抛错的来源 (含 429 顺延) —— 其观测的出现情况本轮不可判 (🚫 判清单行消失)。 */
  readonly unavailable: readonly EarningsDateSourceName[];
  /** 装配名 → 该来源对本市场的能力；`capabilities()` 本身抛错的来源不在表内 (= 无能力)。 */
  readonly capabilities: ReadonlyMap<string, EarningsDateSourceCapabilities | null>;
  /** 有来源因 429 顺延 ⇒ 调用方转 `ExecutorResult.budgetExhausted`。 */
  readonly budgetExhausted: boolean;
}

/** 事件键 `(标的, period_key)`。 */
export interface EarningsDateEventKey {
  readonly instrumentId: bigint;
  readonly periodKey: string;
}

/** 合并段产出的一条 finding 候选，带上标的代码 (T015 据此写 `stats`)。 */
export interface EarningsDateMergeFinding {
  readonly instrumentId: bigint;
  /** `<market>:<code>`；主表查不到 (不应发生) 时 `<market>:#<id>`。 */
  readonly symbol: string;
  readonly finding: EarningsDateFinding;
}

export interface EarningsDatesMergeSummary {
  /** 事件行 create / 条件更新次数 (含占位事件)。 */
  readonly eventsWritten: number;
  readonly findings: readonly EarningsDateMergeFinding[];
  /** 因无财年档案未判定逾期 / 已通知日期未知：每个未判定的事件 (或标的) 一条代码 (FR-028)。 */
  readonly fiscalUnknown: readonly string[];
  /** 从未在清单出现、满足已通知日期未知条件的标的代码 (FR-017：只计数)。 */
  readonly neverListedUndated: readonly string[];
}

/** 港股日常入口结局 = 采集段结局 + 起手财年档案反推 + 合并段汇总。 */
export interface EarningsDatesRunOutcome extends EarningsDatesCollectOutcome {
  readonly fiscalProfiles: FiscalProfileBatchResult;
  readonly merge: EarningsDatesMergeSummary;
}

/** 增量入口请求 (美股钩子 T020)。 */
export interface EarningsDatesIncrementalRequest {
  readonly market: string;
  /** 与本批观测落库同一时刻 —— 「本轮改期」按 `date_changed_at === now` 判。 */
  readonly now: Date;
  readonly keys: readonly EarningsDateEventKey[];
}

/** 观测表里与来源侧观测逐列对应的那些列 (比对是否变化用)。 */
type ObservationColumns = Pick<
  Prisma.EarningsDateObservationUncheckedCreateInput,
  | 'market'
  | 'reportKind'
  | 'periodEnd'
  | 'periodText'
  | 'basis'
  | 'announceDate'
  | 'meetingDate'
  | 'publicationTime'
  | 'filedDate'
  | 'evidence'
>;

interface StoredObservation {
  readonly id: bigint;
  readonly instrumentId: bigint;
  readonly periodKey: string;
  readonly market: string;
  readonly reportKind: string | null;
  readonly periodEnd: Date | null;
  readonly periodText: string | null;
  readonly basis: string;
  readonly announceDate: Date | null;
  readonly meetingDate: Date | null;
  readonly publicationTime: Date | null;
  readonly filedDate: Date | null;
  readonly evidence: string | null;
}

function observationColumns(market: string, o: EarningsDateSourceObservation): ObservationColumns {
  return {
    market,
    reportKind: o.reportKind,
    periodEnd: toDateOnly(o.periodEnd),
    periodText: o.periodText,
    basis: o.basis,
    announceDate: toDateOnly(o.announceDate),
    meetingDate: toDateOnly(o.meetingDate),
    publicationTime: o.publicationTime,
    filedDate: toDateOnly(o.filedDate),
    evidence: o.evidence,
  };
}

/**
 * 本行承重日期 (schema `prev_date` 注释：`meeting` 口径为会议日，其余为公布日；`filed` 取刊发日) ——
 * 与合并规则 `sourceDate` 同一取法，改期留痕与合并流水说的是同一个日期。
 */
function bearingDate(o: {
  basis: string;
  announceDate: string | null;
  meetingDate: string | null;
  filedDate: string | null;
}): string | null {
  if (o.basis === 'meeting') return o.meetingDate ?? o.announceDate;
  if (o.basis === 'filed') return o.filedDate ?? o.announceDate;
  return o.announceDate;
}

function storedBearingDate(row: StoredObservation): string | null {
  return bearingDate({
    basis: row.basis,
    announceDate: isoDate(row.announceDate),
    meetingDate: isoDate(row.meetingDate),
    filedDate: isoDate(row.filedDate),
  });
}

function sameColumns(row: StoredObservation, next: ObservationColumns): boolean {
  const dateEq = (a: Date | null, b: Date | string | null | undefined) =>
    isoDate(a) === (b instanceof Date ? isoDate(b) : (b ?? null));
  const instantEq = (a: Date | null, b: Date | string | null | undefined) =>
    (a?.getTime() ?? null) === (b instanceof Date ? b.getTime() : (b ?? null));
  return (
    row.market === next.market &&
    row.reportKind === (next.reportKind ?? null) &&
    dateEq(row.periodEnd, next.periodEnd) &&
    row.periodText === (next.periodText ?? null) &&
    row.basis === next.basis &&
    dateEq(row.announceDate, next.announceDate) &&
    dateEq(row.meetingDate, next.meetingDate) &&
    instantEq(row.publicationTime, next.publicationTime) &&
    dateEq(row.filedDate, next.filedDate) &&
    row.evidence === (next.evidence ?? null)
  );
}

// ─── 合并段 (T014) ────────────────────────────────────────────────────────

/** 事件条件更新命中 0 行 / 新事件撞唯一键 —— 被并发写抢先，重读重算。 */
class EarningsDateEventRaceError extends Error {
  constructor(key: string) {
    super(`[sync-earnings-dates] 事件 ${key} 已被并发写更新 (revision 不符 / 唯一键冲突)`);
    this.name = 'EarningsDateEventRaceError';
  }
}

const isEventRace = (err: unknown): boolean =>
  err instanceof EarningsDateEventRaceError || (err as { code?: unknown } | null)?.code === 'P2002';

const eventKey = (instrumentId: bigint, periodKey: string): string =>
  `${instrumentId} ${periodKey}`;

/** 重算集合。🚨 占位事件在此**单点**排除 (见文件头合并段 ②)。 */
function mergeKeySet() {
  const keys = new Map<string, EarningsDateEventKey>();
  return {
    add({ instrumentId, periodKey }: EarningsDateEventKey): void {
      if (isNoticeUndatedPlaceholder(periodKey)) return;
      keys.set(eventKey(instrumentId, periodKey), { instrumentId, periodKey });
    },
    values: (): EarningsDateEventKey[] => [...keys.values()],
  };
}

function hasPublicationFact(
  capabilities: ReadonlyMap<string, EarningsDateSourceCapabilities | null>,
): boolean {
  return [...capabilities.values()].some((c) => c?.publicationFact === true);
}

/** 提供会前通知信号的来源本轮全部完成采集 —— 否则信号残缺，🚫 判已通知日期未知的迁入 / 迁出。 */
function signalsReliable(outcome: EarningsDatesCollectOutcome): boolean {
  const signalSources = [...outcome.capabilities]
    .filter(([, c]) => c?.confirmationSignal === true)
    .map(([name]) => name);
  const unavailable: readonly string[] = outcome.unavailable;
  return signalSources.length > 0 && signalSources.every((name) => !unavailable.includes(name));
}

/** 列表型来源 (本轮回传 `listedPeriodKeys` + 页首日期) 的出现情况输入。 */
interface ListingRound {
  readonly pageDate: string;
  readonly listed: ReadonlySet<string>;
  /** 上一轮 (该来源观测的上一次最近出现时刻) 在清单上的键。🚨 须在本轮观测落库之前读。 */
  readonly lastRound: ReadonlyMap<string, EarningsDateEventKey>;
}

interface FilingFact {
  readonly periodKey: string;
  readonly date: string;
}

/** 一轮合并共用的输入 (预读一次，逐事件复用)。 */
interface MergeContext {
  readonly market: string;
  readonly businessDate: string;
  readonly now: Date;
  readonly capabilities: ReadonlyMap<string, EarningsDateSourceCapabilities | null>;
  readonly publicationFact: boolean;
  readonly signalsByInstrument: ReadonlyMap<bigint, readonly EarningsNoticeSignal[]>;
  readonly listings: ReadonlyMap<string, ListingRound>;
  readonly fiscalProfiles: ReadonlySet<bigint>;
  readonly filings: ReadonlyMap<bigint, readonly FilingFact[]>;
  readonly symbols: ReadonlyMap<bigint, string>;
  /** 自 `from` 至本轮业务日的交易日数 (左开右闭)，按 `from` memo。 */
  countTradingDays(from: string): Promise<number | null>;
}

type MergeContextBase = Omit<
  MergeContext,
  'fiscalProfiles' | 'filings' | 'symbols' | 'countTradingDays'
>;

interface MergeAccumulator {
  eventsWritten: number;
  findings: EarningsDateMergeFinding[];
  fiscalUnknown: string[];
  neverListedUndated: string[];
}

const MERGE_OBSERVATION_SELECT = {
  instrumentId: true,
  periodKey: true,
  source: true,
  basis: true,
  reportKind: true,
  periodEnd: true,
  announceDate: true,
  meetingDate: true,
  publicationTime: true,
  filedDate: true,
  firstSeenAt: true,
  prevDate: true,
  dateChangedAt: true,
} as const;

interface MergeObservationRow {
  readonly instrumentId: bigint;
  readonly periodKey: string;
  readonly source: string;
  readonly basis: string;
  readonly reportKind: string | null;
  readonly periodEnd: Date | null;
  readonly announceDate: Date | null;
  readonly meetingDate: Date | null;
  readonly publicationTime: Date | null;
  readonly filedDate: Date | null;
  readonly firstSeenAt: Date;
  readonly prevDate: Date | null;
  readonly dateChangedAt: Date | null;
}

const EVENT_SELECT = {
  id: true,
  status: true,
  announceDate: true,
  announceBasis: true,
  conflictCandidates: true,
  publicationTime: true,
  confirmedDate: true,
  confirmedBasis: true,
  sources: true,
  overdueSince: true,
  reportKind: true,
  periodEnd: true,
  revision: true,
} as const;

interface StoredEvent {
  readonly id: bigint;
  readonly status: string;
  readonly announceDate: Date | null;
  readonly announceBasis: string | null;
  readonly conflictCandidates: Prisma.JsonValue | null;
  readonly publicationTime: Date | null;
  readonly confirmedDate: Date | null;
  readonly confirmedBasis: string | null;
  readonly sources: string[];
  readonly overdueSince: Date | null;
  readonly reportKind: string | null;
  readonly periodEnd: Date | null;
  readonly revision: number;
}

interface UndatedScanEvent {
  readonly id: bigint;
  readonly periodKey: string;
  readonly status: string;
  readonly announceDate: Date | null;
  readonly revision: number;
}

function toMergeObservation(
  ctx: MergeContext,
  row: MergeObservationRow,
): EarningsDateMergeObservation {
  const key = eventKey(row.instrumentId, row.periodKey);
  const listing = ctx.listings.get(row.source);
  const presence: ListingPresence | null =
    listing === undefined
      ? null
      : {
          listedLastRound: listing.lastRound.has(key),
          thisRound: listing.listed.has(key) ? 'listed' : 'absent',
          pageDate: listing.pageDate,
        };
  const previousDate = isoDate(row.prevDate);
  return {
    source: row.source,
    basis: row.basis as EarningsDateBasis,
    announceDate: isoDate(row.announceDate),
    meetingDate: isoDate(row.meetingDate),
    publicationTime: row.publicationTime,
    filedDate: isoDate(row.filedDate),
    firstSeenDate: exchangeCalendarDate(ctx.market, row.firstSeenAt),
    // 「本轮改期」= 本轮落库时写的 `date_changed_at` (recordObservations 取同一个 now)。
    dateChange:
      row.dateChangedAt !== null &&
      row.dateChangedAt.getTime() === ctx.now.getTime() &&
      previousDate !== null
        ? { previousDate, changedAt: row.dateChangedAt }
        : null,
    presence,
  };
}

/** 事件的报告类型与期末日：取观测中首个非空值，观测都没有时沿用事件既有值。 */
function eventShape(
  rows: readonly MergeObservationRow[],
  stored: StoredEvent | null,
): { reportKind: string | null; periodEnd: Date | null } {
  const reportKind = rows.find((r) => r.reportKind !== null)?.reportKind;
  const periodEnd = rows.find((r) => r.periodEnd !== null)?.periodEnd;
  return {
    reportKind: reportKind ?? stored?.reportKind ?? null,
    periodEnd: periodEnd ?? stored?.periodEnd ?? null,
  };
}

function toExistingEvent(row: StoredEvent): ExistingEarningsDateEvent {
  return {
    status: row.status as EarningsDateEventStatus,
    announceDate: isoDate(row.announceDate),
    announceBasis: row.announceBasis as EarningsDateBasis | null,
    conflictCandidates: storedCandidates(row.conflictCandidates),
    confirmedDate: isoDate(row.confirmedDate),
    confirmedBasis: row.confirmedBasis as EarningsConfirmedBasis | null,
    overdueSince: row.overdueSince,
  };
}

function storedCandidates(json: Prisma.JsonValue | null): EarningsDateCandidate[] | null {
  return Array.isArray(json) ? (json as unknown as EarningsDateCandidate[]) : null;
}

/** jsonb 会重排对象键 ⇒ 候选比对逐字段取，🚫 `JSON.stringify` 整体比 (会让冲突事件每轮空写)。 */
const candidateSignature = (candidates: readonly EarningsDateCandidate[] | null): string =>
  candidates === null ? '' : candidates.map((c) => `${c.source}|${c.basis}|${c.date}`).join(',');

function sameEvent(
  row: StoredEvent,
  next: EarningsDateEventFields,
  reportKind: string | null,
  periodEnd: Date | null,
): boolean {
  const instant = (d: Date | null) => d?.getTime() ?? null;
  return (
    row.status === next.status &&
    isoDate(row.announceDate) === next.announceDate &&
    row.announceBasis === next.announceBasis &&
    candidateSignature(storedCandidates(row.conflictCandidates)) ===
      candidateSignature(next.conflictCandidates) &&
    instant(row.publicationTime) === instant(next.publicationTime) &&
    isoDate(row.confirmedDate) === next.confirmedDate &&
    row.confirmedBasis === next.confirmedBasis &&
    row.sources.join(',') === next.sources.join(',') &&
    instant(row.overdueSince) === instant(next.overdueSince) &&
    row.reportKind === reportKind &&
    isoDate(row.periodEnd) === isoDate(periodEnd)
  );
}

function eventColumns(next: EarningsDateEventFields) {
  return {
    status: next.status,
    announceDate: toDateOnly(next.announceDate),
    announceBasis: next.announceBasis,
    conflictCandidates:
      next.conflictCandidates === null
        ? Prisma.DbNull
        : (next.conflictCandidates as unknown as Prisma.InputJsonValue),
    publicationTime: next.publicationTime,
    confirmedDate: toDateOnly(next.confirmedDate),
    confirmedBasis: next.confirmedBasis,
    sources: [...next.sources],
    overdueSince: next.overdueSince,
  };
}

function logRows(
  eventId: bigint,
  logs: readonly EarningsDateEventLogEntry[],
): Prisma.EarningsDateEventLogCreateManyInput[] {
  return logs.map((l) => ({
    eventId,
    kind: l.kind,
    fromStatus: l.fromStatus,
    toStatus: l.toStatus,
    detail: l.detail as Prisma.InputJsonValue,
  }));
}

/** 该标的本事件之外、早于本事件日期的最近一次刊发 (确认日期窗口下界，FR-012)。 */
function previousFilingDate(
  filings: readonly FilingFact[],
  periodKey: string,
  selection: EarningsDateSelection,
): string | null {
  const eventDate = selection.date ?? selection.candidates.map((c) => c.date).sort()[0];
  if (eventDate === undefined) return null;
  return (
    filings
      .filter((f) => f.periodKey !== periodKey && f.date < eventDate)
      .map((f) => f.date)
      .sort()
      .pop() ?? null
  );
}

/**
 * 占位事件的接手事件：通知刊发日及之后有日期的未刊发事件 (最早) > 通知之后刊发的事件 (最早) >
 * 任一带日期 (含冲突) 的未刊发事件。
 */
function pickSuccessor(
  events: readonly UndatedScanEvent[],
  noticeDate: string,
): UndatedScanEvent | null {
  const after = events
    .filter((e) => (isoDate(e.announceDate) ?? '') >= noticeDate)
    .sort((a, b) => (isoDate(a.announceDate) ?? '').localeCompare(isoDate(b.announceDate) ?? ''));
  return (
    after.find((e) => e.status !== 'published') ??
    after.find((e) => e.status === 'published') ??
    events.find(
      (e) => e.status !== 'published' && (e.announceDate !== null || e.status === 'conflict'),
    ) ??
    null
  );
}

@Injectable()
export class SyncEarningsDatesUseCase {
  private readonly logger = new Logger(SyncEarningsDatesUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EARNINGS_DATE_SOURCES) private readonly sources: readonly AssembledEarningsDateSource[],
    private readonly fiscalProfile: SyncEarningsFiscalProfileUseCase,
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
  ) {}

  /**
   * 港股日常入口。复杂度：档案反推 O(锚数) + {@link collect} + {@link recordObservations} +
   * 合并 O(E) 个事件 × O(1) 次读写 (E = 重算集合大小；交易日数按起算日 memo)。
   */
  async runHk(
    stats: SyncRunStats,
    request: EarningsDatesRunRequest,
  ): Promise<EarningsDatesRunOutcome> {
    // #138: 声明写路径 —— 零观测的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    // 🚨 排序铁律 9：档案先于采集 (来源换算期末日读档案)。DB 异常上抛 ⇒ 整轮失败重跑。
    const fiscalProfiles = await this.fiscalProfile.syncHkAnchors(request.now);
    const outcome = await this.collect(HK_EARNINGS_DATE_MARKET, stats, request);
    // 🚨 上一轮清单集合须在观测落库之前读：落库后本轮在清单的行最近观测时刻已是本轮。
    const listings = await this.readListingRounds(outcome);
    for (const { name, result } of outcome.collected) {
      await this.recordObservations(name, outcome.market, result.observations, request.now, stats);
    }
    const merge = await this.mergeHk(outcome, listings, request.now);
    addWritten(stats, merge.eventsWritten);
    return { ...outcome, fiscalProfiles, merge };
  }

  /**
   * 增量入口 (美股钩子 T020，plan §D8 触发点 ②)：只重算传入的键；🚫 逾期 / 未知日期扫描、🚫 触碰
   * `stats` (钩子不得改变现役运行记录，plan §D9)。失败直接抛，由调用方 try/catch。
   * 复杂度 O(K) 个事件 × O(1) 次读写。
   */
  async mergeIncremental({
    market,
    now,
    keys,
  }: EarningsDatesIncrementalRequest): Promise<EarningsDatesMergeSummary> {
    const capabilities = new Map<string, EarningsDateSourceCapabilities | null>();
    for (const { name, source } of this.sources) {
      const capability = source.capabilities(market);
      if (capability !== null) capabilities.set(name, capability);
    }
    const set = mergeKeySet();
    keys.forEach(set.add);
    const list = set.values();
    const ctx = await this.buildContext(
      {
        market,
        businessDate: exchangeCalendarDate(market, now),
        now,
        capabilities,
        publicationFact: hasPublicationFact(capabilities),
        signalsByInstrument: new Map(),
        listings: new Map(),
      },
      list.map((k) => k.instrumentId),
    );
    const acc: MergeAccumulator = {
      eventsWritten: 0,
      findings: [],
      fiscalUnknown: [],
      neverListedUndated: [],
    };
    await this.mergeKeys(ctx, list, acc);
    return acc;
  }

  /**
   * 逐来源 `collect` (HTTP 全在这里、全在任何写库之前)。复杂度 O(来源数) 次 `collect`。
   */
  private async collect(
    market: string,
    stats: SyncRunStats,
    { now, mode }: EarningsDatesRunRequest,
  ): Promise<EarningsDatesCollectOutcome> {
    const businessDate = exchangeCalendarDate(market, now);
    const collected: CollectedEarningsDateSource[] = [];
    const unavailable: EarningsDateSourceName[] = [];
    const capabilities = new Map<string, EarningsDateSourceCapabilities | null>();
    let budgetExhausted = false;

    for (const { name, source } of this.sources) {
      try {
        const capability = source.capabilities(market);
        if (capability === null) continue; // 该来源不支持本市场 ⇒ 不是失败，也不算尝试。
        capabilities.set(name, capability);
        const result = await source.collect({ market, businessDate, now, mode });
        collected.push({ name, result });
        stats.scanned += 1;
        stats.ok += 1;
        this.judgeStaleness(name, result, businessDate, stats);
      } catch (err) {
        unavailable.push(name);
        stats.scanned += 1;
        if (err instanceof EarningsCalendarBudgetExhaustedError) {
          budgetExhausted = true;
          this.logger.warn(
            `财报日期来源限频顺延 (本轮零写入, 重入队整段重拉): ${name} ${String(err)}`,
          );
          continue;
        }
        // 🚨 失败三件套：finding + failed + (不进 collected ⇒) 零写入，缺一件日报就是绿的。
        stats.failed += 1;
        stats.findings.push({
          kind: 'failure',
          symbol: `source:${name}`,
          step: 'earnings_date_source',
          error: String(err),
        });
        this.logger.warn(`财报日期来源失败 (来源隔离, 本轮零写入): ${name} ${String(err)}`);
      }
    }
    return { market, businessDate, collected, unavailable, capabilities, budgetExhausted };
  }

  /** 列表型来源的页面陈旧 (FR-025)：陈旧 ⇒ 标红；日历不可判 ⇒ 无法判定、🚫 标红。 */
  private judgeStaleness(
    name: EarningsDateSourceName,
    result: EarningsDateCollectResult,
    businessDate: string,
    stats: SyncRunStats,
  ): void {
    const pageDate = result.boardListScan?.pageDate ?? null;
    if (result.stale === true) {
      stats.failed += 1;
      stats.findings.push({
        kind: 'failure',
        symbol: `source:${name}`,
        step: 'earnings_board_list_stale',
        error: `页首日期 ${pageDate ?? '?'} 距业务日 ${businessDate} 超过陈旧阈值 (观测照写)`,
      });
      this.logger.warn(
        `财报日期清单页陈旧: ${name} 页首 ${pageDate ?? '?'} / 业务日 ${businessDate}`,
      );
    } else if (result.stale === 'unknown') {
      stats.findings.push({
        kind: 'unjudged',
        symbol: `source:${name}`,
        step: 'earnings_date_calendar_unknown',
        contracts: [],
        gates: [`board_list_stale:${pageDate ?? '?'}..${businessDate}`],
      });
    }
  }

  /**
   * 观测 upsert (FR-013 / FR-020a)：新行落首次 = 最近观测时刻 = 本轮；既有行最近观测时刻 = 本轮，
   * 承重日期变了 ⇒ 旧值进 `prev_date`、本轮进 `date_changed_at`；🚫 覆盖 `first_seen_at`。
   *
   * 不包事务：逐行写幂等，中途 DB 失败上抛 ⇒ 整轮重跑收敛 (回填一轮可达数千行，单事务会撞超时)。
   * 并发两轮同时插同一新行 ⇒ `skipDuplicates` 先写者胜，内容同源同轮等价。
   *
   * 复杂度：1 次读 + O(新行 / 500) 次 createMany + 1 次 updateMany (内容未变的行) + O(内容变化行) 次 update。
   */
  async recordObservations(
    source: EarningsDateSourceName,
    market: string,
    observations: readonly EarningsDateSourceObservation[],
    now: Date,
    stats: SyncRunStats,
  ): Promise<void> {
    if (observations.length === 0) return;
    const stored: StoredObservation[] = await this.prisma.earningsDateObservation.findMany({
      where: {
        source,
        instrumentId: { in: [...new Set(observations.map((o) => o.instrumentId))] },
      },
      select: {
        id: true,
        instrumentId: true,
        periodKey: true,
        market: true,
        reportKind: true,
        periodEnd: true,
        periodText: true,
        basis: true,
        announceDate: true,
        meetingDate: true,
        publicationTime: true,
        filedDate: true,
        evidence: true,
      },
    });
    const byKey = new Map(stored.map((row) => [`${row.instrumentId} ${row.periodKey}`, row]));

    const inserts: Prisma.EarningsDateObservationCreateManyInput[] = [];
    const touchOnly: bigint[] = [];
    const updates: { id: bigint; data: Prisma.EarningsDateObservationUpdateInput }[] = [];
    for (const o of observations) {
      const columns = observationColumns(market, o);
      const row = byKey.get(`${o.instrumentId} ${o.periodKey}`);
      if (row === undefined) {
        inserts.push({
          source,
          instrumentId: o.instrumentId,
          periodKey: o.periodKey,
          ...columns,
          firstSeenAt: now,
          lastSeenAt: now,
        });
        continue;
      }
      if (sameColumns(row, columns)) {
        touchOnly.push(row.id);
        continue;
      }
      const previous = storedBearingDate(row);
      const next = bearingDate(o);
      const rescheduled = previous !== null && next !== null && previous !== next;
      updates.push({
        id: row.id,
        data: {
          ...columns,
          lastSeenAt: now,
          ...(rescheduled ? { prevDate: toDateOnly(previous), dateChangedAt: now } : {}),
        },
      });
    }

    for (let i = 0; i < inserts.length; i += OBSERVATION_ROW_CHUNK) {
      const chunk = inserts.slice(i, i + OBSERVATION_ROW_CHUNK);
      addWritten(
        stats,
        (
          await this.prisma.earningsDateObservation.createMany({
            data: chunk,
            skipDuplicates: true,
          })
        ).count,
      );
    }
    if (touchOnly.length > 0) {
      const { count } = await this.prisma.earningsDateObservation.updateMany({
        where: { id: { in: touchOnly } },
        data: { lastSeenAt: now },
      });
      addWritten(stats, count);
    }
    for (const { id, data } of updates) {
      await this.prisma.earningsDateObservation.update({ where: { id }, data });
      addWritten(stats, 1);
    }
  }

  /** 列表型来源的本轮 / 上一轮在清单集合。O(列表型来源数) 次读。 */
  private async readListingRounds(
    outcome: EarningsDatesCollectOutcome,
  ): Promise<Map<string, ListingRound>> {
    const listings = new Map<string, ListingRound>();
    for (const { name, result } of outcome.collected) {
      const pageDate = result.boardListScan?.pageDate;
      if (result.listedPeriodKeys === undefined || pageDate === undefined) continue;
      const latest = await this.prisma.earningsDateObservation.aggregate({
        where: { source: name },
        _max: { lastSeenAt: true },
      });
      const previousRoundAt = latest._max.lastSeenAt;
      const lastRoundRows =
        previousRoundAt === null
          ? []
          : await this.prisma.earningsDateObservation.findMany({
              where: { source: name, lastSeenAt: previousRoundAt },
              select: { instrumentId: true, periodKey: true },
            });
      listings.set(name, {
        pageDate,
        listed: new Set(result.listedPeriodKeys.map((k) => eventKey(k.instrumentId, k.periodKey))),
        lastRound: new Map(lastRoundRows.map((k) => [eventKey(k.instrumentId, k.periodKey), k])),
      });
    }
    return listings;
  }

  private async mergeHk(
    outcome: EarningsDatesCollectOutcome,
    listings: ReadonlyMap<string, ListingRound>,
    now: Date,
  ): Promise<EarningsDatesMergeSummary> {
    const { market } = outcome;
    const set = mergeKeySet();
    const signalsByInstrument = new Map<bigint, EarningsNoticeSignal[]>();
    for (const { result } of outcome.collected) {
      result.observations.forEach(set.add);
      for (const signal of result.noticeSignals) {
        const list = signalsByInstrument.get(signal.instrumentId) ?? [];
        list.push(signal);
        signalsByInstrument.set(signal.instrumentId, list);
      }
    }
    // 提前消失候选：上一轮在、本轮不在 (本轮在的已由观测带入)。
    for (const listing of listings.values()) listing.lastRound.forEach(set.add);
    const publicationFact = hasPublicationFact(outcome.capabilities);
    if (publicationFact) {
      // 逾期扫描只扫具备刊发事实来源的市场 (FR-028：无刊发事实的市场扫到会全部判逾期)。
      const unpublished = await this.prisma.earningsDateEvent.findMany({
        where: { market, status: { not: 'published' } },
        select: { instrumentId: true, periodKey: true },
      });
      unpublished.forEach(set.add);
    }
    const keys = set.values();
    const ctx = await this.buildContext(
      {
        market,
        businessDate: outcome.businessDate,
        now,
        capabilities: outcome.capabilities,
        publicationFact,
        signalsByInstrument,
        listings,
      },
      [...keys.map((k) => k.instrumentId), ...signalsByInstrument.keys()],
    );
    const acc: MergeAccumulator = {
      eventsWritten: 0,
      findings: [],
      fiscalUnknown: [],
      neverListedUndated: [],
    };
    await this.mergeKeys(ctx, keys, acc);
    if (publicationFact && signalsReliable(outcome)) await this.scanNoticeUndated(ctx, acc);
    return acc;
  }

  /** 预读一轮合并共用的输入。3 次读 (档案 / 刊发事实 / 标的代码)。 */
  private async buildContext(
    base: MergeContextBase,
    instrumentIds: readonly bigint[],
  ): Promise<MergeContext> {
    const ids = [...new Set(instrumentIds)];
    const [profiles, filings, instruments] = await Promise.all([
      this.prisma.earningsFiscalProfile.findMany({
        where: { instrumentId: { in: ids } },
        select: { instrumentId: true },
      }),
      this.prisma.earningsDateObservation.findMany({
        where: { instrumentId: { in: ids }, basis: 'filed' },
        select: { instrumentId: true, periodKey: true, filedDate: true, announceDate: true },
      }),
      this.prisma.instrument.findMany({
        where: { id: { in: ids } },
        select: { id: true, market: true, code: true },
      }),
    ]);
    const filingsByInstrument = new Map<bigint, FilingFact[]>();
    for (const f of filings) {
      const date = isoDate(f.filedDate ?? f.announceDate);
      if (date === null) continue;
      const list = filingsByInstrument.get(f.instrumentId) ?? [];
      list.push({ periodKey: f.periodKey, date });
      filingsByInstrument.set(f.instrumentId, list);
    }
    const tradingDays = new Map<string, Promise<number | null>>();
    return {
      ...base,
      fiscalProfiles: new Set(profiles.map((p) => p.instrumentId)),
      filings: filingsByInstrument,
      symbols: new Map(instruments.map((i) => [i.id, `${i.market}:${i.code}`])),
      countTradingDays: (from) => {
        let count = tradingDays.get(from);
        if (count === undefined) {
          count = this.calendar.countTradingDays(base.market, from, base.businessDate);
          tradingDays.set(from, count);
        }
        return count;
      },
    };
  }

  private async mergeKeys(
    ctx: MergeContext,
    keys: readonly EarningsDateEventKey[],
    acc: MergeAccumulator,
  ): Promise<void> {
    for (const key of keys) {
      const { written, result } = await this.withRaceRetry(
        eventKey(key.instrumentId, key.periodKey),
        () => this.mergeEvent(ctx, key),
      );
      if (written) acc.eventsWritten += 1;
      const symbol = ctx.symbols.get(key.instrumentId) ?? `${ctx.market}:#${key.instrumentId}`;
      for (const finding of result.findings) {
        acc.findings.push({ instrumentId: key.instrumentId, symbol, finding });
      }
      if (result.fiscalProfileMissing) acc.fiscalUnknown.push(symbol);
    }
  }

  /** 被并发写抢先 ⇒ 重读重算，至多 {@link MAX_REVISION_RETRIES} 次；其余异常原样上抛。 */
  private async withRaceRetry<T>(key: string, attempt: () => Promise<T>): Promise<T> {
    for (let retry = 0; ; retry++) {
      try {
        return await attempt();
      } catch (err) {
        if (!isEventRace(err) || retry >= MAX_REVISION_RETRIES) throw err;
        this.logger.warn(
          `财报日期事件并发写冲突, 重读重算 (${retry + 1}/${MAX_REVISION_RETRIES}): ${key}`,
        );
      }
    }
  }

  /** 单事件一次尝试：读观测 + 事件 → 纯函数 → 一个事务。 */
  private async mergeEvent(
    ctx: MergeContext,
    { instrumentId, periodKey }: EarningsDateEventKey,
  ): Promise<{ written: boolean; result: EarningsDateMergeResult }> {
    const [rows, stored] = await Promise.all([
      this.prisma.earningsDateObservation.findMany({
        where: { instrumentId, periodKey },
        select: MERGE_OBSERVATION_SELECT,
        orderBy: { source: 'asc' },
      }),
      this.prisma.earningsDateEvent.findUnique({
        where: { instrumentId_periodKey: { instrumentId, periodKey } },
        select: EVENT_SELECT,
      }),
    ]);
    const { reportKind, periodEnd } = eventShape(rows, stored);
    const lag =
      reportKind === null
        ? null
        : await this.prisma.earningsMeetingLag.findUnique({
            where: { instrumentId_reportKind: { instrumentId, reportKind } },
            select: { lagDays: true },
          });
    const meetingLagDays = lag?.lagDays ?? null;
    const observations = rows.map((row) => toMergeObservation(ctx, row));
    // 🚨 交易日数 MUST 自规则将判定的那个公布日起算 (规则侧校验 `from`) ⇒ 先按同一输入选日期。
    const selection = selectAnnounceDate(observations, meetingLagDays);
    const judgedDate =
      ctx.publicationFact && selection.reason !== 'conflict' && selection.basis !== 'filed'
        ? selection.date
        : null;
    const result = mergeEarningsDateEvent({
      periodKey,
      observations,
      capabilities: ctx.capabilities,
      meetingLagDays,
      noticeSignals: ctx.signalsByInstrument.get(instrumentId) ?? [],
      previousFilingDate: previousFilingDate(
        ctx.filings.get(instrumentId) ?? [],
        periodKey,
        selection,
      ),
      existing: stored === null ? null : toExistingEvent(stored),
      runAt: ctx.now,
      hasFiscalProfile: ctx.fiscalProfiles.has(instrumentId),
      elapsedTradingDays:
        judgedDate === null
          ? null
          : {
              from: judgedDate,
              to: ctx.businessDate,
              count: await ctx.countTradingDays(judgedDate),
            },
    });
    // 偏差 / 间隔只在迁入 published 时产出，必伴随 status_changed 流水 ⇒ 无流水且字段不变 = 无事可写。
    if (
      stored !== null &&
      result.logs.length === 0 &&
      sameEvent(stored, result.event, reportKind, periodEnd)
    ) {
      return { written: false, result };
    }
    await this.writeEvent(ctx, { instrumentId, periodKey }, stored, result, {
      reportKind,
      periodEnd,
    });
    return { written: true, result };
  }

  /**
   * 一个事务：事件 create / `updateMany where { id, revision }` → 流水 → 偏差写回观测 → 间隔 upsert。
   * 命中 0 行 ⇒ 抛 {@link EarningsDateEventRaceError} 回滚整个事务 (由 {@link withRaceRetry} 重读重算)。
   */
  private async writeEvent(
    ctx: MergeContext,
    { instrumentId, periodKey }: EarningsDateEventKey,
    stored: StoredEvent | null,
    result: EarningsDateMergeResult,
    { reportKind, periodEnd }: { reportKind: string | null; periodEnd: Date | null },
  ): Promise<void> {
    const key = eventKey(instrumentId, periodKey);
    await this.prisma.$transaction(async (tx) => {
      let eventId: bigint;
      if (stored === null) {
        // 并发先建 ⇒ P2002 ⇒ 重读后走条件更新。
        eventId = (
          await tx.earningsDateEvent.create({
            data: {
              instrumentId,
              periodKey,
              market: ctx.market,
              reportKind,
              periodEnd,
              ...eventColumns(result.event),
            },
            select: { id: true },
          })
        ).id;
      } else {
        const { count } = await tx.earningsDateEvent.updateMany({
          where: { id: stored.id, revision: stored.revision },
          data: {
            reportKind,
            periodEnd,
            ...eventColumns(result.event),
            revision: { increment: 1 },
          },
        });
        if (count === 0) throw new EarningsDateEventRaceError(key);
        eventId = stored.id;
      }
      if (result.logs.length > 0) {
        await tx.earningsDateEventLog.createMany({ data: logRows(eventId, result.logs) });
      }
      for (const d of result.deviations) {
        // 偏差写回观测 (FR-019)：唯一键 (source, instrument, period_key) ⇒ 至多 1 行。
        await tx.earningsDateObservation.updateMany({
          where: { source: d.source, instrumentId, periodKey },
          data: { deviationDays: d.deviationDays },
        });
      }
      const lagUpdate = result.meetingLagUpdate;
      if (lagUpdate !== null && reportKind !== null) {
        const data = { lagDays: lagUpdate.lagDays, periodEnd, observedAt: ctx.now };
        await tx.earningsMeetingLag.upsert({
          where: { instrumentId_reportKind: { instrumentId, reportKind } },
          create: { instrumentId, reportKind, ...data },
          update: data,
        });
      }
    });
  }

  /** 已通知日期未知扫描 (标的级，FR-017)。O(有信号标的数) × O(1) 次读写。 */
  private async scanNoticeUndated(ctx: MergeContext, acc: MergeAccumulator): Promise<void> {
    const instrumentIds = [...ctx.signalsByInstrument.keys()];
    if (instrumentIds.length === 0) return;
    // 「曾出现在清单」= 曾有 `meeting` 口径观测 (只有清单给会议日)：按口径判，🚫 来源名分支 (FR-001)。
    const listedRows = await this.prisma.earningsDateObservation.findMany({
      where: { instrumentId: { in: instrumentIds }, basis: 'meeting' },
      select: { instrumentId: true },
      distinct: ['instrumentId'],
    });
    const everListed = new Set(listedRows.map((r) => r.instrumentId));
    for (const instrumentId of instrumentIds) {
      const { written, result } = await this.withRaceRetry(
        `${instrumentId} ${NOTICE_UNDATED_PERIOD_KEY_PREFIX}`,
        () => this.judgeUndated(ctx, instrumentId, everListed.has(instrumentId)),
      );
      const symbol = ctx.symbols.get(instrumentId) ?? `${ctx.market}:#${instrumentId}`;
      if (written) acc.eventsWritten += 1;
      for (const finding of result.findings) acc.findings.push({ instrumentId, symbol, finding });
      if (result.neverListedUndated) acc.neverListedUndated.push(symbol);
      if (result.fiscalProfileMissing) acc.fiscalUnknown.push(symbol);
    }
  }

  /** 单标的一次尝试：迁入 ⇒ 建占位事件；迁出 ⇒ 占位事件 `superseded` + 流水指向接手事件。 */
  private async judgeUndated(
    ctx: MergeContext,
    instrumentId: bigint,
    everListed: boolean,
  ): Promise<{ written: boolean; result: NoticeUndatedResult }> {
    const events: UndatedScanEvent[] = await this.prisma.earningsDateEvent.findMany({
      where: { instrumentId },
      select: { id: true, periodKey: true, status: true, announceDate: true, revision: true },
    });
    const regular = events.filter((e) => !isNoticeUndatedPlaceholder(e.periodKey));
    const placeholder =
      events.find(
        (e) => isNoticeUndatedPlaceholder(e.periodKey) && e.status === 'notified_undated',
      ) ?? null;
    const hasUnpublishedDatedEvent = regular.some(
      (e) => e.status !== 'published' && (e.announceDate !== null || e.status === 'conflict'),
    );
    const latestFilingDate =
      (ctx.filings.get(instrumentId) ?? [])
        .map((f) => f.date)
        .sort()
        .pop() ?? null;
    const noticeSignals = ctx.signalsByInstrument.get(instrumentId) ?? [];
    const pending = selectPendingNotice(noticeSignals, latestFilingDate);
    const result = judgeNoticeUndated({
      noticeSignals,
      latestFilingDate,
      hasUnpublishedDatedEvent,
      everListed,
      hasFiscalProfile: ctx.fiscalProfiles.has(instrumentId),
      capabilities: ctx.capabilities,
      elapsedTradingDays:
        pending === null || hasUnpublishedDatedEvent
          ? null
          : {
              from: pending.noticeDate,
              to: ctx.businessDate,
              count: await ctx.countTradingDays(pending.noticeDate),
            },
      existingStatus: placeholder === null ? null : 'notified_undated',
    });

    const notice = result.pendingNotice;
    if (result.status === 'notified_undated' && placeholder === null && notice !== null) {
      const periodKey = noticeUndatedPeriodKey(notice.noticeDate);
      // 同键已有 (已并入的) 占位事件 ⇒ 这份通知已被接手过：🚫 复活、🚫 重复标红。
      if (events.some((e) => e.periodKey === periodKey)) {
        return {
          written: false,
          result: { ...result, findings: result.findings.filter((f) => !f.countsAsFailure) },
        };
      }
      await this.prisma.$transaction(async (tx) => {
        const { id } = await tx.earningsDateEvent.create({
          data: {
            instrumentId,
            periodKey,
            market: ctx.market,
            status: 'notified_undated',
            // 占位事件的确认日期 = 通知刊发日；🚫 进逐事件合并 (否则被静默算成 confirmed)。
            confirmedDate: toDateOnly(notice.noticeDate),
            confirmedBasis: 'announced',
            sources: [],
          },
          select: { id: true },
        });
        await tx.earningsDateEventLog.createMany({ data: logRows(id, result.logs) });
      });
      return { written: true, result };
    }

    if (result.status === 'superseded' && placeholder !== null) {
      const successor = pickSuccessor(
        regular,
        placeholder.periodKey.slice(NOTICE_UNDATED_PERIOD_KEY_PREFIX.length),
      );
      const logs = result.logs.map((l) => ({
        ...l,
        detail: {
          ...l.detail,
          supersededBy: successor?.id.toString() ?? null,
          supersededByPeriodKey: successor?.periodKey ?? null,
        },
      }));
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.earningsDateEvent.updateMany({
          where: { id: placeholder.id, revision: placeholder.revision },
          data: { status: 'superseded', revision: { increment: 1 } },
        });
        if (count === 0) {
          throw new EarningsDateEventRaceError(eventKey(instrumentId, placeholder.periodKey));
        }
        await tx.earningsDateEventLog.createMany({ data: logRows(placeholder.id, logs) });
      });
      return { written: true, result };
    }
    return { written: false, result };
  }
}
