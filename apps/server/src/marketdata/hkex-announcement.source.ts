import type { PrismaService } from '../security/prisma.service.js';
import type {
  EarningsDateCollectRequest,
  EarningsDateCollectResult,
  EarningsDateSource,
  EarningsDateSourceCapabilities,
  EarningsDateSourceName,
  EarningsDateSourceObservation,
  EarningsNoticeSignal,
} from './earnings-date-source.port.js';
import { NOTICE_MATCH_WINDOW_DAYS } from './earnings-date-merge.rules.js';
import { classifyNoticeTitle, isResultsPublication } from './earnings-notice.rules.js';
import {
  alignedPeriodKey,
  datePeriodKey,
  resolveAnnouncementPeriod,
} from './earnings-period.rules.js';

/**
 * 财报日期来源 B：交易所公告 (079 T011, FR-004 / FR-005 / FR-020 / FR-024, plan §D6)。**零 PDF、
 * 零新增理杏仁调用**：只读本 ctx 已落库的 `marketdata.announcement` (标题 + `types`)，分类判据全在
 * `earnings-notice.rules.ts`，报告期换算全在 `earnings-period.rules.ts`。
 *
 * 两类产出，**窗口各自独立**：
 *
 * 1. **刊发事实** (`filed` 观测，全部港股)：日常 `[业务日 − 7, 业务日]` (与现役公告 7 天回看一致)。
 *    公布日 = 公告日期 —— `announcement.date` 落库时已是 `+08:00` 当地日期
 *    (`lixinger-announcement.adapter.ts` 文件头：`date` 为 `+08:00`，slice 取日期)。
 * 2. 🚨 **会前通知信号**：**单独**按 `[业务日 − NOTICE_MATCH_WINDOW_DAYS, 业务日]` 现算
 *    (排序铁律 4 / analyze I1)。只按 7 天现算时，事件重算找不到 8–120 天前的通知，确认日期静默
 *    退回首次观测且不报错。窗口常量与合并规则 (T004) 共用，🚫 另写 120。
 *
 * 回填两类都取 730 天。失败直接抛 (port 文件头「失败语义」)。
 *
 * ## 主表外代码
 *
 * `announcement.instrument_id` 外键指向标的主表 ⇒ 读出的每一行都在主表内，`skippedUnknownInstruments`
 * **结构上恒 0** (主表外代码在理杏仁公告采集侧就取不到行)，不是漏计。
 *
 * 复杂度：3 次读 (刊发窗 / 信号窗公告 + 财年档案) + O(行数) 分类 (每行常数条正则)。
 */

export const HKEX_ANNOUNCEMENT_SOURCE: EarningsDateSourceName = 'hkex_announcement';

const HKEX_MARKET = 'hk';

/** 刊发事实日常回看天数 (plan §D6：与现役公告维度 7 天回看一致)。 */
export const PUBLICATION_FACT_DAILY_LOOKBACK_DAYS = 7;

/** 回填回看天数 (plan §D9「交易所两年业绩刊发事实与会前通知信号」)。 */
export const HKEX_ANNOUNCEMENT_BACKFILL_LOOKBACK_DAYS = 730;

/** `earnings_date_observation.period_text` 列宽 (`VarChar(128)`)。 */
const PERIOD_TEXT_MAX_CHARS = 128;

const CAPABILITIES: EarningsDateSourceCapabilities = {
  forward: null,
  confirmationSignal: true,
  publicationFact: true,
};

/** `YYYY-MM-DD` 加 n 天 (UTC 日历算术，不涉时区)。 */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** `@db.Date` 列 (UTC 零点) → `YYYY-MM-DD`。 */
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

interface AnnouncementRow {
  readonly instrumentId: bigint;
  readonly date: Date;
  readonly linkUrl: string;
  readonly linkText: string | null;
  readonly types: string[];
}

export class HkexAnnouncementSource implements EarningsDateSource {
  readonly name = HKEX_ANNOUNCEMENT_SOURCE;

  constructor(private readonly prisma: PrismaService) {}

  capabilities(market: string): EarningsDateSourceCapabilities | null {
    return market === HKEX_MARKET ? CAPABILITIES : null;
  }

