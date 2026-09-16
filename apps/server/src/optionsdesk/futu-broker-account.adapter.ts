import { BrokenCircuitError } from 'cockatiel';
import { Prisma } from '../generated/prisma/client';
import type { MarketdataConfig } from '../config/marketdata.config';
import { vendorTimeToDate } from '../marketdata/futu-option-snapshot.adapter';
import { parseShimRows, type ShimEnvelope } from '../marketdata/futu-shim-envelope';
import { refusingCollectionPort } from '../marketdata/refusing-collection.adapter';
import {
  TransientVendorError,
  VendorHttpClient,
  VendorHttpError,
} from '../marketdata/vendor-http-client';
import {
  BROKER_ACCOUNT_PORT,
  BrokerAccountSelectionError,
  BrokerInfrastructureError,
  type BrokerAccountPort,
  type BrokerAccountSummary,
  type BrokerComboLeg,
  type BrokerDealRow,
  type BrokerEvent,
  type BrokerEventBatch,
  type BrokerEventQuery,
  type BrokerOrderEventRow,
  type BrokerOrderRow,
  type BrokerPositionRow,
  type BrokerRawRow,
  type BrokerTradeWindow,
} from './broker-account.port';
import { parseBrokerCode, parseComboLegs, type BrokerMarket } from './broker-code.rules';
import type { BrokerTradeSide } from './broker-opened-at.rules';
import { FUTU_SHIM_TRADE_PROFILE } from './futu-shim-trade.constraint-profile';

/**
 * 富途券商账户 adapter (082 T012, `BROKER_ACCOUNT_PORT` 的 live 实现; plan D3)。
 *
 * 打 shim 的只读交易面 (`services/futu-shim/`, Bearer 鉴权, 统一信封 `{as_of, count, rows}`):
 * `/trade/accounts` · `/trade/positions?market` · `/trade/deals?market&start&end` ·
 * `/trade/orders?market&start&end`, 以及既有 `/option-snapshot` 取 `stock_owner`。
 *
 * 本文件只做**规范化**: 券商列名 → port 类型、浮点 → `Prisma.Decimal`、无时区时间串 →
 * `Date` (一律经 `vendorTimeToDate`, 🚫 不另写解析, Guardrail 4)、组合单腿串 → 腿码
 * (`parseComboLegs`)。不过滤、不判正股、不写库。
 *
 * 🚨 **坏行 throw、不跳过** (同 `FutuOptionSnapshotAdapter`): 静默丢一笔成交会让对账「补回
 * 条数」与开仓时间推算一起悄悄出错。报错文案只带 `code`, **不整行 stringify** —— 行里可能
 * 带账户号列 (SC-010: 日志也算)。
 */

const FUTU_MARKET: Readonly<Record<BrokerMarket, string>> = { us: 'US', hk: 'HK' };

/**
 * 事件行的市场列取值 → canonical。推送行的市场列名是 `trd_market`, 历史订单查询是
 * `order_market` (084 FR-015 / branch 13) —— 取错字段会让整条数据归错市场, **且不报错**。
 */
const MARKET_BY_FUTU: Readonly<Record<string, BrokerMarket>> = { US: 'us', HK: 'hk' };

/**
 * 成交行币种按市场补。
 * EVIDENCE: 成交行没有 `currency` 列 —— 082 POC-1 ② (2026-09-13 维护者采集的原始输出);
 * 与 futu SDK `trade/trade_query.py` `parse_deal` 的行字典无该键一致 (futu-shim venv)。
 */
const DEAL_CURRENCY_BY_MARKET: Readonly<Record<BrokerMarket, string>> = { us: 'USD', hk: 'HKD' };

const DEAL_SIDES: ReadonlySet<string> = new Set<BrokerTradeSide>([
  'BUY',
  'BUY_BACK',
  'SELL',
  'SELL_SHORT',
]);

/** EVIDENCE: futu SDK 缺值哨兵 `NoneDataValue = 'N/A'` —— `futu/trade/trade_query.py:12` (futu-shim venv)。 */
const VENDOR_NA = 'N/A';

