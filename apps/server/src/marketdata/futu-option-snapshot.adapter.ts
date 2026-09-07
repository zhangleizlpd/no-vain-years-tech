import { Injectable, Logger } from '@nestjs/common';
import { parseCanonicalSymbol } from './marketdata.rules.js';
import {
  normalizeQuoteSide,
  strOrNullSentinelAware,
  tradedPriceOrNull,
  type QuoteSideForm,
} from './vendor-absence.rules.js';
import { exchangeTimeZone } from './session-clock.js';
import {
  OPTION_SNAPSHOT_MAX_CONTRACT_CODES,
  OptionSnapshotBudgetExhaustedError,
  OptionSnapshotRejectedError,
  type OptionSnapshotBatch,
  type OptionSnapshotPort,
  type OptionSnapshotQuery,
  type OptionSnapshotRow,
} from './option-snapshot.port.js';
import { TransientVendorError, VendorHttpError } from './vendor-http-client.js';
import { type ShimEnvelope, parseShimEnvelope } from './futu-shim-envelope.js';
import type { VendorHttpClient } from './vendor-http-client.js';

/**
 * 富途期权快照 adapter (047 T016, `OPTION_SNAPSHOT_PORT` 的唯一实现)。
 *
 * 打 shim 一个端点 (`services/futu-shim/`, Bearer 鉴权, 经 B↔C WireGuard 隧道):
 * GET `<shim>/option-snapshot?codes=US.PEP,US.PEP260918P130000,…` → 报价 + 全 greeks + IV +
 * OI/净OI + Vol/成交额 + vendor 时间戳 + `greeks_complete`。
 *
 * ## 标的 spot 并在**同一批**里, 不另发调用
 *
 * 标的自身的 code 由本 adapter 拼进 `codes` 首位 (`us:PEP` → `US.PEP`), 它的 `last_price` 与
 * 期权行一起回来。多一个 code 远比多一次调用便宜, 且把「谁是标的」的判断留在调用方 ——
 * 端口入参给的是 canonical `underlyingSymbol`, vendor 前缀方言不外泄。
 *
 * ## 批切分不在这里 (同 `FutuOptionChainAdapter` 对 ≤30 天窗的处置)
 *
 * shim 对 > 400 codes **直接 400、绝不截断**。本 adapter **一次调用 = 一批**, 只做**前置
 * 拒绝**(零外呼): 同一段边界逻辑写两遍必漂移, 而真超了 shim 会以 400 说出来。
 *
 * ## 承担 us + hk (066 T01 起)
 *
 * 未登记市场的 symbol **直接抛、零外呼** —— 静默返空会被同步管线记成「该标的今天没有快照」,
 * 一次成功的空采集比一次响亮的失败难发现得多。
 *
 * 港股是 066 加进来的第二个市场: 网关本身市场无关 (市场参数对着 SDK 枚举白名单校验、代码原样
 * 透传), 本端点对港股返回的**键集与美股逐字相同** (2026-08-23 实取 133 行 = 132 期权 + 1 标的,
 * 原始响应落在 `__fixtures__/hk-option-snapshot-00700-2026-08-23.json`); 港股独有的
 * `option_net_open_interest` / `option_contract_nominal_value` / `option_owner_lot_multiplier`
 * 在美股行上同样在场, 只是取值不同 ⇒ server 侧要改的只有下面那张前缀表。
 *
 * ## 🚨 期权行归属标的只能靠 `stock_owner` (plan §A11)
 *
 * 港股合约标识的词根是**交易所助记符** (`HK.TCH260828C220000` 里的 `TCH`), **不是**标的数字
 * 代码 `00700` ⇒ **从合约标识反推不出标的**。美股 `US.PEP260918P130000` 那种「词根即 ticker」
 * 是巧合不是契约 —— `underlyingCode` 一律只取 vendor 给的 `stock_owner` (标的自己那行没有它,
 * 它就是标的)。
 *
 * ## 🚨 greeks 缺失的行照常返回 (FR-007 的下游承接)
 *
 * 实值腿 bid 跌破内在价值 ⇒ IV 无解 ⇒ 五个 greeks 与 IV **一起**没有 (实测 227/2150 行,
 * 99.5% 是深实值腿) —— 是数学固有现象不是脏数据。shim 侧已保证不丢行并带 `greeks_complete`,
 * 本 adapter 同样**一行不丢**, 只把缺失落成 `null` (禁 0 冒充)。
 *
 * 真端点契约由 env-gated 真 vendor IT 校真 (`marketdata.futu-shim.vendor`,
 * `RUN_MARKETDATA_IT`) —— ⚠️ 该门恒 skip, 「测试全绿」对真契约不构成证据。
 */

