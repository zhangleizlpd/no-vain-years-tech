import { Injectable } from '@nestjs/common';
import type {
  SessionKind,
  TradingCalendarFetchResult,
  TradingCalendarSource,
} from './trading-calendar-source.port.js';
import type { VendorHttpClient } from './vendor-http-client.js';

/**
 * 富途 US 交易日历源 adapter (sellput-viz Phase 1 #5, `{us}` 的 L1)。取代腾讯 `usDJI` 指数
 * 反推法作主源, 腾讯降 L2 —— 换源理由 (p3b §3.3):
 * 1. 持牌券商官方接口, 比「指数当日有 bar ⟺ 开市」的反推更接近权威;
 * 2. 带 `MORNING` 半日市标记 (腾讯反推法拿不到; 本 PR 不落库, 见下「半日市」段);
 * 3. 与 6 个 us 期权维度同源, 少一个 vendor。
 *
 * GET `<shim>/trading-days?market=US&start=<from>&end=<to>`, Bearer 鉴权。响应信封
 * `{as_of, count, rows: [{time: 'YYYY-MM-DD', trade_date_type: 'WHOLE'|'MORNING'}]}`。
 *
 * **半日市 `trade_date_type` 自 063 Phase 2 起落库**: 2026-07-31 拍板不落时的理由是「现零消费
 * 方 (p4 的 EOD 采集时点 / session 归属才用)」—— 063 正是那个消费方, 该前提已失效。当时的第二条
 * 顾虑「腾讯与静态层给不出 ⇒ 列语义随 `servedBy` 漂」由**三态**化解: 答不上来的源返 `{}`
 * (= unknown), 与「答得上来且是整天」在类型上分得开, 谁也伪装不了谁。
 *
 * 🚨🚨 **本 adapter 的核心防线 = 首尾截断断言** (本机实测产物, 2026-07-31 · 7 个窗口)。
 * 富途该接口的两个边界**都以「静默截断」的形式表现, 不报错**:
 *
 * | 实测请求 | 实际返回 | 边界 |
 * | --- | --- | --- |
 * | `2016-01-01..2026-07-31` | 2514 行, **首日 2016-08-01** | 滚动 10 年历史上限, **截头** |
 * | `2015-01-01..2016-12-31` | 首日仍 2016-08-01 | 坐实是「今天 −10y」滚动窗, 非数据缺失 |
 * | `2006-01-01..2010-12-31` | **0 行, 不报错** | 完全越界 = 静默空 |
 * | `2027-01-01..2027-06-30` | **0 行, 不报错** | 未来视野硬边界 = **当年 12-31** |
 * | `2026-12-20..2027-01-20` | 8 行, 止于 2026-12-31 | 跨年窗, **截尾** |
 *
 * 🚨 **为什么闸必须在这里、而不能指望链上的合理性闸**: 设 2027-01-05 富途尚未发布次年日历,
 * populate 窗 `2026-12-06..2027-01-05` 只返 12 月的 ~17 天 —— 合理性闸下界 =
 * 22 工作日 × 0.4 = **9**, 17 ≥ 9 ⇒ **闸放行**, 于是写下一份缺 1 月初的日历, 6 个
 * `{us}`-only 维度静默停摆。**这就是 044 事故在 us 重演**。p3b 原写的「复用年更提醒范式」
 * 是月度节奏的人工机制, 救不了这个 —— 故改为结构性断言: 截断即 throw → 链降级腾讯 (无此
 * 视野限制) → `servedBy='tencent'` 落心跳 → 探针报降级。**失败响亮且有兜底。**
 *
 * ⚠️ **别把阈值调大**: 见 {@link MAX_EDGE_WEEKDAY_GAP}。
 *
 * 真端点 / 真隧道由 env-gated 真 vendor IT 校真 (`marketdata.futu-shim.vendor`,
 * `RUN_MARKETDATA_IT`) —— 此处仅解析 / 断言逻辑 (沿 015 全 adapter 范式)。
 */

/** market → 富途 `TradeDateMarket` 枚举值。**只有 us** —— 见 {@link FutuCalendarAdapter}。 */
const MARKET_TO_FUTU_TRADE_DATE_MARKET: Record<string, string> = {
  us: 'US',
};

