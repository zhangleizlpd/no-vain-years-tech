import { Injectable } from '@nestjs/common';
import { vendorTimeToDate } from './futu-option-snapshot.adapter.js';
import { parseCanonicalSymbol } from './marketdata.rules.js';
import {
  REALTIME_QUOTE_MAX_SYMBOLS,
  type RealtimeQuote,
  type RealtimeQuotePort,
} from './realtime-quote.port.js';
import type { VendorHttpClient } from './vendor-http-client.js';

/**
 * 富途实时报价 adapter (061 T003, `REALTIME_QUOTE_PORT` 的 us 实现)。
 *
 * 打 shim 一个端点 (`services/futu-shim/`, Bearer 鉴权, 经 B↔C WireGuard 隧道):
 * GET `<shim>/option-snapshot?codes=US.PEP,US.AAPL` → 每个正股一行, 本 adapter 只取 `last_price`。
 *
 * ## 🚨🚨 与 `FutuOptionSnapshotAdapter` **共用同一个 `VendorHttpClient` 实例** (Guardrail 1)
 *
 * 两者打的是**同一个 shim capability** —— shim 侧限频闸是 per-capability 的单一桶
 * (`ratelimit.py` 的 `LIMITS["snapshot"] = (60, 30)`), 而客户端**每个 `VendorHttpClient` 实例
 * 各持一个独立令牌桶**。⇒ 给本 adapter 新起一个实例 = 两边合起来最多放出 **120 次/30 s**,
 * 是上游允许值的 2 倍, 撞 429。且两条通路在时间上**真的相邻**: 本片 tick 跑到美股收盘后
 * (北京 04:15 前后), 而美股 EOD 快照采集就在那之后。
 *
 * 这不是理论风险 —— `futu-shim.constraint-profile.ts` 记着同一个「桶满突发」病灶在 prod 上让
 * 链发现每 30 分钟顺延一次、12 只锚永远只采到前 2 只。⇒ 接线见 `marketdata.module.ts`:
 * 本 adapter 与快照 adapter 注入的是**同一个** `FUTU_OPTION_SNAPSHOT_HTTP_CLIENT`。
 *
 * ⚠️ **复用的是 client 实例, 不是 `FutuOptionSnapshotAdapter` 这个类** —— 它的 `getSnapshots`
 * 对空 `contractCodes` 前置拒绝, 语义是「取某标的的链」, 与本能力「一批正股的现价」不是一件事。
 *
 * ## 🚨 FR-020: 价只读 `last_price` 一列
 *
 * 响应里的 `pre_*` / `after_*` / `overnight_*` 三族 (盘前 / 盘后 / 夜盘) **登记但不消费**,
 * 本文件里 MUST NOT 出现对它们的读取。要不要呈现盘后价是**独立的产品决策** —— 顺手读进来
 * 就等于替它做了, 而做完之后没有任何断言会红。单测里有一条属性访问代理钉着这件事。
 *
 * ⚠️ 063 Phase 3.4 起另读 `update_time` 一列, 但它**不是价** —— 是 vendor 自报的「这个价是
 * 什么时候的」, 纯证据、零判据 (端口 `RealtimeQuote.vendorUpdateTime` 注释写着为什么不能拿它
 * 判新鲜度)。FR-020 管的是「呈现哪个价」, 与它正交。
 *
 * ## 只承担 us
 *
 * 非 us symbol **直接抛、零外呼** (照 `FutuOptionSnapshotAdapter` 的 `futuCode` 形态) ——
 * 静默返空会被上游记成「该标的今天没有报价」, 一次成功的空采集比一次响亮的失败难发现得多。
 * 「哪些市场有实时源」这件事本身由 `MarketRoutedRealtimeQuoteAdapter` 表达, 本类只兜底。
 *
 * ## 失败一律原样上抛, 不映射具名错误
 *
 * 与链 / 快照 / 财报三个 adapter 的「429 顺延 / 400 永久」二分**刻意不同** (同
 * `FutuMarketStateAdapter` 的处置): 本端口的调用方 (盘中投影 tick) 对任何「取不到报价」的结局
 * 处置完全一致 —— 保留旧值 + 计失败 (spec `state_branch` 4 / 9)。分成几个错误类型只会多出
 * 没人会走的分支。
 *
 * 真端点契约由 env-gated 真 vendor IT 校真 (`marketdata.futu-shim.vendor`, `RUN_MARKETDATA_IT`)
 * —— ⚠️ 该门恒 skip, 「测试全绿」对真契约不构成证据。
 */

/** market → 富途 code 前缀。**只有 us** (本片实时面只覆盖美股, spec「故意零覆盖」第 1 条)。 */
const MARKET_TO_FUTU_PREFIX: Record<string, string> = {
  us: 'US',
};

interface ShimEnvelope {
  as_of?: unknown;
  count?: unknown;
  rows?: unknown;
}

