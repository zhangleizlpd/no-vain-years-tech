import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { W_COEFFICIENT, isBelowW, type LLevel } from './anchor.rules';
import { resolveEffectiveAnchorValues } from './anchor-cascade';
import { shanghaiDateOnly, toUtcDateOnly, type AnchorRow } from './create-anchor.usecase';
import { intradayFreshnessCutoff } from './intraday-spot.rules';
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
  /** 跌破 W (`生效 spot < W`; spot = 新鲜的盘中价否则收盘价, 与排序键同一表达式)。 */
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

/**
 * ⚠️ **两个计数已是死字段** (061 T019): 空态计数改由 {@link GetRadarUseCase.countBaseSet} 按
 * spot 口径另查。留着不删是为了让 {@link GetRadarUseCase.advanceBreachState} 的函数体
 * **零行改动** —— 那是 Guardrail 3 守着的写库判据, 动它的收益远小于风险。
 */
interface BreachScanResult {
  baseTotal: number;
  actionableTotal: number;
}

/** 空态判定所需的两个基础集合计数 (SQL 端一次查出)。 */
type RadarBaseSetCounts = Pick<RadarEmptyStateInput, 'baseTotal' | 'actionableTotal'>;

/** 空态计数查询的输出行 —— PG 的 `COUNT` 原生是 bigint, `::int` 转换后才是 number。 */
interface RadarCountRow {
  base_total: number;
  actionable_total: number;
}

/**
 * 🚨 **W 与 spot 两个 SQL 片段的单点声明** —— 距 W% 排序键、`belowW` 筛选、空态计数
 * **三处共用**。
 *
 * 三处各写各的会让「筛出跌破的」「距 W% 显示跌破」「顶部横幅说一个都没有」在盘中互相矛盾,
 * 而三边都算得出结果、**都不会红** (061 Guardrail 4)。加第四处用法时继续从这里取, 别复制。
 *
 * W = 生效 V × 系数; 系数从 `anchor.rules.ts` 常量取并**走参数绑定**, MUST NOT 在此复写
 * 字面量 (SC-005)。
 */
function radarWSql(): Prisma.Sql {
  return Prisma.sql`(COALESCE(v_manual, v) * ${W_COEFFICIENT.toString()}::numeric)`;
}

/**
 * spot = 「闸内的盘中价, 否则收盘价」(061 FR-008)。`cutoff` **走参数绑定**且由
 * `intraday-spot.rules.ts` 的常量派生 —— **MUST NOT 在此手写 90**。
 * 与读端档位判定 (`resolveAnchorSpot`) 同源: 两处各判一次必漂移, 而漂移的表现是
 * 「排序按实时、显示说收盘」, 没有任何断言会红。
 */