/** shim `/option-snapshot` 单批上限, 与 `futu_shim/app.py` `SNAPSHOT_MAX_CODES = 400` 同值 (超限 shim 400 拒绝、不截断)。 */
const STOCK_OWNER_BATCH = 400;

function asRecord(row: unknown): Record<string, unknown> {
  return row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {};
}

/** 行拷贝并剔除账户号列 (FR-002)。shim 已剔除一次, 这里无条件再剔 —— 防 shim 回退版本漏出。 */
function withoutAccountId(record: Record<string, unknown>): BrokerRawRow {
  const raw = { ...record };
  delete raw.acc_id;
  return raw;
}

/** 非空串; 空白 / `N/A` / 非串 ⇒ null。 */
function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' || s === VENDOR_NA ? null : s;
}

/** 非空串, **保留** `N/A` 原值 (订单方向 / 状态这类只留痕、不参与判据的枚举列)。 */
function textOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** 数值 → Decimal (经十进制串, 不经二进制浮点运算); 缺失 / 非有限 / 哨兵 ⇒ null。 */
function decimalOrNull(v: unknown): Prisma.Decimal | null {
  if (typeof v === 'number') return Number.isFinite(v) ? new Prisma.Decimal(String(v)) : null;
  const s = strOrNull(v);
  return s !== null && Number.isFinite(Number(s)) ? new Prisma.Decimal(s) : null;
}

/**
 * 券商成交号 → 数字串。JSON number 只收安全整数: 超过 2^53 的号在 JSON 解析时已丢精度,
 * 收下它会让两笔不同成交撞同一个唯一键 ⇒ 宁可 null (必填处随即 throw) 也不落错号。
 * EVIDENCE: 成交号为纯数字 —— 2026-09-14 本修复实取港机 shim 全窗口 (2024-09-01..2026-09-14, US + HK)
 * 干跑: 全部成交行的 `deal_id` 均为 17–19 位数字串。
 */
function dealIdOrNull(v: unknown): string | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? String(v) : null;
  const s = strOrNull(v);
  return s !== null && /^\d+$/.test(s) ? s : null;
}

/** 订单号形态: 仅字母数字, 长度上限 = 库列宽 `VarChar(64)` (`BrokerOrder.orderId` / `BrokerDeal.orderId`)。 */
const ORDER_ID_RE = /^[A-Za-z0-9]{1,64}$/;

/**
 * 券商订单号 → 原样串 (只收串, 不收 JSON number)。不合形态 ⇒ null (订单行必填处随即 throw;
 * 成交行上可选, 为 null 即不关联)。
 * EVIDENCE: 订单号**不是纯数字** —— 18 位「大写字母 + 数字」、首字符为字母: 维护者 2026-09-14 港机只读探针
 * 返回的全部订单与成交行 `order_id`; 082 POC-1 原始输出 (2026-09-13 维护者采集) 全部订单号非纯数字;
 * 2026-09-14 本修复同上全窗口干跑: 全部订单与成交行的 `order_id` 均匹配 `^[A-Za-z0-9]+$` 且长 18。
 * 按纯数字校验时 prod 回填报「缺可用的 order_id」, 成交行上的订单号则被静默置 null。
 */
function orderIdOrNull(v: unknown): string | null {
  const s = strOrNull(v);
  return s !== null && ORDER_ID_RE.test(s) ? s : null;
}

function required<T>(
  value: T | null,
  field: string,
  what: string,
  row: Record<string, unknown>,
): T {
  if (value === null) {
    throw new Error(`[futu] ${what} 行缺可用的 ${field} (契约变更?): code=${String(row.code)}`);
  }
  return value;
}

/**
 * EVIDENCE: 空头持仓 `qty` 为负 —— 082 POC-1 (2026-09-13 维护者采集的原始输出: 空头持仓
 * 均为负数)。数量**原样**保留符号与单位 (期权 = 张, plan D8), 不在此取绝对值或乘合约股数。
 */