/** market → 富途 code 前缀。未登记的市场 = 本源不承担（见文件头「承担 us + hk」）。 */
const MARKET_TO_FUTU_PREFIX: Record<string, string> = {
  us: 'US',
  hk: 'HK',
};

/** `get_market_snapshot` 期权行的 greeks 块 (与 shim `mappers.GREEK_FIELDS` 同集合)。 */
const GREEK_FIELDS = [
  'option_implied_volatility',
  'option_delta',
  'option_gamma',
  'option_vega',
  'option_theta',
  'option_rho',
] as const;

/** `YYYY-MM-DD HH:mm:ss`(可带 `T` / 毫秒) 的宽松匹配。 */
const NAIVE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

/**
 * 数值 → Decimal-safe string；缺失 / 非有限 → null。
 * 🚨 **不回落成 0**：0 张 OI 与「vendor 没给 OI」是两件事, 后者被当成前者会让活跃度排名把
 * 一条无数据的腿排在真实的 0 张之后。
 */
function numToString(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return v.trim();
  return null;
}

/**
 * 有限**正整数** → number；其余 (缺失 / 带外哨兵 / 非整数 / ≤ 0) → null。
 *
 * 两段判: 先由 {@link numToString} 挡住带外缺失与字符串哨兵 (`Number('N/A')` 为 NaN), 再校
 * 「正整数」—— 股数是「一张合约多少股」, 0 / 负 / 小数一律是脏值, 而它会被读端直接乘进单笔
 * 权利金 (076 FR-005)。
 *
 * 📌 T002 (链发现 adapter) 落地后会出现同形态的第二处, 届时可考虑抽公共 helper; 此刻那边还
 * 没有, 🚫 不为将来的复用去改另一个 adapter。
 */
