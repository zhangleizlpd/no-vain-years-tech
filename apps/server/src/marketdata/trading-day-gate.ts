import {
  exchangeCalendarDate,
  exchangeCalendarDateForScope,
  isSessionComplete,
  sessionWatermark,
  userToday,
} from './session-clock.js';
import type { TradingCalendarPort } from './trading-calendar.port.js';

/**
 * 交易日 gate (016 T004, FR-S02): 夜间管线**最外层短路**。今日非交易日 → 返 false,
 * 调用方据此整管线 skip (SyncRun status=skipped, 零 vendor 调用 — 节假日/周末盲跑纯浪费配额)。
 *
 * 纯委托 `TRADING_CALENDAR_PORT` (不自维护节假日表); `date` 由调用方按市场时区算 (见
 * `session-clock.ts` 的 `exchangeCalendarDate`)。无副作用 → vitest 纯单测可喂 stub calendar。
 *
 * 🚨 **三态 → 布尔的映射是 `!== 'non-trading'`, 不是 `=== 'trading'`** (062 T006, Impl
 * Guardrail 1): gate 的语义是「**确认**今天不是交易日才关」——「日历还没填到这儿」(`unknown`)
 * 必须走**放行**侧, 与 062 之前 `DbTradingCalendarAdapter` 对未 populate 的日历 fail-open 返
 * `true` 逐点相同 (零行为变更)。写成 `=== 'trading'` 会让上线首刻 (覆盖声明表刚建、尚未灌值
 * ⇒ 全 `unknown`) 整条夜间管线恒 skip, 而**没有任何测试会红**。
 *
 * 🚨 **它问的是「今天开不开市」, 不是「该写哪一天」** (063 Phase 1): 后者归
 * `sync-asof.rules.ts` 的 `resolveAsOfForDimension`。两个问题两个值, 合并会让周日 06:00
 * 那轮白发一整轮 vendor 请求。
 */
export async function isTradingDayGateOpen(
  calendar: TradingCalendarPort,
  market: string,
  date: string,
): Promise<boolean> {
  return (await calendar.classify(market, date)) !== 'non-trading';
}

// ─────────────────────────────────────────────────────────────────────────────
// @deprecated 转发壳 (063 Phase 1) —— 词表统一到 `session-clock.ts`, 下个 release 删。
//
// 🚨 转发而**不是**复制实现: 时区表 / 收盘时刻表全仓只此一份 (`session-clock.ts`)。
//    在这里留第二份就是本次重构要根除的形态。
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated 改用 `session-clock.ts` 的 `userToday` —— 它显式声明「跟用户所在地走」。 */
export function shanghaiToday(now: Date): string {
  return userToday(now);
}

/**
 * @deprecated 改用 `session-clock.ts` 的 `exchangeCalendarDateForScope`(scope) 或
 * `exchangeCalendarDate`(单市场)。🚨 若调用点要的是**采集业务日**, 那不该是本函数 ——
 * 走 `sync-asof.rules.ts` 的 `resolveAsOfForDimension`(#103 的病灶正在这一格)。
 */
export function marketDateFor(marketScope: string[], now: Date): string {
  return exchangeCalendarDateForScope(marketScope, now);
}

/**
 * @deprecated 改用 `session-clock.ts` 的 `sessionWatermark` (业内名 = event-time watermark)。
 * ⚠️ 本壳**按常规收盘**算 —— 063 Phase 2 给新函数加了半日市入参, 而转发壳没有那个信息可传。
 * 又一条「该迁走了」的理由。
 */
export function lastClosedSessionCutoff(market: string, now: Date): string {
  return sessionWatermark(market, now, 'unknown');
}

/**
 * @deprecated 改用 `session-clock.ts` 的 `isSessionComplete`。
 * ⚠️ 同上: 本壳按常规收盘算, 半日市当天答案偏保守 (说没收)。
 */
export function isSessionClosed(market: string, sessionDate: string, now: Date): boolean {
  return isSessionComplete(market, sessionDate, now, 'unknown');
}

// ─────────────────────────────────────────────────────────────────────────────
// 剩余期限 (DTE) —— 047 T006a
// ─────────────────────────────────────────────────────────────────────────────

/** 一个日历日的毫秒数。**只在 UTC 午夜之间做减法**时成立 (UTC 无 DST), 故下方一律先换算到 UTC。 */
const MS_PER_CALENDAR_DAY = 86_400_000;

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DaysToExpiryInput {
  /**
   * 合约到期日。接受 Prisma `@db.Date` 读出的 `Date` (恒为 UTC 午夜) 或 `YYYY-MM-DD` 字符串。
   * 传带时间的绝对时刻会**抛** —— 见 {@link daysToExpiry} 的第 3 条纪律。
   */
  expiry: Date | string;
  /**
   * **请求时刻** (绝对时刻, 通常就是 `new Date()`)。
   *
   * 🚨 蓄意收的是 instant 而**不是**一个算好的 `today` 字符串: 后者等于把"跟谁的今天"这个
   * 判断推回给调用方, 于是每个调用点各自发挥 —— 正是本函数要消灭的形态。
   */
  now: Date;
  /**
   * 该合约到期日所属**交易所** (`us` / `hk` / …, 词表见 `session-clock.ts` 的时区表)。
   *
   * 🚫 **MUST NOT 做成带默认值的可选入参** (#263): 「悄悄用了另一个市场的今天」正是本函数
   * 存在的理由。本片曾写死 `'us'`, 港股期权 2026-08-23 上线后那个字面量就成了一条静默偏
   * 一天的判据 —— 必填是为了让每个调用点**显式声明**是哪个交易所, 加错了在 tsc 当场红。
   *
   * ⚠️ `exchangeCalendarDate` 对**未登记市场 fail-open 回落宿主时区** (`session-clock.ts`
   * 的 `DEFAULT_TIME_ZONE`, 那条 fail-open 是 meta 维度空 scope 要的、刻意如此) ⇒ 本入参
   * 传错一个拼写也不会抛, 只会静默拿到上海的今天。调用点 MUST 从**已有的市场事实**派生
   * (维度的 `marketScope` / 标的的 `market`), 🚫 不要在调用点手写字面量。
   */
  exchange: string;
}

