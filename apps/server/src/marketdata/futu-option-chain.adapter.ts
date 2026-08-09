import { Injectable } from '@nestjs/common';
import { parseCanonicalSymbol } from './marketdata.rules.js';
import {
  OptionChainBudgetExhaustedError,
  OptionChainRejectedError,
  type OptionChainPort,
  type OptionChainWindowQuery,
  type OptionContractStatic,
  type OptionExpiry,
} from './option-chain.port.js';
import { TransientVendorError, VendorHttpError } from './vendor-http-client.js';
import type { VendorHttpClient } from './vendor-http-client.js';

/**
 * 富途期权链 adapter (047 T014, `OPTION_CHAIN_PORT` 的唯一实现)。
 *
 * 打 shim 两个端点 (`services/futu-shim/`, Bearer 鉴权, 经 B↔C WireGuard 隧道):
 * - GET `<shim>/option-expirations?code=US.PEP` → 全部可得到期日 (含 LEAPS, 无裁剪)
 * - GET `<shim>/option-chain?code=US.PEP&start&end&option_type=ALL` → 单窗合约静态属性
 *
 * ## 只承担 us
 *
 * 期权面只覆盖美股锚 (FR-023 / FR-032), 非 us symbol **直接抛、零外呼** —— 静默返空会被
 * 同步管线记成「该标的今天没有链」, 一次成功的空采集比一次响亮的失败难发现得多。
 *
 * ## 🚨 `option_type=ALL` 写死在这里 (Guardrail 3 / plan D-DATA-3)
 *
 * 端口不接受筛选入参, adapter 也不提供「只要 PUT」的旁路。链接口**一次返双边、调用数完全
 * 不变**, 在这里滤掉一分钱不省, 却会给 CALL 侧留下**不可回补**的永久缺口 (vendor 不提供
 * 历史交易日的链快照)。M4 的 wheel / CC 要 CALL 时买不回来。
 *
 * ## 🚨 非标合约照常返回 (Guardrail 4 / p3b E7·E19·E20)
 *
 * 调整后 root (`VICI1` —— GDEN 被 VICI 并购后 OCC 调整的期权遗骸) 逐字段原样映射,
 * 只是 `isStandard=false`。**排除只发生在下游选约层** —— 在采集端滤掉 = 证据没了且不可回补,
 * 且 CBOE 侧那个 OCC 正则 (`^([A-Z]+)(\d{6})([CP])(\d{8})$`) 静默丢非标就是这个坑的既有实例
 * (p3b E12)。
 *
 * ## 分窗不在这里
 *
 * `get_option_chain` 的 ≤30 天窗上限由 `option-chain-window.rules.ts` 的
 * `planOptionChainWindows` 切, 本 adapter **一次调用 = 一个窗**。两处都实现切分 = 同一段边界
 * 逻辑两份实现, 必漂移; 且真切错了 shim 会以 400 说出来 (它不静默截断)。同
 * `FutuUnderlyingIvAdapter` 对 `his-vol` 窗口的处置。
 *
 * ## vendor 错误映射 (T014 的承重设计)
 *
 * 传输纪律仍由 `VendorHttpClient` + `FUTU_SHIM_OPTION_CHAIN_PROFILE` 承担。本 adapter 只把
 * 两类**调用方必须区别对待**的结局提成具名错误: 429 → {@link OptionChainBudgetExhaustedError}
 * (顺延重入队, 不耗 attempts) · 400 → {@link OptionChainRejectedError} (永久, 重试无意义)。
 * 其余原样上抛 —— 吞成上面任一类会把「vendor 坏了」说成「预算用完了」。
 *
 * 真端点契约由 env-gated 真 vendor IT 校真 (`marketdata.futu-shim.vendor`,
 * `RUN_MARKETDATA_IT`) —— ⚠️ 该门恒 skip, 「测试全绿」对真契约不构成证据。
 */

/** market → 富途 code 前缀。**只有 us**（期权面只覆盖美股锚）。 */
const MARKET_TO_FUTU_PREFIX: Record<string, string> = {
  us: 'US',
};

