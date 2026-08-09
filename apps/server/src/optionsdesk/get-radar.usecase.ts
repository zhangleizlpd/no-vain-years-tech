import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { W_COEFFICIENT, isBelowW, type LLevel } from './anchor.rules';
import { resolveEffectiveAnchorValues } from './anchor-cascade';
import { shanghaiDateOnly, toUtcDateOnly, type AnchorRow } from './create-anchor.usecase';
import { sessionOf, toAnchorView, type AnchorView } from './list-anchors.usecase';
import { marketsOfTickers, resolveLastClosedSessions } from './last-closed-session';
import {
  decodeRadarCursor,
  encodeRadarCursor,
  normalizeRadarLimit,
  radarKeysetPredicate,
  type RadarCursor,
} from './radar-cursor';

/**
 * 045 US2 — 击球区雷达读端 (FR-010 / FR-013 / FR-015 / FR-033 / FR-034, plan D8/D14a)。
 *
 * 三件事一起做, 顺序不可换:
 * 1. **复核锚状态机推进** ({@link resolveBreachTransition}) —— 只在**首页**(无游标) 跑一次;
 * 2. **SQL 端**排序 + 筛选 + keyset 取一页键 (`$queryRaw`, 排序键是跨列表达式, Prisma 查询
 *    API 表达不了);
 * 3. 按键序水合整行并投影成 {@link AnchorView} (与锚列表**同一个** `toAnchorView`, 派生口径
 *    单点)。
 *
 * 🚨 **Guardrail 12 — 与锚列表对 `excluded` 的态度相反**: 雷达基础 `WHERE` **排除**
 * `excluded = true` (这是基础条件、**不是**筛选项); 锚管理列表则必须显示它并带
 * `exclude_reason` (FR-005)。两者 MUST NOT 合成一个共用查询。
 *
 * 🚨 **FR-008**: 某档 L 层 (一期是 L1) 无任何锚落入**不是校验错误** —— 本文件不加「L1 必须有
 * 票」这类校验, 也不因某档无数据而隐藏该筛选项 (空数组筛选 = 不筛)。
 *
 * 并发: 状态机是单行状态转换 ⇒ conditional `updateMany` + affected-count (READ COMMITTED),
 * `count === 0` = 同一瞬间已被别的请求推进过, 直接放过 (下次读自然收敛)。**禁** `FOR UPDATE`
 * / Serializable。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 复核锚状态机 (FR-013) —— 纯函数
// ─────────────────────────────────────────────────────────────────────────────

export interface BreachTransitionInput {
  /** **生效** V (调用方经 `resolveEffectiveAnchorValues` 解算, 与红标判据同口径)。 */
  v: Prisma.Decimal | string;
  /** spot = `last_close` 投影; `null` = 行情不可用 (FR-017)。 */
  lastClose: Prisma.Decimal | null;
  /** 行情 session 日 —— 本轮起点的候选观测日 (EC-14 同口径, **不取本地日期**)。 */
  lastCloseDate: Date | null;
  /** 建锚日 —— 起点不早于它 (锚存在之前我们不可能观测到跌破)。 */
  createdAt: Date;
  /** 当前本轮跌破首次观测日; `null` = 不在跌破轮次内。 */
  breachStartedOn: Date | null;
}

export interface BreachTransition {
  /** 转移后的本轮起点。 */
  next: Date | null;
  /** 是否需要落库 (`false` ⇒ 不产生 UPDATE)。 */
  changed: boolean;
}

/**
 * 🚨 **复核锚红标是个状态机, 不是一次比较** (FR-013 / plan D14a-3)。四条转移:
 *
 * 1. **spot 由上穿下 ∧ 本轮起点为空** → 写入本轮起点 = **观测日**
 *    (`last_close_date`, 即数据自身 session 日); 本轮进行中则**不推进** (起点是本轮的身份,
 *    推进会让「最近复审 < 起点」永远成立 ⇒ 复审白做)。
 * 2. **spot 回到 W 上方** → **清空**起点; 其后再次跌破按**新一轮**重新触发 (EC-13,
 *    同一交易日内反复穿越亦然 —— 本函数无「本轮已复审过」这类抑制位, 新一轮永远能重新亮)。
 * 3. **建锚时 spot 已在 W 之下** → 起点 = **建锚当日**: 取 `max(观测日, 建锚日)`。bar 可能比
 *    锚还老 (刚建的锚配着昨天的收盘), 那时把起点倒推到 bar 日会让红标在建锚瞬间就亮 ——
 *    而建锚本身就是一次确认 (`last_reviewed_on` 建锚当日已回填)。
 * 4. **行情不可用期间** (`last_close === null`) → **既不推进也不清空**, 红标维持上一次可判定
 *    状态 (由 `isAnchorReviewFlagOn` 用非空起点代替 spot 判定), 与「行情不可用」标记一同呈现。
 *
 * **EC-11 边界**: 「跌破」判据取 {@link isBelowW} (`spot < W`, 恰好等于**不算**跌破),
 * 与 `classifyZone` 的「下界闭上界开」同一侧 —— 两处共用 rules 单点定义, 不各写各的。
 *
 * ⚠️ 日粒度纪律: 起点与 `last_reviewed_on` 都是 `@db.Date`。同一天内「复审 → 再跌破」按判据
 * (`最近复审 < 起点`) 视为已确认, 与 T009「同日复审即解除」是**同一条**日粒度纪律, 不是遗漏。
 *
 * O(1), 无 I/O。
 */
