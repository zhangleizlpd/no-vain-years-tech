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
 * ## 读取：两窗并集只扫一遍，按日期分片
 *
 * 两个窗口终点都是业务日 ⇒ 并集 = 较早起点起的那一窗，**只扫一遍**，同一批行按各自窗口起点喂两个
 * 分类。按 {@link ANNOUNCEMENT_LOAD_CHUNK_DAYS} 天分片读 (相邻片首尾相接、不重叠不留缝)，每片读完
 * 立即分类、只留命中的行 (刊发候选 / 通知信号；lookalike 只计数)，片结果随即释放。
 * 为什么分片：回填 730 天窗整窗一次载入 prod 实测 306,615 行，而回填跑在 app 进程自己的 worker 里。
 * 片按日期升序、片内 `date asc, id asc` ⇒ 拼接顺序与整窗一次读取逐行相同，「同一期取最早刊发」不变。
 *
 * ## 主表外代码
 *
 * `announcement.instrument_id` 外键指向标的主表 ⇒ 读出的每一行都在主表内，`skippedUnknownInstruments`
 * **结构上恒 0** (主表外代码在理杏仁公告采集侧就取不到行)，不是漏计。
 *
 * 复杂度：⌈并集窗天数 / 片宽⌉ 次公告读 + 1 次财年档案读 + O(行数) 分类 (每行常数条正则)；
 * 驻留内存 O(单片行数 + 命中行数)。
 */

export const HKEX_ANNOUNCEMENT_SOURCE: EarningsDateSourceName = 'hkex_announcement';

const HKEX_MARKET = 'hk';

/** 刊发事实日常回看天数 (plan §D6：与现役公告维度 7 天回看一致)。 */
export const PUBLICATION_FACT_DAILY_LOOKBACK_DAYS = 7;

/** 回填回看天数 (plan §D9「交易所两年业绩刊发事实与会前通知信号」)。 */
export const HKEX_ANNOUNCEMENT_BACKFILL_LOOKBACK_DAYS = 730;

/** 公告按日期分片读取的片宽 (天，含端点)。回填 731 天窗 ⇒ 25 片；日常 121 天信号窗 ⇒ 5 片。 */
export const ANNOUNCEMENT_LOAD_CHUNK_DAYS = 30;

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

  /** @param loadChunkDays 分片片宽，仅测试注入 (对照整窗一次读取)；须为正整数。 */
  constructor(
    private readonly prisma: PrismaService,
    private readonly loadChunkDays: number = ANNOUNCEMENT_LOAD_CHUNK_DAYS,
  ) {
    if (!Number.isInteger(loadChunkDays) || loadChunkDays < 1) {
      throw new Error(
        `[${HKEX_ANNOUNCEMENT_SOURCE}] loadChunkDays 须为正整数，收到 ${loadChunkDays}`,
      );
    }
  }

  capabilities(market: string): EarningsDateSourceCapabilities | null {
    return market === HKEX_MARKET ? CAPABILITIES : null;
  }

  async collect(request: EarningsDateCollectRequest): Promise<EarningsDateCollectResult> {
    const { market, businessDate, mode } = request;
    if (market !== HKEX_MARKET) {
      throw new Error(`[${HKEX_ANNOUNCEMENT_SOURCE}] 不支持 market "${market}" (本来源仅 hk)`);
    }
    const backfill = mode === 'backfill';
    const factFrom = addDays(
      businessDate,
      -(backfill ? HKEX_ANNOUNCEMENT_BACKFILL_LOOKBACK_DAYS : PUBLICATION_FACT_DAILY_LOOKBACK_DAYS),
    );
    const signalFrom = addDays(
      businessDate,
      -(backfill ? HKEX_ANNOUNCEMENT_BACKFILL_LOOKBACK_DAYS : NOTICE_MATCH_WINDOW_DAYS),
    );

    const publications: AnnouncementRow[] = [];
    const noticeSignals: EarningsNoticeSignal[] = [];
    let lookalikeNoticeTitles = 0;
    // `YYYY-MM-DD` 字典序 = 日历序。
    let chunkFrom = factFrom < signalFrom ? factFrom : signalFrom;
    while (chunkFrom <= businessDate) {
      const chunkEnd = addDays(chunkFrom, this.loadChunkDays - 1);
      const chunkTo = chunkEnd < businessDate ? chunkEnd : businessDate;
      const rows = await this.loadAnnouncements(chunkFrom, chunkTo);
      const signalRows: AnnouncementRow[] = [];
      for (const row of rows) {
        const date = isoDate(row.date);
        if (date >= factFrom && isResultsPublication(row.linkText ?? '', row.types)) {
          publications.push(row);
        }
        if (date >= signalFrom) signalRows.push(row);
      }
      const signals = toNoticeSignals(signalRows);
      for (const signal of signals.noticeSignals) noticeSignals.push(signal);
      lookalikeNoticeTitles += signals.lookalikeNoticeTitles;
      chunkFrom = addDays(chunkTo, 1);
    }

    const facts = await this.toPublicationFacts(publications);
    return {
      observations: facts.observations,
      noticeSignals,
      skippedUnknownInstruments: 0,
      unalignedPublications: facts.unalignedPublications,
      lookalikeNoticeTitles,
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
   *
   * 入参 = 已按 `isResultsPublication` 筛过、按 `date asc, id asc` 排好的刊发行。
   */
  private async toPublicationFacts(publications: readonly AnnouncementRow[]): Promise<{
    observations: EarningsDateSourceObservation[];
    unalignedPublications: number;
  }> {
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
