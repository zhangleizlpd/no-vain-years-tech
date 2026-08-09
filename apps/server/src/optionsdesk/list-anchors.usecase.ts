import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import {
  classifyZone,
  computeDistanceToWPct,
  computeW,
  computeWillingSellAnchors,
  computeZoneBoundaries,
  parseAnchorTicker,
  type AnchorZone,
  type AnchorZoneBoundaries,
  type LLevel,
  type WillingSellAnchors,
} from './anchor.rules';
import { resolveEffectiveAnchorValues, type AnchorEffectiveValues } from './anchor-cascade';
import { shanghaiDateOnly, type AnchorRow } from './create-anchor.usecase';
import { marketsOfTickers, resolveLastClosedSessions } from './last-closed-session';
import { isAnchorOverdue, isAnchorReviewFlagOn } from './review-anchor.usecase';

/**
 * 045 US1 — 锚列表读端 (FR-001 / FR-004 / FR-005, plan D6)。
 *
 * 🚨 **Guardrail 12 — 锚列表与雷达对 `excluded` 的态度相反**: 雷达默认视图**排除**
 * `excluded = true` (那是读端的基础 WHERE, 归 `get-radar.usecase.ts`); **锚管理列表则必须
 * 显示它并带 `exclude_reason`** (FR-005)。故两者**不共用查询**: 本 usecase 默认**不加**
 * excluded 条件, 只在调用方显式要筛时才加。写成一个共用查询 = 要么雷达漏排除、要么锚列表
 * 看不到被排除的锚, 两种都是静默失败。
 *
 * 本文件同时是**读侧投影的落点** ({@link AnchorView} / {@link toAnchorView}),
 * `get-anchor.usecase.ts` 与 controller 复用 (体例同写侧投影落在 `create-anchor.usecase.ts`)。
 * 生效值一律经 `resolveEffectiveAnchorValues` 解算 —— **不在读侧另拼一套 COALESCE**,
 * 否则读写两处口径迟早分叉 (FR-006 一致性铁律)。
 *
 * **不分页**: 锚表规模上限约 1000 行 (spec Assumptions), 单人自用; 常识性防护由限流桶承担
 * (体例同 `alert/list-alerts.usecase.ts`)。雷达那侧才需游标分页 —— 它按每日变动的距 W%
 * 排序, 翻页期间行情刷新会漏行 (FR-033), 锚列表按 ticker 静态排序没有这个问题。
 */

/** 锚列表筛选 (FR-004 待复审 / FR-005 已排除)。字段省略 = 该维度不筛。 */
export interface ListAnchorsFilter {
  /** `true` = 只看 `next_review` 逾期的锚 (待复审清单)。 */
  pendingReview?: boolean;
  /**
   * `true` = 只看已排除; `false` = 只看未排除; **省略 = 全都要** —— 默认全都要是
   * Guardrail 12 的落点, 别顺手改成默认 `false`。
   */
  excluded?: boolean;
}

/** 读侧投影: 锚行 + 全部同屏派生值 (FR-003a ① 请求时算, 不落库)。 */
export interface AnchorView {
  row: AnchorRow;
  /** 生效值 + 三处人工态标记 + 同屏对照的派生值 (FR-032 ②)。 */
  effective: AnchorEffectiveValues;
  w: Prisma.Decimal;
  zones: AnchorZoneBoundaries;
  willingSell: WillingSellAnchors;
  /** spot 所在区间; 行情不可用 (`last_close` 为空) ⇒ `null`, **不伪造** (FR-017)。 */
  zone: AnchorZone | null;
  distanceToWPct: Prisma.Decimal | null;
  /** FR-004 日历逾期 (`next_review < 今日`) —— 红标 + 待复审清单判据。 */
  overdue: boolean;
  /** EC-10「建锚即逾期」(`next_review < asof`), 与日历逾期是两回事。 */
  overdueAgainstAsof: boolean;
  /** FR-013 复核锚红标 (`spot < W ∧ 最近复审 < 本轮跌破起点`)。 */
  reviewFlagOn: boolean;
  /**
   * 该锚所属市场的「最近一个已收盘交易日」(`YYYY-MM-DD`; 日历查不到 ⇒ `null`) ——
   * FR-020 行情新鲜度档的判据基准, 由调用方经 `resolveLastClosedSessions` 取后传入。
   * 与 `today` 是**两个不同的日期**: `today` 跟用户所在地走 (人工复核节奏),
   * 这个跟**市场**走 (数据的业务日)。
   */
  lastClosedSession: string | null;
}