/**
 * 数值 → Decimal-safe string；缺失 / 非有限 → null。
 * 🚨 **不回落成 0**：0 是一个有意义的价, 用它表达「vendor 没给价」会让下游把一个不存在的
 * 报价当真, 而 0 距 W% 会把该锚顶到榜首。
 */
function numToString(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return v.trim();
  return null;
}

/** 非空字符串 → 原样 trim；其余 → null（禁默认值冒充）。 */
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function asRecord(row: unknown): Record<string, unknown> {
  return row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {};
}

@Injectable()
export class FutuRealtimeQuoteAdapter implements RealtimeQuotePort {
  constructor(
    private readonly http: VendorHttpClient,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /** 复杂度：**1 个 HTTP 请求**（切批在调用方）+ 解析 O(行数)。 */
  async fetchQuotes(symbols: readonly string[]): Promise<Map<string, RealtimeQuote>> {
    if (symbols.length === 0) {
      // 空批 = 调用方逻辑错 (工作集为空时本就不该调用), 永久性, 重试无意义。
      throw new Error('[futu] realtime-quote 入参 symbols 为空; 工作集为空时不该调用本端口');
    }
    if (symbols.length > REALTIME_QUOTE_MAX_SYMBOLS) {
      // 前置拒绝 = 零外呼。让 shim 去返 400 也对, 但那要先烧掉一次限频配额。
      throw new Error(
        `[futu] realtime-quote 单批 symbol 数 ${symbols.length} 超上限 ` +
          `${REALTIME_QUOTE_MAX_SYMBOLS}; 切分是调用方的事`,
      );
    }

    // vendor code → 入参 canonical symbol 的回查表: 结果键**原样回传入参那个串**, 且省掉一张
    // 反向前缀表 (响应里出现未请求的 code 时也能一眼判为「不是我要的」)。
    const codeToSymbol = new Map<string, string>();
    for (const symbol of symbols) codeToSymbol.set(this.futuCode(symbol), symbol);

    const params = new URLSearchParams({ codes: [...codeToSymbol.keys()].join(',') });
    const what = `realtime-quote ${symbols.length} symbols`;
    const { asOf, rows } = await this.fetchEnvelope(`/option-snapshot?${params.toString()}`, what);

    const quotes = new Map<string, RealtimeQuote>();
    for (const row of rows) {
      const raw = asRecord(row);
      const code = strOrNull(raw.code);
      const symbol = code === null ? undefined : codeToSymbol.get(code);
      if (symbol === undefined) continue; // 未请求的行 —— 忽略, 不混进结果
      const price = numToString(raw.last_price);
      // 行在但没价 (停牌 / 这一刻无成交) 与整行缺席同义: 静默省略, 上游保留旧值。
      if (price === null) continue;
      // 🚨 `update_time` 只作**证据**落到 `vendorUpdateTime`, 判据仍是信封 `as_of` (见端口注释)。
      quotes.set(symbol, {
        price,
        capturedAt: asOf,
        vendorUpdateTime: vendorTimeToDate(raw.update_time),
      });
    }

    if (quotes.size === 0) {
      // 全空 = 源故障 / 契约变更, **不是**「今天所有锚恰好都没有报价」。响亮地失败, 供上游
      // failstreak 熔断计数 (spec `state_branch` 9)。
      throw new Error(`[futu] ${what} 一条可用报价都没有 (源故障 / 契约变更?)`);
    }
    return quotes;
  }

  /** canonical `market:code` → 富途 code；非 us 直接抛（零外呼）。 */
  private futuCode(symbol: string): string {
    const parsed = parseCanonicalSymbol(symbol);
    const prefix = parsed ? MARKET_TO_FUTU_PREFIX[parsed.market] : undefined;
    if (!parsed || !prefix) {
      throw new Error(`[futu] realtime-quote 不支持 symbol "${symbol}" (本源仅承担 us)`);
    }
    return `${prefix}.${parsed.code}`;
  }

  /**
   * 打一次 shim + 信封校验。
   *
   * 三道闸同 `FutuOptionSnapshotAdapter.fetchEnvelope`: 缺 `rows[]` = 契约变更; `count` 与实收
   * 不符 = 传输层截断; **`as_of` 不可解析 = 采集墙钟没了** —— 拿本机时钟顶替会把「这一行是
   * 什么时候采的」变成「这段代码什么时候跑到这一句」, 而 90 秒的新鲜度闸判的正是前者。
   * 任一不过 → throw, **不返回半份数据**。
   */
  private async fetchEnvelope(
    path: string,
    what: string,
  ): Promise<{ asOf: Date; rows: unknown[] }> {
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
    const asOf = new Date(String(res?.as_of ?? ''));
    if (Number.isNaN(asOf.getTime())) {
      throw new Error(`[futu] ${what} 响应缺可解析的 as_of (采集墙钟, 契约变更?)`);
    }
    return { asOf, rows };
  }
}