function parsePosition(row: unknown, market: BrokerMarket, what: string): BrokerPositionRow {
  const r = asRecord(row);
  return {
    market,
    code: required(strOrNull(r.code), 'code', what, r),
    qty: required(decimalOrNull(r.qty), 'qty', what, r),
    marketValue: decimalOrNull(r.market_val),
    costPrice: decimalOrNull(r.cost_price),
    averageCost: decimalOrNull(r.average_cost),
    currentPrice: decimalOrNull(r.nominal_price),
    currency: strOrNull(r.currency),
    raw: withoutAccountId(r),
  };
}

/** 成交方向不在已知值域 ⇒ throw: 方向错一笔, 开仓时间推算的累计带符号数量整条链都错 (FR-016)。 */
function parseDeal(row: unknown, market: BrokerMarket, what: string): BrokerDealRow {
  const r = asRecord(row);
  const side = strOrNull(r.trd_side);
  if (side === null || !DEAL_SIDES.has(side)) {
    throw new Error(
      `[futu] ${what} 成交方向不在已知值域: ${String(r.trd_side)} code=${String(r.code)}`,
    );
  }
  return {
    market,
    dealId: required(dealIdOrNull(r.deal_id), 'deal_id', what, r),
    orderId: orderIdOrNull(r.order_id),
    code: required(strOrNull(r.code), 'code', what, r),
    side: side as BrokerTradeSide,
    qty: required(decimalOrNull(r.qty), 'qty', what, r),
    price: required(decimalOrNull(r.price), 'price', what, r),
    currency: DEAL_CURRENCY_BY_MARKET[market],
    tradedAt: required(vendorTimeToDate(r.create_time, market), 'create_time', what, r),
    raw: withoutAccountId(r),
  };
}

/**
 * 订单行里**两路共用**的字段。腿单独留给各自的调用方: 查询路径拿到的是文本腿码, 推送路径
 * 拿到的是结构化腿 —— 差别只此一处, 其余字段两路同名同义 (084 D2)。
 */
function parseOrderFields(
  r: Record<string, unknown>,
  market: BrokerMarket,
  what: string,
): Omit<BrokerOrderRow, 'comboLegCodes'> {
  return {
    market,
    orderId: required(orderIdOrNull(r.order_id), 'order_id', what, r),
    code: required(strOrNull(r.code), 'code', what, r),
    side: required(textOrNull(r.trd_side), 'trd_side', what, r),
    orderType: strOrNull(r.order_type),
    qty: required(decimalOrNull(r.qty), 'qty', what, r),
    price: decimalOrNull(r.price),
    status: required(textOrNull(r.order_status), 'order_status', what, r),
    currency: strOrNull(r.currency),
    vendorCreatedAt: vendorTimeToDate(r.create_time, market),
    vendorUpdatedAt: required(vendorTimeToDate(r.updated_time, market), 'updated_time', what, r),
    raw: withoutAccountId(r),
  };
}

function parseOrder(row: unknown, market: BrokerMarket, what: string): BrokerOrderRow {
  const r = asRecord(row);
  return { ...parseOrderFields(r, market, what), comboLegCodes: parseComboLegs(r.combo_legs) };
}

// ── 推送事件的规范化 (084 T005; plan D2) ────────────────────────────────────

/** `/trade/events` 在统一信封 (`as_of` / `count` / `rows`) 之外多带的三个字段。 */
interface TradeEventsEnvelope extends ShimEnvelope {
  epoch?: unknown;
  next_seq?: unknown;
  dropped?: unknown;
}

/** 事件行的市场: 取 `trd_market`。🚫 `order_market` —— 那是历史订单查询的列名 (FR-015)。 */
function eventMarket(r: Record<string, unknown>, what: string): BrokerMarket {
  const raw = strOrNull(r.trd_market);
  const market = raw === null ? undefined : MARKET_BY_FUTU[raw];
  if (market === undefined) {
    throw new Error(
      `[futu] ${what} 事件行市场不在已知值域: ${String(r.trd_market)} code=${String(r.code)}`,
    );
  }
  return market;
}

