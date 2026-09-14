import type { PrismaService } from '../security/prisma.service.js';
import type { EarningsCalendarEvent, EarningsCalendarPort } from './earnings-calendar.port.js';
import type {
  EarningsDateCollectRequest,
  EarningsDateCollectResult,
  EarningsDateSource,
  EarningsDateSourceCapabilities,
  EarningsDateSourceName,
  EarningsDateSourceObservation,
} from './earnings-date-source.port.js';
import { resolveFutuPeriod } from './earnings-period.rules.js';
import {
  EARNINGS_FORWARD_HORIZON_DAYS,
  planEarningsWindowsBetween,
} from './sync-earnings-event.usecase.js';

/**
 * 财报日期来源 A：富途财报日历 (079 T010, FR-002 / FR-003 / FR-021 / FR-024, plan §D5)。
 *
 * 经既有 `EARNINGS_CALENDAR_PORT` (专用 client、shim 限频档) 按合规窗取**全市场**事件，映射成
 * `structured` 口径观测。取值只在 {@link toSourceObservations} 一处 —— 美股钩子 (T020) 拿
 * `earnings_event` 那轮已取到的事件复用它，不走 `collect`。
 *
 * ## 能力 (plan §D5)
 *
 * - 港股 = 前向「仅已公告」：EVIDENCE: spec.md 取证 —— 港股往后 364 天只有 54 行、美股同口径
 *   1666 行 (港股只列公司已公告的日期)。历史口径 `structured` 而非 `filed`：`hk:00857` 三次记的是
 *   会议日 (spec.md 取证)。
 * - 美股 = 前向 `unconfirmed` (含预估，🚫 据此升级为确认，FR-021)。
 *
 * ## 窗口
 *
 * 日常 `[业务日 − 7, 业务日 + EARNINGS_FORWARD_HORIZON_DAYS]`，回填起点前移到业务日 − 730。
 * 失败 (含 429 预算耗尽) 直接抛，按来源隔离是合并用例的事 (port 文件头「失败语义」)。
 *
 * 复杂度：O(窗口天数 / 窗宽) 次 HTTP + 2 次读 (标的主表 + 财年档案) + O(事件数) 映射。
 */

export const FUTU_CALENDAR_SOURCE: EarningsDateSourceName = 'futu_calendar';

/** 日常窗口起点前移天数 (刚公布的那几天仍重问一次，改期 / 补录能被看见)。 */
export const FUTU_CALENDAR_DAILY_LOOKBACK_DAYS = 7;

/** 回填窗口起点前移天数 (plan §D9 回填「富途 730 天窗」)。 */
export const FUTU_CALENDAR_BACKFILL_LOOKBACK_DAYS = 730;

export type FutuCalendarMarket = 'hk' | 'us';

const CAPABILITIES: Readonly<Record<FutuCalendarMarket, EarningsDateSourceCapabilities>> = {
  hk: { forward: 'announced_only', confirmationSignal: false, publicationFact: false },
  us: { forward: 'unconfirmed', confirmationSignal: false, publicationFact: false },
};

function isFutuCalendarMarket(market: string): market is FutuCalendarMarket {
  return market === 'hk' || market === 'us';
}

/** `YYYY-MM-DD` 加 n 天 (UTC 日历算术，不涉时区)。 */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 相邻窗共享端点日 ⇒ 同一行会被取到两次；按 `(标的, 财报日)` 去重，后到者覆盖。 */
function dedupeEvents(events: Iterable<EarningsCalendarEvent>): EarningsCalendarEvent[] {
  const unique = new Map<string, EarningsCalendarEvent>();
  for (const event of events) unique.set(`${event.underlyingSymbol} ${event.earningsDate}`, event);
  return [...unique.values()];
}

export interface FutuObservationLookup {
  /** canonical `market:code` → 主表 instrument id。 */
  readonly instrumentIds: ReadonlyMap<string, bigint>;
  /** instrument id → 财年结束月 (财年档案，FR-026)；缺 = 未知 ⇒ 港股 `T:` 键，🚫 代入 12。美股不读。 */
  readonly fiscalYearEndMonths: ReadonlyMap<bigint, number>;
}

export interface FutuObservationMapping {
  readonly observations: EarningsDateSourceObservation[];
  /** 主表查不到而跳过的事件数 (按 `(标的, 财报日)` 去重后计)。 */
  readonly skippedUnknownInstruments: number;
}