function radarSpotSql(now: Date): Prisma.Sql {
  return Prisma.sql`COALESCE(CASE WHEN intraday_at >= ${intradayFreshnessCutoff(now)} THEN intraday_price END, last_close)`;
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
    // 一次请求取**一个** `now`: SQL 的新鲜度 cutoff 与读侧档位判定必须落在同一时点, 各取各的
    // 会在闸的边界那一拍产生「排序用了实时价、档位却说收盘」——而那种漂移不会红 (061 D4)。
    const now = new Date();

    // 状态机只在首页推进: 一次「打开雷达」= 一次可判定时点; 续页重跑会让同一次滚动中判据漂移,
    // 而且每页重扫全表纯属浪费。⚠️ 它顺带返回的两个计数**已不再被消费** (061 T019, 见下)。
    if (firstPage) await this.advanceBreachState();
    // 空态计数按 spot 口径**另查一条** —— 同样只在首页需要 (续页不判空态)。
    const counts = firstPage ? await this.countBaseSet(now) : { baseTotal: 0, actionableTotal: 0 };

    const keys = await this.selectPageKeys(cursor, query.filter ?? {}, limit, now);
    const hasMore = keys.length > limit;
    const pageKeys = hasMore ? keys.slice(0, limit) : keys;
    const items = await this.hydrate(pageKeys, now);
    const last = pageKeys.at(-1);

    return {
      items,
      hasMore,
      nextCursor:
        hasMore && last !== undefined
          ? encodeRadarCursor({ distanceToWPct: last.distance_text, anchorId: last.anchor_id })
          : null,
      ...this.emptyState({ ...counts, pageItems: items.length, firstPage }),
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
   * 推进全部锚的复核锚状态机。
   *
   * ⚠️ 扫描面是**全部**锚 (含 `excluded`): 状态**维护**与**展示**正交 —— excluded 的锚不进
   * 雷达 (Guardrail 12), 但它在锚管理列表仍要显示正确的复核锚红标, 状态冻结会让那边读到陈旧值。
   *
   * 🚨🚨 **本方法恒用 `last_close`, MUST NOT 改用盘中实时价** (061 plan D5)。061 之后本 use case
   * 里**两个 spot 口径并存是刻意的**: 排序与呈现用「新鲜实时否则收盘」({@link selectPageKeys} +
   * `toAnchorView`), 状态机恒用收盘。三条理由, 按分量:
   *  1. `breach_started_on` 是 `@db.Date`, 判据是「本轮跌破的**首次观测日**」。用分钟级价驱动
   *     日粒度状态机 ⇒ 红标在同一天内随 spot 反复穿越 W 而反复置位/清空, 而**清空是破坏性的**
   *     (`last_reviewed_on < breach_started_on` 的比较就此失去意义)。
   *  2. 红标问的是「你确认过这个估值在跌破后仍成立吗」—— 那是人的动作节奏, 不是分钟节奏。
   *  3. `last_close` 是**修订后**的权威值 (拆股/分红调整、错单撤销), 盘中最后一笔不是。
   * ⇒ 别「顺手统一」这两个口径。回归钉在 `get-radar.usecase.spec.ts`「Guardrail 3 回归钉」。
   *
   * ⚠️ **返回的两个计数已无人消费** (061 T019): 空态计数改走 {@link countBaseSet} 的 spot 口径。
   * 「一行不动」管的是**写库判据与状态转换**, 不含这两个纯展示数 —— 让它们继续用收盘口径, 会让
   * 同一份响应里两个口径回答同一个问题「有没有锚跌破 W」。此处保留它们只为让本方法体保持零改动。
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
   * 空态判定的两个计数 (`baseTotal` / `actionableTotal`), 一条查询取回 (`FILTER` 子句)。
   *
   * 🚨 **为什么不复用 {@link advanceBreachState} 顺带数出的那两个数**: 它恒用 `last_close`
   * (状态机的日粒度口径, 刻意不动)。用收盘口径回答「有没有锚跌破 W」, 而同一份响应里的排序 /
   * 筛选 / 距 W% 走盘中口径 ⇒ 盘中一旦出现「新鲜实时价跌破 W、收盘价未跌破」的锚, 顶部横幅会说
   * 「今日无解」而底下的行赫然是红色负距 W%。⚠️ 这**不是**「列表为空才显示所以撞不上」——
   * `all_idle` 是压在**非空列表**头上的提示 (列表为空时先被判成 `filtered_empty`), 两者必然同屏,
   * 且**没有任何断言会红** (061 T019 / plan D5 射程订正)。
   *
   * 口径与 {@link selectPageKeys} 的基础 `WHERE` 一致: 只数 `excluded = false` 的行,
   * **不叠用户筛选** —— 空态问的是「基础集合里有没有可动的」, 不是「筛完还剩几个」(后者是
   * `filtered_empty` 的语义, 两者搅在一起会让两态互相顶掉)。
   *
   * O(n) 单次全表扫 (n = 锚数, 上限约 1000), 只在首页发。
   */
  private async countBaseSet(now: Date): Promise<RadarBaseSetCounts> {
    const rows = await this.prisma.$queryRaw<RadarCountRow[]>(Prisma.sql`
      SELECT COUNT(*)::int AS base_total,
             (COUNT(*) FILTER (WHERE ${radarSpotSql(now)} < ${radarWSql()}))::int AS actionable_total
      FROM optionsdesk.anchor
      WHERE excluded = false
    `);
    // 聚合查询恒回一行; 防御性兜底避免空数组时 NaN 顺流进空态判定。
    const row = rows.at(0);
    return { baseTotal: row?.base_total ?? 0, actionableTotal: row?.actionable_total ?? 0 };
  }

  /**
   * SQL 端排序 + 筛选 + keyset 取一页键 (多取 1 条探测 `hasMore`)。
   *
   * 距 W% 是**跨列表达式** (`(spot − W) / W × 100`, W = 生效 V × 系数), Prisma 查询 API
   * 无法 `orderBy` 表达式 ⇒ 走 `$queryRaw`。
   *
   * 内层子查询算出 `distance_to_w_pct`, 外层才引用它 —— PG 的 `WHERE` 不能引用同层输出列别名,
   * 分两层可让 keyset 谓词与 `ORDER BY` 都只写一次表达式 (写三遍必然改漏一处)。
   *
   * 🚨 **061 spot 表达式**: 排序键的分子不再是裸 `last_close`。两个片段一律从
   * {@link radarSpotSql} / {@link radarWSql} 取 —— 单点声明的理由见那里。
   */
  private async selectPageKeys(
    cursor: RadarCursor | null,
    filter: RadarFilter,
    limit: number,
    now: Date,
  ): Promise<RadarKeyRow[]> {
    const w = radarWSql();
    const spot = radarSpotSql(now);
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
      // 两价皆无 (spot IS NULL) 天然不满足 ⇒ 不会被当成「跌破」(禁伪造)。
      conditions.push(Prisma.sql`${spot} < ${w}`);
    }
    const keyset =
      cursor === null ? Prisma.empty : Prisma.sql`WHERE ${radarKeysetPredicate(cursor)}`;

    return this.prisma.$queryRaw<RadarKeyRow[]>(Prisma.sql`
      SELECT id::text AS anchor_id, distance_to_w_pct::text AS distance_text
      FROM (
        SELECT id, ((${spot} - ${w}) / NULLIF(${w}, 0) * 100) AS distance_to_w_pct
        FROM optionsdesk.anchor
        WHERE ${Prisma.join(conditions, ' AND ')}
      ) ranked
      ${keyset}
      ORDER BY distance_to_w_pct ASC NULLS LAST, id ASC
      LIMIT ${limit + 1}
    `);
  }

  /** 按键序水合整行 → {@link AnchorView} (派生口径与锚列表同源)。 */
  private async hydrate(keys: readonly RadarKeyRow[], now: Date): Promise<AnchorView[]> {
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
    return (
      keys
        .map((key) => byId.get(key.anchor_id))
        .filter((row): row is AnchorRow => row !== undefined)
        // `now` 由 execute 一次性取: 与 SQL 的 cutoff 同一时点 ⇒ 排序与档位不会在闸的边界分叉。
        .map((row) => toAnchorView(row, sessionOf(sessions, row.ticker), today, now))
    );
  }
}