/**
 * 🚨 **首/尾截断判据的容差 (工作日数, 不是自然日数)**。
 *
 * 判据挂**工作日**而非日期差, 是为了让阈值能同时容下合法情形又卡住真截断:
 * - 合法最坏情形 = 请求端点落在长周末尾。`to=2027-12-26`(周日) → 末个交易日 2027-12-23
 *   (12-24 圣诞休市), 间隔工作日 **1**。元旦 / 感恩节 / 独立日同构, 均 ≤1。
 * - 年初未发布 (最隐蔽的真截断): 2027-01-05 请求、末个交易日 2026-12-31 → 间隔工作日
 *   = 1/1(休市) + 1/4 + 1/5 = **3** ⇒ 被卡住。
 *
 * 取 2 = 合法上界 1 留一格余量, 又低于真截断的 3。**别调大**: 调到 3 就正好放过上面那个
 * 年初场景, 闸失去它唯一要拦的东西。
 *
 * ⚠️ 极端历史事件 (9·11 连休 4 个交易日) 会触发本闸 —— **这是对的**: 那种日子人工确认一次,
 * 远好过静默写错日历。
 */
const MAX_EDGE_WEEKDAY_GAP = 2;

const DAY_MS = 86_400_000;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` → UTC epoch ms。非法格式 **throw** —— 禁 NaN 静默退化成「零工作日 → 闸恒过」。 */
function parseIsoDate(date: string, field: string): number {
  const ms = ISO_DATE_RE.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(ms)) {
    throw new Error(`[futu] trading-calendar 非法日期 ${field}="${date}" (须 YYYY-MM-DD)`);
  }
  return ms;
}

/**
 * 闭区间 [fromMs, toMs] 内的工作日 (周一~周五) 数; `fromMs > toMs` → 0 (空区间)。
 * 复杂度 O(区间自然日数) —— 只在截断判据的**边缘间隙**上跑 (正常 ≤ 数日), 全窗遍历仅发生在
 * 「返空」分支, 最宽 seed 窗 ~10yr 亦仅 ~3650 次迭代。
 */
function countWeekdays(fromMs: number, toMs: number): number {
  let count = 0;
  for (let ms = fromMs; ms <= toMs; ms += DAY_MS) {
    const weekday = new Date(ms).getUTCDay();
    if (weekday >= 1 && weekday <= 5) count++;
  }
  return count;
}

interface ShimEnvelope {
  rows?: unknown;
}

/**
 * 富途 `trade_date_type` → {@link SessionKind} (063 Phase 2)。**认不出的值一律返 `null`
 * (= 缺席 = unknown)**, 绝不兜底成 `whole`: vendor 哪天加一个新枚举 (`AFTERNOON`?), 兜底会把
 * 它静默读成整天, 而这个错**不会红** —— 只是那天的收盘时刻悄悄用了常量。
 */
function sessionKindOf(v: unknown): SessionKind | null {
  if (v === 'WHOLE') return 'whole';
  if (v === 'MORNING') return 'half';
  return null;
}

/**
 * 信封 → 交易日集 (升序去重)。
 *
 * **坏行 = throw, 不跳过** (与腾讯 adapter 的「坏项跳过」刻意不同): 腾讯那边每项是 kline
 * 数组、混入杂项可信; 这里每行是 SDK 直出的 dict, 少了 `time` 只可能是**契约变更**, 而静默
 * 丢一行 = 静默丢一个交易日 —— 正是本 feature 要消灭的那类。
 */
function parseRows(
  res: ShimEnvelope | null | undefined,
  ctx: string,
): { dates: string[]; sessionKinds: Record<string, SessionKind> } {
  const rows = res?.rows;
  if (!Array.isArray(rows)) {
    throw new Error(`[futu] trading-calendar 响应缺 rows[] (契约变更?): ${ctx}`);
  }
  const dates = new Set<string>();
  const sessionKinds: Record<string, SessionKind> = {};
  for (const row of rows) {
    const cell = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    const time = cell.time;
    if (typeof time !== 'string' || !ISO_DATE_RE.test(time)) {
      throw new Error(
        `[futu] trading-calendar 行缺合法 time (契约变更?): ${ctx}; 行=${JSON.stringify(row)}`,
      );
    }
    dates.add(time);
    // 🚨 `trade_date_type` 缺失 / 认不出 → **不写这个 key** (= unknown), 不 throw: 少一个
    // 收盘时刻只让那天回落常量 (= 本列上线前的行为), 而为它中断整份日历填充是拿一个诊断级
    // 字段去阻断结构性数据 —— 轻重倒置。`time` 缺失才 throw, 因为那是真丢一个交易日。
    const kind = sessionKindOf(cell.trade_date_type);
    if (kind !== null) sessionKinds[time] = kind;
  }
  return { dates: [...dates].sort(), sessionKinds };
}

@Injectable()
export class FutuCalendarAdapter implements TradingCalendarSource {
  constructor(
    private readonly http: VendorHttpClient,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async fetchTradingDates(
    market: string,
    from: string,
    to: string,
  ): Promise<TradingCalendarFetchResult> {
    const futuMarket = MARKET_TO_FUTU_TRADE_DATE_MARKET[market];
    if (!futuMarket) {
      // cn/hk 走腾讯主源, 不该路由到这里。明确抛 (不静默返空让日历漏填, 比 fail-closed 更隐蔽)。
      throw new Error(`[futu] trading-calendar 不支持市场 "${market}" (本源仅承担 us)`);
    }
    const fromMs = parseIsoDate(from, 'from');
    const toMs = parseIsoDate(to, 'to');
    if (fromMs > toMs) {
      throw new Error(`[futu] trading-calendar 区间非法 (from > to): ${from}..${to}`);
    }

    const res = await this.http.request<ShimEnvelope>({
      url:
        `${this.baseUrl}/trading-days` +
        `?market=${encodeURIComponent(futuMarket)}` +
        `&start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` },
    });

    const ctx = `${market} ${from}..${to}`;
    const { dates, sessionKinds } = parseRows(res, ctx);
    this.assertNotTruncated(dates, fromMs, toMs, ctx);
    return { dates, sessionKinds, servedBy: 'futu' };
  }

  /**
   * 🚨 首/尾截断断言 —— 本 adapter 的核心防线 (判据与阈值论证见类注释 +
   * {@link MAX_EDGE_WEEKDAY_GAP})。命中即 throw, 交链降级。
   *
   * `dates` 为空时无首尾可比 → 退化为「整窗工作日数」判据: 窗内工作日 ≤ 阈值 → 空是合法的
   * (港口契约: 区间确无交易日 → 空数组); 超阈值的空 = 越界静默空 (实测 `2006..2010` 即此形态)。
   */
  private assertNotTruncated(dates: string[], fromMs: number, toMs: number, ctx: string): void {
    if (dates.length === 0) {
      const weekdays = countWeekdays(fromMs, toMs);
      if (weekdays > MAX_EDGE_WEEKDAY_GAP) {
        throw new Error(
          `[futu] trading-calendar ${ctx} 返 0 天但窗内有 ${weekdays} 个工作日 ` +
            `(疑越界: 富途历史上限 ~10yr / 未来视野止于当年 12-31; 禁当成「无交易日」写库)`,
        );
      }
      return;
    }

    // dates 已升序 → 首尾即 min/max。
    const headGap = countWeekdays(fromMs, parseIsoDate(dates[0], 'firstDate') - DAY_MS);
    if (headGap > MAX_EDGE_WEEKDAY_GAP) {
      throw new Error(
        `[futu] trading-calendar ${ctx} 疑截头: 首个交易日 ${dates[0]} 之前尚有 ${headGap} 个 ` +
          `工作日未覆盖 (阈值 ${MAX_EDGE_WEEKDAY_GAP}; 富途历史上限 ~10yr 会静默截头)`,
      );
    }

    const last = dates[dates.length - 1];
    const tailGap = countWeekdays(parseIsoDate(last, 'lastDate') + DAY_MS, toMs);
    if (tailGap > MAX_EDGE_WEEKDAY_GAP) {
      throw new Error(
        `[futu] trading-calendar ${ctx} 疑截尾: 末个交易日 ${last} 之后尚有 ${tailGap} 个 ` +
          `工作日未覆盖 (阈值 ${MAX_EDGE_WEEKDAY_GAP}; 富途未来视野止于当年 12-31 —— ` +
          `年初次年日历未发布时即此形态)`,
      );
    }
  }
}