export function resolveBreachTransition(input: BreachTransitionInput): BreachTransition {
  if (input.lastClose === null) {
    // ④ 行情不可用: 既不推进也不清空 (清空 = 行情一断红标全灭)。
    return { next: input.breachStartedOn, changed: false };
  }
  if (!isBelowW(input.v, input.lastClose)) {
    // ② 回到 W 上方 (含恰好 = W, EC-11)。
    return { next: null, changed: input.breachStartedOn !== null };
  }
  if (input.breachStartedOn !== null) {
    return { next: input.breachStartedOn, changed: false }; // ① 本轮进行中, 起点不动
  }
  const observed = toUtcDateOnly(input.lastCloseDate ?? input.createdAt);
  const created = toUtcDateOnly(input.createdAt);
  const start = observed.getTime() < created.getTime() ? created : observed; // ③
  return { next: start, changed: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 三空态 (FR-015 + FR-034)
// ─────────────────────────────────────────────────────────────────────────────

export const RADAR_EMPTY_STATES = ['zero_anchors', 'filtered_empty', 'all_idle'] as const;

export type RadarEmptyState = (typeof RADAR_EMPTY_STATES)[number];

/**
 * 🚨 三态文案 **MUST NOT 复用** (FR-034 明令与 FR-015 区分): 语义完全不同 ——
 * 「今日没得做」vs「你还没建锚」vs「是你的筛选把它们滤掉了」。混用文案 = 把可操作的空
 * (清筛选 / 去建锚) 说成不可操作的空。
 *
 * 文案落**服务端**是为了三态判定与措辞同源 (mobile 只渲染它拿到的那一条, T024)。
 */
export const RADAR_EMPTY_STATE_MESSAGES: Readonly<Record<RadarEmptyState, string>> = {
  zero_anchors: '还没有锚 —— 先去锚管理建第一个锚',
  filtered_empty: '当前筛选无结果',
  all_idle: '今日无解，空仓是常态',
};

export interface RadarEmptyStateInput {
  /** 基础集合 (`excluded = false`, **未加筛选**) 的锚数。 */
  baseTotal: number;
  /** 本页返回条数。 */
  pageItems: number;
  /** 基础集合中 spot 已跌破 W 的锚数 (= 可动)。 */
  actionableTotal: number;
  /** 是否首页 (无游标)。 */
  firstPage: boolean;
}

/**
 * 空态三分。判定序不可换: 零锚 → 筛选无结果 → 全体不动区。
 *
 * - **零锚**: 基础集合为空 (锚库为空, 或仅有的锚全被 `excluded`)。两种都引导去锚管理 ——
 *   excluded 的锚在**那边**可见 (FR-005), 雷达这边说「去建锚」不会让人找不到东西。
 * - **筛选无结果**: 有锚但本页空 ⇒ 是筛选滤掉的 (基础集合非空时首页为空只可能是筛选)。
 * - **全体不动区**: 有行但无一只跌破 W —— 行**照常渲染**, 只在顶部加提示 (非空白页)。
 * - **续页不判空态**: 空态是「打开雷达这一刻」的语义, 翻到底自然到头, 不是「无结果」。
 */
export function resolveRadarEmptyState(input: RadarEmptyStateInput): RadarEmptyState | null {
  if (!input.firstPage) return null;
  if (input.baseTotal === 0) return 'zero_anchors';
  if (input.pageItems === 0) return 'filtered_empty';
  if (input.actionableTotal === 0) return 'all_idle';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 读端
// ─────────────────────────────────────────────────────────────────────────────

/** 雷达筛选面 (FR-034)。字段省略 / 空数组 = 该维度不筛。 */
export interface RadarFilter {
  /** 生效 L 层多选 (L1–L4)。 */
  lLevels?: readonly LLevel[];
  /** `next_review` 逾期 (待复审)。 */
  pendingReview?: boolean;
  /** 跌破 W (`last_close < W`)。 */
  belowW?: boolean;
}

export interface RadarQuery {
  limit?: number;
  /** 上一页返回的 `nextCursor`; 省略 = 首页。 */
  cursor?: string | null;
  filter?: RadarFilter;
}

export interface RadarPage {
  /** 本页行 (键序 = SQL 序, 不在内存二次排序)。 */
  items: AnchorView[];
  /** 下一页游标; `null` = 已到底。 */
  nextCursor: string | null;
  hasMore: boolean;
  emptyState: RadarEmptyState | null;
  emptyStateMessage: string | null;
}

/**
 * SQL 只回排序键 —— 整行由主键水合 (见 {@link GetRadarUseCase.execute})。
 *
 * 🚨 列名**故意不叫** `id` / `distance_to_w_pct`: PG 的 `ORDER BY` 优先解析**输出列别名**,
 * 若把 `::text` 转换后的列取同名, 排序就会落到 text 上 —— `'-10' < '-15' < '-5'` 的字典序,
 * 分页直接错乱 (T014 IT 实测撞到过)。取不同名 ⇒ `ORDER BY` 只能解析到子查询里的
 * numeric / bigint 原列。
 */
interface RadarKeyRow {
  anchor_id: string;
  distance_text: string | null;
}

/** 状态机扫描需要的列 (生效 V 要 confidence / 人工位一起解算)。 */
interface BreachScanRow {
  id: bigint;
  v: Prisma.Decimal;
  confidence: Prisma.Decimal;
  vManual: Prisma.Decimal | null;
  lLevelManual: string | null;
  positionCapManual: Prisma.Decimal | null;
  excluded: boolean;
  lastClose: Prisma.Decimal | null;
  lastCloseDate: Date | null;
  createdAt: Date;
  breachStartedOn: Date | null;
}

interface BreachScanResult {
  baseTotal: number;
  actionableTotal: number;
}

@Injectable()
export class GetRadarUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: RadarQuery = {}): Promise<RadarPage> {
    const limit = normalizeRadarLimit(query.limit);
    const cursor = query.cursor ? decodeRadarCursor(query.cursor) : null;
    if (query.cursor && cursor === null) {
      throw new BadRequestException('INVALID_RADAR_CURSOR');
    }
    const firstPage = cursor === null;

    // 状态机只在首页推进: 一次「打开雷达」= 一次可判定时点; 续页重跑会让同一次滚动中判据漂移,
    // 而且每页重扫全表纯属浪费。
    const scan = firstPage ? await this.advanceBreachState() : { baseTotal: 0, actionableTotal: 0 };

    const keys = await this.selectPageKeys(cursor, query.filter ?? {}, limit);
    const hasMore = keys.length > limit;
    const pageKeys = hasMore ? keys.slice(0, limit) : keys;
    const items = await this.hydrate(pageKeys);
    const last = pageKeys.at(-1);

    return {
      items,
      hasMore,
      nextCursor:
        hasMore && last !== undefined
          ? encodeRadarCursor({ distanceToWPct: last.distance_text, anchorId: last.anchor_id })
          : null,
      ...this.emptyState({ ...scan, pageItems: items.length, firstPage }),
    };
  }

  private emptyState(
    input: RadarEmptyStateInput,
  ): Pick<RadarPage, 'emptyState' | 'emptyStateMessage'> {
    const emptyState = resolveRadarEmptyState(input);
    return {
      emptyState,
      emptyStateMessage: emptyState === null ? null : RADAR_EMPTY_STATE_MESSAGES[emptyState],
    };
  }

  /**
   * 推进全部锚的复核锚状态机, 顺带数出空态判定所需的两个计数。
   *
   * ⚠️ 扫描面是**全部**锚 (含 `excluded`): 状态**维护**与**展示**正交 —— excluded 的锚不进
   * 雷达 (Guardrail 12), 但它在锚管理列表仍要显示正确的复核锚红标, 状态冻结会让那边读到陈旧值。
   *
   * O(n) 扫 + O(变更行) 次 UPDATE (n = 锚数, 上限约 1000; 常态下 0 次写)。
   */
  private async advanceBreachState(): Promise<BreachScanResult> {
    const rows = (await this.prisma.anchor.findMany({
      select: {
        id: true,
        v: true,
        confidence: true,
        vManual: true,
        lLevelManual: true,
        positionCapManual: true,
        excluded: true,
        lastClose: true,
        lastCloseDate: true,
        createdAt: true,
        breachStartedOn: true,
      },
    })) as BreachScanRow[];

    let baseTotal = 0;
    let actionableTotal = 0;
    for (const row of rows) {
      // 生效值一律经 anchor-cascade 解算, 读侧不另拼一套 COALESCE (FR-006 一致性铁律)。
      const effective = resolveEffectiveAnchorValues(
        { v: row.v, confidence: row.confidence },
        {
          vManual: row.vManual,
          lLevelManual: row.lLevelManual as LLevel | null,
          positionCapManual: row.positionCapManual,
        },
      );
      const belowW = row.lastClose !== null && isBelowW(effective.v, row.lastClose);
      if (!row.excluded) {
        baseTotal += 1;
        if (belowW) actionableTotal += 1;
      }
      const transition = resolveBreachTransition({
        v: effective.v,
        lastClose: row.lastClose,
        lastCloseDate: row.lastCloseDate,
        createdAt: row.createdAt,
        breachStartedOn: row.breachStartedOn,
      });
      if (!transition.changed) continue;
      // conditional UPDATE + affected-count: 前置值不符 = 并发请求已推进过, 放过即可。
      await this.prisma.anchor.updateMany({
        where: { id: row.id, breachStartedOn: row.breachStartedOn },
        data: { breachStartedOn: transition.next },
      });
    }
    return { baseTotal, actionableTotal };
  }

  /**
   * SQL 端排序 + 筛选 + keyset 取一页键 (多取 1 条探测 `hasMore`)。
   *
   * 距 W% 是**跨列表达式** (`(last_close − W) / W × 100`, W = 生效 V × 系数), Prisma 查询 API
   * 无法 `orderBy` 表达式 ⇒ 走 `$queryRaw`。系数从 `anchor.rules.ts` 常量取并**走参数绑定**,
   * MUST NOT 在此复写字面量 (SC-005)。
   *
   * 内层子查询算出 `distance_to_w_pct`, 外层才引用它 —— PG 的 `WHERE` 不能引用同层输出列别名,
   * 分两层可让 keyset 谓词与 `ORDER BY` 都只写一次表达式 (写三遍必然改漏一处)。
   */
  private async selectPageKeys(
    cursor: RadarCursor | null,
    filter: RadarFilter,
    limit: number,
  ): Promise<RadarKeyRow[]> {
    const w = Prisma.sql`(COALESCE(v_manual, v) * ${W_COEFFICIENT.toString()}::numeric)`;
    const conditions: Prisma.Sql[] = [Prisma.sql`excluded = false`]; // Guardrail 12 基础条件
    if (filter.lLevels !== undefined && filter.lLevels.length > 0) {
      conditions.push(Prisma.sql`l_level_effective IN (${Prisma.join([...filter.lLevels])})`);
    }
    if (filter.pendingReview === true) {
      // 与 `ListAnchorsUseCase` 同口径: 锚的「今天」跟用户所在地走, 不是 UTC (§FR-034)。
      const today = shanghaiDateOnly(new Date()).toISOString().slice(0, 10);
      conditions.push(Prisma.sql`next_review < ${today}::date`);
    }
    if (filter.belowW === true) {
      // 行情不可用 (last_close IS NULL) 天然不满足 ⇒ 不会被当成「跌破」(禁伪造)。
      conditions.push(Prisma.sql`last_close < ${w}`);
    }
    const keyset =
      cursor === null ? Prisma.empty : Prisma.sql`WHERE ${radarKeysetPredicate(cursor)}`;

    return this.prisma.$queryRaw<RadarKeyRow[]>(Prisma.sql`
      SELECT id::text AS anchor_id, distance_to_w_pct::text AS distance_text
      FROM (
        SELECT id, ((last_close - ${w}) / NULLIF(${w}, 0) * 100) AS distance_to_w_pct
        FROM optionsdesk.anchor
        WHERE ${Prisma.join(conditions, ' AND ')}
      ) ranked
      ${keyset}
      ORDER BY distance_to_w_pct ASC NULLS LAST, id ASC
      LIMIT ${limit + 1}
    `);
  }

  /** 按键序水合整行 → {@link AnchorView} (派生口径与锚列表同源)。 */
  private async hydrate(keys: readonly RadarKeyRow[]): Promise<AnchorView[]> {
    if (keys.length === 0) return [];
    const rows = (await this.prisma.anchor.findMany({
      where: { id: { in: keys.map((k) => BigInt(k.anchor_id)) } },
    })) as AnchorRow[];
    const byId = new Map(rows.map((row) => [row.id.toString(), row]));
    const today = shanghaiDateOnly(new Date());
    // 逐市场取一次新鲜度基准 (本页涉及的市场, ≤ 3 次单行索引查询), 全页共用。
    const sessions = await resolveLastClosedSessions(
      this.prisma,
      marketsOfTickers(rows.map((r) => r.ticker)),
    );
    // 键查询与水合之间被并发删除的行直接跳过 (整页照常返回, 不 500)。
    return keys
      .map((key) => byId.get(key.anchor_id))
      .filter((row): row is AnchorRow => row !== undefined)
      .map((row) => toAnchorView(row, sessionOf(sessions, row.ticker), today));
  }
}
