import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { exchangeCalendarDate } from '../marketdata/session-clock';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../marketdata/trading-calendar.port';
import type { AnchorManualState } from './anchor-cascade';
import { buildImportFallbackReport } from './anchor-cascade';
import {
  isImportNoop,
  type AnchorSubmissionStatus,
  type ImportableMarket,
} from './anchor-import.rules';
import { parseAnchorTicker, type LLevel } from './anchor.rules';
import {
  asofNeedsAcknowledgement,
  classifyAsof,
  resolveDisposition,
  type AnchorSubmissionAsofFlag,
  type AnchorSubmissionDisposition,
} from './anchor-submission.rules';
import { dateOnlyOf } from './date-only';
import { resolveInstrumentNames } from './instrument-name';

/**
 * 072 待审箱读侧。**把 `ops/bin/anchor-approve.sh plan` 那条 SQL 的判断力搬上线** ——
 * 它一次查询同时答四件事 (disposition / asof 可疑 / 改期建议 / 有没有锚), 因为审阅者
 * 靠这四样做决定。少任何一样, 人就得回去开 psql, 那这条线就白搬了。
 *
 * 🚨 **不分页** (072 定): 全量返回 + 硬上限 {@link ANCHOR_SUBMISSION_LIST_CAP} + `truncated`。
 * 判据同 `list-anchors.usecase.ts` 拒绝分页那条 (单人自用、常识性防护由限流桶承担), 且分页会
 * 引入一个真 bug 类: **采纳第 3 行会让第 2 页在审阅者脚下平移**。日后要加纯属加法。
 */

/** 单次返回上限 —— 常识性防护, 不是分页。命中即 `truncated: true`, 呈现层必须显式说。 */
export const ANCHOR_SUBMISSION_LIST_CAP = 500;

export interface AnchorSubmissionView {
  id: bigint;
  submitter: string;
  ticker: string;
  /** 标的中文名; 未注册 / ticker 不可解析 ⇒ null, 呈现层退回代号 (MUST NOT 拼假名字)。 */
  instrumentName: string | null;
  market: string;
  v: Prisma.Decimal;
  /** `YYYY-MM-DD` —— 🚨 `@db.Date` 列 MUST NOT 走 `.toISOString()` (会带 T00:00:00.000Z)。 */
  asof: string;
  method: string;
  confidence: Prisma.Decimal;
  note: string | null;
  reviewNote: string | null;
  status: AnchorSubmissionStatus;
  consumedAnchorId: bigint | null;
  createdAt: Date;
  updatedAt: Date;
  disposition: AnchorSubmissionDisposition;
  asofFlag: AnchorSubmissionAsofFlag;
  /** 需要改期时的建议日; 日历解不出 ⇒ null (**不猜**, 逐字对齐 shell 的硬停)。 */
  asofSuggested: string | null;
  /** 该档要不要显式确认才放行采纳。 */
  asofNeedsAck: boolean;
}

export interface ListAnchorSubmissionsFilter {
  status?: AnchorSubmissionStatus;
  market?: ImportableMarket;
}

export interface ListAnchorSubmissionsResult {
  items: AnchorSubmissionView[];
  truncated: boolean;
}

/** 采纳既有锚时会被冲掉的人工位现值 —— 详情页的复述闸素材。 */
export interface AnchorSubmissionPreview {
  /** 逐条「哪一项 / 原值 / 回落成什么」。`willBeNoop` 时恒为空数组。 */
  fallbackEntries: ReturnType<typeof buildImportFallbackReport>;
  /**
   * 本次采纳会不会**什么都不写** (四个模型事实全等且来源已是 model)。
   * 🚨 少了它, 一条与现有锚逐值相同的提交会被预览成「将刷新, 并清掉你的 3 处人工位」——
   * 一个什么都不会写的操作配上最吓人的警告, 而那正是训练人闭眼点确认的机制。
   */
  willBeNoop: boolean;
  /** 既有锚的来源; `model` 意味着置信度在 App 里本就改不动。无锚 ⇒ null。 */
  existingConfidenceSource: string | null;
}