/**
 * 事件行的组合单腿 → 结构化腿 (FR-020)。
 *
 * 🚨 **MUST NOT 经 `parseComboLegs`** (`broker-code.rules.ts:99-107`): 那是给**历史查询路径的
 * 文本**腿用的, 对数组入参先 `filter(typeof === 'string')` ⇒ 喂对象**静默返回 `[]`**, 组合单的
 * 标的归属就此消失且不报错。推送路径的腿由 shim 从 `ComboLeg` 对象展开成结构化 dict, 直接读。
 *
 * 腿缺 `code` ⇒ throw (同本文件「坏行 throw、不跳过」的纪律): 静默丢一条腿会让组合单只按剩下
 * 那条腿归属, 比整单报错更难发现。复杂度 O(腿数)。
 */
function eventComboLegs(raw: unknown, what: string): BrokerComboLeg[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((leg) => {
    const r = asRecord(leg);
    const code = strOrNull(r.code);
    if (code === null) {
      throw new Error(`[futu] ${what} 组合单腿缺可用的 code (契约变更?)`);
    }
    return { code, side: textOrNull(r.trd_side) };
  });
}

function parseOrderEvent(r: Record<string, unknown>, what: string): BrokerOrderEventRow {
  const market = eventMarket(r, what);
  const comboLegs = eventComboLegs(r.combo_legs, what);
  const fields = parseOrderFields(r, market, what);
  return {
    ...fields,
    comboLegCodes: comboLegs.map((leg) => leg.code),
    comboLegs,
    // 🚨 只有**判不出单一合约**的码才是组合单的合成码 (`parseBrokerCode` 对 `US.ZQY-COMBO` 这类
    // 带分隔符的合成码返回 null)。不加这一半的话, 普通单腿单的空腿列表会让**每一单**都被标成
    // 待回查, 回查量与订单量同阶 —— 那不是 FR-020 要的。
    legsPending: comboLegs.length === 0 && parseBrokerCode(fields.code) === null,
  };
}

/**
 * 一条事件行 → port 事件。**靠事件源显式给的 `event_type` 分流**, 🚫 靠「哪些字段恰好在」猜:
 * 订单与成交的字段集不同 (branch 13), 猜字段集会在券商加列那天静默错分。复杂度 O(列数)。
 */
function parseEvent(row: unknown, what: string): BrokerEvent {
  const r = asRecord(row);
  const seq = r.seq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) {
    throw new Error(`[futu] ${what} 事件行缺可用的 seq (契约变更?)`);
  }
  const eventType = strOrNull(r.event_type);
  if (eventType === 'order') return { kind: 'order', seq, order: parseOrderEvent(r, what) };
  if (eventType === 'deal') {
    return { kind: 'deal', seq, deal: parseDeal(r, eventMarket(r, what), what) };
  }
  throw new Error(`[futu] ${what} 事件行 event_type 不在已知值域: ${String(r.event_type)}`);
}