/**
 * 锚行 → 读侧投影。派生全部走 `anchor.rules` / `anchor-cascade` 单点口径。O(1)。
 *
 * 🚨 `lastClosedSession` **无默认值、必须显式传**（哪怕传 `null`）—— 给它一个默认值等于让
 * 新调用点静默走 fail-open「恒当期」，那正是 FR-020 这条信号最怕的失效形态：不报错、只是
 * 永远不说陈旧。要 fail-open 就在调用点显式写 `null`。
 */
export function toAnchorView(
  row: AnchorRow,
  lastClosedSession: string | null,
  today: Date = shanghaiDateOnly(new Date()),
): AnchorView {
  const effective = resolveEffectiveAnchorValues(
    { v: row.v, confidence: row.confidence },
    {
      vManual: row.vManual,
      lLevelManual: row.lLevelManual as LLevel | null,
      positionCapManual: row.positionCapManual,
    },
  );
  return {
    row,
    effective,
    w: computeW(effective.v),
    zones: computeZoneBoundaries(effective.v),
    willingSell: computeWillingSellAnchors(effective.v),
    zone: row.lastClose === null ? null : classifyZone(effective.v, row.lastClose),
    distanceToWPct: computeDistanceToWPct(effective.v, row.lastClose),
    overdue: isAnchorOverdue(row.nextReview, today),
    overdueAgainstAsof: row.nextReview !== null && row.nextReview.getTime() < row.asof.getTime(),
    reviewFlagOn: isAnchorReviewFlagOn({
      v: effective.v,
      lastClose: row.lastClose,
      lastReviewedOn: row.lastReviewedOn,
      breachStartedOn: row.breachStartedOn,
    }),
    lastClosedSession,
  };
}

@Injectable()
export class ListAnchorsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(filter: ListAnchorsFilter = {}): Promise<AnchorView[]> {
    // 「今天」跟**用户所在地**走 (锚是人工复核节奏, 与市场无关) —— 同一个值同时供
    // SQL 筛选与读侧投影, 避免两处各求各的。
    const today = shanghaiDateOnly(new Date());
    const where: Prisma.AnchorWhereInput = {};
    // 筛选在 SQL 端求值 (FR-034 同口径), MUST NOT 拉全量回来再筛。
    if (filter.pendingReview === true) {
      where.nextReview = { lt: today };
    }
    if (filter.excluded !== undefined) {
      where.excluded = filter.excluded;
    }
    // ticker 升序 + id 兜底 tiebreaker ⇒ 全序且可复现 (同 ticker 唯一, id 仅防御性)。
    const rows = (await this.prisma.anchor.findMany({
      where,
      orderBy: [{ ticker: 'asc' }, { id: 'asc' }],
    })) as AnchorRow[];
    // 逐市场取一次新鲜度基准 (锚表跨市场时 ≤ 3 次单行索引查询), 全页共用。
    const sessions = await resolveLastClosedSessions(
      this.prisma,
      marketsOfTickers(rows.map((r) => r.ticker)),
    );
    return rows.map((row) => toAnchorView(row, sessionOf(sessions, row.ticker), today));
  }
}

/** 锚 ticker → 该市场的新鲜度基准 (市场未登记 / 日历无行 ⇒ `null` ⇒ fail-open 判当期)。 */
export function sessionOf(
  sessions: ReadonlyMap<string, string | null>,
  ticker: string,
): string | null {
  const parsed = parseAnchorTicker(ticker);
  return parsed === null ? null : (sessions.get(parsed.market) ?? null);
}