type SubmissionRow = {
  id: bigint;
  submitter: string;
  ticker: string;
  v: Prisma.Decimal;
  asof: Date;
  method: string;
  confidence: Prisma.Decimal;
  note: string | null;
  reviewNote: string | null;
  status: string;
  consumedAnchorId: bigint | null;
  createdAt: Date;
  updatedAt: Date;
};

type AnchorFacts = {
  id: bigint;
  ticker: string;
  v: Prisma.Decimal;
  asof: Date;
  method: string;
  confidence: Prisma.Decimal;
  confidenceSource: string;
  vManual: Prisma.Decimal | null;
  lLevelManual: string | null;
  positionCapManual: Prisma.Decimal | null;
};

@Injectable()
export class ListAnchorSubmissionsUseCase {
  constructor(
    private readonly prisma: PrismaService,
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 交易日历读端口 (ADR-0062 的唯一 module 边)。
    // 用途有二: ① 判 asof 那天是不是交易日 (三态); ② 解出改期建议日。零写。
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
  ) {}

  async execute(
    filter: ListAnchorSubmissionsFilter,
    now: Date = new Date(),
  ): Promise<ListAnchorSubmissionsResult> {
    const status = filter.status ?? 'PENDING';
    const rows = (await this.prisma.anchorSubmission.findMany({
      where: {
        status,
        ...(filter.market === undefined ? {} : { ticker: { startsWith: `${filter.market}:` } }),
      },
      orderBy: { id: 'asc' },
      take: ANCHOR_SUBMISSION_LIST_CAP + 1, // 多取一条只为判 truncated, 不返回
    })) as SubmissionRow[];

    const truncated = rows.length > ANCHOR_SUBMISSION_LIST_CAP;
    const page = truncated ? rows.slice(0, ANCHOR_SUBMISSION_LIST_CAP) : rows;
    const items = await this.enrich(page, now);
    return { items, truncated };
  }

  /**
   * 富化。查询次数**与行数无关**: 1 次锚批量 + 1 次标的名批量 + 每个 distinct
   * `(market, asof)` 一次日历三态。
   *
   * ⚠️ 最后那项**不是** O(1) —— 日历判据按 (market, date) 定义, 而本文件 MUST NOT 自己
   * 批量查 `trading_day` 绕过端口 (那正是端口存在的理由: 判据散成两份必漂, 且只让日期悄悄
   * 差一天)。故按 distinct 对去重后并发发出; 待审箱是低频 admin 面, 这个代价买的是判据单点。
   */
  private async enrich(rows: readonly SubmissionRow[], now: Date): Promise<AnchorSubmissionView[]> {
    if (rows.length === 0) return [];
    const tickers = [...new Set(rows.map((r) => r.ticker))];

    const [anchors, names] = await Promise.all([
      this.prisma.anchor.findMany({
        where: { ticker: { in: tickers } },
        select: {
          id: true,
          ticker: true,
          v: true,
          asof: true,
          method: true,
          confidence: true,
          confidenceSource: true,
          vManual: true,
          lLevelManual: true,
          positionCapManual: true,
        },
      }) as Promise<AnchorFacts[]>,
      resolveInstrumentNames(this.prisma, tickers),
    ]);
    const anchorByTicker = new Map(anchors.map((a) => [a.ticker, a]));

    const flags = await this.classifyAsofFor(rows, now);

    return rows.map((row) => {
      const market = parseAnchorTicker(row.ticker)?.market ?? '';
      const asof = dateOnlyOf(row.asof);
      // 解不出 market 的行拿不到判定 —— 退 UNKNOWN 而非 OK (不可判定永远落在需确认侧)。
      const flag = flags.get(`${market}|${asof}`) ?? { flag: 'UNKNOWN' as const, suggested: null };
      return {
        id: row.id,
        submitter: row.submitter,
        ticker: row.ticker,
        instrumentName: names.get(row.ticker) ?? null,
        market,
        v: row.v,
        asof,
        method: row.method,
        confidence: row.confidence,
        note: row.note,
        reviewNote: row.reviewNote,
        status: row.status as AnchorSubmissionStatus,
        consumedAnchorId: row.consumedAnchorId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        disposition: resolveDisposition(anchorByTicker.has(row.ticker)),
        asofFlag: flag.flag,
        asofSuggested: flag.suggested,
        asofNeedsAck: asofNeedsAcknowledgement(flag.flag),
      };
    });
  }

