import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import {
  loadAnchoredInstruments,
  subtractDays,
  type WorkingInstrument,
} from './dimension-executor.js';
import type { EarningsDateSourceName } from './earnings-date-source.port.js';
import {
  findFiscalProfileTitleConflict,
  isFiscalProfilePending,
  resolveFiscalProfile,
  type FiscalProfileAnnouncement,
  type FiscalProfileSource,
} from './earnings-fiscal-profile.rules.js';
import { HKEX_BOARD_MEETING_LIST_SOURCE } from './hkex-board-meeting-list.rules.js';
import { exchangeCalendarDate } from './session-clock.js';

/** 反推读取的公告回看天数 (plan §D13「近 2 年」)。 */
export const FISCAL_PROFILE_LOOKBACK_DAYS = 730;

/** 财年档案只对港股建 (FR-028：首批只有港股具备刊发事实来源)。 */
export const FISCAL_PROFILE_MARKET = 'hk';

const FUTU_CALENDAR_SOURCE: EarningsDateSourceName = 'futu_calendar';

export type FiscalProfileSyncOutcome =
  | { readonly kind: 'written'; readonly month: number; readonly source: FiscalProfileSource }
  | { readonly kind: 'unchanged'; readonly month: number }
  | { readonly kind: 'pending'; readonly pending: 'none' | 'conflict'; readonly detail: string }
  | { readonly kind: 'conflict'; readonly profileMonth: number; readonly detail: string };

export interface FiscalProfilePendingItem {
  readonly ticker: string;
  readonly pending: 'none' | 'conflict';
  readonly detail: string;
}

export interface FiscalProfileConflictItem {
  readonly ticker: string;
  readonly detail: string;
}

