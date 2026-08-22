/**
 * guest 通道标的查询的**输入校验**纯函数。无 I/O、无 DI、不 import Nest —— 与
 * `marketdata.rules.ts` 同为纯层; HTTP 语义 (400 / FORM_VALIDATION) 由
 * `marketdata-guest.controller.ts` 折。刻意返回判定结果而不是直接抛 HttpException:
 * 本模块的 rules 文件是纯的 (既有体例), 而这三条判据值得被 vitest 单测钉住, 不该只由
 * 起容器的 IT 覆盖。
 *
 * 🚨 **一律拒, 绝不归一** —— 政策同 `optionsdesk/anchor-import.rules.ts`, 但理由不同:
 * 那边是「归一会把上游 bug 藏成僵尸锚」; 这边是**调方手里的 code 本来就该是
 * `/instrument-codes` 原样返回的串**。把 `us:aos` 悄悄归一成 `us:AOS` 会掩盖「你用的不是
 * 我给你的串」, 而那正是调方需要知道的事。未命中一律走响应里的 `missing[]`, 失败可见。
 *
 * ⚠️ **本文件的市场白名单与字符集, 在 `services/guest-proxy/nginx/futu-shim-guest.conf.template`
 * 里各有一份独立文本 (`$arg_market` / `$arg_codes` 两道闸)。改一处必改另一处** ——
 * 两层各拒一次、不依赖对方 (体例同 059 的 `IMPORTABLE_MARKETS` ↔ nginx `^(us|hk):`)。
 * 钉住它俩不漂的是: 本文件的单测 + `marketdata-instrument-guest-query.it.spec.ts` 的
 * 三市场断言 (服务端一半) + `verify-guards.sh` 闸 9 的反例 (通道一半)。
 */

/**
 * 访客可枚举 / 可批量查询的市场白名单。
 *
 * 与行情面 (`/kline` / 期权三口) 的 **US-only** 刻意不同, 别当成不一致改齐: 那边收窄是因为
 * 每一发都在切富途的官方限额, 给访客多少 prod 就少多少; 本面读的是本机 PG 里的上市元数据,
 * 不打任何上游、不耗任何配额 —— 收窄只会让通道对一半标的不可用 (研报投递同样收三个市场)。
 */
export const QUERYABLE_MARKETS = ['cn', 'hk', 'us'] as const;

export type QueryableMarket = (typeof QUERYABLE_MARKETS)[number];

/** 枚举口的 `status` 取值。`all` = 不过滤 (含已退市)。 */
export const INSTRUMENT_STATUS_FILTERS = ['active', 'inactive', 'all'] as const;

export type InstrumentStatusFilter = (typeof INSTRUMENT_STATUS_FILTERS)[number];

/**
 * 🚨 缺省 `active` 是刻意的, 不是随手取的默认值。枚举口**只返裸 code、没有 status 字段**
 * ⇒ 混返在市与已退市的话, 调方拿到的列表里两者**在结构上不可区分**, 而它下一步就是拿这批
 * code 去做研究 / 送锚。要全量必须显式写 `status=all`。
 */
export const DEFAULT_INSTRUMENT_STATUS_FILTER: InstrumentStatusFilter = 'active';

/**
 * 批量口单发上限。**沿用 `/overview` 已在能力目录里公布的 ≤500** —— 同一条通道上少一个要
 * 记的数字, 比「按本端点重新算一个更优的数」值钱。us 全量 19.5k ⇒ 40 发批完。
 */
export const INSTRUMENT_BASICS_MAX_CODES = 500;

/** = `schema.prisma` 的 `instrument.code` 列宽。超长在这里拒, 别穿透到 PG 变 22001。 */
export const INSTRUMENT_CODE_MAX_LENGTH = 16;