/**
 * 富途事件 → 来源观测 (取值单点，零 I/O)。报告期经 `resolveFutuPeriod`：港股有档案 ⇒ `P:`，
 * 无档案 / 美股 ⇒ `T:`，原文缺失 ⇒ `D:`。同一 `(标的, period_key)` 多行 (改期前后同窗) 取最后一行，
 * 与落库唯一键 `(source, instrument_id, period_key)` 一致。
 *
 * 复杂度 O(n)，n = 事件数。
 */
export function toSourceObservations(
  events: readonly EarningsCalendarEvent[],
  market: FutuCalendarMarket,
  lookup: FutuObservationLookup,
): FutuObservationMapping {
  const byKey = new Map<string, EarningsDateSourceObservation>();
  let skippedUnknownInstruments = 0;
  for (const event of dedupeEvents(events)) {
    const instrumentId = lookup.instrumentIds.get(event.underlyingSymbol);
    if (instrumentId === undefined) {
      skippedUnknownInstruments += 1;
      continue;
    }
    const period = resolveFutuPeriod(FUTU_CALENDAR_SOURCE, {
      market,
      periodText: event.periodText,
      earningsDate: event.earningsDate,
      fiscalYearEndMonth: lookup.fiscalYearEndMonths.get(instrumentId) ?? null,
    });
    byKey.set(`${instrumentId} ${period.periodKey}`, {
      instrumentId,
      periodKey: period.periodKey,
      reportKind: period.reportKind,
      periodEnd: period.periodEnd,
      periodText: event.periodText,
      basis: 'structured',
      announceDate: event.earningsDate,
      meetingDate: null,
      publicationTime: event.publicationTime,
      filedDate: null,
      evidence: null,
    });
  }
  return { observations: [...byKey.values()], skippedUnknownInstruments };
}

export class FutuCalendarSource implements EarningsDateSource {
  readonly name = FUTU_CALENDAR_SOURCE;

  constructor(
    private readonly calendar: EarningsCalendarPort,
    private readonly prisma: PrismaService,
  ) {}

  capabilities(market: string): EarningsDateSourceCapabilities | null {
    return isFutuCalendarMarket(market) ? CAPABILITIES[market] : null;
  }

  async collect(request: EarningsDateCollectRequest): Promise<EarningsDateCollectResult> {
    const { market, businessDate, mode } = request;
    if (!isFutuCalendarMarket(market)) {
      throw new Error(`[${FUTU_CALENDAR_SOURCE}] 不支持 market "${market}" (本来源仅 hk / us)`);
    }
    const lookback =
      mode === 'backfill'
        ? FUTU_CALENDAR_BACKFILL_LOOKBACK_DAYS
        : FUTU_CALENDAR_DAILY_LOOKBACK_DAYS;
    const windows = planEarningsWindowsBetween(
      addDays(businessDate, -lookback),
      addDays(businessDate, EARNINGS_FORWARD_HORIZON_DAYS),
    );

    const events: EarningsCalendarEvent[] = [];
    for (const window of windows) {
      // 逐个 push 而非展开：回填窗内全市场行数可达数万，展开进参数表有栈上限风险。
      for (const event of await this.calendar.getWindow({ market, ...window })) events.push(event);
    }

    const mapped = toSourceObservations(
      events,
      market,
      await loadFutuObservationLookup(this.prisma, market),
    );
    return {
      observations: mapped.observations,
      noticeSignals: [],
      skippedUnknownInstruments: mapped.skippedUnknownInstruments,
      forwardRows: dedupeEvents(events).filter((e) => e.earningsDate >= businessDate).length,
    };
  }
}

/**
 * {@link toSourceObservations} 的查找表 (标的主表 + 财年档案)。来源 `collect` 与美股钩子 (T020) 共用,
 * 保证两条路径映射口径同一。复杂度：2 次读。
 */
export async function loadFutuObservationLookup(
  prisma: PrismaService,
  market: FutuCalendarMarket,
): Promise<FutuObservationLookup> {
  const instruments = await prisma.instrument.findMany({
    where: { market },
    select: { id: true, code: true },
  });
  const profiles = await prisma.earningsFiscalProfile.findMany({
    where: { instrument: { market } },
    select: { instrumentId: true, fiscalYearEndMonth: true },
  });
  return {
    instrumentIds: new Map(instruments.map((i) => [`${market}:${i.code}`, i.id])),
    fiscalYearEndMonths: new Map(profiles.map((p) => [p.instrumentId, p.fiscalYearEndMonth])),
  };
}