/**
 * 请求时的**剩余日历天数 (DTE)**。canonical 口径见
 * `docs/conventions/cross-timezone-date-semantics.md` §3 (「今天」归属表) + §4 (剩余期限)。
 *
 * 业内叫 **day count convention**: 本函数用的是 `ACT/365F` 那一族的分子 (实际日历日);
 * 分母 365 在 `leg-derive.rules.ts` 的 `DAYS_PER_YEAR`。🚨 与 IVP 窗的 **252 交易日制
 * (BUS/252)** 是两套, ISDA 2021 Definitions §4.6.1 明文不可混 —— 同一个假日在 252 制里是
 * `0/252`、在 365 制里仍是 `1/365`。
 *
 * 三条纪律, 每条都对应一种**不会报错、只让数字悄悄差一天**的塌法:
 *
 * 1. **基准 = 该合约所属交易所的今天** (`exchangeCalendarDate(exchange, now)`), 不是宿主本地
 *    日期、也不是别的市场的今天。北京上午 = ET 前一日晚 ⇒ 美股腿取宿主日期会让 DTE **恒偏
 *    1 天**; 反过来港股腿沿用 `'us'` 基准同样偏 1 天 (港股与宿主同为 UTC+8, #263 就是这条)。
 *    而 DTE 是两个意图 Tab 的带判据 (建仓腿 `DTE ≤ 14` / 收租腿 `DTE ∈ [150,365]`) 与
 *    FR-048 的豁免线 (`DTE ≤ 2`), 偏一天 = 边界腿静默进出带。
 * 2. **整数日历日, 含周末与节假日**; 到期日当天 = 0, 已过期为负 (🚫 不 clamp 到 0 —— 0 已被
 *    "当天到期"占用)。🚫 **禁用绝对时刻差**: 会得小数, 让 `≤ N 天` 这类带判据在一天之内抖,
 *    且跨 DST 的窗口不是 24h 的整数倍 (73 小时的窗会算成 3.04 天)。
 * 3. **到期日只接受"日期"**, 不接受带时间的绝对时刻 —— canonical §3 那个"同一个函数身兼两职"
 *    的陷阱 (拿 `@db.Date` 归一化是对的, 拿 `new Date()` 求今天是错的) 在此处被签名挡住。
 *
 * 🚨 **允许并要求一处口径错配 —— 这是有意为之, 不是 bug, 🚫 不要"修"它**: 同屏的价格来自
 * **上一场 session** 的 EOD 快照, 而 DTE 从**当前** ET 日期起算, 两者不同基准。决策是前瞻的
 * ("我今天挂这张单还要扛多少天风险"), 改成按快照日起算会**系统性多算一天**。代价是同屏必须有
 * 显式 `asOf` 让人看得见价格的时点 (FR-041 / 快照行另有独立的 `oi_as_of`)。
 *
 * 复杂度 O(1)。
 */
export function daysToExpiry({ expiry, now, exchange }: DaysToExpiryInput): number {
  const today = exchangeCalendarDate(exchange, now);
  return utcEpochDay(expiryDateOnly(expiry)) - utcEpochDay(today);
}

/** `@db.Date` 的 Date (UTC 午夜) → `YYYY-MM-DD`; 带时间的绝对时刻直接拒。 */
function expiryDateOnly(expiry: Date | string): string {
  if (typeof expiry === 'string') {
    return expiry;
  }
  // NaN (Invalid Date) 与任何非 UTC 午夜时刻都落这里。
  if (expiry.getTime() % MS_PER_CALENDAR_DAY !== 0) {
    throw new Error(
      `[trading-day] 到期日必须是**日期** (\`YYYY-MM-DD\` 或 \`@db.Date\` 读出的 UTC 午夜 Date), ` +
        `实得带时间的绝对时刻 ${expiry.toISOString?.() ?? String(expiry)}; ` +
        `拿绝对时刻当到期日会把"谁的日期"这个判断推给宿主时区`,
    );
  }
  return expiry.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → 自 epoch 起的整数日序 (UTC 午夜锚点, 故减法恒为整数日, DST 不参与)。 */
function utcEpochDay(dateOnly: string): number {
  const parts = DATE_ONLY_PATTERN.exec(dateOnly);
  const ms = parts
    ? Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : Number.NaN;
  // 🚨 回写比对: `Date.UTC` 把溢出日**静默滚进下个月** (2026-02-30 → 2026-03-02), 不回比就是
  // 一个不报错的两天误差。
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== dateOnly) {
    throw new Error(`[trading-day] 不是合法的 YYYY-MM-DD 日期: ${JSON.stringify(dateOnly)}`);
  }
  return ms / MS_PER_CALENDAR_DAY;
}