/**
 * 单个 code 的合法字符集。
 *
 * 🚨 **这个集合是从 registry 实测来的, 不是想当然**。照 `/option-snapshot` 那道闸原样抄
 * `[A-Za-z0-9.,-]` 会把我们**自己刚发给访客的** 112 个 code 拒掉 (2026-08-22 实测 us 侧:
 * `_` 97 条如 `WFC_Z` / `YCY_WS`, `*` 13 条如 `BHVN*`, `/` 1 条 `PSUS/PS`, `-` 1 条;
 * 另有 7 条含小写如 `SPGIw`)。那种坏法最阴 —— 枚举口给的串, 批量口不认。
 *
 * `*` 与 `/` 看着像脏数据 (vendor universe 同步的产物), 但它们**确实在库里、也确实会被枚举口
 * 返回** ⇒ 过滤掉等于静默藏数据。要清洗是另一件事, 不在查询口这里做。
 *
 * ⚠️ 不含 `%`: 那是本闸的**全部意义** —— nginx 的 `$arg_*` 不解码, `%2C` 在通道层是一个
 * 不含字面逗号的串; 字符集闸先把 `%` 拒掉, 逗号切分才成立。
 */
export const INSTRUMENT_CODE_PATTERN = /^[A-Za-z0-9._/*-]+$/;

export type MarketParseResult =
  | { ok: true; market: QueryableMarket }
  | { ok: false; message: string };

export type StatusParseResult =
  | { ok: true; status: InstrumentStatusFilter }
  | { ok: false; message: string };

export type CodesParseResult = { ok: true; codes: string[] } | { ok: false; message: string };

export function isQueryableMarket(market: string): market is QueryableMarket {
  return (QUERYABLE_MARKETS as readonly string[]).includes(market);
}

/**
 * `market` query 参数解析 (必填)。O(1)。
 *
 * 大小写不对时报**写法**不合规而非市场越界 —— 体例同 `assertImportableTicker`: 报后者会让
 * 调方去查「港股是不是不支持了」, 而真正要改的是那两个字母的大小写。
 */
export function parseQueryableMarket(raw: string | undefined): MarketParseResult {
  const market = raw ?? '';
  if (market.length === 0) {
    return { ok: false, message: `must be one of: ${QUERYABLE_MARKETS.join(', ')}` };
  }
  if (!isQueryableMarket(market)) {
    if (isQueryableMarket(market.toLowerCase())) {
      return { ok: false, message: 'must be lowercase (cn / hk / us)' };
    }
    return { ok: false, message: `must be one of: ${QUERYABLE_MARKETS.join(', ')}` };
  }
  return { ok: true, market };
}

/** `status` query 参数解析 (可选, 缺省 {@link DEFAULT_INSTRUMENT_STATUS_FILTER})。O(1)。 */
export function parseInstrumentStatusFilter(raw: string | undefined): StatusParseResult {
  if (raw === undefined || raw === '')
    return { ok: true, status: DEFAULT_INSTRUMENT_STATUS_FILTER };
  if (!(INSTRUMENT_STATUS_FILTERS as readonly string[]).includes(raw)) {
    return { ok: false, message: `must be one of: ${INSTRUMENT_STATUS_FILTERS.join(', ')}` };
  }
  return { ok: true, status: raw as InstrumentStatusFilter };
}

/**
 * `codes` query 参数解析: 逗号分隔 → 去空段 → **保序去重**。O(n)。
 *
 * 保序去重而非排序: `missing[]` 按请求顺序回显, 调方对得上自己发出去的那一批。
 * 重复段不算错 (调方拼批时难免), 但只查一次也只回一次。
 */
export function parseInstrumentCodes(raw: string | undefined): CodesParseResult {
  const segments = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) {
    return { ok: false, message: 'must be a non-empty comma-separated code list' };
  }
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const code of segments) {
    if (code.length > INSTRUMENT_CODE_MAX_LENGTH) {
      return { ok: false, message: `code exceeds ${INSTRUMENT_CODE_MAX_LENGTH} chars: ${code}` };
    }
    if (!INSTRUMENT_CODE_PATTERN.test(code)) {
      return {
        ok: false,
        message: `code contains an illegal character (percent-encoding is rejected): ${code}`,
      };
    }
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  if (codes.length > INSTRUMENT_BASICS_MAX_CODES) {
    return { ok: false, message: `at most ${INSTRUMENT_BASICS_MAX_CODES} codes per request` };
  }
  return { ok: true, codes };
}
