import type { PrismaService } from '../security/prisma.service.js';
import type {
  EarningsBoardListStaleness,
  EarningsDateCollectRequest,
  EarningsDateCollectResult,
  EarningsDateSource,
  EarningsDateSourceCapabilities,
  EarningsDateSourceObservation,
} from './earnings-date-source.port.js';
import { datePeriodKey } from './earnings-period.rules.js';
import {
  HKEX_BOARD_MEETING_LIST_SOURCE,
  parseBoardMeetingList,
  type BoardListRow,
} from './hkex-board-meeting-list.rules.js';
import type { TradingCalendarPort } from './trading-calendar.port.js';
import type { VendorHttpClient } from './vendor-http-client.js';

/**
 * 财报日期来源 C：港交所「董事會會議通知」清单 —— 获取 + 陈旧判定 + 主表映射 (079 T012, FR-006 /
 * FR-020a / FR-024 / FR-025, plan §D7)。解析在 `hkex-board-meeting-list.rules.ts` (T003)。
 *
 * ## 🚨 响亮失败：任何取数 / 解析失败一律上抛，🚫 捕获后返回空
 *
 * 空观测在下游读作「今天没有董事会会议」，而实际是改版 / 换地址 / 停服 (FR-025)。本类**零 try/catch**：
 *
 * - 请求带 `redirect: 'manual'` ⇒ 3xx 落进 `VendorHttpError` 永久错 (消息带新地址)，🚫 跟随 ——
 *   跟随后若新地址结构未变，换地址会被静默吞掉；404 同路；网络 / 5xx 由 client 重试后上抛。
 * - 解析失败 ⇒ `BoardListParseError` (带原因与首个不合法行)。
 *
 * 由合并用例 (T013) 按来源隔离、计入运行失败、该来源本轮零写入。
 *
 * ## 陈旧 ≠ 失败
 *
 * 页首日期距业务日 > {@link BOARD_LIST_STALE_TRADING_DAYS} 个交易日 ⇒ `stale: true`，观测**照常产出**
 * (页面停更时旧会议日仍有效)；交易日历不可判 ⇒ `'unknown'` (🚫 当 0，🚫 当陈旧)。怎么告警在 T013。
 *
 * 日常与回填行为相同 —— 清单只有当日页，无历史 (plan §D7)。
 *
 * 复杂度：1 次 HTTP + 解析 O(HTML 长度) + 1 次主表读 + 1 次日历区间计数 + O(行数) 映射。
 */

export const HKEX_BOARD_MEETING_LIST_URL = 'https://www3.hkexnews.hk/reports/bmn/ebmn_c.htm';

/**
 * 页首日期到业务日超过这么多个交易日 ⇒ 陈旧。EVIDENCE: plan §D7「阈值依据」—— 8 份快照页首日期到
 * 抓取时刻的交易日数 0 / 0 / 1 / 1 / 1 / 1 / 2 / 1，唯一的 2 出现在当天页面更新之前。
 */
export const BOARD_LIST_STALE_TRADING_DAYS = 2;

const HKEX_MARKET = 'hk';

const CAPABILITIES: EarningsDateSourceCapabilities = {
  // 清单只列公司已发通知的会议 (FR-011)。
  forward: 'announced_only',
  confirmationSignal: false,
  publicationFact: false,
};

export class HkexBoardMeetingListSource implements EarningsDateSource {
  readonly name = HKEX_BOARD_MEETING_LIST_SOURCE;

  constructor(
    private readonly http: VendorHttpClient,
    private readonly prisma: PrismaService,
    private readonly calendar: TradingCalendarPort,
  ) {}

  capabilities(market: string): EarningsDateSourceCapabilities | null {
    return market === HKEX_MARKET ? CAPABILITIES : null;
  }

  async collect(request: EarningsDateCollectRequest): Promise<EarningsDateCollectResult> {
    const { market, businessDate } = request;
    if (market !== HKEX_MARKET) {
      throw new Error(
        `[${HKEX_BOARD_MEETING_LIST_SOURCE}] 不支持 market "${market}" (本来源仅 hk)`,
      );
    }
    const html = await this.http.requestText({
      url: HKEX_BOARD_MEETING_LIST_URL,
      method: 'GET',
      redirect: 'manual',
    });
    const page = parseBoardMeetingList(html);

    const instrumentIds = await this.loadInstrumentIds(page.rows);
    const evidence = `${HKEX_BOARD_MEETING_LIST_URL} 页首日期=${page.pageDate}`;
    const byKey = new Map<string, EarningsDateSourceObservation>();
    let skippedUnknownInstruments = 0;
    for (const row of page.rows) {
      const instrumentId = instrumentIds.get(row.code);
      if (instrumentId === undefined) {
        skippedUnknownInstruments += 1;
        continue;
      }
      const observation = toObservation(row, instrumentId, evidence);
      const key = `${instrumentId} ${observation.periodKey}`;
      // 同页同标的同期多行 ⇒ 取页面顺序第一行 (唯一键 (source, instrument_id, period_key) 只容一行)。
      if (!byKey.has(key)) byKey.set(key, observation);
    }
    const observations = [...byKey.values()];

    return {
      observations,
      noticeSignals: [],
      skippedUnknownInstruments,
      stale: await this.judgeStaleness(page.pageDate, businessDate),
      listedPeriodKeys: observations.map(({ instrumentId, periodKey }) => ({
        instrumentId,
        periodKey,
      })),
      boardListScan: { pageDate: page.pageDate, counts: page.counts },
    };
  }

  /** 代码 → 主表 id (`hk` + 5 位代码)；查不到的 (人民币柜台 `8xxxx` 等) 不在 Map 里。 */
  private async loadInstrumentIds(rows: readonly BoardListRow[]): Promise<Map<string, bigint>> {
    if (rows.length === 0) return new Map();
    const instruments = await this.prisma.instrument.findMany({
      where: { market: HKEX_MARKET, code: { in: [...new Set(rows.map((r) => r.code))] } },
      select: { id: true, code: true },
    });
    return new Map(instruments.map((i) => [i.code, i.id]));
  }

  /** `(页首日期, 业务日]` 交易日数 > 阈值 ⇒ 陈旧；日历不可判 (null) ⇒ `'unknown'`。 */
  private async judgeStaleness(
    pageDate: string,
    businessDate: string,
  ): Promise<EarningsBoardListStaleness> {
    const tradingDays = await this.calendar.countTradingDays(HKEX_MARKET, pageDate, businessDate);
    return tradingDays === null ? 'unknown' : tradingDays > BOARD_LIST_STALE_TRADING_DAYS;
  }
}

/**
 * 清单业绩行 → `meeting` 口径观测。🚨 期间空白 ⇒ `D:<来源>:<会议日>` 键：同一标的多次空白期间若都落
 * 解析层给的 `T:<来源>:` (原文为空串)，会在唯一键上互相覆盖、只剩最后一次会议。
 */
function toObservation(
  row: BoardListRow,
  instrumentId: bigint,
  evidence: string,
): EarningsDateSourceObservation {
  const blankPeriod = row.periodText.trim() === '';
  return {
    instrumentId,
    periodKey: blankPeriod
      ? datePeriodKey(HKEX_BOARD_MEETING_LIST_SOURCE, row.meetingDate)
      : row.periodKey,
    reportKind: row.reportKind,
    periodEnd: row.periodEnd,
    periodText: blankPeriod ? null : row.periodText,
    basis: 'meeting',
    announceDate: null,
    meetingDate: row.meetingDate,
    publicationTime: null,
    filedDate: null,
    evidence,
  };
}