  async collect(request: EarningsDateCollectRequest): Promise<EarningsDateCollectResult> {
    const { market, businessDate, mode } = request;
    if (market !== HKEX_MARKET) {
      throw new Error(`[${HKEX_ANNOUNCEMENT_SOURCE}] 不支持 market "${market}" (本来源仅 hk)`);
    }
    const backfill = mode === 'backfill';
    const factRows = await this.loadAnnouncements(
      addDays(
        businessDate,
        -(backfill
          ? HKEX_ANNOUNCEMENT_BACKFILL_LOOKBACK_DAYS
          : PUBLICATION_FACT_DAILY_LOOKBACK_DAYS),
      ),
      businessDate,
    );
    const signalRows = await this.loadAnnouncements(
      addDays(
        businessDate,
        -(backfill ? HKEX_ANNOUNCEMENT_BACKFILL_LOOKBACK_DAYS : NOTICE_MATCH_WINDOW_DAYS),
      ),
      businessDate,
    );

    const facts = await this.toPublicationFacts(factRows);
    const signals = toNoticeSignals(signalRows);
    return {
      observations: facts.observations,
      noticeSignals: signals.noticeSignals,
      skippedUnknownInstruments: 0,
      unalignedPublications: facts.unalignedPublications,
      lookalikeNoticeTitles: signals.lookalikeNoticeTitles,
    };
  }

  /** 港股公告 `[from, to]` (含端点)，按日期升序 —— 同一期多次刊发时取最早的那次 (见下)。 */
  private loadAnnouncements(from: string, to: string): Promise<AnnouncementRow[]> {
    return this.prisma.announcement.findMany({
      where: {
        date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
        instrument: { market: HKEX_MARKET },
      },
      select: { instrumentId: true, date: true, linkUrl: true, linkText: true, types: true },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * 业绩刊发事实 → `filed` 观测。标题带期末日 ⇒ `P:`；不带时按财年档案与刊发时限换算，无档案 /
   * 超时限 ⇒ `D:<来源>:<公告日>` 并计数 (FR-027，🚫 代入 12 月)。
   *
   * 同一 `(标的, period_key)` 多份刊发 (本体 + 補充) 只留**最早**一份：公布日是第一次刊发那天，
   * 补充公告晚几天再出，覆盖进来会把公布日静默推后。
   */
  private async toPublicationFacts(rows: readonly AnnouncementRow[]): Promise<{
    observations: EarningsDateSourceObservation[];
    unalignedPublications: number;
  }> {
    const publications = rows.filter((r) => isResultsPublication(r.linkText ?? '', r.types));
    const fiscalYearEndMonths = await this.loadFiscalYearEndMonths(publications);
    const byKey = new Map<string, EarningsDateSourceObservation>();
    let unalignedPublications = 0;

    for (const row of publications) {
      const title = row.linkText ?? '';
      const announceDate = isoDate(row.date);
      const period = resolveAnnouncementPeriod(title, {
        announceDate,
        fiscalYearEndMonth: fiscalYearEndMonths.get(row.instrumentId) ?? null,
      });
      const periodKey =
        period === null
          ? datePeriodKey(HKEX_ANNOUNCEMENT_SOURCE, announceDate)
          : alignedPeriodKey(period.periodEnd);
      const key = `${row.instrumentId} ${periodKey}`;
      if (byKey.has(key)) continue;
      if (period === null) unalignedPublications += 1;
      byKey.set(key, {
        instrumentId: row.instrumentId,
        periodKey,
        reportKind: period?.reportKind ?? null,
        periodEnd: period?.periodEnd ?? null,
        // 报告期原文嵌在标题里，原样存标题 (列宽截断)。
        periodText: title === '' ? null : title.slice(0, PERIOD_TEXT_MAX_CHARS),
        basis: 'filed',
        announceDate,
        meetingDate: null,
        publicationTime: null,
        filedDate: announceDate,
        evidence: row.linkUrl,
      });
    }
    return { observations: [...byKey.values()], unalignedPublications };
  }

  private async loadFiscalYearEndMonths(
    rows: readonly AnnouncementRow[],
  ): Promise<Map<bigint, number>> {
    if (rows.length === 0) return new Map();
    const profiles = await this.prisma.earningsFiscalProfile.findMany({
      where: { instrumentId: { in: [...new Set(rows.map((r) => r.instrumentId))] } },
      select: { instrumentId: true, fiscalYearEndMonth: true },
    });
    return new Map(profiles.map((p) => [p.instrumentId, p.fiscalYearEndMonth]));
  }
}

/** 会前通知信号 (标题识别，不落表)；「长得像通知」只计数 (`state_branches` 12)。O(行数)。 */
function toNoticeSignals(rows: readonly AnnouncementRow[]): {
  noticeSignals: EarningsNoticeSignal[];
  lookalikeNoticeTitles: number;
} {
  const noticeSignals: EarningsNoticeSignal[] = [];
  let lookalikeNoticeTitles = 0;
  for (const row of rows) {
    const title = row.linkText ?? '';
    const titleClass = classifyNoticeTitle(title, row.types);
    if (titleClass === 'notice') {
      noticeSignals.push({
        instrumentId: row.instrumentId,
        noticeDate: isoDate(row.date),
        title,
        link: row.linkUrl,
      });
    } else if (titleClass === 'lookalike') {
      lookalikeNoticeTitles += 1;
    }
  }
  return { noticeSignals, lookalikeNoticeTitles };
}
