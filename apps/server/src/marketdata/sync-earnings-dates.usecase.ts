import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../security/prisma.service.js';
import { EarningsCalendarBudgetExhaustedError } from './earnings-calendar.port.js';
import {
  EARNINGS_DATE_SOURCES,
  type AssembledEarningsDateSource,
  type EarningsDateCollectMode,
  type EarningsDateCollectResult,
  type EarningsDateSourceCapabilities,
  type EarningsDateSourceName,
  type EarningsDateSourceObservation,
} from './earnings-date-source.port.js';
import { exchangeCalendarDate } from './session-clock.js';
import { addWritten, type SyncRunStats } from './sync-run.recorder.js';

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
 */

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

@Injectable()
export class SyncEarningsDatesUseCase {
  private readonly logger = new Logger(SyncEarningsDatesUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EARNINGS_DATE_SOURCES) private readonly sources: readonly AssembledEarningsDateSource[],
  ) {}

  /**
   * 港股日常入口。复杂度见 {@link collect} + {@link recordObservations}。
   */
  async runHk(
    stats: SyncRunStats,
    request: EarningsDatesRunRequest,
  ): Promise<EarningsDatesCollectOutcome> {
    // #138: 声明写路径 —— 零观测的一轮报 0 而非 null (见 addWritten 注释)。
    addWritten(stats, 0);
    const outcome = await this.collect(HK_EARNINGS_DATE_MARKET, stats, request);
    for (const { name, result } of outcome.collected) {
      await this.recordObservations(name, outcome.market, result.observations, request.now, stats);
    }
    return outcome;
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
}
