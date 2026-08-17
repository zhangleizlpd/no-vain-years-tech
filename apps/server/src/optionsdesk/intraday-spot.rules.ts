import { Prisma } from '../generated/prisma/client';
import type { PriceKind } from '../marketdata/marketdata.types';
import { dateOnlyOf } from './date-only';

/**
 * 061 — 盘中价的**新鲜度闸与档位判定单点** (FR-006 / FR-007 / FR-008 / FR-014, plan D4)。
 * 纯函数, 无 I/O 无 DI。
 *
 * 🚨 **`INTRADAY_TICK_INTERVAL_SECONDS` 是本系统唯一的自由变量** (FR-007)。新鲜度闸由它
 * **派生**, 倍数**定死为一个单值**（不是区间 —— 区间等于留了第二个没人拍的自由变量）。
 * ⇒ **MUST NOT 在第二处手写 90**: 投影 tick、雷达读端的 SQL cutoff、IT 断言, 一律从这里取。
 *
 * 🚨 **倍数为什么恰好等于熔断阈值**: 熔断是「连续 {@link INTRADAY_CIRCUIT_THRESHOLD} 轮失败」,
 * 每轮 `T` 秒 ⇒ 熔断打开的那一刻正是最后一次成功采集越过闸的那一刻 —— **「熔断打开」与
 * 「数据判陈旧」同刻发生**。倍数取大一档会留出一个「熔断已开、雷达还按实时档排序与呈现」的
 * 窗口, 那正是本 feature 要消灭的静默骗人形态。这条不是巧合而是判据, 故由
 * `intraday-spot.rules.spec.ts` 的等式断言机器化钉住 —— 两者脱钩时该断言红。
 *
 * 🚨 **{@link resolveAnchorSpot} 是读端档位判定的唯一入口**: 雷达 SQL 的排序表达式与它
 * **同源** (SQL 的 cutoff 取 {@link intradayFreshnessCutoff})。禁「SQL 里判一次新鲜度、TS 里
 * 再判一次」—— 两处必漂移, 而漂移的表现是「排序按实时、显示说收盘」, **没有任何断言会红**。
 *
 * ⚠️ 新鲜度只认**我们自己的采集时刻** (FR-006), 不认 vendor 时间戳: 后者是「最后成交时刻」,
 * 实测盘中滞后中位 40 秒 / p95 292 秒 / 最大 672 秒, 按它判会在正常交易时段内把活跃标的稳定
 * 误判成陈旧。
 */

/** tick 间隔（秒）—— **系统中唯一的自由变量**, 一切时间阈值由它派生。 */
export const INTRADAY_TICK_INTERVAL_SECONDS = 30;

/**
 * 新鲜度闸 = 多少个 tick。**定死为单值**, MUST NOT 改回区间 (FR-007)。
 * 取值理由见文件头「倍数为什么恰好等于熔断阈值」。
 */
export const FRESHNESS_TICK_MULTIPLIER = 3;

/** 新鲜度闸（秒）—— **派生量**, 全系统唯一落点。 */
export const INTRADAY_FRESHNESS_SECONDS =
  INTRADAY_TICK_INTERVAL_SECONDS * FRESHNESS_TICK_MULTIPLIER;

/**
 * 熔断阈值：连续多少轮采集失败即打开熔断 (FR-012)。
 *
 * 🚨 **蓄意与 {@link FRESHNESS_TICK_MULTIPLIER} 各自独立声明**（两者量纲不同：一个是失败轮次
 * 计数, 一个是无量纲倍数）。数值相等是**判据**不是巧合 ——「同刻发生」由 spec 里那条等式断言
 * 守住; 若把它写成 `= FRESHNESS_TICK_MULTIPLIER`, 断言就退化成恒真, 白装。
 */
export const INTRADAY_CIRCUIT_THRESHOLD = 3;

const MS_PER_SECOND = 1000;

