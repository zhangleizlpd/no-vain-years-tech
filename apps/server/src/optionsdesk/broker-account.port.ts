import type { Prisma } from '../generated/prisma/client';
import type { BrokerMarket } from './broker-code.rules';
import type { BrokerTradeSide } from './broker-opened-at.rules';

/**
 * 082 **券商账户 port** —— 券商只读查询面的接缝 (plan D3; ADR-0043 §4「3rd-party SDK 留 port」)。
 *
 * 存在理由: ① 同步 use case / 调度器可脱离真券商跑 IT (只替换本 token); ② `MARKETDATA_PROVIDER
 * =mock` 下模块层绑拒绝壳 (FR-018), 调用即抛, 与 marketdata 采集口同一纪律。
 *
 * 🚫 **接口 MUST NOT 出现 vendor 方言**: 富途 code 前缀之外的列名 (`trd_side` / `market_val` …)、
 * 无时区时间串、浮点数一律在 adapter 内规范化成下面的类型。换第二家券商时本文件不应改动。
 *
 * 🚨 **完整券商账户号 MUST NOT 出现在任何返回值里** —— 含 `raw` (FR-002 / SC-010)。
 */

/** DI token (沿 `leg-retrieval.port.ts` 的 `Symbol` 体例)。 */
export const BROKER_ACCOUNT_PORT = Symbol('BROKER_ACCOUNT_PORT');

/**
 * 同步对象账户的概要。**不含尾号或账户号的任何片段** —— 连接尾号是所属账号手机号后四位,
 * 上线建连接时手填 (2026-09-14 amend)。`matched` 恒为 1 (≠ 1 时券商侧以
 * {@link BrokerAccountSelectionError} 拒绝, 走不到这里)。
 */
export interface BrokerAccountSummary {
  /** 账户具备的交易市场权限, 券商原值 (如 `['HK', 'US']`)。 */
  trdmarketAuth: string[];
  matched: number;
}

/** 规范化后的原始行: 券商原样字段, **已剔除账户号列**。 */
export type BrokerRawRow = Record<string, unknown>;

/** 一条当前持仓。数量**带符号** (空头为负), 期权单位为张。 */
export interface BrokerPositionRow {
  market: BrokerMarket;
  /** 券商原始代码 (含市场前缀)。 */
  code: string;
  qty: Prisma.Decimal;
  marketValue: Prisma.Decimal | null;
  costPrice: Prisma.Decimal | null;
  averageCost: Prisma.Decimal | null;
  currentPrice: Prisma.Decimal | null;
  currency: string | null;
  raw: BrokerRawRow;
}

/** 一笔成交。`qty` 恒非负, 方向只看 `side`。 */
export interface BrokerDealRow {
  market: BrokerMarket;
  dealId: string;
  orderId: string | null;
  code: string;
  side: BrokerTradeSide;
  qty: Prisma.Decimal;
  price: Prisma.Decimal;
  currency: string;
  /** 按所属市场交易所时区解析出的绝对时刻 (FR-008), 毫秒保留。 */
  tradedAt: Date;
  raw: BrokerRawRow;
}

/** 一张订单的券商当前状态。组合单的腿码在 `comboLegCodes`, `code` 不解析 (FR-007)。 */
export interface BrokerOrderRow {
  market: BrokerMarket;
  orderId: string;
  code: string;
  comboLegCodes: string[];
  /** 券商原值 (组合单等场景可能不在 {@link BrokerTradeSide} 值域内, 故不收窄)。 */
  side: string;
  orderType: string | null;
  qty: Prisma.Decimal;
  price: Prisma.Decimal | null;
  status: string;
  currency: string | null;
  vendorCreatedAt: Date | null;
  /** FR-013 新旧判据, 毫秒保留。 */
  vendorUpdatedAt: Date;
  raw: BrokerRawRow;
}

/**
 * 历史查询窗口, `YYYY-MM-DD` 两端含, **原样**交给券商。
 * 🚨 券商侧对这两个日期按哪个时区解释未验证 ⇒ 调用方按段相邻重叠 1 天 + 唯一键去重吸收 (T014);
 * 单窗跨度上限由券商侧拒绝 (超限 400), 切段是调用方的事。
 */
export interface BrokerTradeWindow {
  start: string;
  end: string;
}

/**
 * 组合单的一条腿, 已由事件源从券商的 `ComboLeg` **对象**展开成结构化字段 (084 FR-020)。
 *
 * 🚫 与 {@link BrokerOrderRow.comboLegCodes} 的文本腿码**不是一回事**: 那是历史查询路径上从
 * repr 串里正则抠出来的形态。推送路径的腿从一开始就是结构化的, 不经那条文本通路。
 */
export interface BrokerComboLeg {
  code: string;
  /** 券商原值 (`BUY` / `SELL` …); 券商未给 ⇒ `null` (组合单腿方向不收窄, 同 {@link BrokerOrderRow.side})。 */
  side: string | null;
}

/**
 * 订单推送事件的规范化行。比历史查询的订单行多两样: 结构化的腿, 与「腿缺失待回查」标记。
 */
export interface BrokerOrderEventRow extends BrokerOrderRow {
  comboLegs: BrokerComboLeg[];
  /**
   * 该单是组合单但腿列表为空 ⇒ MUST 按订单号回查补全并留痕 (084 FR-020)。
   * 🚫 当作「无腿」正常写入 —— 组合单的标的归属会就此永久缺失, 且无人察觉。
   */
  legsPending: boolean;
}