  /** 按 distinct `(market, asof)` 求三态 + 改期建议;返回 key = `market|asof`。 */
  private async classifyAsofFor(
    rows: readonly SubmissionRow[],
    now: Date,
  ): Promise<Map<string, { flag: AnchorSubmissionAsofFlag; suggested: string | null }>> {
    const pairs = new Map<string, { market: string; asof: string }>();
    for (const row of rows) {
      const market = parseAnchorTicker(row.ticker)?.market;
      if (market === undefined) continue;
      const asof = dateOnlyOf(row.asof);
      pairs.set(`${market}|${asof}`, { market, asof });
    }

    const resolved = await Promise.all(
      [...pairs].map(async ([key, { market, asof }]) => {
        const calendarStatus = await this.calendar.classify(market, asof);
        const flag = classifyAsof({
          asof,
          exchangeToday: exchangeCalendarDate(market, now),
          calendarStatus,
        });
        // 只有要改期的档才去解建议日 —— OK / TODAY 去解等于白打两次查询。
        const suggested = asofNeedsAcknowledgement(flag)
          ? await this.calendar.previousTradingDay(market, asof)
          : null;
        return [key, { flag, suggested }] as const;
      }),
    );
    return new Map(resolved);
  }

  /**
   * 单条详情 = 同一份富化 + 采纳前预览。不存在 ⇒ null (由 controller 折 404)。
   *
   * 📌 复用 {@link enrich} 而不是另写一条查询: 列表与详情给出**不同的** disposition / asofFlag
   * 是最难发现的一类不一致 —— 人在列表上看到 create、点进去看到 refresh, 而两处都「没报错」。
   */
  async getDetail(
    id: bigint,
    now: Date = new Date(),
  ): Promise<{ view: AnchorSubmissionView; preview: AnchorSubmissionPreview } | null> {
    const row = (await this.prisma.anchorSubmission.findUnique({
      where: { id },
    })) as SubmissionRow | null;
    if (row === null) return null;

    const [view] = await this.enrich([row], now);
    if (view === undefined) return null;

    const anchor = (await this.prisma.anchor.findUnique({
      where: { ticker: row.ticker },
      select: {
        id: true,
        ticker: true,
        v: true,
        asof: true,
        method: true,
        confidence: true,
        confidenceSource: true,
        vManual: true,
        lLevelManual: true,
        positionCapManual: true,
      },
    })) as AnchorFacts | null;

    return { view, preview: this.buildPreview(view, anchor) };
  }

  /** 详情页的采纳前预览 —— 与真实写入路径共用同一个纯函数, 不可能漂。 */
  buildPreview(view: AnchorSubmissionView, anchor: AnchorFacts | null): AnchorSubmissionPreview {
    if (anchor === null) {
      return { fallbackEntries: [], willBeNoop: false, existingConfidenceSource: null };
    }
    const willBeNoop = isImportNoop(anchor, {
      v: view.v,
      asof: new Date(`${view.asof}T00:00:00Z`),
      method: view.method,
      confidence: view.confidence,
    });
    const manual: AnchorManualState = {
      vManual: anchor.vManual,
      lLevelManual: anchor.lLevelManual as LLevel | null,
      positionCapManual: anchor.positionCapManual,
    };
    return {
      fallbackEntries: willBeNoop
        ? []
        : buildImportFallbackReport([
            { ticker: view.ticker, manual, next: { v: view.v, confidence: view.confidence } },
          ]),
      willBeNoop,
      existingConfidenceSource: anchor.confidenceSource,
    };
  }
}