/** 富途 code 前缀 → canonical market（上表的反向，落库 `option_contract.market` 用）。 */
const FUTU_PREFIX_TO_MARKET: Record<string, string> = {
  US: 'us',
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 富途合约代码 = `<市场>.<root><YYMMDD><C|P><行权价数字>`（实测 `US.PEP260918P130000`）。
 *
 * 🚨 **root 段用惰性匹配从尾部锚定**，不能写成 `^([A-Z]+)`：调整后 root 自带尾数字
 * （`VICI1`），字母类正则会把它切成 `VICI` 并把 `1` 算进日期段 —— 那正是 CBOE 采集器
 * 静默丢非标的成因（p3b E12）。惰性 root + 固定长度的 `\d{6}[CP]` 让 `VICI1260918P30000`
 * 只有一种合法切法（`VICI` + `126091` 后跟 `8` 不是 C/P，回溯即得 `VICI1`）。
 */
const FUTU_OPTION_CODE_RE = /^(.+?)(\d{6})([CP])(\d+)$/;

interface ShimEnvelope {
  count?: unknown;
  rows?: unknown;
}

/**
 * 数值 → Decimal-safe string；缺失 / 非有限 → null。
 * 🚨 **不回落成 0**：行权价 0 是一个能被下游当真的价格，与「没有值」方向相反。
 */
function numToString(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return v.trim();
  return null;
}

/** 有限数值 → number；缺失 / 非有限 → null（DTE 用；**不回落 0**，0 = 今天到期）。 */
function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** 非空字符串 → 原样 trim；其余（null / 空串 / 非字符串）→ null（禁默认值冒充）。 */
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function asRecord(row: unknown): Record<string, unknown> {
  return row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {};
}

/**
 * 富途 code（`US.PEP` / `US.PEP260918P130000`）→ `{ canonical market, 前缀后的符号段 }`；
 * 前缀缺失或非已知市场 → null（交调用方 throw，不猜）。
 */
function splitFutuCode(code: string): { market: string; symbol: string } | null {
  const dot = code.indexOf('.');
  const market = dot > 0 ? FUTU_PREFIX_TO_MARKET[code.slice(0, dot)] : undefined;
  return market === undefined || dot === code.length - 1
    ? null
    : { market, symbol: code.slice(dot + 1) };
}

/** 日期列（实测可带时间后缀）→ `YYYY-MM-DD`；不合形态返 null 交调用方 throw。 */
function dateOrNull(v: unknown): string | null {
  const date = (typeof v === 'string' ? v : '').slice(0, 10);
  return ISO_DATE_RE.test(date) ? date : null;
}

/**
 * 是否标准合约。**两个信号取合取**（p3b §4.5「识别」列的两条判据）：
 *
 * 1. `option_standard_type`（vendor 直给，实测 `STANDARD` / `NON_STANDARD`）；
 * 2. root 尾数字 —— 美股正股 ticker 不以数字结尾，`<TICKER>1` 恰恰是 OCC 对被并购公司期权的
 *    改名规则（p3b E20：GDEN → `VICI1`）。
 *
 * 取合取而非只信 vendor：**误标成标准**会让一张 90 股乘数的合约混进选约层并被按 ×100 算出
 * 一个看起来正常的错数（p3b §4.5 第 3 条点名的后果）；误标成非标只是少一个本就不可交易的候选。
 * 不对称性一边倒。字段缺失 → 只用 root 判据（**不默认 true**）。
 *
 * 复杂度 O(1)。
 */
export function isStandardContract(standardType: string | null, root: string): boolean {
  const vendorSaysStandard = standardType === null || standardType.toUpperCase() === 'STANDARD';
  return vendorSaysStandard && !/\d$/.test(root);
}

/**
 * 单行 `option-expirations` → {@link OptionExpiry}。
 *
 * **坏行 throw、不跳过**：静默丢一个到期日 = 那一整批腿这辈子都不会被任何一次请求问起
 * （分窗的输入就是这份列表），而链调用本身全都会成功、日志全绿。
 */
function parseExpiryRow(row: unknown): OptionExpiry {
  const raw = asRecord(row);
  const expiryDate = dateOrNull(raw.strike_time);
  if (expiryDate === null) {
    throw new Error(
      `[futu] option-expirations 行不合契约 (须 strike_time=YYYY-MM-DD...; 契约变更?): ` +
        `行=${JSON.stringify(row)}`,
    );
  }
  return {
    expiryDate,
    expirationCycle: strOrNull(raw.expiration_cycle),
    daysToExpiry: numOrNull(raw.option_expiry_date_distance),
  };
}

/**
 * 单行 `option-chain` → {@link OptionContractStatic}。
 *
 * **坏行 throw、不跳过**：这里每行是 SDK 直出的 dict，缺字段只可能是契约变更，而静默丢一行 =
 * 那条腿的快照永久缺席（后续覆盖率核对的分母也跟着少一个，缺口自我掩盖）。
 */
function parseChainRow(row: unknown, ctx: string): OptionContractStatic {
  const raw = asRecord(row);
  const code = strOrNull(raw.code);
  const contract = code === null ? null : splitFutuCode(code);
  const owner = code === null ? null : splitFutuCode(strOrNull(raw.stock_owner) ?? '');
  const expiryDate = dateOrNull(raw.strike_time);
  const strikePrice = numToString(raw.strike_price);
  const optionType = strOrNull(raw.option_type)?.toUpperCase();
  const parts = contract === null ? null : FUTU_OPTION_CODE_RE.exec(contract.symbol);

  if (
    code === null ||
    contract === null ||
    owner === null ||
    parts === null ||
    expiryDate === null ||
    strikePrice === null ||
    (optionType !== 'PUT' && optionType !== 'CALL')
  ) {
    throw new Error(
      `[futu] option-chain 行不合契约 (须 code=<US>.<root><YYMMDD><C|P><strike> + ` +
        `stock_owner + strike_time + 数值 strike_price + option_type∈{PUT,CALL}; 契约变更?): ` +
        `${ctx} 行=${JSON.stringify(row)}`,
    );
  }

  const root = parts[1];
  return {
    market: contract.market,
    // 原样含市场前缀 —— 这串正是喂回 /option-snapshot 的键 (schema 幂等键 (market, code) 同口径)。
    code,
    root,
    underlyingSymbol: `${owner.market}:${owner.symbol}`,
    expiryDate,
    strikePrice,
    optionType,
    // vendor 原样存 (WEEK / MONTH · PM / AM): 换算一次就再也说不清库里那个值是谁的口径。
    expirationCycle: strOrNull(raw.expiration_cycle),
    settlementMode: strOrNull(raw.option_settlement_mode),
    isStandard: isStandardContract(strOrNull(raw.option_standard_type), root),
  };
}

@Injectable()
export class FutuOptionChainAdapter implements OptionChainPort {
  constructor(
    private readonly http: VendorHttpClient,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /** 复杂度：**1 个 HTTP 请求** + 解析 O(到期日数) + 排序 O(n log n)。 */
  async getExpiryDates(symbol: string): Promise<OptionExpiry[]> {
    const params = new URLSearchParams({ code: this.futuCode(symbol, 'option-expirations') });
    const rows = await this.fetchRows(
      `/option-expirations?${params.toString()}`,
      `option-expirations ${symbol}`,
    );
    // vendor **未承诺**有序；端口契约是升序。假设有序一旦不成立，分窗会静默漏掉到期日
    // （`planOptionChainWindows` 自己也归一化，此处翻正是让端口契约本身成立，不是重复防御）。
    return rows
      .map((row) => parseExpiryRow(row))
      .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  }

  /** 复杂度：**1 个 HTTP 请求**（窗切分在调用方）+ 解析 O(合约数)。 */
  async getChainWindow(query: OptionChainWindowQuery): Promise<OptionContractStatic[]> {
    const params = new URLSearchParams({
      code: this.futuCode(query.symbol, 'option-chain'),
      start: query.start,
      end: query.end,
      // 🚨 恒 ALL —— 见类注释「option_type=ALL 写死在这里」。
      option_type: 'ALL',
    });
    const ctx = `${query.symbol} ${query.start}..${query.end}`;
    const rows = await this.fetchRows(`/option-chain?${params.toString()}`, `option-chain ${ctx}`);
    return rows.map((row) => parseChainRow(row, ctx));
  }

  /** canonical `market:code` → 富途 code；非 us 直接抛（零外呼）。 */
  private futuCode(symbol: string, what: string): string {
    const parsed = parseCanonicalSymbol(symbol);
    const prefix = parsed ? MARKET_TO_FUTU_PREFIX[parsed.market] : undefined;
    if (!parsed || !prefix) {
      throw new Error(`[futu] ${what} 不支持 symbol "${symbol}" (本源仅承担 us)`);
    }
    return `${prefix}.${parsed.code}`;
  }

  /**
   * 打一次 shim + 信封校验 + 失败语义映射。
   *
   * 两道信封闸都不是形式主义：缺 `rows[]` = 契约变更；`count` 与实收不符 = 传输层截断
   * （同 `FutuEodBarAdapter` / `FutuUnderlyingIvAdapter` 的对账闸）。任一不过 → throw，
   * **不返回半份数据** —— 半份链在下游读作「那段本来就没有合约」，与真缺口无法区分。
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
        throw new OptionChainBudgetExhaustedError(what, err);
      }
      // 400：窗越界 / 非法 code —— 永久事实，重试只是把同一个 400 再要一遍。
      if (err instanceof VendorHttpError && err.status === 400) {
        throw new OptionChainRejectedError(what, err);
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