/**
 * 一条推送事件。**`kind` 由事件源显式给出** (shim 的 `event_type`), 🚫 靠「哪些字段恰好在」猜 ——
 * 订单事件与成交事件的字段集不同 (084 branch 13), 猜字段集会在券商加列那天静默错分。
 */
export type BrokerEvent =
  | { kind: 'order'; seq: number; order: BrokerOrderEventRow }
  | { kind: 'deal'; seq: number; deal: BrokerDealRow };

/** 事件读取游标。首次消费 ⇒ 传 `null`, 从缓冲最旧一条起。 */
export interface BrokerEventQuery {
  epoch: string;
  afterSeq: number;
}

/** 一次事件读取的结果; 前四个字段与 `broker-event-cursor.rules.ts` 的判定入参对齐。 */
export interface BrokerEventBatch {
  epoch: string;
  rows: BrokerEvent[];
  nextSeq: number;
  dropped: boolean;
  /**
   * 事件源记下的**最近一次事件到达时刻**; 该代次还没收到过任何推送 ⇒ `null` (084 FR-014)。
   *
   * 🚨 **这是订阅健康的判据之一**, 与本批有没有行无关 —— 事件源每次都报同一个值, 直到真的
   * 又收到一条推送。🚫 拿信封的 `as_of` 顶替: 那是**响应时刻**, 每拍都在变, 用它判健康等于
   * 「只要 shim 还活着就算通道健在」, 恰好把要测的东西测没了。
   *
   * 🚫 **MUST NOT 改用 SDK 那个「账户已订阅推送」的私有布尔标记** (符号名与「全仓零命中」
   * 守卫都在 `test/integration/optionsdesk-084.push-consume.it.spec.ts` 的 T013 段 —— 刻意不在
   * 本文件写出那个符号, 否则守卫扫的就是这行注释) —— 维护者 2026-09-13 POC-3 实测
   * 该标记**恒为假**, 与「同一次会话确实收到了订单与成交推送」的事实矛盾 (原始记录见
   * `docs/private/evidence/broker-account-poc/`)。FR-014 因此明令健康判据不依赖第三方组件的
   * 内部状态标记。阈值 (多久没事件算异常) 本片**不定**, 见 spec clarify 覆盖率表的 Outstanding 项。
   */
  lastEventAt: Date | null;
}

export interface BrokerAccountPort {
  getAccountSummary(): Promise<BrokerAccountSummary>;
  fetchPositions(market: BrokerMarket): Promise<BrokerPositionRow[]>;
  fetchDeals(market: BrokerMarket, window: BrokerTradeWindow): Promise<BrokerDealRow[]>;
  fetchOrders(market: BrokerMarket, window: BrokerTradeWindow): Promise<BrokerOrderRow[]>;
  /**
   * 期权码 → 正股 canonical `market:code`; 券商不认 / 未给归属 ⇒ `null`。入参里的每个 code
   * 在返回 Map 中**恰有一个键**。给 `resolve-broker-underlying.ts` 的最后一环兜底用 (plan D5)。
   */
  fetchStockOwners(
    market: BrokerMarket,
    codes: readonly string[],
  ): Promise<Map<string, string | null>>;
  /**
   * 读推送事件缓冲 (084 FR-004)。`query` 为 `null` ⇒ 从缓冲最旧一条起。
   *
   * 🚨 **非阻塞**: 没有新事件时立即返回空批, MUST NOT 长轮询 —— 挂起会占住事件源仅有的几个
   * 工作线程, 与行情面抢资源。
   */
  fetchEvents(query: BrokerEventQuery | null): Promise<BrokerEventBatch>;
}

/**
 * 券商侧同步对象账户不唯一 (FR-003: 符合条件的账户数 ≠ 1)。**数据类错误, 不可重试** ——
 * 账户状态不会在 15 分钟后自愈, 重试只会把同一个结论再要一遍 (plan D9: 立即 `failed`)。
 */
export class BrokerAccountSelectionError extends Error {
  constructor(readonly what: string) {
    super(`[broker] ${what}: 同步对象账户不唯一 (FR-003), 需人工处理账户状态`);
    this.name = 'BrokerAccountSelectionError';
  }
}

/**
 * 基础设施类失败 (网络 / 超时 / 5xx / 429 且客户端重试已用尽 / 熔断开启)。**可重试** ——
 * 调度器按 `decideBackfillAfterInfraFailure` 延迟重试 (plan D9)。
 *
 * 🚨 **port 层错误的判别口径 = `instanceof BrokerInfrastructureError`, port 抛出的其余错误均按数据类处理**
 * (409 选户 / 400 参数 / 401 鉴权 / 响应形状或行解析异常) ⇒ 立即 `failed`、不重试。仅指 port 层错误;
 * use case 另按 `isTransientDbError` 把 DB 连接 / 连接数耗尽 / 事务写冲突归基础设施。
 * 反方向更坏: 把确定性的永久错当基础设施失败, 会让同一个错连续重试 24 小时。
 */
export class BrokerInfrastructureError extends Error {
  constructor(
    readonly what: string,
    cause: unknown,
  ) {
    super(`[broker] ${what}: 基础设施失败 (可重试) —— ${String(cause)}`);
    this.name = 'BrokerInfrastructureError';
    this.cause = cause;
  }
}