/** 锚的两个价源 + 各自的时间事实（= `anchor` 表的四列, 贫血原样传入）。 */
export interface AnchorSpotInput {
  /** 最近一次盘中实时价; 从未采集过 ⇒ `null`。 */
  intradayPrice: Prisma.Decimal | null;
  /** 该价的**采集墙钟**（我们的时刻, 非 vendor 时间戳）; 从未采集过 ⇒ `null`。 */
  intradayAt: Date | null;
  /** 当日收盘的权威值（FR-015: 语义不变, 仍是一切降级的落脚点）; 行情不可得 ⇒ `null`。 */
  lastClose: Prisma.Decimal | null;
  /** 收盘价所属的 session 日（`@db.Date` ⇒ UTC 午夜）; 行情不可得 ⇒ `null`。 */
  lastCloseDate: Date | null;
}

/** 裁决结果三元组。**任何一档都显式给出 `priceKind`**, 包括无价可用时。 */
export interface AnchorSpot {
  /**
   * 生效 spot。两价皆无 ⇒ `null`。
   * 🚨 **MUST NOT 回落成 0** (FR-014): 0 是一个有意义的距离值（「正好在带上」），
   * 用它表达「没有数据」会被读成一个强信号。
   */
  price: Prisma.Decimal | null;
  priceKind: PriceKind;
  /**
   * 时间事实, **粒度即档位**(FR-009 —— 界面不为档位另加视觉标记, 只靠这个粒度表达):
   * 实时档 = ISO-8601 **时刻**; 收盘档 = `YYYY-MM-DD` **交易日**; 无价可用 ⇒ `null`。
   */
  asOf: string | null;
}

/**
 * 新鲜度闸的左端点 = `now − 闸`。**雷达 SQL 的 `$cutoff` 参数取自这里**, 与
 * {@link isIntradayFresh} 同源（plan D4 的「同源」要求就是这一处 export）。O(1)。
 */
export function intradayFreshnessCutoff(now: Date): Date {
  return new Date(now.getTime() - INTRADAY_FRESHNESS_SECONDS * MS_PER_SECOND);
}

/**
 * 该采集时刻是否仍在闸内。**闭区间** —— 恰好等于闸的那一拍仍算新鲜, 与 SQL 的
 * `intraday_at >= $cutoff` 逐字同义（半开/闭区间两处取不同, 边界那一拍就会「排序用了实时价、
 * 档位却说收盘」）。
 *
 * 缺时刻 / 时刻不可解析 ⇒ 一律**陈旧**（fail-closed: 无从判新鲜时 MUST NOT 猜成新鲜）。O(1)。
 */
export function isIntradayFresh(intradayAt: Date | null, now: Date): boolean {
  if (intradayAt === null) return false;
  const at = intradayAt.getTime();
  if (Number.isNaN(at)) return false;
  return at >= intradayFreshnessCutoff(now).getTime();
}

/**
 * 🚨 **读端档位判定的唯一入口** (FR-008)。
 *
 * 单点裁决 ⇒ 收盘后一段时间内两价「都是今天的」时不会在两个来源之间抖动（state_branch 15）:
 * 同一个 `now` 下本函数是纯函数, 连查两次必得同一结果。
 *
 * 降级顺序只有一条: **新鲜的实时价 → 否则收盘价 → 否则显式无价**。O(1)。
 */
export function resolveAnchorSpot(input: AnchorSpotInput, now: Date): AnchorSpot {
  const { intradayPrice, intradayAt } = input;
  // 半写状态（有价无时刻 / 有时刻无价）一律落收盘档: 缺任一半都无从判新鲜。
  if (intradayPrice !== null && intradayAt !== null && isIntradayFresh(intradayAt, now)) {
    return { price: intradayPrice, priceKind: 'realtime', asOf: intradayAt.toISOString() };
  }
  return {
    price: input.lastClose,
    priceKind: 'eod_close',
    asOf: input.lastCloseDate === null ? null : dateOnlyOf(input.lastCloseDate),
  };
}
