import { MARKET_CATALOG, DEFAULT_ACTIVE_MARKETS, type MarketGroup } from './market-catalog';
import { brokerNameOf } from './broker-catalog';

/**
 * 011 portfolio 纯函数不变量 (ADR-0043 §4: rules 文件持无副作用业务规则)。
 *
 * ADR-0046 单行模型：偏好态 = 单行 `active_markets: string[]`（当前激活的核心市场码集合）。
 * min-1 跨行不变性已塌缩成「单行非空」，由 UpdateMarketPreferenceUseCase 的 conditional
 * UPDATE 在 SQL 层强制（无 FOR UPDATE）。本文件只剩纯投影。
 */
export interface ProjectedMarket {
  marketCode: string;
  displayName: string;
  isoCurrency: string;
  group: MarketGroup;
  v1Available: boolean;
  active: boolean;
}

/**
 * merge 持久化激活集与静态字典 9 行 → 全量投影 (固定顺序)。
 *
 * - `activeMarkets = null`（新用户无行）→ 核心市场取 DEFAULT_ACTIVE_MARKETS（FR-S01 默认态）。
 * - `activeMarkets = string[]`（已有行）→ 核心市场 active ⟺ 码 ∈ 集合。
 * - 海外市场恒 inactive（历史脏数据防御：即便误入集合，读侧仍按字典 v1Available=false 呈现）。
 */
export function projectMarkets(activeMarkets: string[] | null): ProjectedMarket[] {
  const activeSet = new Set(activeMarkets ?? DEFAULT_ACTIVE_MARKETS);
  return MARKET_CATALOG.map((m) => ({
    marketCode: m.marketCode,
    displayName: m.displayName,
    isoCurrency: m.isoCurrency,
    group: m.group,
    v1Available: m.v1Available,
    active: m.group === 'core' ? activeSet.has(m.marketCode) : false,
  }));
}

/**
 * 012 客户号归一 (FR-S07 宽松 + 禁控制字符)。
 *
 * 先对 **raw** 查禁字符 deny-list (trim 会吞 BOM, 须 trim 前查) → 命中抛; 再 trim → 空抛;
 * 返回 trimmed 明文。deny-list = 002 displayName 同款 (控制/零宽/行段分隔符) —— portfolio
 * 自带常量, 跨 ctx 不 import account.rules (边界; 小常量复制 < 跨 ctx 耦合)。**不强制格式 /
 * 不限长** (各券商客户号格式不一, 归属标记非凭证)。错误 message 前缀 `INVALID_CLIENT_NO`
 * 供 bind UC catch → 映射 400 FORM_VALIDATION。
 */
/* eslint-disable no-control-regex */
const CLIENT_NO_FORBIDDEN = new RegExp('[\\x00-\\x1F\\x7F\\u200B-\\u200F\\uFEFF\\u2028\\u2029]');
/* eslint-enable no-control-regex */

export function normalizeClientNo(raw: string): string {
  if (CLIENT_NO_FORBIDDEN.test(raw)) {
    throw new Error(
      'INVALID_CLIENT_NO: contains forbidden characters (control chars, zero-width chars, or line separators)',
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('INVALID_CLIENT_NO: must be non-empty after trim');
  }
  return trimmed;
}

/** broker_account 行的最小读形 (Prisma row 结构兼容超集)。 */
export interface BrokerAccountRow {
  id: bigint;
  brokerCode: string;
  clientNo: string;
  createdAt: Date;
}

/**
 * list response 单项 (EP1)。`id` string (BigInt JSON-safety, 同 device-list); 默认账户
 * brokerCode/clientNo/createdAt = null。clientNo 为 **raw 明文** (FR-S07 脱敏在客户端)。
 */
export interface BrokerAccountListItem {
  id: string;
  brokerCode: string | null;
  brokerName: string;
  clientNo: string | null;
  isDefault: boolean;
  createdAt: string | null;
}

/**
 * 012 合成券商账户列表 (OQ3 读侧虚拟派生): 系统「默认账户」恒置顶 (index 0, id=accountId,
 * isDefault=true, 无 brokerCode/clientNo/createdAt) + 已绑券商按入参序 (UC 已 createdAt asc)
 * merge brokerName。未知 code (防御) → brokerName 回退为 code 本身 (DTO 非 nullable)。
 */
export function buildBrokerAccountList(
  rows: readonly BrokerAccountRow[],
  accountId: bigint,
): BrokerAccountListItem[] {
  const defaultItem: BrokerAccountListItem = {
    id: accountId.toString(),
    brokerCode: null,
    brokerName: '默认账户',
    clientNo: null,
    isDefault: true,
    createdAt: null,
  };
  const bound = rows.map((row) => ({
    id: row.id.toString(),
    brokerCode: row.brokerCode,
    brokerName: brokerNameOf(row.brokerCode) ?? row.brokerCode,
    clientNo: row.clientNo,
    isDefault: false,
    createdAt: row.createdAt.toISOString(),
  }));
  return [defaultItem, ...bound];
}
