import { Injectable } from '@nestjs/common';
import type {
  TradingCalendarFetchResult,
  TradingCalendarSource,
} from './trading-calendar-source.port.js';
import type { VendorHttpClient } from './vendor-http-client.js';

/**
 * 腾讯指数日历源 adapter (044 L1, TRADING_CALENDAR_SOURCE 链首)。接替东财源 (端点被定向
 * 下线 + `robots.txt` `Disallow: /`, FR-007), 形态**同构**: 某市场代表性指数在某日有 bar
 * ⟺ 该市场当日开市 —— 换源不换语义。
 *
 * GET `/appstock/app/kline/kline?param=<symbol>,day,<from>,<to>,<limit>` (host
 * `web.ifzq.gtimg.cn`) —— **单 endpoint 罩三市场** (cn/hk/us)。响应
 * `data.<key>.day[]`, 每项首元素即 `YYYY-MM-DD`。复用共享 `VendorHttpClient` (限频 +
 * 退避 + 熔断由其透明执行, ADR-0047)。
 *
 * ★ **换源正当性 = prod 77 PoC 交叉校验实证** (2026-07-16): 腾讯 vs 库内旧东财源已服役数月
 * 的 `trading_day` (2026-01-01..07-14) —— hk 128/128 + cn 126/126 **双向零差异**。
 *
 * 🚨 **本 adapter 的三条实证铁律** (盲写必踩; plan Decision 2 / tasks Impl Guardrail 1/3/4):
 * 1. **`limit` 是「取最近 N 条」的截断器且硬上限 2000** → `planChunks` 分片规约。
 * 2. **响应 key ≠ 请求参数** (请求 `usDJI` → 响应回显 `us.DJI`) → `parseChunkDates` 取
 *    `Object.values(data)[0]`, **禁**按请求参数查 key。
 * 3. **`code:0` 不是成功信号** (超限错误与正常响应共用 code 0) → `parseChunkDates` 按 shape 判。
 *
 * 真端点 / symbol / 分片真调由 env-gated 真 vendor IT 校真 (`marketdata.tencent.vendor`,
 * `RUN_MARKETDATA_IT`) —— 此处仅解析 / 分片逻辑 (沿 015 全 adapter 范式)。
 */

/** market → 该市场交易日基准指数腾讯 symbol (指数有 bar = 开市)。 */
const MARKET_INDEX_SYMBOL: Record<string, string> = {
  cn: 'sh000001', // 上证综指 (A 股交易日基准)
  hk: 'hkHSI', // 恒生指数 (港股交易日基准)
  us: 'usDJI', // 道琼斯工业指数 (美股交易日基准; 🚨 响应 key 回显 `us.DJI`)
};

/**
 * 🚨 每片自然日上限 (FR-016)。vendor `limit` 硬上限 = **2000** (PoC 二分实证: 2000 ✓ /
 * 2001 ✗ —— 干净十进制, 佐证是 vendor **有意的服务端自保**而非缺陷); 取 1800 留 200 余量。
 * 上限**只由 `limit` 值触发, 与区间宽度无关** (实证: 7yr 区间 + limit=1827 ✓ / 2yr 区间 +
 * limit=2558 ✗)。
 */
const SAFE_CHUNK_DAYS = 1800;

