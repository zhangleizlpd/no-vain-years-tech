import { Injectable } from '@nestjs/common';
import { parseCanonicalSymbol } from './marketdata.rules.js';
import type {
  UnderlyingIvHistoryPoint,
  UnderlyingIvHistoryQuery,
  UnderlyingIvPort,
  UnderlyingIvSnapshot,
} from './underlying-iv.port.js';
import type { VendorHttpClient } from './vendor-http-client.js';

/**
 * 富途标的级 IV adapter (046, `UNDERLYING_IV_PORT` 的唯一实现)。
 *
 * 打 shim 两个端点 (`services/futu-shim/`, Bearer 鉴权, 经 B↔C WireGuard 隧道):
 * - GET `<shim>/overview?codes=US.PEP,US.VICI` → 当日 IV / iv_rank / iv_percentile + HV 阶梯
 * - GET `<shim>/his-vol?code=US.PEP&start&end` → IV / HV / 标的价 日序列
 *
 * ## 只承担 us
 *
 * 富途期权面本片只覆盖美股锚 (FR-023), 非 us symbol **直接抛、零外呼** —— 静默返空会被
 * 同步管线记成「该标的今天没有 IV」, 一次成功的空采集比一次响亮的失败难发现得多。
 *
 * ## 分批在这里, 切窗不在这里
 *
 * `overview` 单批上限 500 codes 是 **vendor 硬限**, shim 侧超限返 400。批量拆分是「把一次
 * 逻辑调用翻译成 vendor 能接受的物理调用」= 协议翻译, 属 adapter 的活。
 *
 * 而 `his-vol` 的 ≤364 天跨度上限**不在这里切**: 回填的窗口序列由 `splitBackfillWindows`
 * (T004 纯函数) 产出、按窗逐次调用本端口。两处都实现切分 = 同一段边界逻辑两份实现, 必漂移;
 * 且真切错了 shim 会以 400 说出来 (它不静默截断)。同 `FutuEodBarAdapter` 对分页的处置。
 *
 * ## vendor 错误映射
 *
 * 不自造错误分类: 传输纪律由 `VendorHttpClient` + `FUTU_SHIM_PROFILE` 承担 ——
 * 429/5xx/网络错 → `TransientVendorError` (退避重试 + 熔断), 4xx → `VendorHttpError` (永久,
 * 不重试)。本 adapter 只负责**不把它们吞掉**。
 *
 * 真端点契约由 env-gated 真 vendor IT 校真 (`marketdata.futu-shim.vendor`,
 * `RUN_MARKETDATA_IT`) —— ⚠️ 该门恒 skip, 「测试全绿」对真契约不构成证据。
 */

/** market → 富途 code 前缀。**只有 us**（期权面本片只覆盖美股锚）。 */
const MARKET_TO_FUTU_PREFIX: Record<string, string> = {
  us: 'US',
};

/**
 * `overview` 单次请求的 code 上限（vendor 官方值，p3b E9）。超限 shim 返 400，
 * 故这里必须**先切批**而不是赌它宽容。
 */
export const OVERVIEW_MAX_CODES_PER_CALL = 500;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface ShimEnvelope {
  count?: unknown;
  rows?: unknown;
}

/**
 * 数值 → Decimal-safe string；缺失 / 非有限 → null。
 * 🚨 **不回落成 0**：IV 分位上 0 的意思是「一年最低」，与「没有值」方向相反。
 */
function numToString(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return v.trim();
  return null;
}

function asRecord(row: unknown): Record<string, unknown> {
  return row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {};
}

/**
 * 单行 `overview` → {@link UnderlyingIvSnapshot}。
 *
 * `code` 缺失 / 不在本批请求内 → **throw**：前者是契约变更，后者说明我们把哪一批的响应
 * 认到了另一批头上 —— 两种都会让 IV 落到错的标的名下，而落错比没落更难发现。
 */
function parseOverviewRow(
  row: unknown,
  canonicalByFutuCode: Map<string, string>,
): UnderlyingIvSnapshot {
  const raw = asRecord(row);
  const futuCode = typeof raw.code === 'string' ? raw.code : '';
  const symbol = canonicalByFutuCode.get(futuCode);
  if (symbol === undefined) {
    throw new Error(
      `[futu] overview 行的 code 不在本批请求内 (契约变更 / 批次错配?): ` +
        `code=${JSON.stringify(raw.code)} 本批=${[...canonicalByFutuCode.keys()].join(',')}`,
    );
  }
  return {
    symbol,
    iv: numToString(raw.iv),
    ivRank: numToString(raw.iv_rank),
    ivPercentile: numToString(raw.iv_percentile),
    preIv: numToString(raw.pre_iv),
    hv30: numToString(raw.hv_30d),
    hv30Percentile: numToString(raw.hv_30d_percentile),
    hv60: numToString(raw.hv_60d),
    hv60Percentile: numToString(raw.hv_60d_percentile),
    hv90: numToString(raw.hv_90d),
    hv90Percentile: numToString(raw.hv_90d_percentile),
    hv120: numToString(raw.hv_120d),
    hv120Percentile: numToString(raw.hv_120d_percentile),
    hv365: numToString(raw.hv_365d),
    hv365Percentile: numToString(raw.hv_365d_percentile),
    callVolume: numToString(raw.call_volume),
    putVolume: numToString(raw.put_volume),
    callOi: numToString(raw.call_open_interest),
    putOi: numToString(raw.put_open_interest),
  };
}