export class FutuBrokerAccountAdapter implements BrokerAccountPort {
  constructor(
    // CROSS-CONTEXT-SYNC: 复用 marketdata 的 vendor 传输类 (限频 / 退避 / 熔断纪律, ADR-0047), 非业务
    // 调用; 实例由本 ctx 以自己的约束档自建, 与 marketdata 零共享状态 (plan D3)。
    private readonly http: VendorHttpClient,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async getAccountSummary(): Promise<BrokerAccountSummary> {
    const what = 'trade/accounts';
    const rows = await this.fetchRows('/trade/accounts', what);
    const r = asRecord(rows[0]);
    if (rows.length !== 1 || typeof r.matched !== 'number' || !Array.isArray(r.trdmarket_auth)) {
      throw new Error(
        `[futu] ${what} 响应形状不符 (应恰 1 行 {trdmarket_auth[], matched}; 契约变更?)`,
      );
    }
    return {
      trdmarketAuth: r.trdmarket_auth.filter((m): m is string => typeof m === 'string'),
      matched: r.matched,
    };
  }

  async fetchPositions(market: BrokerMarket): Promise<BrokerPositionRow[]> {
    const what = `trade/positions ${market}`;
    const params = new URLSearchParams({ market: FUTU_MARKET[market] });
    const rows = await this.fetchRows(`/trade/positions?${params.toString()}`, what);
    return rows.map((row) => parsePosition(row, market, what));
  }

  async fetchDeals(market: BrokerMarket, window: BrokerTradeWindow): Promise<BrokerDealRow[]> {
    const what = `trade/deals ${market} ${window.start}..${window.end}`;
    const rows = await this.fetchRows(`/trade/deals?${this.windowParams(market, window)}`, what);
    return rows.map((row) => parseDeal(row, market, what));
  }

  async fetchOrders(market: BrokerMarket, window: BrokerTradeWindow): Promise<BrokerOrderRow[]> {
    const what = `trade/orders ${market} ${window.start}..${window.end}`;
    const rows = await this.fetchRows(`/trade/orders?${this.windowParams(market, window)}`, what);
    return rows.map((row) => parseOrder(row, market, what));
  }

  /**
   * 复杂度: ⌈n / 400⌉ 个 HTTP 请求 + 解析 O(n)。
   *
   * 🚨 **调用方只许传在挂合约**: shim 把 vendor 任何 `ret != OK` 映射成 502, 一个券商不认的码
   * 会让**整批**失败 (EVIDENCE: `marketdata/vendor-http-client.ts` `TransientVendorError` 注释
   * #199 记录的 `未知股票 ALB260828C100000` 整批 502), 而 502 在本 adapter 是基础设施失败 ⇒
   * 会被当成可重试错误反复重打 (plan D5 「在挂合约批量」)。
   */
  async fetchStockOwners(
    market: BrokerMarket,
    codes: readonly string[],
  ): Promise<Map<string, string | null>> {
    const owners = new Map<string, string | null>(codes.map((code) => [code, null]));
    const prefix = `${FUTU_MARKET[market]}.`;
    const unique = [...owners.keys()];
    const foreign = unique.find((code) => !code.startsWith(prefix));
    if (foreign !== undefined) {
      throw new Error(`[futu] option-snapshot: ${foreign} 不属于市场 ${market} (调用方逻辑错)`);
    }
    for (let i = 0; i < unique.length; i += STOCK_OWNER_BATCH) {
      const batch = unique.slice(i, i + STOCK_OWNER_BATCH);
      const what = `option-snapshot stock_owner ${market} ${batch.length} codes`;
      const params = new URLSearchParams({ codes: batch.join(',') });
      for (const row of await this.fetchRows(`/option-snapshot?${params.toString()}`, what)) {
        const r = asRecord(row);
        const code = strOrNull(r.code);
        if (code === null || !owners.has(code)) continue;
        const owner = parseBrokerCode(strOrNull(r.stock_owner) ?? '');
        owners.set(code, owner?.kind === 'stock' && owner.market === market ? owner.ticker : null);
      }
    }
    return owners;
  }

  /**
   * 读推送事件缓冲 (084 FR-004)。shim 立即返回当前缓冲内容, **不挂起**。
   *
   * 走 {@link fetchEnvelope} 而非 `fetchRows`: 本端点的信封比 rows 型端点多 `epoch` /
   * `next_seq` / `dropped`, 而这三个字段是断档判定 (`broker-event-cursor.rules.ts`) 的**全部**
   * 依据 —— 丢掉任一个都判不出缓冲绕回。复杂度 O(rows × 列数)。
   */
  async fetchEvents(query: BrokerEventQuery | null): Promise<BrokerEventBatch> {
    const what = 'trade/events';
    const params = new URLSearchParams();
    if (query !== null) {
      params.set('epoch', query.epoch);
      params.set('after_seq', String(query.afterSeq));
    }
    const search = params.toString();
    const res = await this.fetchEnvelope<TradeEventsEnvelope>(
      search === '' ? '/trade/events' : `/trade/events?${search}`,
      what,
    );
    const rows = parseShimRows(res, what);
    const epoch = strOrNull(res.epoch);
    if (epoch === null) {
      throw new Error(`[futu] ${what} 响应缺可用的 epoch (契约变更?)`);
    }
    if (typeof res.next_seq !== 'number' || !Number.isSafeInteger(res.next_seq)) {
      throw new Error(`[futu] ${what} 响应缺可用的 next_seq (契约变更?)`);
    }
    // 🚨 缺 `dropped` 不按 false 兜底: 那会把「缓冲已绕回」读成一切正常, 丢掉的成交永不出现。
    if (typeof res.dropped !== 'boolean') {
      throw new Error(`[futu] ${what} 响应缺可用的 dropped (契约变更?)`);
    }
    return {
      epoch,
      rows: rows.map((row) => parseEvent(row, what)),
      nextSeq: res.next_seq,
      dropped: res.dropped,
    };
  }

  private windowParams(market: BrokerMarket, window: BrokerTradeWindow): string {
    return new URLSearchParams({
      market: FUTU_MARKET[market],
      start: window.start,
      end: window.end,
    }).toString();
  }

  /**
   * 打一次 shim + 失败语义映射 (判别口径见 `BrokerInfrastructureError` 注释)。
   * 🚨 信封校验**不在这里**: 留给调用方按端点形状各自做 (rows 型走 `parseShimRows`,
   * 事件端点另取三个字段), 与原先「映射归映射、校验归 `parseShimRows`」的分工一致。
   */
  private async fetchEnvelope<T extends ShimEnvelope = ShimEnvelope>(
    path: string,
    what: string,
  ): Promise<T> {
    try {
      return await this.http.request<T>({
        url: `${this.baseUrl}${path}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      // 409 只由交易路由的选户闸返回 (`futu_shim/app.py` `_on_account_selection`)。
      if (err instanceof VendorHttpError && err.status === 409) {
        throw new BrokerAccountSelectionError(what);
      }
      // 5xx / 429 / 网络 / 超时 在客户端重试用尽后到这里; 熔断开启抛的 BrokenCircuitError
      // 不是 TransientVendorError (vendor-http-client.ts 类注释 § 熔断口径), 须单独认。
      if (err instanceof TransientVendorError || err instanceof BrokenCircuitError) {
        throw new BrokerInfrastructureError(what, err);
      }
      // 其余 4xx (400 参数 / 401 鉴权) = 确定性错误, 原样上抛, 按数据类处理、不重试。
      throw err;
    }
  }

  /** 信封校验委托 `parseShimRows` (shim 信封三道闸的单点, 🚫 不另抄一份)。 */
  private async fetchRows(path: string, what: string): Promise<unknown[]> {
    return parseShimRows(await this.fetchEnvelope(path, what), what);
  }
}

/**
 * `BROKER_ACCOUNT_PORT` 的 provider 工厂 (模块层 `useFactory`)。mock 分支收在这里, 调用处写不出。
 *
 * `kind=mock` ⇒ 拒绝壳, 任一方法**一调即抛** `MockCollectionRefusedError` (FR-018; 复用 marketdata
 * 采集口的同一个壳, 054 纪律: 同步产出必然落库, dev 机上不许造出任何券商数据)。
 * `kind=live` ⇒ 自建 `VendorHttpClient` (marketdata 不导出其客户端实例, plan D3)。
 */
export function createBrokerAccountPort(cfg: MarketdataConfig): BrokerAccountPort {
  if (cfg.kind === 'mock') {
    return refusingCollectionPort<BrokerAccountPort>(
      BROKER_ACCOUNT_PORT.description ?? 'BROKER_ACCOUNT_PORT',
    );
  }
  return new FutuBrokerAccountAdapter(
    new VendorHttpClient(FUTU_SHIM_TRADE_PROFILE),
    cfg.futuShimUrl,
    cfg.futuShimToken,
  );
}