const DAY_MS = 86_400_000;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` → UTC epoch ms。非法格式 **throw** —— 禁 NaN 静默退化成零分片 → 无声返空。 */
function parseIsoDate(date: string): number {
  const ms = ISO_DATE_RE.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(ms)) {
    throw new Error(`[tencent] trading-calendar 非法日期 "${date}" (须 YYYY-MM-DD)`);
  }
  return ms;
}

interface CalendarChunk {
  from: string;
  to: string;
  /** = 片内自然日数。「交易日数 ≤ 自然日数」恒成立 ⇒ **由构造保证永不截断**。 */
  limit: number;
}

/**
 * 🚨 **分片规约** (FR-016, PoC 实证产物 —— 初稿「铁律 `limit = windowDays`」已被证伪作废)。
 *
 * 闭区间 [from, to] 切成每片自然日数 ≤ `SAFE_CHUNK_DAYS`, 每片 `limit = 片内自然日数`,
 * 结果 concat + 按日期去重。**日常 30 天填充 = 1 片、行为零变**; seed CLI 10yr = 3 片
 * (1800+1800+53)。★ 等价性 PoC 实证: 7yr 单次 (limit=1827 → 1725 天) vs 2 片拼接 (1725 天)
 * —— 零丢失 / 零重复 / 片间零重叠。
 *
 * **禁**省略 `limit` (真端返空) / **禁**传 0 (真端返 1 天) / 🚨 **禁 `limit =
 * min(windowDays, CAP)`** —— 那会把「超限报错」换成「静默截断」, **响亮错误退化成无声错误**,
 * 正是本 feature 要消灭的那类。合理性闸 (T010) **拦不住中度截断** (limit=10 → 返 10 天 >
 * 下界 → 放行 → 写入残缺日历), 故截断只能**靠构造消除**, 不能指望闸兜底。
 *
 * 复杂度 O(⌈区间自然日数 / SAFE_CHUNK_DAYS⌉) —— 片数, 日常 = 1。
 */
function planChunks(from: string, to: string): CalendarChunk[] {
  const endMs = parseIsoDate(to);
  const chunks: CalendarChunk[] = [];
  for (let startMs = parseIsoDate(from); startMs <= endMs; ) {
    const chunkEndMs = Math.min(startMs + (SAFE_CHUNK_DAYS - 1) * DAY_MS, endMs);
    chunks.push({
      from: new Date(startMs).toISOString().slice(0, 10),
      to: new Date(chunkEndMs).toISOString().slice(0, 10),
      limit: Math.round((chunkEndMs - startMs) / DAY_MS) + 1,
    });
    startMs = chunkEndMs + DAY_MS;
  }
  return chunks;
}

interface KlineResponse {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

/**
 * 🚨🚨 **Guardrail 4 — `code:0` 不是成功信号** (FR-015, **本 feature 的核心防线**)。
 *
 * 超限错误响应 `{"code":0,"msg":"param error","data":[]}` 与正常响应 `{"code":0,"msg":""}`
 * **共用 code 0** ⇒「`code===0` 即成功」这个最自然的判据**是错的** (push2delay 同款陷阱在
 * 新源上重现)。**按 shape 判**: `data` 是**非数组对象** 且 `msg` 空 → 成功, 否则 **throw**。
 *
 * ⚠️ **禁返空** —— 返空则链降不了级, 等于再造一个毒饵。(`Object.values([])[0]` → `undefined`,
 * 盲取会崩或静默空。)
 */
function assertSuccessShape(
  res: KlineResponse | null | undefined,
  ctx: string,
): Record<string, unknown> {
  const msg = res?.msg;
  const data = res?.data;
  const msgEmpty = msg === undefined || msg === null || msg === '';
  const dataIsObject = data !== null && typeof data === 'object' && !Array.isArray(data);
  if (!msgEmpty || !dataIsObject) {
    throw new Error(
      `[tencent] trading-calendar 响应非成功形态 (code:0 不是成功信号): ${JSON.stringify({
        ctx,
        code: res?.code ?? null,
        msg: msg ?? null,
        dataIsArray: Array.isArray(data),
      })}`,
    );
  }
  return data as Record<string, unknown>;
}

/**
 * 🚨 **Guardrail 3 — 响应 key 回显 ≠ 请求参数**: 请求 `usDJI` → 响应 key `us.DJI` ⇒
 * **禁按请求参数查 key** (踩则静默返空 = 毒饵), 取 `data` 的唯一 value。
 *
 * **`day` 整体缺失 = vendor 改 schema** → throw; 静默返空才是毒饵 (`day: []` 则是「区间确无
 * 交易日」的合法表达, 由调用方原样传出)。
 */
function dayBarsOf(data: Record<string, unknown>, ctx: string): unknown[] {
  const block = Object.values(data)[0];
  if (block === null || typeof block !== 'object') {
    throw new Error(`[tencent] trading-calendar 响应缺 symbol 块: ${ctx}`);
  }
  const day = (block as { day?: unknown }).day;
  if (!Array.isArray(day)) {
    throw new Error(`[tencent] trading-calendar 响应缺 day[] (vendor 契约变更?): ${ctx}`);
  }
  return day;
}

/**
 * 单片响应 → 交易日集 (先过 Guardrail 4 的 shape 闸, 再过 Guardrail 3 的 key 回显)。
 * `day[]` 内坏项 (非数组 / 首元素非 ISO 日期) 跳过、不整体失败 (沿既有 adapter 容错范式)。
 */
function parseChunkDates(res: KlineResponse | null | undefined, ctx: string): string[] {
  const bars = dayBarsOf(assertSuccessShape(res, ctx), ctx);
  const dates: string[] = [];
  for (const bar of bars) {
    // 每项 `["YYYY-MM-DD", 开, 收, 高, 低, 量]` → 取首元素; 坏项跳过不整体失败。
    const date = Array.isArray(bar) && typeof bar[0] === 'string' ? bar[0] : '';
    if (ISO_DATE_RE.test(date)) dates.push(date);
  }
  return dates;
}

@Injectable()
export class TencentCalendarAdapter implements TradingCalendarSource {
  constructor(
    private readonly http: VendorHttpClient,
    private readonly baseUrl: string,
  ) {}

  async fetchTradingDates(
    market: string,
    from: string,
    to: string,
  ): Promise<TradingCalendarFetchResult> {
    const symbol = MARKET_INDEX_SYMBOL[market];
    if (!symbol) {
      // 未配指数基准的市场 → 明确抛 (不静默返空让某市场日历漏填, 比 fail-closed 更隐蔽)。
      throw new Error(`[tencent] trading-calendar 不支持市场 "${market}" (仅 cn/hk/us)`);
    }

    // 分片**串行**发 (片数 ≤ 3 且 VendorHttpClient 持双窗限频 → 无谓并发只会抢自己的配额)。
    // Set: 片间由构造零重叠, 去重是防御 (规约要求「concat + 按日期去重」); 片与片内均升序
    // ⇒ 插入序即升序。
    const dates = new Set<string>();
    for (const chunk of planChunks(from, to)) {
      const res = await this.http.request<KlineResponse>({
        url: this.klineUrl(symbol, chunk),
        method: 'GET',
      });
      for (const date of parseChunkDates(res, `${market} ${chunk.from}..${chunk.to}`)) {
        dates.add(date);
      }
    }
    return { dates: [...dates], servedBy: 'tencent' };
  }

  private klineUrl(symbol: string, chunk: CalendarChunk): string {
    return (
      `${this.baseUrl}/appstock/app/kline/kline` +
      `?param=${symbol},day,${chunk.from},${chunk.to},${chunk.limit}`
    );
  }
}