/**
 * 单行 `his-vol` → {@link UnderlyingIvHistoryPoint}。
 *
 * `time` 是「交易日时间字符串」，实测形态可带时间后缀 ⇒ 取前 10 位再校验，两种形态都吃得下。
 * **坏行 throw、不跳过**：静默丢一行 = 序列里凭空少一个交易日，而 IVP 是靠这条序列的**长度**
 * 判「窗口够不够」的（<252 交易日 ⇒ 不可算），少几行会让不可算与可算的分界悄悄挪位。
 */
function parseHistoryRow(row: unknown, ctx: string): UnderlyingIvHistoryPoint {
  const raw = asRecord(row);
  const time = typeof raw.time === 'string' ? raw.time : '';
  const date = time.slice(0, 10);
  if (!ISO_DATE_RE.test(date)) {
    throw new Error(
      `[futu] his-vol 行不合契约 (须 time=YYYY-MM-DD...; 契约变更?): ${ctx} 行=${JSON.stringify(row)}`,
    );
  }
  return {
    date,
    iv: numToString(raw.iv),
    hv: numToString(raw.hv),
    underlyingPrice: numToString(raw.underlying_price),
  };
}

@Injectable()
export class FutuUnderlyingIvAdapter implements UnderlyingIvPort {
  constructor(
    private readonly http: VendorHttpClient,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /**
   * 复杂度：`ceil(n / 500)` 个 HTTP 请求，解析 O(行数)。
   *
   * 分批**顺序**发：`VendorHttpClient` 的双窗令牌桶本就会把并发排成队，并发只是把队列
   * 堆深、让熔断更早跳，换不来吞吐。
   */
  async getIvSnapshots(symbols: readonly string[]): Promise<UnderlyingIvSnapshot[]> {
    const canonicalByFutuCode = new Map<string, string>();
    for (const symbol of symbols) {
      const parsed = parseCanonicalSymbol(symbol);
      const prefix = parsed ? MARKET_TO_FUTU_PREFIX[parsed.market] : undefined;
      if (!parsed || !prefix) {
        throw new Error(`[futu] overview 不支持 symbol "${symbol}" (本源仅承担 us)`);
      }
      canonicalByFutuCode.set(`${prefix}.${parsed.code}`, symbol);
    }
    if (canonicalByFutuCode.size === 0) return [];

    const futuCodes = [...canonicalByFutuCode.keys()];
    const out: UnderlyingIvSnapshot[] = [];
    for (let i = 0; i < futuCodes.length; i += OVERVIEW_MAX_CODES_PER_CALL) {
      const batch = futuCodes.slice(i, i + OVERVIEW_MAX_CODES_PER_CALL);
      const params = new URLSearchParams({ codes: batch.join(',') });
      const rows = await this.fetchRows(
        `/overview?${params.toString()}`,
        `overview ${batch.length} codes`,
      );
      // 逐批 map 用**本批**的 code 表：跨批混淆会把 IV 记到别的标的名下。
      const batchIndex = new Map(
        batch.map((code) => [code, canonicalByFutuCode.get(code) as string]),
      );
      for (const row of rows) out.push(parseOverviewRow(row, batchIndex));
    }
    return out;
  }

  /** 复杂度：**1 个 HTTP 请求**（分页由 shim 内部跟到尽头）+ 解析 O(行数) + 排序 O(n log n)。 */
  async getIvHistoryRange(query: UnderlyingIvHistoryQuery): Promise<UnderlyingIvHistoryPoint[]> {
    const parsed = parseCanonicalSymbol(query.symbol);
    const prefix = parsed ? MARKET_TO_FUTU_PREFIX[parsed.market] : undefined;
    if (!parsed || !prefix) {
      throw new Error(`[futu] his-vol 不支持 symbol "${query.symbol}" (本源仅承担 us)`);
    }

    const params = new URLSearchParams({ code: `${prefix}.${parsed.code}` });
    if (query.from) params.set('start', query.from);
    if (query.to) params.set('end', query.to);

    const ctx = `${query.symbol} ${query.from ?? '-'}..${query.to ?? '-'}`;
    const rows = await this.fetchRows(`/his-vol?${params.toString()}`, `his-vol ${ctx}`);
    // 🚨 vendor 侧**按日期降序**下发（p3 2026-07-29 实测）；端口契约是升序。
    return rows
      .map((row) => parseHistoryRow(row, ctx))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * 打一次 shim 并做信封校验。
   *
   * 两道闸都不是形式主义：缺 `rows[]` = 契约变更；`count` 与实收不符 = 传输层截断
   * （同 `FutuEodBarAdapter` / universe adapter 的对账闸）。任一不过 → throw，
   * **不返回半份数据**。
   */
  private async fetchRows(path: string, what: string): Promise<unknown[]> {
    const res = await this.http.request<ShimEnvelope>({
      url: `${this.baseUrl}${path}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` },
    });

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
