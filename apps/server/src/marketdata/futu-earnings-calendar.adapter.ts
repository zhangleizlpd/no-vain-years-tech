import { Injectable } from '@nestjs/common';
import {
  EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS,
  EarningsCalendarBudgetExhaustedError,
  EarningsCalendarRejectedError,
  type EarningsCalendarEvent,
  type EarningsCalendarPort,
  type EarningsCalendarWindowQuery,
} from './earnings-calendar.port.js';
import { TransientVendorError, VendorHttpError } from './vendor-http-client.js';
import type { VendorHttpClient } from './vendor-http-client.js';

/**
 * 富途财报日历 adapter (047 T018, `EARNINGS_CALENDAR_PORT` 的唯一实现)。
 *
 * 打 shim 一个端点 (`services/futu-shim/`, Bearer 鉴权, 经 B↔C WireGuard 隧道):
 * GET `<shim>/earnings-calendar?market=US&start&end` → 该窗内**全市场**财报事件。
 *
 * ## 🚨 全市场, 不带任何标的过滤 (Guardrail 2 / FR-035b)
 *
 * 端口没有标的入参, adapter 也不提供「只要白名单」的旁路 —— shim 侧 `filter_list` 恒不传。
 * 在这里滤一分钱不省 (调用数与标的数无关), 却会让 PIT 三件套只对当前白名单成立: 日后加票时,
 * 它此前的改期史无从回补, 且 `first_seen_at` 语义直接变错。过滤是消费端的事。
 *
 * ## 🚨 窗越界**本地前置拒绝, 零外呼**
 *
 * 窗宽上限 (`EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS`) 是 vendor 的永久约束, 判据本地就有 ⇒
 * 打出去只是白烧一次限频配额换同一个 400。前置拒绝抛的是与 shim 400 **同一个**
 * {@link EarningsCalendarRejectedError} —— 两者对调用方的处置完全一致 (计 failed 继续下一窗,
 * 重试无意义), 分成两个类型只会让调用方多写一个分支去表达同一件事。
 *
 * ## 只承担 us
 *
 * 期权面只覆盖美股锚 (FR-032 / FR-036), 非 us market **直接抛、零外呼** —— 静默返空会被同步
 * 管线记成「那个市场今天没有财报」, 一次成功的空采集比一次响亮的失败难发现得多。
 *
 * ## 分窗不在这里
 *
 * 前向视野的窗序列由 `sync-earnings-event.usecase.ts` 切, 本 adapter **一次调用 = 一个窗**。
 * 两处都实现切分 = 同一段边界逻辑两份实现, 必漂移。同 `FutuOptionChainAdapter` 对 ≤30 天链窗
 * 的处置。
 *
 * ## vendor 错误映射 (同链 / 快照 adapter 的同一对, 不另造第三套)
 *
 * 传输纪律仍由 `VendorHttpClient` + `FUTU_SHIM_EARNINGS_CALENDAR_PROFILE` 承担。本 adapter 只把
 * 两类**调用方必须区别对待**的结局提成具名错误: 429 → {@link EarningsCalendarBudgetExhaustedError}
 * (顺延重入队, 不耗 attempts) · 400 → {@link EarningsCalendarRejectedError} (永久, 重试无意义)。
 * 其余原样上抛 —— 吞成上面任一类会把「vendor 坏了」说成「预算用完了」。
 *
 * 真端点契约由 env-gated 真 vendor IT 校真 (`marketdata.futu-shim.vendor`, `RUN_MARKETDATA_IT`)
 * —— ⚠️ 该门恒 skip, 「测试全绿」对真契约不构成证据。
 */

/** canonical market → 富途 market 参数。**只有 us**（期权面只覆盖美股锚）。 */
const MARKET_TO_FUTU_MARKET: Record<string, string> = {
  us: 'US',
};