/** 批量反推结果 —— T014 / T015 据此写 `earnings_fiscal_profile_pending` / `_conflict` findings。 */
export interface FiscalProfileBatchResult {
  readonly written: number;
  readonly pending: readonly FiscalProfilePendingItem[];
  readonly conflicts: readonly FiscalProfileConflictItem[];
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * 财年档案用例 (079 T029, FR-026 / FR-028 / plan §D13)。ADR-0043 扁平贫血：直注 `PrismaService`，
 * 判据全在 `earnings-fiscal-profile.rules.ts`，本类只做读写编排。
 *
 * - **无档案**：读近 2 年公告 + 清单 / 富途观测 → 各路一致 ⇒ 写入；矛盾 / 推不出 ⇒ `pending`，🚫 写。
 * - **有档案**：只核对最近一期年度业绩标题的显式期末月，矛盾 ⇒ `conflict`，🚫 覆盖
 *   (公司可能改财年，交维护者人工裁决)。
 *
 * 调用方：① `AnchorColdStartUseCase` 建港股锚时 (失败只 warn)；② 每日 `hk_earnings_date` 运行起手
 * {@link SyncEarningsFiscalProfileUseCase.syncHkAnchors} (T014)。人工补录走 `marketdata-fiscal-profile.cli.ts`，不经本类。
 *
 * 复杂度：单标的 ≤ 3 次读 + ≤ 1 次写 (规则 O(a·f))；批量 = 1 次锚读 + 1 次标的读 + N × 单标的。
 */
@Injectable()
export class SyncEarningsFiscalProfileUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async syncInstrument(
    instrument: WorkingInstrument,
    now: Date,
  ): Promise<FiscalProfileSyncOutcome> {
    const existing = await this.prisma.earningsFiscalProfile.findUnique({
      where: { instrumentId: instrument.id },
      select: { fiscalYearEndMonth: true },
    });
    const announcements = await this.loadAnnouncements(instrument, now);
    if (existing !== null) {
      const conflict = findFiscalProfileTitleConflict(existing.fiscalYearEndMonth, announcements);
      return conflict === null
        ? { kind: 'unchanged', month: existing.fiscalYearEndMonth }
        : { kind: 'conflict', profileMonth: existing.fiscalYearEndMonth, detail: conflict.detail };
    }

    const observations = await this.prisma.earningsDateObservation.findMany({
      where: {
        instrumentId: instrument.id,
        source: { in: [HKEX_BOARD_MEETING_LIST_SOURCE, FUTU_CALENDAR_SOURCE] },
      },
      select: {
        source: true,
        periodText: true,
        periodEnd: true,
        announceDate: true,
        evidence: true,
      },
    });
    const resolution = resolveFiscalProfile({
      announcements,
      boardListRows: observations
        .filter((o) => o.source === HKEX_BOARD_MEETING_LIST_SOURCE)
        .map((o) => ({
          periodText: o.periodText,
          periodEnd: o.periodEnd === null ? null : isoDate(o.periodEnd),
          evidence: o.evidence,
        })),
      futuObservations: observations.flatMap((o) =>
        o.source === FUTU_CALENDAR_SOURCE && o.announceDate !== null
          ? [{ periodText: o.periodText, earningsDate: isoDate(o.announceDate) }]
          : [],
      ),
    });
    if (isFiscalProfilePending(resolution)) {
      return { kind: 'pending', pending: resolution.pending, detail: resolution.detail };
    }

    // skipDuplicates: 与人工补录 CLI 并发时先写者胜 (唯一键 instrument_id)，🚫 覆盖人工值。
    const { count } = await this.prisma.earningsFiscalProfile.createMany({
      data: [
        {
          instrumentId: instrument.id,
          fiscalYearEndMonth: resolution.month,
          source: resolution.source,
          evidence: resolution.evidence,
          determinedAt: now,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) return { kind: 'written', month: resolution.month, source: resolution.source };
    const raced = await this.prisma.earningsFiscalProfile.findUnique({
      where: { instrumentId: instrument.id },
      select: { fiscalYearEndMonth: true },
    });
    return { kind: 'unchanged', month: raced?.fiscalYearEndMonth ?? resolution.month };
  }

  /**
   * 为全部港股锚反推 / 核对财年档案 (plan §D13 ②)。锚集合走 {@link loadAnchoredInstruments}
   * (marketdata 既有的只读锚口径，不新开跨 ctx 读)。单标的异常上抛，由调用方隔离。
   */
  async syncHkAnchors(now: Date): Promise<FiscalProfileBatchResult> {
    const instruments = await loadAnchoredInstruments(this.prisma, [FISCAL_PROFILE_MARKET]);
    let written = 0;
    const pending: FiscalProfilePendingItem[] = [];
    const conflicts: FiscalProfileConflictItem[] = [];
    for (const instrument of instruments) {
      const ticker = `${instrument.market}:${instrument.code}`;
      const outcome = await this.syncInstrument(instrument, now);
      if (outcome.kind === 'written') written++;
      else if (outcome.kind === 'pending') {
        pending.push({ ticker, pending: outcome.pending, detail: outcome.detail });
      } else if (outcome.kind === 'conflict') conflicts.push({ ticker, detail: outcome.detail });
    }
    return { written, pending, conflicts };
  }

  /** 近 2 年公告，按交易所当地的今天起算 (`announcement.date` 是交易所当地日期)。 */
  private async loadAnnouncements(
    instrument: WorkingInstrument,
    now: Date,
  ): Promise<FiscalProfileAnnouncement[]> {
    const from = subtractDays(
      exchangeCalendarDate(instrument.market, now),
      FISCAL_PROFILE_LOOKBACK_DAYS,
    );
    const rows = await this.prisma.announcement.findMany({
      where: { instrumentId: instrument.id, date: { gte: new Date(`${from}T00:00:00Z`) } },
      select: { date: true, linkText: true, linkUrl: true, types: true },
      orderBy: { date: 'asc' },
    });
    return rows.flatMap((r) =>
      r.linkText === null
        ? []
        : [{ date: isoDate(r.date), title: r.linkText, types: r.types, link: r.linkUrl }],
    );
  }
}