function positiveIntOrNull(v: unknown): number | null {
  const s = numToString(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function asRecord(row: unknown): Record<string, unknown> {
  return row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {};
}

/**
 * 某 IANA 时区在给定瞬间相对 UTC 的偏移 (ms)。DST 由 `Intl` 处理, 无需手工分夏令冬令。
 * 复杂度 O(1)。
 */
function timeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const at = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour: '2-digit'` + hour12:false 在午夜会给出 24, Date.UTC 自行进位, 无需特判。
  const asIfUtc = Date.UTC(
    at('year'),
    at('month') - 1,
    at('day'),
    at('hour'),
    at('minute'),
    at('second'),
  );
  return asIfUtc - utcMs;
}

/**
 * vendor 的**无时区**时间串 → `Date`, 按**该行所属市场的交易所时区**解释 (066 T17)。
 * 不合形态 → null (缺时间戳不阻断落库: 该列 nullable, 且不参与快照侧任何判据)。复杂度 O(1)。
 *
 * 🚨 **时区跟市场走, 不是固定美东**: vendor 用**交易所当地时刻**打这个戳 —— 美股行给美东
 * (p3b E21 实测「1333/2150 行停在 09:30 ET」= 美股期权开盘那一刻; E32 实测正股 PEP 的
 * `04:59:43` 正是探针在 ET 盘前执行的那一秒), 港股行给港股当地 (2026-08-23 实取: 期权行
 * `09:30:00`、标的行 `16:07:49`, 均为 HKT)。整列按美东读会让港股这一列**偏 12 小时**,
 * 而**这个错不会红** —— 它只让一个时间戳悄悄偏移。
 *
 * 🚨 **market → 时区取 `session-clock` 的那一份表, MUST NOT 在本文件里再存一份**: 两份表
 * 一旦漂开, 表现就是某个市场的时间戳悄悄差几小时 (`check-time-semantics.ts` Rule A 拦的正是
 * 这个形状)。
 *
 * ⚠️ 该列在快照侧只作诊断: **报价新鲜度一律取采集时刻** (E33 两条硬纪律之一) ——
 * `update_time` 是**最后成交时刻**, 做市商挪报价时它纹丝不动。
 *
 * 🚨 **导出是为了给 `FutuRealtimeQuoteAdapter` 用, 别再抄第二份** (063 Phase 3.4): 两个
 * adapter 打的是**同一个** shim 端点 (`/option-snapshot`)、解析的是**同一个** `update_time`
 * 字段 —— 时区与解析规约属于 vendor 而不属于某一个 adapter, 抄第二份就等着两边对时区的理解
 * 各自漂移。
 */
export function vendorTimeToDate(v: unknown, market: string): Date | null {
  const parts = NAIVE_DATETIME_RE.exec(typeof v === 'string' ? v : '');
  if (parts === null) return null;
  const naiveUtc = Date.UTC(
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
    Number(parts[4]),
    Number(parts[5]),
    Number(parts[6]),
  );
  // 先当 UTC 读, 再减去该瞬间的本地偏移 (偏移在两侧相差不到一天, 单次校正足够)。
  return new Date(naiveUtc - timeZoneOffsetMs(naiveUtc, exchangeTimeZone(market)));
}

/**
 * greeks 完整性标记。shim 已算好 (`mappers.mark_greeks_completeness`), 本函数只在**该字段
 * 缺席**时兜底现算 —— 缺席只可能是 shim 尚未部署新版本 (Guardrail 15: `/healthz` 绿 ≠ 新端点在),
 * 那时把期权行标成 `false` 会让「这只票 greeks 缺失」的告警全面误报。
 *
 * 非期权行恒 `null` (不适用), 与 shim 同口径。复杂度 O(1)。
 */
function greeksCompleteOf(raw: Record<string, unknown>, isOption: boolean): boolean | null {
  if (!isOption) return null;
  const flag = raw.greeks_complete;
  if (typeof flag === 'boolean') return flag;
  return GREEK_FIELDS.every((f) => raw[f] !== null && raw[f] !== undefined);
}

/**
 * 把一侧的 `inconsistent` 记进批级累加器。**不改值、不丢行** —— 只留痕。
 *
 * 🚨 它是「哨兵理论破裂」的**唯一信号**: 富途没有文档化缺失时返什么
 * (2026-08-24 核官方 `get-market-snapshot` 页), 所以「(price, vol) 成对为 0 = 无挂单」
 * 是**从数据反推**的。反推出来的东西会过期, 且过期时不报错。O(1)。
 */
function collectInconsistent(
  sink: string[],
  code: string,
  side: 'bid' | 'ask',
  form: QuoteSideForm,
  price: string | null,
  size: string | null,
): void {
  if (form !== 'inconsistent') return;
  sink.push(`${code} ${side}=${price ?? 'null'}/${size ?? 'null'}`);
}

/**
 * 单行 `option-snapshot` → {@link OptionSnapshotRow}。
 *
 * **坏行 throw、不跳过**: 唯一的必填是 `code` —— 没有它这行无从归属, 而静默丢一行 = 那条腿
 * 当日的快照永久缺席 (vendor 不提供历史交易日的期权快照, 出处见 `option-snapshot.port.ts`),
 * 且完整性核对的分子跟着少一个,
 * 缺口自我掩盖。其余字段缺失一律 `null` (缺 greeks 是固有现象, 见类注释)。
 */
function parseSnapshotRow(
  row: unknown,
  ctx: string,
  market: string,
  inconsistent: string[],
): OptionSnapshotRow {
  const raw = asRecord(row);
  const code = strOrNullSentinelAware(raw.code);
  if (code === null) {
    throw new Error(
      `[futu] option-snapshot 行缺 code (契约变更?): ${ctx} 行=${JSON.stringify(row)}`,
    );
  }
  const isOption = raw.option_valid === true;
  // 🚨 盘口两侧**成对**归一 (#172): `(price, vol)` 同时为 0 = 该侧无挂单 ⇒ null。
  // 单看价格会误杀合法零价买盘 (OPRA: 「Zero in the bid price field represents a
  // valid Bid Price」), 见 vendor-absence.rules.ts。
  const bidSide = normalizeQuoteSide(raw.bid_price, raw.bid_vol);
  const askSide = normalizeQuoteSide(raw.ask_price, raw.ask_vol);
  collectInconsistent(inconsistent, code, 'bid', bidSide.form, bidSide.price, bidSide.size);
  collectInconsistent(inconsistent, code, 'ask', askSide.form, askSide.price, askSide.size);
  return {
    code,
    isOption,
    // 非期权行没有 stock_owner —— 它自己就是标的。
    underlyingCode: isOption ? strOrNullSentinelAware(raw.stock_owner) : null,
    bid: bidSide.price,
    ask: askSide.price,
    bidSize: bidSide.size,
    askSize: askSide.size,
    // 🚨 成交价类走 `tradedPriceOrNull` 而非 `numToString` (#258): 富途用带内哨兵 `0` 表达
    // 「没有这个价」, 而 `numToString` 只认带外缺失 ⇒ 那道闸在这个 vendor 上恒不触发。
    // 官方书面确认期权成交价恒为正, 故单列判即可 (盘口价为何必须成对见该函数注释)。
    last: tradedPriceOrNull(raw.last_price),
    prevClose: tradedPriceOrNull(raw.prev_close_price),
    iv: numToString(raw.option_implied_volatility),
    delta: numToString(raw.option_delta),
    gamma: numToString(raw.option_gamma),
    vega: numToString(raw.option_vega),
    theta: numToString(raw.option_theta),
    rho: numToString(raw.option_rho),
    openInterest: numToString(raw.option_open_interest),
    netOpenInterest: numToString(raw.option_net_open_interest),
    volume: numToString(raw.volume),
    turnover: numToString(raw.turnover),
    vendorUpdateTime: vendorTimeToDate(raw.update_time, market),
    greeksComplete: greeksCompleteOf(raw, isOption),
    // 🚨 **只期权行取** (076 FR-003): 正股行的同名字段是板手数 —— 取错了每张美股合约会被
    // 算成 1 股。判据复用本文件既有的 `isOption` (`option_valid`) 而不是另立一条
    // `option_type !== 'N/A'`: 同一个问题写两遍必漂移, 而实取里两者对同一行同判 (标的行
    // `option_valid: false` ∧ `option_type: 'N/A'`)。
    // EVIDENCE: 期权行 `lot_size` = 每张合约正股股数, 正股行是板手数 —— fixture
    // `__fixtures__/hk-option-snapshot-00700-2026-08-23.json` (HK.00700 标的行 `lot_size` 100
    // = 该股板手, 132 期权行同为 100) 与 `specs/076-option-contract-size/spec.md`「取证」
    // §2 PoC-A (美股正股行 `lot_size = 1`)。
    contractSize: isOption ? positiveIntOrNull(raw.lot_size) : null,
  };
}

const SNAPSHOT_LOGGER = new Logger('FutuOptionSnapshotAdapter');

@Injectable()
export class FutuOptionSnapshotAdapter implements OptionSnapshotPort {
  constructor(
    private readonly http: VendorHttpClient,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /** 复杂度：**1 个 HTTP 请求**（批切分在调用方）+ 解析 O(行数)。 */
  async getSnapshots(query: OptionSnapshotQuery): Promise<OptionSnapshotBatch> {
    const { underlyingSymbol, contractCodes } = query;
    if (contractCodes.length === 0) {
      // 空批 = 调用方逻辑错 (工作集为空时本就不该调用), 永久性, 重试无意义。
      throw new OptionSnapshotRejectedError(`${underlyingSymbol}: contractCodes 为空`);
    }
    if (contractCodes.length > OPTION_SNAPSHOT_MAX_CONTRACT_CODES) {
      // 前置拒绝 = 零外呼。让 shim 去返 400 也对, 但那要先烧掉一次限频配额。
      throw new OptionSnapshotRejectedError(
        `${underlyingSymbol}: 单批合约数 ${contractCodes.length} 超上限 ` +
          `${OPTION_SNAPSHOT_MAX_CONTRACT_CODES} (标的自身占一个位); 切分是调用方的事`,
      );
    }

    // 标的自身放首位: 它是 spot 的来源, 与期权行同批返回 (不另发调用)。
    const { market, futuCode } = this.vendorRef(underlyingSymbol);
    const codes = [futuCode, ...contractCodes];
    const params = new URLSearchParams({ codes: codes.join(',') });
    const what = `option-snapshot ${underlyingSymbol} ${contractCodes.length} codes`;
    const res = await this.fetchEnvelope(`/option-snapshot?${params.toString()}`, what);

    // 盘口归一化的「不一致」累加器 —— 批级报一次, 不逐行刷屏。
    const inconsistent: string[] = [];
    const rows = res.rows.map((row) => parseSnapshotRow(row, what, market, inconsistent));
    if (inconsistent.length > 0) {
      // 🚨 这条 WARN 的意义不是「有脏数据」, 是「**我们对 vendor 的假设可能已经不成立**」。
      // 行已照常入库 (原值未改) —— 猜错的代价远高于留一行待查数据。
      SNAPSHOT_LOGGER.warn(
        `[futu] 盘口形态与哨兵假设不符 ${inconsistent.length} 侧 (原值已保留、行未丢): ` +
          `${what}; 前 10 侧 = ${inconsistent.slice(0, 10).join(', ')}`,
      );
    }
    return {
      asOf: res.asOf,
      // 一批 = 一个标的 ⇒ 整批同市场, vendor 的行内时刻按该市场的交易所时区解释。
      rows,
    };
  }

  /**
   * canonical `market:code` → 富途 code **与它所属的 market**；未登记市场直接抛（零外呼）。
   * market 一并返回是因为行内 `update_time` 的时区跟市场走（066 T17）。
   */
  private vendorRef(symbol: string): { market: string; futuCode: string } {
    const parsed = parseCanonicalSymbol(symbol);
    const prefix = parsed ? MARKET_TO_FUTU_PREFIX[parsed.market] : undefined;
    if (!parsed || !prefix) {
      throw new Error(`[futu] option-snapshot 不支持 symbol "${symbol}" (本源仅承担 us / hk)`);
    }
    return { market: parsed.market, futuCode: `${prefix}.${parsed.code}` };
  }

  /**
   * 打一次 shim + 失败语义映射; 信封校验委托 {@link parseShimEnvelope} (三道闸的单点)。
   *
   * 🚨 **本端点为什么在意闸③**: `as_of` 不可解析 = 落库的 `quote_as_of` 没了。任一闸不过 →
   * throw, **不返回半份数据**。
   */
  private async fetchEnvelope(
    path: string,
    what: string,
  ): Promise<{ asOf: Date; rows: unknown[] }> {
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
        throw new OptionSnapshotBudgetExhaustedError(what, err);
      }
      // 400：批量超上限 / 非法 code —— 永久事实，重试只是把同一个 400 再要一遍。
      if (err instanceof VendorHttpError && err.status === 400) {
        throw new OptionSnapshotRejectedError(what, err);
      }
      // 5xx / 网络 / 401 等一律原样上抛：吞了会把「vendor 坏了」说成「预算用完了」。
      throw err;
    }

    return parseShimEnvelope(res, what);
  }
}