/** 富途 code 前缀 → canonical market（上表的反向，`security` 列翻译用）。 */
const FUTU_PREFIX_TO_MARKET: Record<string, string> = {
  US: 'us',
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MS_PER_DAY = 86_400_000;

interface ShimEnvelope {
  count?: unknown;
  rows?: unknown;
}

/**
 * 数值 → Decimal-safe string；缺失 / 非有限 → null。
 * 🚨 **不回落成 0**：eps 为 0 是一个能被下游当真的业绩，与「尚未公布」方向相反。
 */
function numToString(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return v.trim();
  return null;
}

/** 非空字符串 → 原样 trim；其余（null / 空串 / 非字符串）→ null（禁默认值冒充）。 */
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function asRecord(row: unknown): Record<string, unknown> {
  return row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {};
}

/** 日期列（实测可带时间后缀）→ `YYYY-MM-DD`；不合形态返 null 交调用方 throw。 */
function dateOrNull(v: unknown): string | null {
  const date = (typeof v === 'string' ? v : '').slice(0, 10);
  return ISO_DATE_RE.test(date) ? date : null;
}

/** 富途 `security`（`US.PEP`）→ canonical `us:PEP`；前缀缺失或非已知市场 → null。 */
function toCanonicalSymbol(security: string): string | null {
  const dot = security.indexOf('.');
  const market = dot > 0 ? FUTU_PREFIX_TO_MARKET[security.slice(0, dot)] : undefined;
  const code = security.slice(dot + 1);
  return market === undefined || code === '' ? null : `${market}:${code}`;
}

/**
 * 单行 `earnings-calendar` → {@link EarningsCalendarEvent}。
 *
 * **坏行 throw、不跳过**：这里每行是 SDK 直出的 dict，缺 `security` / `earnings_date` /
 * `pub_type` 只可能是契约变更。静默丢一行 = 那只票的这次财报从此不在库里，而**跨财报判定
 * 会照常渲染成「不跨」**（FR-026 明禁的「编造一个未知事实」），且全程日志绿。
 *
 * ⚠️ 记账清楚：一行坏 ⇒ 整窗失败。这在市场级接口上是**可接受**的不对称 —— 财报日历**每日
 * 重拉整个前向视野**（FR-034），当窗失败次日自愈；而期权快照那侧漏采即永久缺口，故两处
 * 对「半份数据」的容忍度本就不同。窗级隔离在 use case（单窗 failed 后继续下一窗）。
 */
function parseEarningsRow(row: unknown, ctx: string): EarningsCalendarEvent {
  const raw = asRecord(row);
  const security = strOrNull(raw.security);
  const underlyingSymbol = security === null ? null : toCanonicalSymbol(security);
  const earningsDate = dateOrNull(raw.earnings_date);
  const pubType = strOrNull(raw.pub_type);

  if (underlyingSymbol === null || earningsDate === null || pubType === null) {
    throw new Error(
      `[futu] earnings-calendar 行不合契约 (须 security=<US>.<code> + earnings_date=YYYY-MM-DD ` +
        `+ 非空 pub_type; 契约变更?): ${ctx} 行=${JSON.stringify(row)}`,
    );
  }

  return {
    underlyingSymbol,
    earningsDate,
    // vendor 原样存 (BEFORE / AFTER / REGULAR): 归一成自造枚举就再也说不清库里那个值是谁的口径。
    pubType,
    periodText: strOrNull(raw.period_text),
    // 金融数值全程 string (FR-S08); 未公布恒 null, 禁 0 冒充。
    epsActual: numToString(raw.eps_actual),
    epsPredict: numToString(raw.eps_predict),
  };
}

@Injectable()
export class FutuEarningsCalendarAdapter implements EarningsCalendarPort {
  constructor(
    private readonly http: VendorHttpClient,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /** 复杂度：**1 个 HTTP 请求**（窗切分在调用方）+ 解析 O(窗内全市场事件数)。 */
  async getWindow(query: EarningsCalendarWindowQuery): Promise<EarningsCalendarEvent[]> {
    const ctx = `${query.market} ${query.start}..${query.end}`;
    // 🚨 两道本地闸都在任何外呼之前 (窗越界 / 非 us market 都是本地已知的永久事实)。
    this.assertWindowWithinCap(query, ctx);
    const params = new URLSearchParams({
      market: this.futuMarket(query.market),
      start: query.start,
      end: query.end,
    });

    const rows = await this.fetchRows(
      `/earnings-calendar?${params.toString()}`,
      `earnings-calendar ${ctx}`,
    );
    return rows.map((row) => parseEarningsRow(row, ctx));
  }

  /**
   * 窗宽 / 日期形态的**本地**前置闸：不合规直接抛 {@link EarningsCalendarRejectedError}，
   * **一次外呼都不发**。
   *
   * 判据全在本地已知 ⇒ 打出去只是白烧一次限频配额换同一个 400，而那次 400 还会在 vendor 侧
   * 的限频统计里留下一笔。复杂度 O(1)。
   */
  private assertWindowWithinCap(query: EarningsCalendarWindowQuery, ctx: string): void {
    if (!ISO_DATE_RE.test(query.start) || !ISO_DATE_RE.test(query.end)) {
      throw new EarningsCalendarRejectedError(`日期须 YYYY-MM-DD: ${ctx}`);
    }
    const spanDays =
      (Date.parse(`${query.end}T00:00:00Z`) - Date.parse(`${query.start}T00:00:00Z`)) / MS_PER_DAY;
    if (spanDays < 0) {
      throw new EarningsCalendarRejectedError(`窗止早于窗起: ${ctx}`);
    }
    if (spanDays > EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS) {
      throw new EarningsCalendarRejectedError(
        `窗跨度 ${spanDays} 天超 vendor 上限 ${EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS} 天 ` +
          `(分窗是调用方的事; 截断会让被裁掉的那几天在下游读作「全市场无财报」): ${ctx}`,
      );
    }
  }

  /** canonical market → 富途 market 参数；非 us 直接抛（零外呼）。 */
  private futuMarket(market: string): string {
    const futuMarket = MARKET_TO_FUTU_MARKET[market];
    if (futuMarket === undefined) {
      throw new Error(`[futu] earnings-calendar 不支持 market "${market}" (本源仅承担 us)`);
    }
    return futuMarket;
  }

  /**
   * 打一次 shim + 信封校验 + 失败语义映射。
   *
   * 两道信封闸都不是形式主义：缺 `rows[]` = 契约变更；`count` 与实收不符 = 传输层截断
   * （同 `FutuOptionChainAdapter` / `FutuEodBarAdapter` 的对账闸）。任一不过 → throw，
   * **不返回半份数据** —— 半份日历在下游读作「那几天全市场没有财报」，与真缺口无法区分。
   */
  private async fetchRows(path: string, what: string): Promise<unknown[]> {
    let res: ShimEnvelope | undefined;
    try {
      res = await this.http.request<ShimEnvelope>({
        url: `${this.baseUrl}${path}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      // 429：退避重试也没过 ⇒ 预算真耗尽 → 顺延信号（deferral ≠ failure，不耗 attempts）。
      if (err instanceof TransientVendorError && err.status === 429) {
        throw new EarningsCalendarBudgetExhaustedError(what, err);
      }
      // 400：窗越界 / 非法日期 —— 永久事实，重试只是把同一个 400 再要一遍。
      if (err instanceof VendorHttpError && err.status === 400) {
        throw new EarningsCalendarRejectedError(what, err);
      }
      // 5xx / 网络 / 401 等一律原样上抛：吞了会把「vendor 坏了」说成「预算用完了」。
      throw err;
    }

    const rows = res?.rows;
    if (!Array.isArray(rows)) {
      throw new Error(`[futu] ${what} 响应缺 rows[] (契约变更?)`);
    }
    if (typeof res?.count === 'number' && res.count !== rows.length) {
      throw new Error(
        `[futu] ${what} 行数与信封 count 不符 (疑截断): count=${res.count} rows=${rows.length}`,
      );
    }
    return rows;
  }
}
