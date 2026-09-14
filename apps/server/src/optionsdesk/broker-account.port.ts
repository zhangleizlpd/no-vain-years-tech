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
 * 🚨 **判别口径 = `instanceof BrokerInfrastructureError`, 其余一切错误均按数据类处理**
 * (409 选户 / 400 参数 / 401 鉴权 / 响应形状或行解析异常) ⇒ 立即 `failed`、不重试。
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
